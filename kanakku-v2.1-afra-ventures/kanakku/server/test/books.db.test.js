// End-to-end book-keeping test on a throwaway database: <your database>_test (created and dropped here).
// Runs real money flows and checks every number: GST never counted as income, TDS counted, shared costs split,
// transfers and investor capital not profit, month lock, bank matching, recurring entries, investor share.
// Needs DATABASE_URL (or TEST_DATABASE_URL) with permission to create a database. Skips itself otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const base = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const testUrl = base && (process.env.TEST_DATABASE_URL ? base : base.replace(/\/([^/?]+)(\?|$)/, '/$1_test$2'));
const adminUrl = base && base.replace(/\/([^/?]+)(\?|$)/, '/postgres$2');

let ok = !!base;
async function adminQuery(sql) {
  const { Pool } = require('pg');
  const p = new Pool({ connectionString: adminUrl });
  try { await p.query(sql); } finally { await p.end(); }
}

test('books: full money flow on a test database', { skip: !base && 'no DATABASE_URL / TEST_DATABASE_URL' }, async (t) => {
  const dbName = testUrl.match(/\/([^/?]+)(\?|$)/)[1];
  if (!process.env.TEST_DATABASE_URL) {
    try { await adminQuery(`DROP DATABASE IF EXISTS ${dbName}`); await adminQuery(`CREATE DATABASE ${dbName}`); }
    catch (err) { ok = false; t.skip(`cannot create test database (${err.message})`); return; }
  }
  process.env.DATABASE_URL = testUrl;
  process.env.TEST_DATABASE_URL = testUrl;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const { query, tx, pool } = require('../src/lib/db');
  const sql = (f) => fs.readFileSync(path.join(__dirname, '../db', f), 'utf8');
  if (process.env.KANAKKU_TEST_PSQL) {
    for (const f of ['schema.sql', 'seed.sql']) execFileSync('psql', ['-q', '-v', 'ON_ERROR_STOP=1', testUrl, '-f', path.join(__dirname, '../db', f)], { stdio: 'ignore' });
  } else {
    await pool.query(sql('schema.sql')); await pool.query(sql('seed.sql'));
  }

  const { insertEntry } = require('../src/lib/ledger');
  const { recordPayment, loadDoc } = require('../src/routes/deals');
  const { pnl, investorStatement } = require('../src/lib/reports');
  const { accountBalances, clearLockCache } = require('../src/lib/books');
  const { listEntries } = require('../src/routes/entries');
  const { autoReconcile } = require('../src/lib/reconcile');
  const { runDue } = require('../src/lib/recurring');
  const one = async (q, p) => (await query(q, p)).rows[0];
  const brand = async (code) => (await one('SELECT id FROM brands WHERE code=$1', [code])).id;
  const cat = async (name, kind) => (await one('SELECT id FROM categories WHERE name=$1 AND kind=$2', [name, kind])).id;
  const TX = await brand('TX'); const NPP = await brand('NPP'); const AC = await brand('AC');
  const rbl = (await one(`INSERT INTO accounts (name,kind,opening_balance,opening_date) VALUES ('Test RBL','bank',100000,'2026-09-12') RETURNING id`)).id;
  const cash = (await one(`INSERT INTO accounts (name,kind,opening_balance,opening_date) VALUES ('Test cash','cash',20000,'2026-09-12') RETURNING id`)).id;

  async function makeDoc(type, partyId, brandId, date, items, extra = {}) {
    const sub = items.reduce((s, i) => s + i.amount, 0); const tax = items.reduce((s, i) => s + i.amount * i.gst_rate / 100, 0);
    const d = await one(`INSERT INTO documents (doc_type,number,brand_id,customer_id,doc_date,status,place_of_supply,subtotal,cgst,sgst,igst,total,itc_eligible,split,category_id)
      VALUES ($1,$2,$3,$4,$5,'unpaid','34',$6,$7,$7,0,$8,$9,$10,$11) RETURNING id`, [type, `T/${type}/${Math.random().toString(36).slice(2, 8)}`, brandId, partyId, date,
      sub, tax / 2, sub + tax, extra.itc ?? true, extra.split ? JSON.stringify(extra.split) : null, extra.category_id || null]);
    for (const [i, it] of items.entries()) await query('INSERT INTO document_items (document_id,position,description,hsn_sac,qty,rate,gst_rate,amount) VALUES ($1,$2,$3,$4,1,$5,$6,$5)', [d.id, i, it.d || 'item', '998314', it.amount, it.gst_rate]);
    return loadDoc(d.id);
  }
  const cust = (await one(`INSERT INTO customers (name,phone,gstin,state_code,tds_rate) VALUES ('Murugan Traders','9876543210','34ABGCA7083D1ZS','34',10) RETURNING id`)).id;
  const vendor = (await one(`INSERT INTO customers (name,kind,gstin,state_code) VALUES ('Office Supplies Co','vendor','34ABGCA7083D1ZS','34') RETURNING id`)).id;
  const overheads = (await one("SELECT rules FROM split_presets WHERE name LIKE 'Office overheads%'")).rules;

  await t.test('invoice paid with TDS: income = taxable value, GST kept out, TDS counted', async () => {
    const inv = await makeDoc('invoice', cust, TX, '2026-10-02', [{ amount: 60000, gst_rate: 18 }]);
    assert.equal(Number(inv.total), 70800);
    await tx((c) => recordPayment(c, inv, { amount: 64800, tds_amount: 6000, paid_on: '2026-10-05', account_id: rbl }));
    const after = await loadDoc(inv.id);
    assert.equal(after.status, 'paid'); assert.equal(Number(after.tds_total), 6000); assert.equal(after.balance, 0);
    const e = after.payments[0];
    assert.deepEqual([Number(e.amount), Number(e.tds_amount), Number(e.gst_amount)], [64800, 6000, 10800]);
  });

  await t.test('part payments: GST shares add up exactly', async () => {
    const inv = await makeDoc('invoice', cust, AC, '2026-10-06', [{ amount: 10000, gst_rate: 18 }]);
    await tx((c) => recordPayment(c, inv, { amount: 3333.33, paid_on: '2026-10-07', account_id: rbl }));
    await tx(async (c) => recordPayment(c, await loadDoc(inv.id, c), { amount: 8466.67, paid_on: '2026-10-08', account_id: rbl }));
    const g = await one('SELECT SUM(gst_amount) AS g FROM entries WHERE document_id=$1', [inv.id]);
    assert.equal(Number(g.g), 1800);
  });

  await t.test('credit note on an unpaid invoice, then the rest is paid', async () => {
    const inv = await makeDoc('invoice', cust, NPP, '2026-10-09', [{ amount: 10000, gst_rate: 18 }]);
    // credit note for half
    const cn = await one(`INSERT INTO documents (doc_type,number,brand_id,customer_id,doc_date,status,place_of_supply,subtotal,cgst,sgst,igst,total,amount_credited,against_id)
      VALUES ('credit_note','T/CN/1',$1,$2,'2026-10-10','issued','34',5000,450,450,0,5900,5900,$3) RETURNING id`, [NPP, cust, inv.id]);
    await query('UPDATE documents SET amount_credited=5900 WHERE id=$1', [inv.id]);
    const d = await loadDoc(inv.id);
    assert.equal(d.balance, 5900);
    await tx((c) => recordPayment(c, d, { amount: 5900, paid_on: '2026-10-11', account_id: rbl }));
    const e = await one('SELECT amount, gst_amount FROM entries WHERE document_id=$1', [inv.id]);
    assert.equal(Number(e.gst_amount), 900, 'GST on the reduced invoice'); // income counted = 5000
    assert.ok(cn.id);
  });

  await t.test('purchase bill with input GST, split across brands', async () => {
    const bill = await makeDoc('bill', vendor, TX, '2026-10-12', [{ amount: 10000, gst_rate: 18 }], { split: overheads, category_id: await cat('Office expense', 'out') });
    await tx((c) => recordPayment(c, bill, { amount: 11800, paid_on: '2026-10-12', account_id: rbl }));
    const e = await one('SELECT id, gst_amount, type FROM entries WHERE bill_id=$1', [bill.id]);
    assert.equal(e.type, 'out'); assert.equal(Number(e.gst_amount), 1800);
    const a = await one('SELECT SUM(amount) AS s, COUNT(*)::int AS n FROM entry_allocations WHERE entry_id=$1', [e.id]);
    assert.equal(Number(a.s), 11800); assert.equal(a.n, overheads.length);
  });

  await t.test('shared rent, transfer and investor capital', async () => {
    await tx((c) => insertEntry(c, { entry_date: '2026-10-05', type: 'out', amount: 15500, split: overheads, category_id: null, account_id: rbl, note: 'Rent' }));
    await tx((c) => insertEntry(c, { entry_date: '2026-10-06', type: 'transfer', amount: 5000, account_id: cash, to_account_id: rbl }));
    await tx((c) => insertEntry(c, { entry_date: '2026-10-07', type: 'in', amount: 500000, brand_id: TX, category_id: null, account_id: rbl, note: 'capital' }));
    const capCat = await cat('Investor capital', 'in');
    await query("UPDATE entries SET category_id=$1 WHERE note='capital'", [capCat]);
  });

  await t.test('P&L: GST out, TDS in, capital and transfers not profit, shared costs split', async () => {
    const r = await pnl({ from: '2026-10-01', to: '2026-10-31' });
    // income: TX 60000 (64800+6000-10800) · AC 10000 · NPP 5000
    // expense: bill 10000 (11800-1800) + rent 15500 — split by Office overheads
    assert.equal(r.income, 75000);
    assert.equal(Math.round(r.expense * 100), 2550000);
    const tx = r.brands.find((b) => b.brand_code === 'TX');
    const txPct = overheads.find((o) => o.brand_id === TX).pct / 100;
    assert.equal(Math.round(tx.income), 60000);
    assert.equal(Math.round(tx.expense), Math.round(25500 * txPct));
  });

  await t.test('account balances follow opening balance, payments and transfers', async () => {
    const b = await accountBalances();
    const r = b.find((x) => x.id === rbl); const c = b.find((x) => x.id === cash);
    // 100000 + 64800 + 3333.33 + 8466.67 + 5900 − 11800 − 15500 + 5000 + 500000
    assert.equal(r.balance, 660200);
    assert.equal(c.balance, 15000);
  });

  await t.test('Book totals cover every matching entry, not just the page', async () => {
    const all = await listEntries({ status: 'posted', limit: 200, offset: 0, from: '2026-10-01', to: '2026-10-31' });
    const page = await listEntries({ status: 'posted', limit: 2, offset: 0, from: '2026-10-01', to: '2026-10-31' });
    assert.equal(page.rows.length, 2);
    assert.equal(page.totals.in, all.totals.in);
    assert.equal(page.count, all.count);
    assert.equal(all.totals.tds, 6000);
  });

  await t.test('month lock stops changes in a closed month', async () => {
    await query(`UPDATE settings SET value = jsonb_set(value,'{lock_until}','"2026-09-30"') WHERE key='books'`);
    clearLockCache();
    await assert.rejects(() => tx((c) => insertEntry(c, { entry_date: '2026-09-20', type: 'out', amount: 100, brand_id: TX })), /closed/);
    await tx((c) => insertEntry(c, { entry_date: '2026-10-20', type: 'out', amount: 100, brand_id: TX, account_id: cash }));
  });

  await t.test('bank import: matches existing entries, rules create entries to confirm', async () => {
    await query(`INSERT INTO bank_lines (account_id,line_date,description,debit,credit,hash) VALUES
      ($1,'2026-10-06','NEFT MURUGAN TRADERS',0,64800,'h1'), ($1,'2026-10-15','UPI TNEB EB BILL',4200,0,'h2'), ($1,'2026-10-16','UNKNOWN',123,0,'h3')`, [rbl]);
    const ruleBrand = await brand('DK');
    await query("INSERT INTO bank_rules (pattern,direction,brand_id,category_id) VALUES ('TNEB','out',$1,$2)", [ruleBrand, await cat('Electricity & utilities', 'out')]);
    const r = await autoReconcile({ allowAutoPost: true });
    assert.deepEqual([r.matched, r.by_rule, r.left], [1, 1, 1]);
    const p = await one("SELECT status, amount FROM entries WHERE source='bank'");
    assert.deepEqual([p.status, Number(p.amount)], ['pending', 4200]);
    const before = await pnl({ from: '2026-10-01', to: '2026-10-31' });
    assert.equal(Math.round(before.expense * 100), 2560000, 'pending entry not counted yet'); // 25500 + 100
  });

  await t.test('recurring: catches up missed months, skips closed ones, never doubles', async () => {
    await query(`INSERT INTO recurring (name,template,frequency,day,next_date,auto_post) VALUES ('Internet', $1, 'monthly', 5, '2026-09-05', false)`,
      [JSON.stringify({ type: 'out', amount: 999, brand_id: TX })]);
    const r1 = await runDue('2026-11-10');
    assert.deepEqual([r1.created, r1.skipped_locked], [2, 1]); // Oct 5 + Nov 5; Sep is closed
    const r2 = await runDue('2026-11-10');
    assert.equal(r2.created, 0);
  });

  await t.test('investor share per brand, dated changes keep past months', async () => {
    const inv = (await one("INSERT INTO investors (name,profit_share_pct,start_date,payout_from_month) VALUES ('Test investor',14,'2026-10-01',4) RETURNING id")).id;
    await query("INSERT INTO investor_brands (investor_id,effective_from,brand_id,share_pct) VALUES ($1,'2026-10',$2,14), ($1,'2026-11',$2,20)", [inv, TX]);
    const s = await investorStatement(inv, '2026-11');
    const oct = s.months.find((m) => m.month === '2026-10');
    const txOct = oct.brands.find((b) => b.brand_id === TX);
    assert.equal(txOct.share_pct, 14);
    assert.equal(txOct.share, Math.round(txOct.net * 14) / 100);
    assert.equal(s.months.find((m) => m.month === '2026-11').brands[0].share_pct, 20);
  });

  await t.test('what is due: bills, recurring EMIs and payables, for reminders and the calendar', async () => {
    const { upcoming } = require('../src/lib/upcoming');
    const loanCat = await cat('Loan repaid', 'out');
    await query(`INSERT INTO recurring (name,template,frequency,day,next_date,auto_post) VALUES ('Car loan EMI', $1, 'monthly', 7, '2026-11-07', false)`,
      [JSON.stringify({ type: 'out', amount: 12500, brand_id: TX, category_id: loanCat })]);
    await query("INSERT INTO dues (brand_id,direction,party,amount,due_date) VALUES ($1,'payable','Landlord deposit',20000,'2026-11-03')", [TX]);
    const items = await upcoming({ from: '2026-11-01', to: '2026-11-30', today: '2026-11-04' });
    const emi = items.find((i) => i.title.includes('Car loan EMI'));
    assert.ok(emi, 'EMI listed'); assert.equal(emi.kind, 'EMI'); assert.equal(emi.date, '2026-11-07'); assert.equal(emi.days_left, 3);
    const dep = items.find((i) => i.party === 'Landlord deposit');
    assert.ok(dep && dep.direction === 'out' && dep.days_left === -1, 'payable due listed as overdue');
    const { buildIcs } = require('../src/lib/ics');
    assert.match(buildIcs(items), /Car loan EMI/);
  });

  await pool.end?.();
  if (!process.env.KANAKKU_KEEP_TEST_DB && ok && dbName.endsWith('_test')) { try { await adminQuery(`DROP DATABASE IF EXISTS ${dbName}`); } catch { /* fine */ } }
});

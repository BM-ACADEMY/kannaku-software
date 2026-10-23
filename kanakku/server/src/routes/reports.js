const router = require('express').Router();
const { query } = require('../lib/db');
const { ah, HttpError } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { pnl, monthRange } = require('../lib/reports');
const { gstr1, gstr3b } = require('../lib/gstr');
const { forecast } = require('../lib/forecast');
const { accountBalances } = require('../lib/books');
const { z } = require('zod');
const { parse } = require('../lib/http');

const { todayIST: today } = require('../lib/books');
const petty = require('../lib/petty');
const { listPlans } = require('../lib/plans');

router.get('/pnl', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) throw new HttpError(400, 'from and to are required');
  const brandIds = req.query.brand_id ? [Number(req.query.brand_id)] : null;
  const r = await pnl({ from, to, brandIds });
  // monthly trend (shared costs already split by the entry_lines view)
  const p = [from, to]; let bf = '';
  if (brandIds) { p.push(brandIds); bf = 'AND l.brand_id = ANY($3)'; }
  const trend = await query(`SELECT to_char(l.entry_date,'YYYY-MM') AS month,
      COALESCE(SUM(l.pnl_amount) FILTER (WHERE l.type='in'),0) AS income,
      COALESCE(SUM(l.pnl_amount) FILTER (WHERE l.type='out'),0) AS expense
    FROM entry_lines l LEFT JOIN categories c ON c.id=l.category_id
    WHERE l.deleted_at IS NULL AND l.entry_date BETWEEN $1 AND $2 ${bf} AND COALESCE(c.in_pnl, TRUE)
    GROUP BY 1 ORDER BY 1`, p);
  res.json({ ...r, trend: trend.rows });
}));

router.get('/gst', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const ym = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  const { from, to } = monthRange(ym);
  const { rows } = await query(`SELECT d.number, d.doc_date, c.name AS customer, c.gstin, d.place_of_supply, b.name AS brand_name,
      d.subtotal, d.cgst, d.sgst, d.igst, d.total
    FROM documents d JOIN customers c ON c.id=d.customer_id JOIN brands b ON b.id=d.brand_id
    WHERE d.doc_type='invoice' AND d.status<>'cancelled' AND d.doc_date BETWEEN $1 AND $2 ORDER BY d.doc_date, d.number`, [from, to]);
  const t = rows.reduce((a, r) => ({ taxable: a.taxable + r.subtotal, cgst: a.cgst + r.cgst, sgst: a.sgst + r.sgst, igst: a.igst + r.igst, total: a.total + r.total }),
    { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 });
  res.json({ month: ym, rows, totals: t, b2b: rows.filter((r) => r.gstin).length, b2c: rows.filter((r) => !r.gstin).length });
}));

// Dashboard — what everyone sees first
router.get('/dashboard', requireRole('admin', 'accounts', 'sales'), ah(async (req, res) => {
  const t = today(); const ym = t.slice(0, 7);
  const { from, to } = monthRange(ym);
  const [day, month, recv, pay, quotes, recent] = await Promise.all([
    query(`SELECT COALESCE(SUM(amount) FILTER (WHERE type='in'),0) AS income, COALESCE(SUM(amount) FILTER (WHERE type='out'),0) AS expense
      FROM entries WHERE deleted_at IS NULL AND status='posted' AND entry_date=$1`, [t]),
    pnl({ from, to }),
    query(`SELECT COALESCE(SUM(total-amount_paid-amount_credited),0) AS amt, COUNT(*) AS n,
      COUNT(*) FILTER (WHERE due_date < CURRENT_DATE) AS overdue
      FROM documents WHERE doc_type='invoice' AND status IN ('unpaid','partial')`),
    query(`SELECT COALESCE(SUM(amount-amount_settled) FILTER (WHERE direction='payable'),0) AS payable,
      COALESCE(SUM(amount-amount_settled) FILTER (WHERE direction='receivable'),0) AS receivable
      FROM dues WHERE status='open' AND document_id IS NULL`),
    query(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS amt FROM documents WHERE doc_type='quote' AND status IN ('draft','sent','accepted')`),
    query(`SELECT e.id,e.entry_date,e.type,e.amount,
        CASE WHEN e.type='transfer' THEN fa.name || ' → ' || ta.name ELSE e.party END AS party,
        b.code AS brand_code,b.color AS brand_color,c.name AS category_name,fa.name AS account_name
      FROM entries e JOIN brands b ON b.id=e.brand_id LEFT JOIN categories c ON c.id=e.category_id
      LEFT JOIN accounts fa ON fa.id=e.account_id LEFT JOIN accounts ta ON ta.id=e.to_account_id
      WHERE e.deleted_at IS NULL AND e.status='posted' ORDER BY e.created_at DESC LIMIT 8`),
  ]);
  let extra = {};
  if (req.user.role !== 'sales') {
    const [bal, pend, bank, fc] = await Promise.all([
      accountBalances(),
      query("SELECT COUNT(*)::int AS n FROM entries WHERE status='pending' AND deleted_at IS NULL"),
      query("SELECT COUNT(*)::int AS n FROM bank_lines WHERE status='unmatched'"),
      forecast(30).catch(() => null),
    ]);
    extra = { balances: bal.filter((a) => a.active), cash_total: bal.filter((a) => a.active).reduce((s, a) => s + Number(a.balance), 0),
      pending_count: pend.rows[0].n, unmatched_bank: bank.rows[0].n,
      forecast: fc ? { low: fc.low, runs_out_on: fc.runs_out_on, end_balance: fc.end_balance, expected_in: fc.expected_in, expected_out: fc.expected_out } : null };
    // "Needs your action" counts — admin and accounts only (never sent to sales or investors)
    const p = await petty.status().catch(() => null);
    extra.plans = await listPlans(t).catch(() => []);
    // Top accounts with the change over the last 7 days (admin and accounts only)
    const weekAgo = new Date(Date.parse(`${t}T00:00:00Z`) - 7 * 864e5).toISOString().slice(0, 10);
    const prevBal = await accountBalances(weekAgo).catch(() => []);
    extra.accounts = extra.balances.map((a) => {
      const was = prevBal.find((x) => x.id === a.id);
      return { id: a.id, name: a.name, kind: a.kind, balance: Number(a.balance), change7: Math.round((Number(a.balance) - Number(was?.balance || 0)) * 100) / 100 };
    });
    extra.attention = {
      pending_approval: p?.awaiting_approval?.count || 0,
      cash_waiting: p?.collections?.yesterday_balance || 0,
      cash_waiting_account: p?.collections?.name || null,
      cash_low: !!p?.low,
      cash_balance: p?.balance ?? null,
      cash_float: p?.float ?? null,
      cash_box: p?.account?.name || null,
      bills_missing: p?.bills_missing?.count || 0,
    };
  }
  const showMoney = req.user.role !== 'sales';
  res.json({
    today: showMoney ? day.rows[0] : null,
    month: showMoney ? month : null,
    receivable: Number(recv.rows[0].amt) + Number(pay.rows[0].receivable),
    overdue_invoices: Number(recv.rows[0].overdue),
    payable: showMoney ? Number(pay.rows[0].payable) + Number((await query(`SELECT COALESCE(SUM(total-amount_paid-amount_credited),0) AS amt
      FROM documents WHERE doc_type IN ('bill','credit_note') AND status IN ('unpaid','partial') AND total-amount_paid-amount_credited > 0`)).rows[0].amt) : null,
    open_quotes: { count: Number(quotes.rows[0].n), amount: Number(quotes.rows[0].amt) },
    recent: showMoney ? recent.rows : [],
    ...extra,
  });
}));

// ── GST returns working sheet (GSTR-1 + GSTR-3B) ──
router.get('/gstr', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const ym = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  const { from, to } = monthRange(ym);
  const co = (await query("SELECT value FROM settings WHERE key='company'")).rows[0]?.value || {};
  const docs = (await query(`SELECT d.id, d.doc_type, d.number, d.doc_date, d.total, d.place_of_supply, d.status, c.gstin, c.name AS customer,
      ag.number AS against_number, ag.doc_date AS against_date
    FROM documents d JOIN customers c ON c.id=d.customer_id LEFT JOIN documents ag ON ag.id=d.against_id
    WHERE d.doc_type IN ('invoice','credit_note') AND d.doc_date BETWEEN $1 AND $2 ORDER BY d.number`, [from, to])).rows;
  const items = docs.length ? (await query('SELECT * FROM document_items WHERE document_id = ANY($1) ORDER BY document_id, position', [docs.map((d) => d.id)])).rows : [];
  const byDoc = {}; for (const it of items) (byDoc[it.document_id] = byDoc[it.document_id] || []).push(it);
  const r1 = gstr1(docs, byDoc, co.state_code || '34');
  const bills = (await query(`SELECT d.number, d.vendor_ref, d.doc_date, d.subtotal, d.igst, d.cgst, d.sgst, d.total, d.itc_eligible, d.status, c.name AS vendor, c.gstin
    FROM documents d JOIN customers c ON c.id=d.customer_id WHERE d.doc_type='bill' AND d.doc_date BETWEEN $1 AND $2 ORDER BY d.doc_date`, [from, to])).rows;
  const missingGstin = bills.filter((b) => b.itc_eligible && !b.gstin && b.status !== 'cancelled').map((b) => `${b.number}: vendor ${b.vendor} has no GSTIN — input credit can't be claimed`);
  res.json({ month: ym, gstin: co.gstin, gstr1: { ...r1, warnings: [...r1.warnings, ...missingGstin] }, gstr3b: gstr3b(r1.totals, bills), bills });
}));

// ── TDS deducted by customers (claim it in the income-tax return; match with Form 26AS) ──
router.get('/tds', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) throw new HttpError(400, 'from and to are required');
  const { rows } = await query(`SELECT e.entry_date, e.amount AS received, e.tds_amount, e.party, d.number AS invoice, c.gstin, b.name AS brand_name
    FROM entries e LEFT JOIN documents d ON d.id=e.document_id LEFT JOIN customers c ON c.id=d.customer_id JOIN brands b ON b.id=e.brand_id
    WHERE e.deleted_at IS NULL AND e.status='posted' AND e.tds_amount > 0 AND e.entry_date BETWEEN $1 AND $2 ORDER BY e.entry_date`, [from, to]);
  res.json({ rows, total: rows.reduce((s, r) => s + Number(r.tds_amount), 0) });
}));

// ── Cash-flow forecast ──
router.get('/forecast', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const days = Math.min(180, Math.max(7, Number(req.query.days) || 60));
  res.json(await forecast(days));
}));

// ── Budget vs actual (per brand, per month) ──
router.get('/budget', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const ym = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  const actual = await pnl(monthRange(ym));
  const budgets = (await query('SELECT * FROM budgets WHERE month=$1', [ym])).rows;
  const brands = (await query("SELECT id, name, code, color FROM brands WHERE active AND code<>'HO' ORDER BY sort_order")).rows;
  const rows = brands.map((b) => {
    const a = actual.brands.find((x) => x.brand_id === b.id) || { income: 0, expense: 0, net: 0 };
    const t = budgets.find((x) => x.brand_id === b.id) || { income_target: 0, expense_limit: 0 };
    return { brand_id: b.id, brand_name: b.name, brand_code: b.code, brand_color: b.color, income: a.income, expense: a.expense, net: a.net,
      income_target: Number(t.income_target), expense_limit: Number(t.expense_limit),
      income_pct: t.income_target > 0 ? Math.round((a.income / t.income_target) * 100) : null,
      expense_pct: t.expense_limit > 0 ? Math.round((a.expense / t.expense_limit) * 100) : null };
  });
  res.json({ month: ym, rows });
}));
router.put('/budget', requireRole('admin'), ah(async (req, res) => {
  const b = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), rows: z.array(z.object({ brand_id: z.coerce.number().int(),
    income_target: z.coerce.number().min(0).default(0), expense_limit: z.coerce.number().min(0).default(0) })) }), req.body);
  for (const r of b.rows) {
    await query(`INSERT INTO budgets (brand_id,month,income_target,expense_limit) VALUES ($1,$2,$3,$4)
      ON CONFLICT (brand_id,month) DO UPDATE SET income_target=EXCLUDED.income_target, expense_limit=EXCLUDED.expense_limit`,
    [r.brand_id, b.month, r.income_target, r.expense_limit]);
  }
  res.json({ ok: true });
}));
// Copy a month's budget to the next months (set once, use all year)
router.post('/budget/copy', requireRole('admin'), ah(async (req, res) => {
  const b = parse(z.object({ from: z.string().regex(/^\d{4}-\d{2}$/), months: z.coerce.number().int().min(1).max(12) }), req.body);
  const src = (await query('SELECT * FROM budgets WHERE month=$1', [b.from])).rows;
  let [y, m] = b.from.split('-').map(Number);
  for (let i = 0; i < b.months; i++) {
    m++; if (m > 12) { m = 1; y++; }
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    for (const r of src) await query(`INSERT INTO budgets (brand_id,month,income_target,expense_limit) VALUES ($1,$2,$3,$4)
      ON CONFLICT (brand_id,month) DO UPDATE SET income_target=EXCLUDED.income_target, expense_limit=EXCLUDED.expense_limit`, [r.brand_id, ym, r.income_target, r.expense_limit]);
  }
  res.json({ ok: true });
}));

module.exports = router;

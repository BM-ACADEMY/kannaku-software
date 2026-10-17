// Razorpay → Book. One function records a captured payment (used by the webhook and by the key-based sync),
// and syncPayments() pulls recent payments with the Key ID + Secret so it works without a public webhook URL.
const { query, tx } = require('./db');
const { getConfig } = require('./integrations');

// Put the invoice number in payment notes as `invoice` (e.g. AFV/TX/INV/2627/0001) or a brand code as `brand` (e.g. TX).
async function recordRazorpayPayment(pay, rzp) {
  const { recordPayment, loadDoc } = require('../routes/deals'); // lazy: routes/deals loads a lot
  const dup = await query("SELECT id FROM entries WHERE source='razorpay' AND ref=$1", [pay.id]);
  if (dup.rows[0]) return { duplicate: true };
  const amount = pay.amount / 100;
  const notes = pay.notes && !Array.isArray(pay.notes) ? pay.notes : {};
  const date = new Date((pay.created_at || Date.now() / 1000) * 1000).toISOString().slice(0, 10);
  const acc = (await query("SELECT id FROM accounts WHERE name='Razorpay'")).rows[0];

  if (notes.invoice) {
    const d = (await query("SELECT id FROM documents WHERE number=$1 AND doc_type='invoice'", [String(notes.invoice).trim()])).rows[0];
    if (d) {
      const inv = await loadDoc(d.id);
      const apply = Math.min(amount, inv.total - inv.amount_paid);
      if (apply > 0) {
        await tx((client) => recordPayment(client, inv, { amount: apply, paid_on: date, account_id: acc?.id, ref: pay.id, source: 'razorpay' }));
        return { matched_invoice: inv.number };
      }
    }
  }
  const code = String(notes.brand || rzp.default_brand || 'HO').toUpperCase();
  const brand = (await query('SELECT id FROM brands WHERE code=$1', [code])).rows[0]
    || (await query("SELECT id FROM brands WHERE code='HO'")).rows[0];
  const cat = (await query("SELECT id FROM categories WHERE name='Client payment' AND kind='in'")).rows[0];
  await query(`INSERT INTO entries (entry_date,brand_id,type,amount,category_id,account_id,party,note,ref,source)
    VALUES ($1,$2,'in',$3,$4,$5,$6,$7,$8,'razorpay')`,
  [date, brand.id, amount, cat?.id || null, acc?.id || null, pay.email || pay.contact || null, `Razorpay ${pay.method || ''} ${pay.description || ''}`.trim(), pay.id]);
  return { recorded: true };
}

const auth = (rzp) => `Basic ${Buffer.from(`${rzp.key_id}:${rzp.key_secret}`).toString('base64')}`;

async function rzpGet(rzp, path) {
  const r = await fetch(`https://api.razorpay.com/v1${path}`, { headers: { authorization: auth(rzp) }, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.description || `Razorpay returned ${r.status}`);
  return j;
}

// Checks the keys with the smallest possible call
async function checkKeys(rzp) {
  await rzpGet(rzp, '/payments?count=1');
  return rzp.key_id.startsWith('rzp_live_') ? 'live' : 'test';
}

let running = false;
// Pull payments since the last run (with a day of overlap — duplicates are skipped by payment id)
async function syncPayments() {
  if (running) return { skipped: 'already running' };
  const rzp = (await getConfig()).razorpay;
  if (!rzp.key_id || !rzp.key_secret) return { skipped: 'no keys' };
  running = true;
  const state = (await query("SELECT value FROM settings WHERE key='razorpay_sync'")).rows[0]?.value || {};
  const now = Math.floor(Date.now() / 1000);
  const from = state.last_ok ? state.last_ok - 86400 : now - 3 * 86400;
  const out = { fetched: 0, recorded: 0, matched: 0, duplicates: 0 };
  try {
    for (let skip = 0; ; skip += 100) {
      const page = await rzpGet(rzp, `/payments?from=${from}&to=${now}&count=100&skip=${skip}`);
      const items = page.items || [];
      out.fetched += items.length;
      for (const p of items.filter((x) => x.status === 'captured')) {
        const r = await recordRazorpayPayment(p, rzp);
        if (r.duplicate) out.duplicates++; else if (r.matched_invoice) out.matched++; else out.recorded++;
      }
      if (items.length < 100) break;
    }
    await saveState({ last_run: now, last_ok: now, last_result: out, last_error: null });
    return out;
  } catch (err) {
    await saveState({ ...state, last_run: now, last_error: err.message.slice(0, 300) });
    throw err;
  } finally {
    running = false;
  }
}

const saveState = (v) => query(`INSERT INTO settings (key,value) VALUES ('razorpay_sync',$1)
  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(v)]);

const syncState = async () => (await query("SELECT value FROM settings WHERE key='razorpay_sync'")).rows[0]?.value || null;

// Every 5 minutes while keys are saved
function startAutoSync() {
  setInterval(() => {
    syncPayments().then((r) => { if (r.recorded || r.matched) console.log('[razorpay sync]', r); })
      .catch((e) => console.warn('[razorpay sync] failed:', e.message));
  }, 5 * 60 * 1000).unref();
}

module.exports = { recordRazorpayPayment, syncPayments, syncState, checkKeys, startAutoSync };

// Payment plans: one invoice paid in instalments ("slabs"). The invoice is the single bill; each slab is a due date and an amount.
// Slab payments go through the same recordPayment() as any invoice payment, so the Book, GST and TDS stay correct.
const { query } = require('./db');
const { round2 } = require('./books');
const { sendWhatsApp } = require('./notify');
const { HttpError } = require('./http');
const { loadDoc, recordPayment } = require('../routes/deals');

const fmt = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const dayDiff = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5);

// Add k months to a YYYY-MM-DD date, keeping the day of month (clamped to month end: 31 Jan + 1 month = 28/29 Feb)
function addMonths(iso, k) {
  const [y, m, d] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + k, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

// Split a total into n equal parts. The last part takes any paise left over, so the parts always add up exactly.
function splitAmounts(total, n) {
  const cents = Math.round(Number(total) * 100);
  const base = Math.floor(cents / n);
  const parts = Array.from({ length: n }, () => base);
  parts[n - 1] += cents - base * n;
  return parts.map((c) => c / 100);
}

function slabState(s, today) {
  if (round2(Number(s.amount) - Number(s.paid_amount)) <= 0.009) return 'paid';
  const due = String(s.due_date).slice(0, 10);
  if (due < today) return 'overdue';
  if (due === today) return 'due';
  return Number(s.paid_amount) > 0 ? 'partial' : 'upcoming';
}

// Active plans only (invoice not yet fully paid or cancelled), with every slab and the next unpaid one
async function listPlans(today, q = query) {
  const plans = (await q(`SELECT p.id, p.name, d.id AS document_id, d.number, d.total, d.amount_paid, d.amount_credited,
      c.name AS customer, b.name AS brand_name
    FROM payment_plans p JOIN documents d ON d.id=p.document_id JOIN customers c ON c.id=d.customer_id JOIN brands b ON b.id=d.brand_id
    WHERE d.status IN ('unpaid','partial') ORDER BY d.doc_date, p.id`)).rows;
  if (!plans.length) return [];
  const slabs = (await q('SELECT * FROM plan_slabs WHERE plan_id = ANY($1) ORDER BY plan_id, position', [plans.map((p) => p.id)])).rows;
  return plans.map((p) => {
    const mine = slabs.filter((s) => s.plan_id === p.id).map((s) => ({
      id: s.id, position: s.position, amount: Number(s.amount), paid: Number(s.paid_amount),
      left: round2(Number(s.amount) - Number(s.paid_amount)), due_date: String(s.due_date).slice(0, 10), state: slabState(s, today),
    }));
    const left = round2(Number(p.total) - Number(p.amount_paid) - Number(p.amount_credited));
    return { id: p.id, name: p.name, number: p.number, customer: p.customer, brand: p.brand_name, total: Number(p.total),
      paid: Number(p.amount_paid), left, slabs: mine, count: mine.length,
      next: mine.find((s) => s.state !== 'paid') || null, overdue: mine.filter((s) => s.state === 'overdue').length };
  });
}

// Creates the slabs for an unpaid invoice. The invoice keeps its total; it simply has no single due date.
async function createPlan(client, docId, { count, first_due, every_months = 1, name, userId }) {
  const doc = await loadDoc(docId, client);
  if (doc.doc_type !== 'invoice' || doc.status === 'cancelled' || doc.status === 'paid') throw new HttpError(400, 'Instalments can only be set on an unpaid invoice');
  if (Number(doc.amount_paid) > 0 || Number(doc.amount_credited) > 0) throw new HttpError(400, 'Set instalments before any payment or credit note');
  if ((await client.query('SELECT 1 FROM payment_plans WHERE document_id=$1', [docId])).rows[0]) throw new HttpError(400, 'This invoice already has instalments');
  const amounts = splitAmounts(doc.total, count);
  const plan = (await client.query('INSERT INTO payment_plans (document_id,name,created_by) VALUES ($1,$2,$3) RETURNING id',
    [docId, name || `${count} instalments`, userId])).rows[0];
  for (let i = 0; i < count; i++) {
    await client.query('INSERT INTO plan_slabs (plan_id,position,amount,due_date) VALUES ($1,$2,$3,$4)',
      [plan.id, i + 1, amounts[i], addMonths(first_due, i * every_months)]);
  }
  return plan.id;
}

// Records a payment against one slab (default: the rest of the slab). Also counts against the invoice.
async function paySlab(client, slabId, { amount, paid_on, account_id, userId }) {
  const s = (await client.query('SELECT s.*, p.document_id FROM plan_slabs s JOIN payment_plans p ON p.id=s.plan_id WHERE s.id=$1 FOR UPDATE', [slabId])).rows[0];
  if (!s) throw new HttpError(404, 'Instalment not found');
  const left = round2(Number(s.amount) - Number(s.paid_amount));
  if (left <= 0.009) throw new HttpError(400, 'This instalment is already paid');
  const amt = round2(amount ?? left);
  if (amt <= 0 || amt > left + 0.01) throw new HttpError(400, `Amount must be more than ₹0 and at most ₹${fmt(left)}`);
  const doc = await loadDoc(s.document_id, client);
  const entryId = await recordPayment(client, doc, { amount: amt, paid_on, account_id, ref: `Instalment ${s.position}`, userId, source: 'invoice' });
  await client.query('UPDATE plan_slabs SET paid_amount = paid_amount + $1 WHERE id=$2', [amt, slabId]);
  return entryId;
}

// Reminds the customer about the NEXT unpaid instalment of each plan (one message per plan, never every slab).
// Sent when the instalment is due in `days_before` days, on the due day, and again every `repeat_days` while overdue.
// At most once per day per instalment.
async function remindPlans(cfg, now) {
  const days = Number(cfg.days_before ?? 2); const repeat = Number(cfg.repeat_days ?? 3); const today = now.date;
  const rows = (await query(`SELECT s.id, s.position, s.amount, s.paid_amount, s.due_date, s.last_reminded_at, p.id AS plan_id,
      d.number, c.name AS party, c.phone, b.name AS brand_name, (SELECT COUNT(*) FROM plan_slabs x WHERE x.plan_id=p.id)::int AS n
    FROM plan_slabs s JOIN payment_plans p ON p.id=s.plan_id JOIN documents d ON d.id=p.document_id
      JOIN customers c ON c.id=d.customer_id JOIN brands b ON b.id=d.brand_id
    WHERE d.status IN ('unpaid','partial') AND c.phone IS NOT NULL AND s.paid_amount < s.amount - 0.009
    ORDER BY p.id, s.position`)).rows;
  const next = new Map();
  for (const r of rows) if (!next.has(r.plan_id)) next.set(r.plan_id, r);
  let sent = 0; const failed = []; let total = 0;
  for (const r of next.values()) {
    const due = String(r.due_date).slice(0, 10);
    const left = dayDiff(today, due); // >0 = still to come, 0 = due today, <0 = overdue
    const timely = left === 0 || (left > 0 && left <= days);
    const lateRepeat = left < 0 && (!r.last_reminded_at || Date.now() - new Date(r.last_reminded_at) >= repeat * 864e5);
    const sentToday = r.last_reminded_at && String(new Date(r.last_reminded_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })) === today;
    if ((!timely && !lateRepeat) || sentToday) continue;
    total++;
    const amount = round2(Number(r.amount) - Number(r.paid_amount));
    const res = await sendWhatsApp(r.phone, 'afv_payment_reminder', [r.party, fmt(amount), r.brand_name, `invoice ${r.number} · instalment ${r.position} of ${r.n}`, due]);
    if (res.ok) { sent++; await query('UPDATE plan_slabs SET last_reminded_at=now() WHERE id=$1', [r.id]); }
    else failed.push(`${r.party}: ${res.error}`);
  }
  return { sent, total, failed };
}

module.exports = { addMonths, splitAmounts, slabState, listPlans, createPlan, paySlab, remindPlans };

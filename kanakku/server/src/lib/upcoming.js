// Money due in the coming days — used by the "to pay" reminder and the Google Calendar feed.
//   out: unpaid purchase bills, refunds owed (credit notes), money-to-pay dues, recurring money-out (rent, EMI, salary…)
//   in:  unpaid invoices, money-to-collect dues, recurring money-in
const { query } = require('./db');
const { nextAfter } = require('./recurring');
const { todayIST } = require('./books');

const addDays = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5);

// from/to: YYYY-MM-DD. includeOverdue: also items whose due date is before `from` and still unpaid.
async function upcoming({ from = todayIST(), to, includeOverdue = true, today = todayIST() } = {}) {
  to = to || addDays(from, 30);
  const items = [];
  const docs = (await query(`SELECT d.id, d.doc_type, d.number, d.vendor_ref, d.due_date, d.doc_date, c.name AS party, b.name AS brand_name,
      (d.total-d.amount_paid-d.amount_credited) AS bal
    FROM documents d JOIN customers c ON c.id=d.customer_id JOIN brands b ON b.id=d.brand_id
    WHERE d.doc_type IN ('invoice','bill','credit_note') AND d.status NOT IN ('cancelled','paid','refunded','issued')
      AND d.total-d.amount_paid-d.amount_credited > 0.009
      AND NOT EXISTS (SELECT 1 FROM payment_plans pp WHERE pp.document_id=d.id)`)).rows;
  for (const d of docs) {
    const date = String(d.due_date || d.doc_date).slice(0, 10);
    if (date > to || (!includeOverdue && date < from)) continue;
    const out = d.doc_type !== 'invoice';
    items.push({ key: `doc-${d.id}`, date, direction: out ? 'out' : 'in', amount: Number(d.bal), party: d.party, brand: d.brand_name,
      kind: d.doc_type === 'bill' ? 'Bill' : d.doc_type === 'credit_note' ? 'Refund' : 'Invoice',
      title: `${d.doc_type === 'bill' ? 'Pay bill' : d.doc_type === 'credit_note' ? 'Refund' : 'Collect'} · ${d.party}`,
      ref: d.number + (d.vendor_ref ? ` (${d.vendor_ref})` : '') });
  }
  // Instalment plans: each unpaid slab is its own item on its due date
  const slabs = (await query(`SELECT s.id, s.position, s.due_date, (s.amount-s.paid_amount) AS bal, d.number, c.name AS party, b.name AS brand_name,
      (SELECT COUNT(*) FROM plan_slabs x WHERE x.plan_id=p.id)::int AS n
    FROM plan_slabs s JOIN payment_plans p ON p.id=s.plan_id JOIN documents d ON d.id=p.document_id
      JOIN customers c ON c.id=d.customer_id JOIN brands b ON b.id=d.brand_id
    WHERE d.status IN ('unpaid','partial') AND s.paid_amount < s.amount - 0.009`)).rows;
  for (const s of slabs) {
    const date = String(s.due_date).slice(0, 10);
    if (date > to || (!includeOverdue && date < from)) continue;
    items.push({ key: `slab-${s.id}`, date, direction: 'in', amount: Number(s.bal), party: s.party, brand: s.brand_name, kind: 'Instalment',
      title: `Collect · ${s.party}`, ref: `${s.number} · instalment ${s.position} of ${s.n}` });
  }
  const dues = (await query(`SELECT d.id, d.direction, d.party, d.note, d.due_date, (d.amount-d.amount_settled) AS bal, b.name AS brand_name
    FROM dues d JOIN brands b ON b.id=d.brand_id WHERE d.status='open' AND d.document_id IS NULL AND d.due_date IS NOT NULL`)).rows;
  for (const d of dues) {
    const date = String(d.due_date).slice(0, 10);
    if (date > to || (!includeOverdue && date < from)) continue;
    const out = d.direction === 'payable';
    items.push({ key: `due-${d.id}`, date, direction: out ? 'out' : 'in', amount: Number(d.bal), party: d.party, brand: d.brand_name, kind: 'Due',
      title: `${out ? 'Pay' : 'Collect'} · ${d.party}`, ref: d.note || '' });
  }
  // Recurring: every coming date in the window (rent, EMI, salaries, subscriptions)
  const rec = (await query(`SELECT r.*, b.name AS brand_name, c.name AS category_name FROM recurring r
    LEFT JOIN brands b ON b.id=(r.template->>'brand_id')::int LEFT JOIN categories c ON c.id=(r.template->>'category_id')::int WHERE r.active`)).rows;
  for (const r of rec) {
    const t = r.template || {};
    if (t.type === 'transfer') continue;
    let d = String(r.next_date).slice(0, 10); let guard = 0;
    while (d < from && guard++ < 400) d = nextAfter(d, r.frequency, r.day);
    while (d <= to && guard++ < 400 && (!r.end_date || d <= String(r.end_date).slice(0, 10))) {
      items.push({ key: `rec-${r.id}-${d}`, date: d, direction: t.type === 'in' ? 'in' : 'out', amount: Number(t.amount), party: t.party || r.name,
        brand: t.split?.length ? 'Shared' : r.brand_name, kind: r.category_name === 'Loan repaid' ? 'EMI' : 'Recurring',
        title: `${t.type === 'in' ? 'Expect' : 'Pay'} · ${r.name}`, ref: r.category_name || '' });
      d = nextAfter(d, r.frequency, r.day);
    }
  }
  // Monthly money dates (rent, statutory, investor payouts, salaries)
  items.push(...(await require('./obligations').scheduleItems({ from, to })));
  for (const i of items) i.days_left = daysBetween(today, i.date);
  return items.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
}

module.exports = { upcoming, addDays, daysBetween };

// Cash-flow forecast: money in the accounts today + what's expected in and out over the next N days.
//   In:  unpaid invoices (on their due date; already overdue → assumed in 7 days), money-to-collect dues
//   Out: unpaid purchase bills, refunds owed, money-to-pay dues, recurring bills (rent, salaries…), entries waiting to be confirmed
// Gives a day-by-day balance, the lowest point, and the first day the money would run out.
const { query } = require('./db');
const { accountBalances, round2 } = require('./books');
const { nextAfter } = require('./recurring');

const addDays = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);

function project(start, events, from, days) {
  const end = addDays(from, days);
  const byDay = {};
  for (const e of events) {
    const d = e.date < from ? from : e.date;
    if (d > end) continue;
    (byDay[d] = byDay[d] || []).push(e);
  }
  let bal = round2(start); const series = []; let low = { date: from, balance: bal }; let runsOut = null;
  for (let i = 0; i <= days; i++) {
    const d = addDays(from, i);
    const evs = byDay[d] || [];
    const inn = evs.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    const out = evs.filter((e) => e.amount < 0).reduce((s, e) => s - e.amount, 0);
    bal = round2(bal + inn - out);
    series.push({ date: d, in: round2(inn), out: round2(out), balance: bal });
    if (bal < low.balance) low = { date: d, balance: bal };
    if (bal < 0 && !runsOut) runsOut = d;
  }
  return { series, low, runs_out_on: runsOut, end_balance: bal };
}

async function forecast(days = 60, today = require('./books').todayIST()) {
  const end = addDays(today, days);
  const accounts = (await accountBalances()).filter((a) => a.active);
  const start = accounts.reduce((s, a) => s + Number(a.balance), 0);
  const ev = [];
  const docs = (await query(`SELECT d.doc_type, d.number, d.due_date, d.doc_date, c.name AS party, (d.total-d.amount_paid-d.amount_credited) AS bal
    FROM documents d JOIN customers c ON c.id=d.customer_id
    WHERE d.doc_type IN ('invoice','bill','credit_note') AND d.status NOT IN ('cancelled','paid','refunded','issued')
      AND d.total-d.amount_paid-d.amount_credited > 0.009`)).rows;
  for (const d of docs) {
    let date = d.due_date ? String(d.due_date).slice(0, 10) : addDays(String(d.doc_date).slice(0, 10), 7);
    const late = date < today;
    if (late) date = addDays(today, d.doc_type === 'invoice' ? 7 : 0); // overdue money in: hope for a week; overdue bills: due now
    ev.push({ date, amount: d.doc_type === 'invoice' ? Number(d.bal) : -Number(d.bal), what: `${d.doc_type === 'invoice' ? 'Invoice' : d.doc_type === 'bill' ? 'Bill' : 'Refund'} ${d.number} · ${d.party}${late ? ' (overdue)' : ''}` });
  }
  const dues = (await query("SELECT direction, party, due_date, (amount-amount_settled) AS bal FROM dues WHERE status='open' AND document_id IS NULL")).rows;
  for (const d of dues) ev.push({ date: d.due_date ? String(d.due_date).slice(0, 10) : addDays(today, 14), amount: d.direction === 'receivable' ? Number(d.bal) : -Number(d.bal), what: `Due · ${d.party}` });
  const pending = (await query("SELECT entry_date, type, amount, party, note FROM entries WHERE status='pending' AND deleted_at IS NULL AND type<>'transfer'")).rows;
  for (const p of pending) ev.push({ date: String(p.entry_date).slice(0, 10), amount: p.type === 'in' ? Number(p.amount) : -Number(p.amount), what: `To confirm · ${p.party || p.note || ''}` });
  const rec = (await query('SELECT * FROM recurring WHERE active')).rows;
  for (const r of rec) {
    let d = String(r.next_date).slice(0, 10); let guard = 0;
    const t = r.template || {};
    if (t.type === 'transfer') continue;
    while (d <= end && guard++ < 60 && (!r.end_date || d <= String(r.end_date).slice(0, 10))) {
      ev.push({ date: d, amount: t.type === 'in' ? Number(t.amount) : -Number(t.amount), what: `Recurring · ${r.name}` });
      d = nextAfter(d, r.frequency, r.day);
    }
  }
  const p = project(start, ev, today, days);
  const upcoming = ev.filter((e) => e.date <= end).sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount).slice(0, 200)
    .map((e) => ({ ...e, date: e.date < today ? today : e.date }));
  return { today, days, start: round2(start), accounts, ...p,
    expected_in: round2(upcoming.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0)),
    expected_out: round2(-upcoming.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0)), upcoming };
}

module.exports = { forecast, project, addDays };

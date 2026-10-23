// Server-to-server endpoints for n8n (header: x-internal-key)
const router = require('express').Router();
const { query } = require('../lib/db');
const { ah } = require('../lib/http');
const { pnl, investorStatement } = require('../lib/reports');
const { cfoBrief, fmt } = require('../lib/ai');
const { getConfig } = require('../lib/integrations');

const iso = (d) => d.toISOString().slice(0, 10);

// Invoices + manual receivables due within N days or overdue, not reminded in the last 3 days (n8n marks them after sending)
router.get('/dues-reminders', ah(async (req, res) => {
  const days = Number(req.query.days || 2);
  const inv = await query(`SELECT 'invoice' AS kind, d.id, d.number, c.name AS party, c.phone, (d.total-d.amount_paid-d.amount_credited) AS balance,
      d.due_date, b.name AS brand_name
    FROM documents d JOIN customers c ON c.id=d.customer_id JOIN brands b ON b.id=d.brand_id
    WHERE d.doc_type='invoice' AND d.status IN ('unpaid','partial') AND d.due_date IS NOT NULL
      AND d.due_date <= CURRENT_DATE + $1::int AND c.phone IS NOT NULL
      AND (d.last_reminded_at IS NULL OR d.last_reminded_at < now() - interval '3 days')
      AND NOT EXISTS (SELECT 1 FROM payment_plans pp WHERE pp.document_id=d.id)`, [days]);
  const man = await query(`SELECT 'due' AS kind, d.id, NULL AS number, d.party, d.phone, (d.amount-d.amount_settled) AS balance,
      d.due_date, b.name AS brand_name
    FROM dues d JOIN brands b ON b.id=d.brand_id
    WHERE d.status='open' AND d.direction='receivable' AND d.document_id IS NULL AND d.phone IS NOT NULL
      AND d.due_date <= CURRENT_DATE + $1::int AND (d.last_reminded_at IS NULL OR d.last_reminded_at < now() - interval '3 days')`, [days]);
  const rows = [...inv.rows, ...man.rows].map((r) => ({ ...r, phone: normalisePhone(r.phone), balance_text: fmt(r.balance),
    overdue: r.due_date < iso(new Date()) }));
  res.json({ count: rows.length, rows });
}));

// n8n posts the WhatsApp Cloud API message body here; Kanakku adds the number id + token from Settings → Integrations.
// Keeps the WhatsApp keys in one place (the admin panel) instead of n8n's environment.
router.post('/whatsapp/send', ah(async (req, res) => {
  const wa = (await getConfig()).whatsapp;
  if (!wa.phone_number_id || !wa.token) return res.status(503).json({ error: 'WhatsApp is not set up in Settings → Integrations' });
  const r = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(wa.phone_number_id)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${wa.token}` },
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(20000),
  });
  res.status(r.status).json(await r.json().catch(() => ({})));
}));

router.post('/dues-reminders/mark', ah(async (req, res) => {
  const ids = (req.body?.due_ids || []).map(Number).filter(Boolean);
  const docIds = (req.body?.document_ids || []).map(Number).filter(Boolean);
  if (ids.length) await query('UPDATE dues SET last_reminded_at=now() WHERE id = ANY($1)', [ids]);
  if (docIds.length) await query('UPDATE documents SET last_reminded_at=now() WHERE id = ANY($1)', [docIds]);
  res.json({ ok: true, marked: ids.length + docIds.length });
}));

router.get('/weekly-brief', ah(async (_req, res) => {
  const to = new Date(); const from = new Date(Date.now() - 6 * 864e5);
  const r = await pnl({ from: iso(from), to: iso(to) });
  const recv = (await query(`SELECT COALESCE(SUM(total-amount_paid-amount_credited),0) AS amt, COUNT(*) FILTER (WHERE due_date<CURRENT_DATE) AS overdue
    FROM documents WHERE doc_type='invoice' AND status IN ('unpaid','partial')`)).rows[0];
  const pay = (await query("SELECT COALESCE(SUM(amount-amount_settled),0) AS amt FROM dues WHERE status='open' AND direction='payable'")).rows[0];
  const summary = { ...r, receivable: Number(recv.amt), overdue: Number(recv.overdue), payable: Number(pay.amt) };
  const admins = (await query("SELECT name, phone FROM users WHERE role='admin' AND active AND phone IS NOT NULL")).rows;
  res.json({ text: await cfoBrief(summary), summary, recipients: admins.map((a) => ({ ...a, phone: normalisePhone(a.phone) })) });
}));

// Monthly investor statements (run on the 1st–10th for the previous month)
router.get('/investor-statements', ah(async (_req, res) => {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  const ym = iso(d).slice(0, 7);
  const invs = (await query('SELECT id FROM investors WHERE active')).rows;
  const out = [];
  for (const i of invs) {
    const s = await investorStatement(i.id, ym);
    const m = s.months.find((x) => x.month === ym);
    out.push({ investor_id: i.id, name: s.investor.name, phone: normalisePhone(s.investor.phone), email: s.investor.email, month: ym,
      net_profit: m?.net_profit || 0, share: m?.share || 0, accrued_unpaid: s.accrued_unpaid, due_now: s.due_now,
      text: `Afra Ventures — profit statement for ${ym}\n` + (m?.brands || []).map((b) => `${b.brand_name}: net ₹${fmt(b.net)} × ${b.share_pct}% = ₹${fmt(b.share)}`).join('\n') + `\nYour share this month: ₹${fmt(m?.share)}\nTotal accrued, unpaid: ₹${fmt(s.accrued_unpaid)}` });
  }
  res.json({ month: ym, rows: out });
}));

function normalisePhone(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, '');
  return d.length === 10 ? `91${d}` : d;
}

module.exports = router;

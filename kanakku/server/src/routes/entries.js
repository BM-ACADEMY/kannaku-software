// Book — daily cash in / out / transfers.
// An "out" entry can be a shared cost split across brands. Entries made by autopilot (recurring, bank import)
// arrive as status 'pending' and only count once someone confirms them.
const router = require('express').Router();
const { z } = require('zod');
const { query, tx } = require('../lib/db');
const { ah, parse, HttpError } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { insertEntry, updateEntry } = require('../lib/ledger');
const { assertOpen } = require('../lib/books');
const petty = require('../lib/petty');
const { notifyAdmins } = require('../lib/notify');

const entrySchema = z.object({
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  brand_id: z.coerce.number().int().nullable().optional(),
  type: z.enum(['in', 'out', 'transfer']),
  amount: z.coerce.number().positive(),
  gst_amount: z.coerce.number().min(0).default(0),   // GST inside the amount (input credit on a purchase)
  tds_amount: z.coerce.number().min(0).default(0),   // TDS the customer kept back (money in only)
  category_id: z.coerce.number().int().nullable().optional(),
  account_id: z.coerce.number().int().nullable().optional(),
  to_account_id: z.coerce.number().int().nullable().optional(),
  party: z.string().max(200).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  ref: z.string().max(100).nullable().optional(),
  no_bill: z.boolean().default(false),               // money out with no receipt (acknowledged — keeps it off the "bill missing" list)
  source: z.enum(['manual', 'ai']).default('manual'),
  split: z.array(z.object({ brand_id: z.coerce.number().int(), pct: z.coerce.number().positive() })).nullable().optional(),
  split_preset_id: z.coerce.number().int().nullable().optional(),
});

const SELECT = `SELECT e.*, b.name AS brand_name, b.code AS brand_code, b.color AS brand_color,
  c.name AS category_name, a.name AS account_name, ta.name AS to_account_name, u.name AS created_by_name, sp.name AS split_preset_name,
  (SELECT COALESCE(json_agg(json_build_object('brand_id', ea.brand_id, 'pct', ea.pct, 'amount', ea.amount,
      'brand_code', bb.code, 'brand_name', bb.name, 'brand_color', bb.color) ORDER BY ea.pct DESC), '[]'::json)
     FROM entry_allocations ea JOIN brands bb ON bb.id = ea.brand_id WHERE ea.entry_id = e.id) AS allocations,
  (SELECT COUNT(*) FROM attachments at WHERE at.entity='entry' AND at.entity_id=e.id)::int AS attachment_count
  FROM entries e JOIN brands b ON b.id=e.brand_id
  LEFT JOIN categories c ON c.id=e.category_id LEFT JOIN accounts a ON a.id=e.account_id LEFT JOIN accounts ta ON ta.id=e.to_account_id
  LEFT JOIN users u ON u.id=e.created_by LEFT JOIN split_presets sp ON sp.id=e.split_preset_id`;

const listSchema = z.object({
  from: z.string().optional(), to: z.string().optional(), brand_id: z.coerce.number().optional(),
  type: z.enum(['in', 'out', 'transfer']).optional(), account_id: z.coerce.number().optional(), q: z.string().optional(),
  status: z.enum(['posted', 'pending']).default('posted'),
  limit: z.coerce.number().min(1).max(1000).default(200), offset: z.coerce.number().min(0).default(0),
});

function filters(f) {
  const where = ['e.deleted_at IS NULL', 'e.status = $1']; const p = [f.status];
  if (f.from) { p.push(f.from); where.push(`e.entry_date >= $${p.length}`); }
  if (f.to) { p.push(f.to); where.push(`e.entry_date <= $${p.length}`); }
  if (f.brand_id) { p.push(f.brand_id); where.push(`(e.brand_id = $${p.length} OR EXISTS (SELECT 1 FROM entry_allocations x WHERE x.entry_id=e.id AND x.brand_id=$${p.length}))`); }
  if (f.type) { p.push(f.type); where.push(`e.type = $${p.length}`); }
  if (f.account_id) { p.push(f.account_id); where.push(`(e.account_id = $${p.length} OR e.to_account_id = $${p.length})`); }
  if (f.q) { p.push(`%${f.q}%`); where.push(`(e.party ILIKE $${p.length} OR e.note ILIKE $${p.length} OR e.ref ILIKE $${p.length})`); }
  return { where: where.join(' AND '), p };
}

async function listEntries(f) {
  const { where, p } = filters(f);
  const { rows } = await query(`${SELECT} WHERE ${where} ORDER BY e.entry_date DESC, e.id DESC LIMIT ${Number(f.limit)} OFFSET ${Number(f.offset)}`, p);
  for (const r of rows) {
    const slice = f.brand_id && r.allocations.length ? r.allocations.find((a) => a.brand_id === f.brand_id) : null;
    r.brand_amount = slice ? Number(slice.amount) : (f.brand_id && r.allocations.length ? 0 : r.amount);
  }
  // Totals come from the database over EVERY matching entry, not just the rows on this page.
  // With a brand filter, shared costs count only that brand's slice. Transfers are not in or out.
  const bp = [...p]; let brandAmt = 'e.amount';
  if (f.brand_id) { bp.push(f.brand_id); brandAmt = `COALESCE((SELECT x.amount FROM entry_allocations x WHERE x.entry_id=e.id AND x.brand_id=$${bp.length}),
      CASE WHEN EXISTS (SELECT 1 FROM entry_allocations x WHERE x.entry_id=e.id) THEN 0 ELSE e.amount END)`; }
  const t = (await query(`SELECT COUNT(*)::int AS count,
      COALESCE(SUM(${brandAmt}) FILTER (WHERE e.type='in'),0) AS in_total,
      COALESCE(SUM(${brandAmt}) FILTER (WHERE e.type='out'),0) AS out_total,
      COALESCE(SUM(e.gst_amount) FILTER (WHERE e.type='in'),0) AS gst_in,
      COALESCE(SUM(e.gst_amount) FILTER (WHERE e.type='out'),0) AS gst_out,
      COALESCE(SUM(e.tds_amount),0) AS tds
    FROM entries e WHERE ${where}`, bp)).rows[0];
  const pending = (await query("SELECT COUNT(*)::int AS n FROM entries WHERE status='pending' AND deleted_at IS NULL")).rows[0].n;
  return { rows, count: t.count, limit: f.limit, offset: f.offset, pending,
    totals: { in: Number(t.in_total), out: Number(t.out_total), net: Number(t.in_total) - Number(t.out_total),
      gst_in: Number(t.gst_in), gst_out: Number(t.gst_out), tds: Number(t.tds) } };
}

// Staff spends over the limit wait for an admin (Settings → Petty cash). Returns true if this entry must wait.
async function approvalNeeded(client, user, e) {
  const cfg = await petty.config(client.query.bind(client));
  const kind = e.account_id ? (await client.query('SELECT kind FROM accounts WHERE id=$1', [e.account_id])).rows[0]?.kind : null;
  return petty.needsApproval(cfg, { role: user.role, type: e.type, amount: e.amount, accountKind: kind });
}

router.get('/', requireRole('admin', 'accounts'), ah(async (req, res) => {
  res.json(await listEntries(parse(listSchema, req.query)));
}));

router.get('/:id', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const r = (await query(`${SELECT} WHERE e.id=$1 AND e.deleted_at IS NULL`, [req.params.id])).rows[0];
  if (!r) throw new HttpError(404, 'Entry not found');
  res.json(r);
}));

router.post('/', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const e = parse(entrySchema, req.body);
  let waits = false;
  const id = await tx(async (client) => {
    waits = await approvalNeeded(client, req.user, e);
    const newId = await insertEntry(client, { ...e, created_by: req.user.id, ...(waits ? { status: 'pending', approval_required: true } : {}) });
    await audit(req.user.id, waits ? 'create_needs_approval' : 'create', 'entry', newId, e, client);
    return newId;
  });
  if (waits) notifyAdmins('Approval needed', `${req.user.name} spent ₹${Number(e.amount).toLocaleString('en-IN')}${e.party ? ` on ${e.party}` : ''}${e.note ? ` (${e.note})` : ''}. Open Book → To confirm to approve.`).catch(() => {});
  res.status(201).json((await query(`${SELECT} WHERE e.id=$1`, [id])).rows[0]);
}));

router.put('/:id', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const e = parse(entrySchema, req.body);
  const id = Number(req.params.id);
  await tx(async (client) => {
    const cur = (await client.query('SELECT source, document_id, bill_id, status, amount FROM entries WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'Entry not found');
    if (['razorpay', 'invoice', 'bill', 'investor', 'refund'].includes(cur.source) && req.user.role !== 'admin') throw new HttpError(403, 'Only admin can edit entries made automatically');
    if ((cur.document_id || cur.bill_id) && (e.split?.length || e.type === 'transfer')) throw new HttpError(400, 'A payment linked to an invoice or bill cannot be split or turned into a transfer');
    let extra = {};
    // Staff cannot raise an approved spend over the limit (or turn a draft into a posted one) by editing it
    if (await approvalNeeded(client, req.user, e) && (cur.status === 'pending' || Number(e.amount) !== Number(cur.amount))) extra = { status: 'pending', approval_required: true };
    await updateEntry(client, id, { ...e, ...extra });
    await audit(req.user.id, 'update', 'entry', id, e, client);
  });
  res.json((await query(`${SELECT} WHERE e.id=$1`, [id])).rows[0]);
}));

// Confirm entries that autopilot prepared (recurring bills, bank lines). Optional edits are applied first.
router.post('/confirm', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.coerce.number().int()).min(1) }), req.body);
  const n = await tx(async (client) => {
    const rows = (await client.query("SELECT id, entry_date, approval_required FROM entries WHERE id = ANY($1) AND status='pending' AND deleted_at IS NULL", [ids])).rows;
    if (req.user.role !== 'admin' && rows.some((r) => r.approval_required)) throw new HttpError(403, 'A staff spend over the limit needs an admin to approve it');
    await assertOpen(rows.map((r) => r.entry_date), client.query.bind(client));
    await client.query("UPDATE entries SET status='posted', approved_by=CASE WHEN approval_required THEN $2::int END, approved_at=CASE WHEN approval_required THEN now() END WHERE id = ANY($1)", [rows.map((r) => r.id), req.user.id]);
    for (const r of rows) await audit(req.user.id, 'confirm', 'entry', r.id, null, client);
    return rows.length;
  });
  res.json({ confirmed: n });
}));

// Soft delete — keeps the audit trail
router.delete('/:id', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const cur = (await query('SELECT * FROM entries WHERE id=$1 AND deleted_at IS NULL', [req.params.id])).rows[0];
  if (!cur) throw new HttpError(404, 'Entry not found');
  // Accounts may only discard autopilot drafts; deleting real entries stays admin-only
  if (req.user.role !== 'admin' && cur.status !== 'pending') throw new HttpError(403, 'Only admin can delete a posted entry');
  if (cur.document_id || cur.bill_id) throw new HttpError(400, 'This is a payment on an invoice or bill — reverse it from that document');
  if (cur.status === 'posted') await assertOpen(cur.entry_date);
  await tx(async (client) => {
    await client.query('UPDATE entries SET deleted_at=now() WHERE id=$1', [cur.id]);
    await client.query("UPDATE bank_lines SET status='unmatched', entry_id=NULL WHERE entry_id=$1", [cur.id]);
    await audit(req.user.id, 'delete', 'entry', cur.id, null, client);
  });
  res.json({ ok: true });
}));

module.exports = router;
module.exports.SELECT = SELECT;
module.exports.listEntries = listEntries;
module.exports.listSchema = listSchema;

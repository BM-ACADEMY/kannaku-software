// Book — daily cash in / out. An "out" entry can be a shared cost split across brands.
const router = require('express').Router();
const { z } = require('zod');
const { query, tx } = require('../lib/db');
const { ah, parse, HttpError } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { allocate } = require('../lib/split');

const entrySchema = z.object({
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  brand_id: z.coerce.number().int().nullable().optional(),
  type: z.enum(['in', 'out']),
  amount: z.coerce.number().positive(),
  category_id: z.coerce.number().int().nullable().optional(),
  account_id: z.coerce.number().int().nullable().optional(),
  party: z.string().max(200).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  ref: z.string().max(100).nullable().optional(),
  source: z.enum(['manual', 'ai']).default('manual'),
  // Shared cost: [{brand_id, pct}] totalling 100. Omit/null for a single-brand entry.
  split: z.array(z.object({ brand_id: z.coerce.number().int(), pct: z.coerce.number().positive() })).nullable().optional(),
  split_preset_id: z.coerce.number().int().nullable().optional(),
});

const SELECT = `SELECT e.*, b.name AS brand_name, b.code AS brand_code, b.color AS brand_color,
  c.name AS category_name, a.name AS account_name, u.name AS created_by_name, sp.name AS split_preset_name,
  (SELECT COALESCE(json_agg(json_build_object('brand_id', ea.brand_id, 'pct', ea.pct, 'amount', ea.amount,
      'brand_code', bb.code, 'brand_name', bb.name, 'brand_color', bb.color) ORDER BY ea.pct DESC), '[]'::json)
     FROM entry_allocations ea JOIN brands bb ON bb.id = ea.brand_id WHERE ea.entry_id = e.id) AS allocations
  FROM entries e JOIN brands b ON b.id=e.brand_id
  LEFT JOIN categories c ON c.id=e.category_id LEFT JOIN accounts a ON a.id=e.account_id
  LEFT JOIN users u ON u.id=e.created_by LEFT JOIN split_presets sp ON sp.id=e.split_preset_id`;

async function commonBrandId(client) {
  const r = await client.query("SELECT id FROM brands WHERE code='HO'");
  if (!r.rows[0]) throw new HttpError(400, 'Add a brand with code HO (Afra Common) for shared costs');
  return r.rows[0].id;
}

async function writeAllocations(client, entryId, amount, split) {
  await client.query('DELETE FROM entry_allocations WHERE entry_id=$1', [entryId]);
  if (!split || !split.length) return;
  for (const l of allocate(amount, split)) {
    await client.query('INSERT INTO entry_allocations (entry_id,brand_id,pct,amount) VALUES ($1,$2,$3,$4)', [entryId, l.brand_id, l.pct, l.amount]);
  }
}

router.get('/', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const f = parse(z.object({
    from: z.string().optional(), to: z.string().optional(), brand_id: z.coerce.number().optional(),
    type: z.enum(['in', 'out']).optional(), q: z.string().optional(), limit: z.coerce.number().max(1000).default(300),
  }), req.query);
  const where = ['e.deleted_at IS NULL']; const p = [];
  if (f.from) { p.push(f.from); where.push(`e.entry_date >= $${p.length}`); }
  if (f.to) { p.push(f.to); where.push(`e.entry_date <= $${p.length}`); }
  if (f.brand_id) { p.push(f.brand_id); where.push(`(e.brand_id = $${p.length} OR EXISTS (SELECT 1 FROM entry_allocations x WHERE x.entry_id=e.id AND x.brand_id=$${p.length}))`); }
  if (f.type) { p.push(f.type); where.push(`e.type = $${p.length}`); }
  if (f.q) { p.push(`%${f.q}%`); where.push(`(e.party ILIKE $${p.length} OR e.note ILIKE $${p.length} OR e.ref ILIKE $${p.length})`); }
  p.push(f.limit);
  const { rows } = await query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY e.entry_date DESC, e.id DESC LIMIT $${p.length}`, p);
  // When filtering by brand, a shared cost counts only that brand's slice
  for (const r of rows) {
    const slice = f.brand_id && r.allocations.length ? r.allocations.find((a) => a.brand_id === f.brand_id) : null;
    r.brand_amount = slice ? Number(slice.amount) : (f.brand_id && r.allocations.length ? 0 : r.amount);
  }
  const totals = rows.reduce((t, r) => { t[r.type] += r.brand_amount; return t; }, { in: 0, out: 0 });
  res.json({ rows, totals: { ...totals, net: totals.in - totals.out } });
}));

async function save(req, id) {
  const e = parse(entrySchema, req.body);
  const shared = e.split && e.split.length;
  return tx(async (client) => {
    const brandId = shared ? await commonBrandId(client) : e.brand_id;
    if (!brandId) throw new HttpError(400, 'Pick a brand, or split it across brands');
    const vals = [e.entry_date, brandId, e.type, e.amount, e.category_id || null, e.account_id || null, e.party || null,
      e.note || null, e.ref || null, shared ? e.split_preset_id || null : null];
    let entryId = id;
    if (id) {
      const cur = await client.query('SELECT source, document_id FROM entries WHERE id=$1 AND deleted_at IS NULL', [id]);
      if (!cur.rows[0]) throw new HttpError(404, 'Entry not found');
      if (['razorpay', 'invoice'].includes(cur.rows[0].source) && req.user.role !== 'admin') throw new HttpError(403, 'Only admin can edit auto-created entries');
      if (cur.rows[0].document_id && shared) throw new HttpError(400, 'An invoice payment cannot be split');
      await client.query(`UPDATE entries SET entry_date=$1,brand_id=$2,type=$3,amount=$4,category_id=$5,account_id=$6,party=$7,note=$8,ref=$9,
        split_preset_id=$10 WHERE id=$11`, [...vals, id]);
    } else {
      const r = await client.query(`INSERT INTO entries (entry_date,brand_id,type,amount,category_id,account_id,party,note,ref,split_preset_id,source,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [...vals, e.source, req.user.id]);
      entryId = r.rows[0].id;
    }
    await writeAllocations(client, entryId, e.amount, shared ? e.split : null);
    await audit(req.user.id, id ? 'update' : 'create', 'entry', entryId, e, client);
    return entryId;
  });
}

router.post('/', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const id = await save(req, null);
  res.status(201).json((await query(`${SELECT} WHERE e.id=$1`, [id])).rows[0]);
}));

router.put('/:id', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const id = await save(req, Number(req.params.id));
  res.json((await query(`${SELECT} WHERE e.id=$1`, [id])).rows[0]);
}));

// Soft delete — keeps the audit trail
router.delete('/:id', requireRole('admin'), ah(async (req, res) => {
  const { rowCount } = await query('UPDATE entries SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL AND document_id IS NULL', [req.params.id]);
  if (!rowCount) throw new HttpError(400, 'Entry not found, or it is an invoice payment (reverse it from the invoice)');
  await audit(req.user.id, 'delete', 'entry', Number(req.params.id));
  res.json({ ok: true });
}));

module.exports = router;

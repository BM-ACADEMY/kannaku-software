// Investors — profit-share (no interest). Admin + accounts only.
const router = require('express').Router();
const { z } = require('zod');
const { query, tx } = require('../lib/db');
const { ah, parse, HttpError } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { investorStatement } = require('../lib/reports');
const { audit } = require('../lib/audit');

router.use(requireRole('admin', 'accounts'));

const invSchema = z.object({
  name: z.string().min(1), phone: z.string().nullable().optional(), email: z.string().nullable().optional(),
  profit_share_pct: z.coerce.number().min(0).max(100), start_date: z.string().nullable().optional(),
  payout_from_month: z.coerce.number().int().min(1).default(4), statement_day: z.coerce.number().int().min(1).max(28).default(10),
  notes: z.string().nullable().optional(), active: z.boolean().default(true),
  loss_rule: z.enum(['pooled', 'per_brand']).default('pooled'),
  include_shared_costs: z.boolean().default(true),
  // Per-brand share. Omit to keep the old rule (profit_share_pct on every investor-pool brand).
  brands: z.array(z.object({ brand_id: z.coerce.number().int(), share_pct: z.coerce.number().min(0).max(100) })).optional(),
  // Month the brand shares take effect from (YYYY-MM). Earlier months keep their old %.
  brands_effective_from: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

async function writeBrands(client, investorId, brands, from) {
  if (!brands) return;
  const eff = from || new Date().toISOString().slice(0, 7);
  const cur = await client.query(`SELECT brand_id, share_pct FROM investor_brands WHERE investor_id=$1
    AND effective_from = (SELECT MAX(effective_from) FROM investor_brands WHERE investor_id=$1 AND effective_from <= $2)`, [investorId, eff]);
  const key = (list) => list.filter((x) => Number(x.share_pct) > 0).map((x) => `${x.brand_id}:${Number(x.share_pct)}`).sort().join(',');
  if (key(cur.rows) === key(brands)) return; // nothing changed — don't create a new version
  await client.query('DELETE FROM investor_brands WHERE investor_id=$1 AND effective_from=$2', [investorId, eff]);
  for (const b of brands.filter((x) => x.share_pct > 0)) {
    await client.query('INSERT INTO investor_brands (investor_id,effective_from,brand_id,share_pct) VALUES ($1,$2,$3,$4)', [investorId, eff, b.brand_id, b.share_pct]);
  }
}

router.get('/', ah(async (_req, res) => {
  const { rows } = await query(`SELECT i.*,
      COALESCE((SELECT SUM(amount) FROM investor_contributions WHERE investor_id=i.id),0) AS capital,
      COALESCE((SELECT SUM(amount) FROM investor_payouts WHERE investor_id=i.id),0) AS paid_out,
      (SELECT COALESCE(json_agg(json_build_object('brand_id', ib.brand_id, 'share_pct', ib.share_pct, 'brand_code', b.code) ORDER BY b.sort_order), '[]'::json)
         FROM investor_brands ib JOIN brands b ON b.id=ib.brand_id WHERE ib.investor_id=i.id
         AND ib.effective_from = (SELECT MAX(effective_from) FROM investor_brands WHERE investor_id=i.id AND effective_from <= to_char(CURRENT_DATE,'YYYY-MM'))) AS brands
    FROM investors i ORDER BY i.active DESC, i.name`);
  res.json(rows);
}));

router.post('/', requireRole('admin'), ah(async (req, res) => {
  const i = parse(invSchema, req.body);
  const row = await tx(async (client) => {
    const { rows } = await client.query(`INSERT INTO investors (name,phone,email,profit_share_pct,start_date,payout_from_month,statement_day,notes,active,loss_rule,include_shared_costs)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [i.name, i.phone || null, i.email || null, i.profit_share_pct, i.start_date || null,
      i.payout_from_month, i.statement_day, i.notes || null, i.active, i.loss_rule, i.include_shared_costs]);
    await writeBrands(client, rows[0].id, i.brands, i.brands_effective_from || (i.start_date || '').slice(0, 7) || null);
    await audit(req.user.id, 'create', 'investor', rows[0].id, { brands: i.brands }, client);
    return rows[0];
  });
  res.status(201).json(row);
}));

router.put('/:id', requireRole('admin'), ah(async (req, res) => {
  const i = parse(invSchema, req.body);
  const row = await tx(async (client) => {
    const { rows } = await client.query(`UPDATE investors SET name=$1,phone=$2,email=$3,profit_share_pct=$4,start_date=$5,payout_from_month=$6,
      statement_day=$7,notes=$8,active=$9,loss_rule=$10,include_shared_costs=$11 WHERE id=$12 RETURNING *`, [i.name, i.phone || null, i.email || null,
      i.profit_share_pct, i.start_date || null, i.payout_from_month, i.statement_day, i.notes || null, i.active, i.loss_rule, i.include_shared_costs, req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'Investor not found');
    await writeBrands(client, rows[0].id, i.brands, i.brands_effective_from);
    // Share changes affect past statements too — the audit log keeps what it was
    await audit(req.user.id, 'update', 'investor', rows[0].id, { profit_share_pct: i.profit_share_pct, brands: i.brands, loss_rule: i.loss_rule, include_shared_costs: i.include_shared_costs }, client);
    return rows[0];
  });
  res.json(row);
}));

router.post('/:id/contributions', requireRole('admin'), ah(async (req, res) => {
  const c = parse(z.object({ amount: z.coerce.number().positive(), received_on: z.string(), mode: z.string().nullable().optional(), note: z.string().nullable().optional() }), req.body);
  const { rows } = await query(`INSERT INTO investor_contributions (investor_id,amount,received_on,mode,note) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.params.id, c.amount, c.received_on, c.mode || null, c.note || null]);
  await audit(req.user.id, 'contribution', 'investor', Number(req.params.id), c);
  res.status(201).json(rows[0]);
}));

// Record a payout — also posts an "Investor payout" out-entry to the Book (Head Office)
router.post('/:id/payouts', requireRole('admin'), ah(async (req, res) => {
  const p = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), amount: z.coerce.number().positive(), paid_on: z.string(),
    account_id: z.coerce.number().nullable().optional(), note: z.string().nullable().optional() }), req.body);
  const out = await tx(async (client) => {
    const inv = (await client.query('SELECT name FROM investors WHERE id=$1', [req.params.id])).rows[0];
    if (!inv) throw new HttpError(404, 'Investor not found');
    const r = await client.query(`INSERT INTO investor_payouts (investor_id,period,amount,paid_on,note) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, p.period, p.amount, p.paid_on, p.note || null]);
    const ho = (await client.query("SELECT id FROM brands WHERE code='HO'")).rows[0];
    const cat = (await client.query("SELECT id FROM categories WHERE name='Investor payout' AND kind='out'")).rows[0];
    if (ho) await client.query(`INSERT INTO entries (entry_date,brand_id,type,amount,category_id,account_id,party,note,created_by)
      VALUES ($1,$2,'out',$3,$4,$5,$6,$7,$8)`, [p.paid_on, ho.id, p.amount, cat?.id || null, p.account_id || null, inv.name, `Profit share for ${p.period}`, req.user.id]);
    await audit(req.user.id, 'payout', 'investor', Number(req.params.id), p, client);
    return r.rows[0];
  });
  res.status(201).json(out);
}));

router.get('/:id/statement', ah(async (req, res) => {
  const upto = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const s = await investorStatement(req.params.id, upto);
  if (!s) throw new HttpError(404, 'Investor not found');
  res.json(s);
}));

module.exports = router;

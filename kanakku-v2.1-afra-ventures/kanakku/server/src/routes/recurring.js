// Recurring entries — admin + accounts
const router = require('express').Router();
const { z } = require('zod');
const { query } = require('../lib/db');
const { ah, parse, HttpError } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { firstOnOrAfter, runDue } = require('../lib/recurring');
const { normaliseRules } = require('../lib/split');

router.use(requireRole('admin', 'accounts'));

const schema = z.object({
  name: z.string().min(1).max(120),
  frequency: z.enum(['monthly', 'weekly', 'quarterly', 'yearly']),
  day: z.coerce.number().int().min(1).max(31),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  auto_post: z.boolean().default(false),
  active: z.boolean().default(true),
  template: z.object({
    type: z.enum(['in', 'out', 'transfer']),
    amount: z.coerce.number().positive(),
    gst_amount: z.coerce.number().min(0).default(0),
    brand_id: z.coerce.number().int().nullable().optional(),
    split: z.array(z.object({ brand_id: z.coerce.number().int(), pct: z.coerce.number().positive() })).nullable().optional(),
    split_preset_id: z.coerce.number().int().nullable().optional(),
    category_id: z.coerce.number().int().nullable().optional(),
    account_id: z.coerce.number().int().nullable().optional(),
    to_account_id: z.coerce.number().int().nullable().optional(),
    party: z.string().max(200).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  }),
});

function check(r) {
  if (r.template.split?.length) normaliseRules(r.template.split);
  else if (r.template.type !== 'transfer' && !r.template.brand_id) throw new HttpError(400, 'Pick a brand or a split');
  if (r.frequency === 'weekly' && r.day > 7) throw new HttpError(400, 'For weekly, day is 1 (Mon) to 7 (Sun)');
}

router.get('/', ah(async (_req, res) => {
  const { rows } = await query(`SELECT r.*, b.name AS brand_name, c.name AS category_name,
      (SELECT COUNT(*)::int FROM entries e WHERE e.recurring_id=r.id AND e.deleted_at IS NULL) AS made
    FROM recurring r LEFT JOIN brands b ON b.id=(r.template->>'brand_id')::int LEFT JOIN categories c ON c.id=(r.template->>'category_id')::int
    ORDER BY r.active DESC, r.next_date`);
  res.json(rows);
}));

router.post('/', ah(async (req, res) => {
  const r = parse(schema, req.body); check(r);
  const next = firstOnOrAfter(r.start_date, r.frequency, r.day);
  const { rows } = await query(`INSERT INTO recurring (name,template,frequency,day,next_date,end_date,auto_post,active,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [r.name, JSON.stringify(r.template), r.frequency, r.day, next, r.end_date || null, r.auto_post, r.active, req.user.id]);
  await audit(req.user.id, 'create', 'recurring', rows[0].id, r);
  res.status(201).json(rows[0]);
}));

router.put('/:id', ah(async (req, res) => {
  const r = parse(schema, req.body); check(r);
  const cur = (await query('SELECT * FROM recurring WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) throw new HttpError(404, 'Not found');
  // Changing the schedule restarts it from the start date, but never re-creates a period already made
  const from = r.start_date > (cur.last_run ? String(cur.last_run).slice(0, 10) : '') ? r.start_date : String(cur.next_date).slice(0, 10);
  const next = firstOnOrAfter(from, r.frequency, r.day);
  const { rows } = await query(`UPDATE recurring SET name=$1,template=$2,frequency=$3,day=$4,next_date=$5,end_date=$6,auto_post=$7,active=$8 WHERE id=$9 RETURNING *`,
    [r.name, JSON.stringify(r.template), r.frequency, r.day, next, r.end_date || null, r.auto_post, r.active, req.params.id]);
  await audit(req.user.id, 'update', 'recurring', rows[0].id, r);
  res.json(rows[0]);
}));

router.delete('/:id', ah(async (req, res) => {
  await query('UPDATE recurring SET active=FALSE WHERE id=$1', [req.params.id]);
  await audit(req.user.id, 'stop', 'recurring', Number(req.params.id));
  res.json({ ok: true });
}));

// Make everything due up to today right now (instead of waiting for the morning run)
router.post('/run', ah(async (_req, res) => res.json(await runDue())));

module.exports = router;

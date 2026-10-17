// Dues — money to collect (receivable) and money to pay (payable)
// Unpaid invoices appear automatically as receivables; manual dues cover everything else.
const router = require('express').Router();
const { z } = require('zod');
const { query, tx } = require('../lib/db');
const { ah, parse, HttpError } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { audit } = require('../lib/audit');

const dueSchema = z.object({
  brand_id: z.coerce.number().int(), direction: z.enum(['receivable', 'payable']),
  party: z.string().min(1), phone: z.string().nullable().optional(), amount: z.coerce.number().positive(),
  due_date: z.string().nullable().optional(), note: z.string().nullable().optional(),
});

router.get('/', ah(async (req, res) => {
  const status = req.query.status === 'all' ? null : 'open';
  const manual = await query(`SELECT d.*, 'manual' AS origin, b.name AS brand_name, b.code AS brand_code, b.color AS brand_color,
      (d.amount - d.amount_settled) AS balance
    FROM dues d JOIN brands b ON b.id=d.brand_id WHERE ($1::text IS NULL OR d.status=$1) AND d.document_id IS NULL
    ORDER BY d.due_date NULLS LAST, d.id`, [status]);
  const invoices = await query(`SELECT d.id AS document_id, 'invoice' AS origin, 'receivable' AS direction, d.number, c.name AS party, c.phone,
      d.total AS amount, d.amount_paid AS amount_settled, (d.total - d.amount_paid) AS balance, d.due_date, d.brand_id,
      b.name AS brand_name, b.code AS brand_code, b.color AS brand_color,
      CASE WHEN d.status IN ('unpaid','partial') THEN 'open' ELSE 'settled' END AS status
    FROM documents d JOIN brands b ON b.id=d.brand_id JOIN customers c ON c.id=d.customer_id
    WHERE d.doc_type='invoice' AND d.status <> 'cancelled' AND ($1::text IS NULL OR d.status IN ('unpaid','partial'))
    ORDER BY d.due_date NULLS LAST`, [status]);
  const rows = [...invoices.rows, ...manual.rows];
  const sum = (dir) => rows.filter((r) => r.direction === dir && r.status === 'open').reduce((s, r) => s + Number(r.balance), 0);
  res.json({ rows, totals: { receivable: sum('receivable'), payable: sum('payable') } });
}));

router.post('/', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const d = parse(dueSchema, req.body);
  const { rows } = await query(`INSERT INTO dues (brand_id,direction,party,phone,amount,due_date,note,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [d.brand_id, d.direction, d.party, d.phone || null, d.amount, d.due_date || null, d.note || null, req.user.id]);
  await audit(req.user.id, 'create', 'due', rows[0].id, d);
  res.status(201).json(rows[0]);
}));

router.put('/:id', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const d = parse(dueSchema, req.body);
  const { rows } = await query(`UPDATE dues SET brand_id=$1,direction=$2,party=$3,phone=$4,amount=$5,due_date=$6,note=$7 WHERE id=$8 RETURNING *`,
    [d.brand_id, d.direction, d.party, d.phone || null, d.amount, d.due_date || null, d.note || null, req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Due not found');
  res.json(rows[0]);
}));

// Settle (fully or partly) — also posts the cash movement to the Book
router.post('/:id/settle', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const p = parse(z.object({ amount: z.coerce.number().positive(), paid_on: z.string(), account_id: z.coerce.number().nullable().optional(),
    category_id: z.coerce.number().nullable().optional(), ref: z.string().nullable().optional() }), req.body);
  const out = await tx(async (client) => {
    const { rows } = await client.query('SELECT * FROM dues WHERE id=$1 FOR UPDATE', [req.params.id]);
    const due = rows[0];
    if (!due || due.status !== 'open') throw new HttpError(400, 'Due not open');
    const balance = Number(due.amount) - Number(due.amount_settled);
    if (p.amount > balance + 0.01) throw new HttpError(400, `More than the balance (₹${balance})`);
    await client.query(`INSERT INTO entries (entry_date,brand_id,type,amount,category_id,account_id,party,note,ref,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [p.paid_on, due.brand_id, due.direction === 'receivable' ? 'in' : 'out', p.amount,
      p.category_id || null, p.account_id || null, due.party, `Due settled${due.note ? ': ' + due.note : ''}`, p.ref || null, req.user.id]);
    const settled = Number(due.amount_settled) + p.amount;
    const r = await client.query('UPDATE dues SET amount_settled=$1, status=$2 WHERE id=$3 RETURNING *',
      [settled, settled >= Number(due.amount) - 0.01 ? 'settled' : 'open', due.id]);
    await audit(req.user.id, 'settle', 'due', due.id, p, client);
    return r.rows[0];
  });
  res.json(out);
}));

router.post('/:id/write-off', requireRole('admin'), ah(async (req, res) => {
  await query("UPDATE dues SET status='written_off' WHERE id=$1", [req.params.id]);
  await audit(req.user.id, 'write_off', 'due', Number(req.params.id));
  res.json({ ok: true });
}));

router.post('/:id/reminded', requireRole('admin', 'accounts'), ah(async (req, res) => {
  await query('UPDATE dues SET last_reminded_at=now() WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;

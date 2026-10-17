// Deals — customers, quotations, invoices (quote → invoice → GST → payment)
const router = require('express').Router();
const { z } = require('zod');
const { query, tx } = require('../lib/db');
const { ah, parse, HttpError } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { computeTotals, fyCode, round2 } = require('../lib/gst');
const { audit } = require('../lib/audit');

// ── Customers ──
const customerSchema = z.object({
  name: z.string().min(1), phone: z.string().nullable().optional(), email: z.string().nullable().optional(),
  gstin: z.string().max(15).nullable().optional(), state_code: z.string().default('34'), address: z.string().nullable().optional(),
});
router.get('/customers', ah(async (req, res) => {
  const q = req.query.q ? `%${req.query.q}%` : '%';
  const { rows } = await query('SELECT * FROM customers WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY name LIMIT 200', [q]);
  res.json(rows);
}));
router.post('/customers', ah(async (req, res) => {
  const c = parse(customerSchema, req.body);
  const { rows } = await query(`INSERT INTO customers (name,phone,email,gstin,state_code,address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [c.name, c.phone || null, c.email || null, c.gstin ? c.gstin.toUpperCase() : null, c.state_code, c.address || null]);
  res.status(201).json(rows[0]);
}));
router.put('/customers/:id', ah(async (req, res) => {
  const c = parse(customerSchema, req.body);
  const { rows } = await query(`UPDATE customers SET name=$1,phone=$2,email=$3,gstin=$4,state_code=$5,address=$6 WHERE id=$7 RETURNING *`,
    [c.name, c.phone || null, c.email || null, c.gstin ? c.gstin.toUpperCase() : null, c.state_code, c.address || null, req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Customer not found');
  res.json(rows[0]);
}));

// ── Documents ──
const itemSchema = z.object({
  description: z.string().min(1), hsn_sac: z.string().nullable().optional(),
  qty: z.coerce.number().positive(), rate: z.coerce.number().min(0), gst_rate: z.coerce.number().min(0).max(28),
});
const docSchema = z.object({
  doc_type: z.enum(['quote', 'invoice']),
  brand_id: z.coerce.number().int(),
  customer_id: z.coerce.number().int(),
  doc_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  place_of_supply: z.string().optional(),
  notes: z.string().nullable().optional(),
  terms: z.string().nullable().optional(),
  items: z.array(itemSchema).min(1),
});

async function company() {
  const { rows } = await query("SELECT value FROM settings WHERE key='company'");
  return rows[0]?.value || { state_code: '34', doc_prefix: 'AFV' };
}

async function nextNumber(client, brandId, docType, docDate, prefix) {
  const fy = fyCode(docDate);
  const { rows } = await client.query(`INSERT INTO doc_sequences (brand_id,doc_type,fy,last_no) VALUES ($1,$2,$3,1)
    ON CONFLICT (brand_id,doc_type,fy) DO UPDATE SET last_no = doc_sequences.last_no + 1 RETURNING last_no`, [brandId, docType, fy]);
  const b = await client.query('SELECT code FROM brands WHERE id=$1', [brandId]);
  if (!b.rows[0]) throw new HttpError(400, 'Unknown brand');
  const tag = docType === 'quote' ? 'QT' : 'INV';
  return `${prefix || 'AFV'}/${b.rows[0].code}/${tag}/${fy}/${String(rows[0].last_no).padStart(4, '0')}`;
}

async function loadDoc(id, client) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(`SELECT d.*, b.name AS brand_name, b.code AS brand_code, b.color AS brand_color,
    to_jsonb(c.*) AS customer FROM documents d JOIN brands b ON b.id=d.brand_id JOIN customers c ON c.id=d.customer_id WHERE d.id=$1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Document not found');
  const items = await q('SELECT * FROM document_items WHERE document_id=$1 ORDER BY position', [id]);
  const payments = await q(`SELECT e.id, e.entry_date, e.amount, e.ref, a.name AS account_name FROM entries e
    LEFT JOIN accounts a ON a.id=e.account_id WHERE e.document_id=$1 AND e.deleted_at IS NULL ORDER BY e.entry_date`, [id]);
  return { ...rows[0], items: items.rows, payments: payments.rows };
}

async function writeItems(client, docId, lines) {
  await client.query('DELETE FROM document_items WHERE document_id=$1', [docId]);
  for (const l of lines) {
    await client.query(`INSERT INTO document_items (document_id,position,description,hsn_sac,qty,rate,gst_rate,amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [docId, l.position, l.description, l.hsn_sac || null, l.qty, l.rate, l.gst_rate, l.amount]);
  }
}

router.get('/documents', ah(async (req, res) => {
  const f = parse(z.object({ doc_type: z.enum(['quote', 'invoice']).optional(), status: z.string().optional(),
    brand_id: z.coerce.number().optional(), q: z.string().optional() }), req.query);
  const where = ['TRUE']; const p = [];
  if (f.doc_type) { p.push(f.doc_type); where.push(`d.doc_type=$${p.length}`); }
  if (f.status) { p.push(f.status); where.push(`d.status=$${p.length}`); }
  if (f.brand_id) { p.push(f.brand_id); where.push(`d.brand_id=$${p.length}`); }
  if (f.q) { p.push(`%${f.q}%`); where.push(`(d.number ILIKE $${p.length} OR c.name ILIKE $${p.length})`); }
  const { rows } = await query(`SELECT d.id,d.doc_type,d.number,d.doc_date,d.due_date,d.status,d.total,d.amount_paid,
    b.name AS brand_name,b.code AS brand_code,b.color AS brand_color,c.name AS customer_name
    FROM documents d JOIN brands b ON b.id=d.brand_id JOIN customers c ON c.id=d.customer_id
    WHERE ${where.join(' AND ')} ORDER BY d.doc_date DESC, d.id DESC LIMIT 500`, p);
  res.json(rows);
}));

router.get('/documents/:id', ah(async (req, res) => res.json(await loadDoc(req.params.id))));

router.post('/documents', ah(async (req, res) => {
  const d = parse(docSchema, req.body);
  if (d.doc_type === 'invoice' && req.user.role === 'sales') throw new HttpError(403, 'Sales can create quotes; invoices are raised by accounts');
  const co = await company();
  const cust = await query('SELECT state_code FROM customers WHERE id=$1', [d.customer_id]);
  if (!cust.rows[0]) throw new HttpError(400, 'Unknown customer');
  const pos = d.place_of_supply || cust.rows[0].state_code || co.state_code;
  const t = computeTotals(d.items, co.state_code || '34', pos);
  const id = await tx(async (client) => {
    const number = await nextNumber(client, d.brand_id, d.doc_type, d.doc_date, co.doc_prefix);
    const { rows } = await client.query(`INSERT INTO documents (doc_type,number,brand_id,customer_id,doc_date,due_date,status,place_of_supply,
      subtotal,cgst,sgst,igst,total,notes,terms,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [d.doc_type, number, d.brand_id, d.customer_id, d.doc_date, d.due_date || null, d.doc_type === 'invoice' ? 'unpaid' : 'draft', pos,
      t.subtotal, t.cgst, t.sgst, t.igst, t.total, d.notes || null, d.terms ?? co.invoice_terms ?? null, req.user.id]);
    await writeItems(client, rows[0].id, t.lines);
    await audit(req.user.id, 'create', d.doc_type, rows[0].id, { number, total: t.total }, client);
    return rows[0].id;
  });
  res.status(201).json(await loadDoc(id));
}));

router.put('/documents/:id', ah(async (req, res) => {
  const d = parse(docSchema.omit({ doc_type: true }), req.body);
  const cur = await loadDoc(req.params.id);
  if (cur.doc_type === 'invoice' && req.user.role === 'sales') throw new HttpError(403, 'Sales cannot edit invoices');
  if (cur.amount_paid > 0) throw new HttpError(400, 'Invoice has payments — cancel and re-issue instead of editing');
  if (['converted', 'cancelled', 'paid'].includes(cur.status)) throw new HttpError(400, `A ${cur.status} document cannot be edited`);
  if (cur.brand_id !== d.brand_id) throw new HttpError(400, 'Brand cannot change after numbering — create a new document');
  const co = await company();
  const pos = d.place_of_supply || cur.place_of_supply;
  const t = computeTotals(d.items, co.state_code || '34', pos);
  await tx(async (client) => {
    await client.query(`UPDATE documents SET customer_id=$1,doc_date=$2,due_date=$3,place_of_supply=$4,subtotal=$5,cgst=$6,sgst=$7,igst=$8,
      total=$9,notes=$10,terms=$11,updated_at=now() WHERE id=$12`,
    [d.customer_id, d.doc_date, d.due_date || null, pos, t.subtotal, t.cgst, t.sgst, t.igst, t.total, d.notes || null, d.terms || null, cur.id]);
    await writeItems(client, cur.id, t.lines);
    await audit(req.user.id, 'update', cur.doc_type, cur.id, { total: t.total }, client);
  });
  res.json(await loadDoc(cur.id));
}));

// Quote status changes: sent / accepted / rejected
router.post('/documents/:id/status', ah(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['draft', 'sent', 'accepted', 'rejected']) }), req.body);
  const cur = await loadDoc(req.params.id);
  if (cur.doc_type !== 'quote') throw new HttpError(400, 'Only quotes use this status flow');
  if (cur.status === 'converted') throw new HttpError(400, 'Quote already converted');
  await query('UPDATE documents SET status=$1, updated_at=now() WHERE id=$2', [status, cur.id]);
  res.json(await loadDoc(cur.id));
}));

// Convert quote → invoice (copies items; new invoice number)
router.post('/documents/:id/convert', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const q = await loadDoc(req.params.id);
  if (q.doc_type !== 'quote') throw new HttpError(400, 'Only a quote can be converted');
  if (q.status === 'converted') throw new HttpError(400, 'Already converted');
  const co = await company();
  const today = new Date().toISOString().slice(0, 10);
  const due = req.body?.due_date || null;
  const id = await tx(async (client) => {
    const number = await nextNumber(client, q.brand_id, 'invoice', today, co.doc_prefix);
    const { rows } = await client.query(`INSERT INTO documents (doc_type,number,brand_id,customer_id,doc_date,due_date,status,place_of_supply,
      subtotal,cgst,sgst,igst,total,notes,terms,converted_from_id,created_by)
      VALUES ('invoice',$1,$2,$3,$4,$5,'unpaid',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [number, q.brand_id, q.customer_id, today, due, q.place_of_supply, q.subtotal, q.cgst, q.sgst, q.igst, q.total, q.notes, q.terms, q.id, req.user.id]);
    await writeItems(client, rows[0].id, q.items);
    await client.query("UPDATE documents SET status='converted', updated_at=now() WHERE id=$1", [q.id]);
    await audit(req.user.id, 'convert', 'quote', q.id, { invoice: number }, client);
    return rows[0].id;
  });
  res.status(201).json(await loadDoc(id));
}));

// Record a payment against an invoice → creates a Book "in" entry
async function recordPayment(client, inv, { amount, paid_on, account_id, ref, userId, source = 'invoice' }) {
  const balance = round2(inv.total - inv.amount_paid);
  if (amount > balance + 0.01) throw new HttpError(400, `Amount is more than the balance (₹${balance})`);
  const cat = await client.query("SELECT id FROM categories WHERE name='Client payment' AND kind='in'");
  const { rows } = await client.query(`INSERT INTO entries (entry_date,brand_id,type,amount,category_id,account_id,party,note,ref,source,document_id,created_by)
    VALUES ($1,$2,'in',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
  [paid_on, inv.brand_id, amount, cat.rows[0]?.id || null, account_id || null, inv.customer?.name || null, `Payment for ${inv.number}`, ref || null, source, inv.id, userId || null]);
  const paid = round2(inv.amount_paid + amount);
  const status = paid >= inv.total - 0.01 ? 'paid' : 'partial';
  await client.query('UPDATE documents SET amount_paid=$1, status=$2, updated_at=now() WHERE id=$3', [paid, status, inv.id]);
  await client.query("UPDATE dues SET amount_settled=LEAST(amount, amount_settled+$1), status=CASE WHEN amount_settled+$1>=amount THEN 'settled' ELSE status END WHERE document_id=$2 AND status='open'", [amount, inv.id]);
  return rows[0].id;
}

router.post('/documents/:id/payments', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const p = parse(z.object({ amount: z.coerce.number().positive(), paid_on: z.string(), account_id: z.coerce.number().nullable().optional(), ref: z.string().nullable().optional() }), req.body);
  const inv = await loadDoc(req.params.id);
  if (inv.doc_type !== 'invoice' || inv.status === 'cancelled') throw new HttpError(400, 'Payments can only be recorded on an active invoice');
  await tx((client) => recordPayment(client, inv, { ...p, userId: req.user.id }));
  await audit(req.user.id, 'payment', 'invoice', inv.id, p);
  res.json(await loadDoc(inv.id));
}));

router.post('/documents/:id/cancel', requireRole('admin'), ah(async (req, res) => {
  const d = await loadDoc(req.params.id);
  if (d.amount_paid > 0) throw new HttpError(400, 'This invoice has payments recorded, so it cannot be cancelled. Issue a credit note instead.');
  await query("UPDATE documents SET status='cancelled', updated_at=now() WHERE id=$1", [d.id]);
  await audit(req.user.id, 'cancel', d.doc_type, d.id);
  res.json(await loadDoc(d.id));
}));

module.exports = router;
module.exports.recordPayment = recordPayment;
module.exports.loadDoc = loadDoc;

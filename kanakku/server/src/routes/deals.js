// Deals — customers & vendors, quotations, invoices, credit notes, purchase bills.
//   quote → invoice → payment (with TDS) → credit note → refund
//   bill (vendor) → payment, GST claimed as input credit
// Money rules: a payment's GST share and TDS are stored on the Book entry, so P&L and investor share never count GST as income.
const router = require('express').Router();
const { z } = require('zod');
const { query, tx } = require('../lib/db');
const { ah, parse, HttpError } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { computeTotals, fyCode, round2, checkGstin } = require('../lib/gst');
const { audit } = require('../lib/audit');
const { assertOpen, gstShare, docBalance } = require('../lib/books');
const { insertEntry } = require('../lib/ledger');

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TAGS = { quote: 'QT', invoice: 'INV', credit_note: 'CN', bill: 'BILL' };
const money = ['admin', 'accounts'];

// ── Customers & vendors ──
const customerSchema = z.object({
  name: z.string().min(1), phone: z.string().nullable().optional(), email: z.string().nullable().optional(),
  gstin: z.string().max(15).nullable().optional(), state_code: z.string().default('34'), address: z.string().nullable().optional(),
  kind: z.enum(['customer', 'vendor', 'both']).default('customer'),
  tds_rate: z.coerce.number().min(0).max(30).default(0),
});
function cleanParty(c) {
  const g = checkGstin(c.gstin);
  if (!g.ok) throw new HttpError(400, g.error);
  // GSTIN decides the state for place of supply
  return { ...c, gstin: g.gstin, state_code: g.state_code || c.state_code };
}
router.get('/customers', ah(async (req, res) => {
  const q = req.query.q ? `%${req.query.q}%` : '%';
  const kind = req.query.kind === 'vendor' ? "kind IN ('vendor','both')" : req.query.kind === 'customer' ? "kind IN ('customer','both')" : 'TRUE';
  const { rows } = await query(`SELECT * FROM customers WHERE (name ILIKE $1 OR phone ILIKE $1 OR gstin ILIKE $1) AND ${kind} ORDER BY name LIMIT 300`, [q]);
  res.json(rows);
}));
router.post('/customers', ah(async (req, res) => {
  const c = cleanParty(parse(customerSchema, req.body));
  const { rows } = await query(`INSERT INTO customers (name,phone,email,gstin,state_code,address,kind,tds_rate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [c.name, c.phone || null, c.email || null, c.gstin, c.state_code, c.address || null, c.kind, c.tds_rate]);
  res.status(201).json(rows[0]);
}));
router.put('/customers/:id', ah(async (req, res) => {
  const c = cleanParty(parse(customerSchema, req.body));
  const { rows } = await query(`UPDATE customers SET name=$1,phone=$2,email=$3,gstin=$4,state_code=$5,address=$6,kind=$7,tds_rate=$8 WHERE id=$9 RETURNING *`,
    [c.name, c.phone || null, c.email || null, c.gstin, c.state_code, c.address || null, c.kind, c.tds_rate, req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Not found');
  res.json(rows[0]);
}));

// ── Documents ──
const itemSchema = z.object({
  description: z.string().min(1), hsn_sac: z.string().nullable().optional(),
  qty: z.coerce.number().positive(), rate: z.coerce.number().min(0), gst_rate: z.coerce.number().min(0).max(28),
});
const docSchema = z.object({
  doc_type: z.enum(['quote', 'invoice', 'bill']),
  brand_id: z.coerce.number().int().nullable().optional(),
  customer_id: z.coerce.number().int(),
  doc_date: DATE,
  due_date: DATE.nullable().optional(),
  place_of_supply: z.string().optional(),
  notes: z.string().nullable().optional(),
  terms: z.string().nullable().optional(),
  items: z.array(itemSchema).min(1),
  // bills only
  vendor_ref: z.string().max(60).nullable().optional(),
  itc_eligible: z.boolean().default(true),
  category_id: z.coerce.number().int().nullable().optional(),
  split: z.array(z.object({ brand_id: z.coerce.number().int(), pct: z.coerce.number().positive() })).nullable().optional(),
});

async function company(q = query) {
  const { rows } = await q("SELECT value FROM settings WHERE key='company'");
  return rows[0]?.value || { state_code: '34', doc_prefix: 'AFV' };
}

async function nextNumber(client, brandId, docType, docDate, prefix) {
  const fy = fyCode(docDate);
  const { rows } = await client.query(`INSERT INTO doc_sequences (brand_id,doc_type,fy,last_no) VALUES ($1,$2,$3,1)
    ON CONFLICT (brand_id,doc_type,fy) DO UPDATE SET last_no = doc_sequences.last_no + 1 RETURNING last_no`, [brandId, docType, fy]);
  const b = await client.query('SELECT code FROM brands WHERE id=$1', [brandId]);
  if (!b.rows[0]) throw new HttpError(400, 'Unknown brand');
  return `${prefix || 'AFV'}/${b.rows[0].code}/${TAGS[docType]}/${fy}/${String(rows[0].last_no).padStart(4, '0')}`;
}

async function loadDoc(id, client) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(`SELECT d.*, b.name AS brand_name, b.code AS brand_code, b.color AS brand_color, cat.name AS category_name,
    to_jsonb(c.*) AS customer, ag.number AS against_number,
    EXISTS (SELECT 1 FROM payment_plans pp WHERE pp.document_id=d.id) AS has_plan
    FROM documents d JOIN brands b ON b.id=d.brand_id JOIN customers c ON c.id=d.customer_id
    LEFT JOIN categories cat ON cat.id=d.category_id LEFT JOIN documents ag ON ag.id=d.against_id WHERE d.id=$1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Document not found');
  const items = await q('SELECT * FROM document_items WHERE document_id=$1 ORDER BY position', [id]);
  const payments = await q(`SELECT e.id, e.entry_date, e.type, e.amount, e.gst_amount, e.tds_amount, e.ref, e.source, a.name AS account_name FROM entries e
    LEFT JOIN accounts a ON a.id=e.account_id WHERE (e.document_id=$1 OR e.bill_id=$1) AND e.deleted_at IS NULL ORDER BY e.entry_date, e.id`, [id]);
  const credits = await q(`SELECT id, number, doc_date, total, amount_credited, amount_paid, status FROM documents
    WHERE doc_type='credit_note' AND against_id=$1 AND status<>'cancelled' ORDER BY doc_date`, [id]);
  const d = rows[0];
  const tax = round2(Number(d.cgst) + Number(d.sgst) + Number(d.igst));
  let balance = docBalance(d);
  // credit note: what's still to refund = total − applied to the invoice − refunded
  if (d.doc_type === 'credit_note') balance = round2(Number(d.total) - Number(d.amount_credited) - Number(d.amount_paid));
  return { ...d, tax, balance, items: items.rows, payments: payments.rows, credit_notes: credits.rows };
}

async function writeItems(client, docId, lines) {
  await client.query('DELETE FROM document_items WHERE document_id=$1', [docId]);
  for (const l of lines) {
    await client.query(`INSERT INTO document_items (document_id,position,description,hsn_sac,qty,rate,gst_rate,amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [docId, l.position, l.description, l.hsn_sac || null, l.qty, l.rate, l.gst_rate, l.amount]);
  }
}

router.get('/documents', ah(async (req, res) => {
  const f = parse(z.object({ doc_type: z.enum(['quote', 'invoice', 'credit_note', 'bill']).optional(), status: z.string().optional(),
    brand_id: z.coerce.number().optional(), q: z.string().optional(), customer_id: z.coerce.number().optional() }), req.query);
  if (req.user.role === 'sales' && f.doc_type === 'bill') throw new HttpError(403, 'Sales cannot see purchase bills');
  const where = ['TRUE']; const p = [];
  if (req.user.role === 'sales') where.push("d.doc_type <> 'bill'");
  if (f.doc_type) { p.push(f.doc_type); where.push(`d.doc_type=$${p.length}`); }
  if (f.status === 'overdue') where.push("d.status IN ('unpaid','partial') AND d.due_date < CURRENT_DATE");
  else if (f.status) { p.push(f.status); where.push(`d.status=$${p.length}`); }
  if (f.brand_id) { p.push(f.brand_id); where.push(`d.brand_id=$${p.length}`); }
  if (f.customer_id) { p.push(f.customer_id); where.push(`d.customer_id=$${p.length}`); }
  if (f.q) { p.push(`%${f.q}%`); where.push(`(d.number ILIKE $${p.length} OR c.name ILIKE $${p.length} OR d.vendor_ref ILIKE $${p.length})`); }
  const { rows } = await query(`SELECT d.id,d.doc_type,d.number,d.vendor_ref,d.doc_date,d.due_date,d.status,d.total,d.amount_paid,d.amount_credited,
    (d.total-d.amount_paid-d.amount_credited) AS balance,
    b.name AS brand_name,b.code AS brand_code,b.color AS brand_color,c.name AS customer_name
    FROM documents d JOIN brands b ON b.id=d.brand_id JOIN customers c ON c.id=d.customer_id
    WHERE ${where.join(' AND ')} ORDER BY d.doc_date DESC, d.id DESC LIMIT 500`, p);
  res.json(rows);
}));

router.get('/documents/:id', ah(async (req, res) => {
  const d = await loadDoc(req.params.id);
  if (req.user.role === 'sales' && d.doc_type === 'bill') throw new HttpError(403, 'Sales cannot see purchase bills');
  res.json(d);
}));

router.post('/documents', ah(async (req, res) => {
  const d = parse(docSchema, req.body);
  if (d.doc_type !== 'quote' && req.user.role === 'sales') throw new HttpError(403, 'Sales can create quotes; invoices and bills are made by accounts');
  await assertOpen(d.doc_type === 'quote' ? null : d.doc_date);
  const co = await company();
  const party = (await query('SELECT state_code, kind FROM customers WHERE id=$1', [d.customer_id])).rows[0];
  if (!party) throw new HttpError(400, 'Unknown customer / vendor');
  const shared = d.doc_type === 'bill' && d.split?.length;
  // Bills: place of supply is OUR state when the vendor charges CGST+SGST — use the vendor's state for the split
  const pos = d.place_of_supply || party.state_code || co.state_code;
  const t = computeTotals(d.items, co.state_code || '34', pos);
  const id = await tx(async (client) => {
    let brandId = d.brand_id;
    if (shared || !brandId) brandId = (await client.query("SELECT id FROM brands WHERE code='HO'")).rows[0]?.id;
    if (!brandId) throw new HttpError(400, 'Pick a brand');
    const number = await nextNumber(client, brandId, d.doc_type, d.doc_date, co.doc_prefix);
    const status = d.doc_type === 'quote' ? 'draft' : 'unpaid';
    const { rows } = await client.query(`INSERT INTO documents (doc_type,number,brand_id,customer_id,doc_date,due_date,status,place_of_supply,
      subtotal,cgst,sgst,igst,total,notes,terms,vendor_ref,itc_eligible,category_id,split,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
    [d.doc_type, number, brandId, d.customer_id, d.doc_date, d.due_date || null, status, pos,
      t.subtotal, t.cgst, t.sgst, t.igst, t.total, d.notes || null, d.doc_type === 'bill' ? null : d.terms ?? co.invoice_terms ?? null,
      d.doc_type === 'bill' ? d.vendor_ref || null : null, d.itc_eligible, d.doc_type === 'bill' ? d.category_id || null : null,
      shared ? JSON.stringify(d.split) : null, req.user.id]);
    await writeItems(client, rows[0].id, t.lines);
    await audit(req.user.id, 'create', d.doc_type, rows[0].id, { number, total: t.total }, client);
    return rows[0].id;
  });
  res.status(201).json(await loadDoc(id));
}));

router.put('/documents/:id', ah(async (req, res) => {
  const d = parse(docSchema.omit({ doc_type: true }), req.body);
  const cur = await loadDoc(req.params.id);
  if (cur.doc_type !== 'quote' && req.user.role === 'sales') throw new HttpError(403, 'Sales can only edit quotes');
  if (cur.doc_type === 'credit_note') throw new HttpError(400, 'Credit notes cannot be edited — cancel it and issue a new one');
  if (cur.amount_paid > 0 || cur.amount_credited > 0) throw new HttpError(400, 'This has payments or credit notes — issue a credit note instead of editing');
  if (['converted', 'cancelled', 'paid'].includes(cur.status)) throw new HttpError(400, `A ${cur.status} document cannot be edited`);
  if (cur.doc_type !== 'bill' && d.brand_id && cur.brand_id !== d.brand_id) throw new HttpError(400, 'Brand cannot change after numbering — create a new document');
  if (cur.doc_type !== 'quote') await assertOpen([cur.doc_date, d.doc_date]);
  const co = await company();
  const pos = d.place_of_supply || cur.place_of_supply;
  const t = computeTotals(d.items, co.state_code || '34', pos);
  await tx(async (client) => {
    await client.query(`UPDATE documents SET customer_id=$1,doc_date=$2,due_date=$3,place_of_supply=$4,subtotal=$5,cgst=$6,sgst=$7,igst=$8,
      total=$9,notes=$10,terms=$11,vendor_ref=$12,itc_eligible=$13,category_id=$14,split=$15,updated_at=now() WHERE id=$16`,
    [d.customer_id, d.doc_date, d.due_date || null, pos, t.subtotal, t.cgst, t.sgst, t.igst, t.total, d.notes || null, d.terms || null,
      cur.doc_type === 'bill' ? d.vendor_ref || null : null, d.itc_eligible, cur.doc_type === 'bill' ? d.category_id || null : null,
      cur.doc_type === 'bill' && d.split?.length ? JSON.stringify(d.split) : null, cur.id]);
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
router.post('/documents/:id/convert', requireRole(...money), ah(async (req, res) => {
  const q = await loadDoc(req.params.id);
  if (q.doc_type !== 'quote') throw new HttpError(400, 'Only a quote can be converted');
  if (q.status === 'converted') throw new HttpError(400, 'Already converted');
  const co = await company();
  const today = new Date().toISOString().slice(0, 10);
  await assertOpen(today);
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

// ── Payments ──
// Invoice: `amount` = cash received, `tds_amount` = TDS the customer deducted. Both settle the invoice.
// Bill:    `amount` = cash paid to the vendor.
// The GST share of each payment goes on the Book entry so it never counts as income/expense.
async function recordPayment(client, doc, { amount, tds_amount = 0, paid_on, account_id, ref, userId, source }) {
  amount = round2(amount); tds_amount = round2(tds_amount || 0);
  const settle = round2(amount + tds_amount);
  const balance = docBalance(doc);
  if (settle > balance + 0.01) throw new HttpError(400, `Amount${tds_amount ? ' + TDS' : ''} is more than the balance (₹${balance})`);
  const isBill = doc.doc_type === 'bill';
  if (isBill && tds_amount) throw new HttpError(400, 'TDS is only for money received from customers');
  const tax = round2(Number(doc.cgst) + Number(doc.sgst) + Number(doc.igst));
  const prev = (await client.query('SELECT COALESCE(SUM(gst_amount),0) AS g FROM entries WHERE (document_id=$1 OR bill_id=$1) AND deleted_at IS NULL', [doc.id])).rows[0];
  // GST on a bill is only kept out of cost when we can claim it; otherwise it is part of the cost
  // After a credit note the invoice is smaller — so is its GST
  const effTotal = round2(Number(doc.total) - Number(doc.amount_credited || 0));
  const effTax = Number(doc.total) ? round2((tax * effTotal) / Number(doc.total)) : 0;
  const gstOnThis = isBill && !doc.itc_eligible ? 0
    : gstShare({ total: effTotal, gst: effTax, settledBefore: doc.amount_paid, gstBefore: prev.g, settle });
  let categoryId;
  if (isBill) categoryId = doc.category_id || (await client.query("SELECT id FROM categories WHERE name='Vendor payment' AND kind='out'")).rows[0]?.id;
  else categoryId = (await client.query("SELECT id FROM categories WHERE name='Client payment' AND kind='in'")).rows[0]?.id;
  const split = isBill && doc.split ? doc.split : null;
  const entryId = await insertEntry(client, {
    entry_date: paid_on, type: isBill ? 'out' : 'in', amount, tds_amount, gst_amount: gstOnThis,
    brand_id: doc.brand_id, split, category_id: categoryId || null, account_id, party: doc.customer?.name || null,
    note: `${isBill ? 'Bill' : 'Payment for'} ${doc.number}${doc.vendor_ref ? ` (${doc.vendor_ref})` : ''}`, ref,
    source: source || (isBill ? 'bill' : 'invoice'), document_id: isBill ? null : doc.id, bill_id: isBill ? doc.id : null, created_by: userId,
  });
  const paid = round2(Number(doc.amount_paid) + settle);
  const status = paid + Number(doc.amount_credited || 0) >= Number(doc.total) - 0.01 ? 'paid' : 'partial';
  await client.query('UPDATE documents SET amount_paid=$1, tds_total=tds_total+$2, status=$3, updated_at=now() WHERE id=$4', [paid, tds_amount, status, doc.id]);
  await client.query("UPDATE dues SET amount_settled=LEAST(amount, amount_settled+$1), status=CASE WHEN amount_settled+$1>=amount THEN 'settled' ELSE status END WHERE document_id=$2 AND status='open'", [settle, doc.id]);
  return entryId;
}

router.post('/documents/:id/payments', requireRole(...money), ah(async (req, res) => {
  const p = parse(z.object({ amount: z.coerce.number().positive(), tds_amount: z.coerce.number().min(0).default(0), paid_on: DATE,
    account_id: z.coerce.number().nullable().optional(), ref: z.string().nullable().optional() }), req.body);
  const doc = await loadDoc(req.params.id);
  if (!['invoice', 'bill'].includes(doc.doc_type) || doc.status === 'cancelled') throw new HttpError(400, 'Payments can only be recorded on an active invoice or bill');
  if (doc.has_plan) throw new HttpError(400, 'This invoice is paid in instalments — record each instalment from the Dashboard');
  await tx((client) => recordPayment(client, doc, { ...p, userId: req.user.id }));
  await audit(req.user.id, 'payment', doc.doc_type, doc.id, p);
  res.json(await loadDoc(doc.id));
}));

// ── Credit notes ──
// Issued against an invoice. It first reduces what the customer still owes; anything above that is a refund due to them.
router.post('/documents/:id/credit-note', requireRole(...money), ah(async (req, res) => {
  const c = parse(z.object({ doc_date: DATE, reason: z.string().min(2).max(300), items: z.array(itemSchema).min(1) }), req.body);
  const inv = await loadDoc(req.params.id);
  if (inv.doc_type !== 'invoice' || inv.status === 'cancelled') throw new HttpError(400, 'A credit note must be against an active invoice');
  await assertOpen(c.doc_date);
  const co = await company();
  const t = computeTotals(c.items, co.state_code || '34', inv.place_of_supply);
  const creditable = round2(Number(inv.total) - Number(inv.amount_credited));
  if (t.total > creditable + 0.01) throw new HttpError(400, `Credit note (₹${t.total}) is more than what's left on the invoice (₹${creditable})`);
  const id = await tx(async (client) => {
    const number = await nextNumber(client, inv.brand_id, 'credit_note', c.doc_date, co.doc_prefix);
    const applied = round2(Math.min(t.total, docBalance(inv)));     // reduces what they owe
    const refundDue = round2(t.total - applied);                      // already paid → we owe them this
    const { rows } = await client.query(`INSERT INTO documents (doc_type,number,brand_id,customer_id,doc_date,status,place_of_supply,
      subtotal,cgst,sgst,igst,total,amount_credited,notes,against_id,created_by)
      VALUES ('credit_note',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [number, inv.brand_id, inv.customer_id, c.doc_date, refundDue > 0 ? 'unpaid' : 'issued', inv.place_of_supply,
      t.subtotal, t.cgst, t.sgst, t.igst, t.total, applied, c.reason, inv.id, req.user.id]);
    await writeItems(client, rows[0].id, t.lines);
    const credited = round2(Number(inv.amount_credited) + t.total);
    const status = Number(inv.amount_paid) + credited >= Number(inv.total) - 0.01 ? 'paid' : inv.amount_paid > 0 ? 'partial' : 'unpaid';
    await client.query('UPDATE documents SET amount_credited=$1, status=$2, updated_at=now() WHERE id=$3', [credited, status, inv.id]);
    await audit(req.user.id, 'credit_note', 'invoice', inv.id, { number, total: t.total, refund_due: refundDue }, client);
    return rows[0].id;
  });
  res.status(201).json(await loadDoc(id));
}));

// Pay back a customer the refund part of a credit note → Book "out" with the GST share (output GST reverses)
router.post('/documents/:id/refund', requireRole(...money), ah(async (req, res) => {
  const p = parse(z.object({ amount: z.coerce.number().positive(), paid_on: DATE, account_id: z.coerce.number().nullable().optional(), ref: z.string().nullable().optional() }), req.body);
  const cn = await loadDoc(req.params.id);
  if (cn.doc_type !== 'credit_note' || cn.status === 'cancelled') throw new HttpError(400, 'Refunds are made from a credit note');
  if (p.amount > cn.balance + 0.01) throw new HttpError(400, `Only ₹${cn.balance} is due as a refund on this credit note`);
  await tx(async (client) => {
    const cat = (await client.query("SELECT id FROM categories WHERE name='Refund to customer' AND kind='out'")).rows[0];
    const gst = round2((p.amount * cn.tax) / Number(cn.total));
    await insertEntry(client, { entry_date: p.paid_on, type: 'out', amount: p.amount, gst_amount: gst, brand_id: cn.brand_id,
      category_id: cat?.id, account_id: p.account_id, party: cn.customer?.name, note: `Refund for ${cn.number}`, ref: p.ref,
      source: 'refund', document_id: cn.id, created_by: req.user.id });
    const paid = round2(Number(cn.amount_paid) + p.amount);
    await client.query("UPDATE documents SET amount_paid=$1, status=CASE WHEN amount_credited+$1>=total-0.01 THEN 'refunded' ELSE status END, updated_at=now() WHERE id=$2", [paid, cn.id]);
    await audit(req.user.id, 'refund', 'credit_note', cn.id, p, client);
  });
  res.json(await loadDoc(cn.id));
}));

router.post('/documents/:id/cancel', requireRole('admin'), ah(async (req, res) => {
  const d = await loadDoc(req.params.id);
  if (d.status === 'cancelled') throw new HttpError(400, 'Already cancelled');
  if (Number(d.amount_paid) > 0) throw new HttpError(400, d.doc_type === 'credit_note' ? 'A refund was paid on this credit note — it cannot be cancelled' : 'This has payments recorded, so it cannot be cancelled. Issue a credit note instead.');
  if (d.credit_notes?.length) throw new HttpError(400, 'Cancel its credit notes first');
  if (d.doc_type !== 'quote') await assertOpen(d.doc_date);
  await tx(async (client) => {
    await client.query("UPDATE documents SET status='cancelled', updated_at=now() WHERE id=$1", [d.id]);
    if (d.doc_type === 'credit_note' && d.against_id) {
      // give the credit back to the invoice
      const inv = (await client.query('SELECT * FROM documents WHERE id=$1', [d.against_id])).rows[0];
      const credited = round2(Number(inv.amount_credited) - Number(d.total));
      const status = Number(inv.amount_paid) + credited >= Number(inv.total) - 0.01 ? 'paid' : inv.amount_paid > 0 ? 'partial' : 'unpaid';
      await client.query('UPDATE documents SET amount_credited=$1, status=$2, updated_at=now() WHERE id=$3', [credited, status, inv.id]);
    }
    await audit(req.user.id, 'cancel', d.doc_type, d.id, null, client);
  });
  res.json(await loadDoc(d.id));
}));

module.exports = router;
module.exports.recordPayment = recordPayment;
module.exports.loadDoc = loadDoc;

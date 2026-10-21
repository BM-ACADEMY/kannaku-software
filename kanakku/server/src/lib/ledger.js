// One way to write a Book entry, used by the Book screen, invoices, bills, refunds, investors,
// recurring entries and bank import — so every entry gets the same checks (month lock, split, transfer rules).
const { HttpError } = require('./http');
const { allocate } = require('./split');
const { assertOpen, round2 } = require('./books');

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

// e: { entry_date, type, amount, brand_id?, split?, split_preset_id?, category_id?, account_id?, to_account_id?, party?, note?, ref?,
//      gst_amount?, tds_amount?, no_bill?, approval_required?, source?, status?, document_id?, bill_id?, recurring_id?, created_by? }
async function insertEntry(client, e) {
  await assertOpen(e.entry_date, client.query.bind(client));
  const shared = Array.isArray(e.split) && e.split.length > 0;
  const transfer = e.type === 'transfer';
  if (transfer) {
    if (!e.account_id || !e.to_account_id) throw new HttpError(400, 'A transfer needs a "from" and a "to" account');
    if (Number(e.account_id) === Number(e.to_account_id)) throw new HttpError(400, 'From and to account are the same');
  }
  const brandId = transfer || shared ? await commonBrandId(client) : e.brand_id;
  if (!brandId) throw new HttpError(400, 'Pick a brand, or split it across brands');
  const gst = round2(e.gst_amount || 0); const tds = round2(e.tds_amount || 0);
  if (gst < 0 || tds < 0) throw new HttpError(400, 'GST and TDS cannot be negative');
  if (gst > Number(e.amount) + tds) throw new HttpError(400, 'GST cannot be more than the amount');
  const r = await client.query(`INSERT INTO entries (entry_date,brand_id,type,amount,gst_amount,tds_amount,category_id,account_id,to_account_id,
      party,note,ref,split_preset_id,source,status,document_id,bill_id,recurring_id,created_by,no_bill,approval_required)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
  [e.entry_date, brandId, e.type, round2(e.amount), transfer ? 0 : gst, transfer ? 0 : tds, transfer ? null : e.category_id || null,
    e.account_id || null, transfer ? e.to_account_id : null, e.party || null, e.note || null, e.ref || null,
    shared ? e.split_preset_id || null : null, e.source || 'manual', e.status || 'posted', e.document_id || null, e.bill_id || null,
    e.recurring_id || null, e.created_by || null, !transfer && e.type === 'out' && !!e.no_bill, !!e.approval_required]);
  if (shared && !transfer) await writeAllocations(client, r.rows[0].id, e.amount, e.split);
  return r.rows[0].id;
}

async function updateEntry(client, id, e) {
  const cur = (await client.query('SELECT * FROM entries WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
  if (!cur) throw new HttpError(404, 'Entry not found');
  await assertOpen([cur.entry_date, e.entry_date], client.query.bind(client));
  const shared = Array.isArray(e.split) && e.split.length > 0;
  const transfer = e.type === 'transfer';
  if (transfer && (!e.account_id || !e.to_account_id || Number(e.account_id) === Number(e.to_account_id))) throw new HttpError(400, 'A transfer needs two different accounts');
  const brandId = transfer || shared ? await commonBrandId(client) : e.brand_id;
  if (!brandId) throw new HttpError(400, 'Pick a brand, or split it across brands');
  await client.query(`UPDATE entries SET entry_date=$1,brand_id=$2,type=$3,amount=$4,gst_amount=$5,tds_amount=$6,category_id=$7,account_id=$8,
      to_account_id=$9,party=$10,note=$11,ref=$12,split_preset_id=$13,no_bill=$14,
      status=COALESCE($16,status), approval_required=COALESCE($17,approval_required) WHERE id=$15`,
  [e.entry_date, brandId, e.type, round2(e.amount), transfer ? 0 : round2(e.gst_amount || 0), transfer ? 0 : round2(e.tds_amount || 0),
    transfer ? null : e.category_id || null, e.account_id || null, transfer ? e.to_account_id : null, e.party || null, e.note || null,
    e.ref || null, shared ? e.split_preset_id || null : null, !transfer && e.type === 'out' && !!e.no_bill, id, e.status || null,
    e.approval_required === undefined ? null : !!e.approval_required]);
  await writeAllocations(client, id, e.amount, shared && !transfer ? e.split : null);
  return cur;
}

module.exports = { insertEntry, updateEntry, writeAllocations, commonBrandId };

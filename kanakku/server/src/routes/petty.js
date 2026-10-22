// Petty cash: cash box status, top-up from the bank, cash count, settings (float, low level, staff-spend approval).
const router = require('express').Router();
const { z } = require('zod');
const { query, tx } = require('../lib/db');
const { ah, parse, HttpError } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { insertEntry } = require('../lib/ledger');
const { accountBalances, todayIST, round2 } = require('../lib/books');
const petty = require('../lib/petty');
const { notifyAdmins } = require('../lib/notify');

router.get('/', requireRole('admin', 'accounts'), ah(async (_req, res) => res.json(await petty.status())));

router.put('/settings', requireRole('admin'), ah(async (req, res) => {
  const b = parse(z.object({
    account_id: z.coerce.number().int().nullable().optional(),
    collections_account_id: z.coerce.number().int().nullable().optional(),
    float: z.coerce.number().min(0).max(10000000),
    low_at: z.coerce.number().min(0).max(10000000),
    approval: z.object({ on: z.boolean(), above: z.coerce.number().min(0).max(10000000), cash_only: z.boolean() }),
  }), req.body);
  if (b.low_at > b.float) throw new HttpError(400, '"Warn me below" cannot be more than the float');
  if (b.account_id) {
    const a = (await query('SELECT kind FROM accounts WHERE id=$1 AND active', [b.account_id])).rows[0];
    if (!a) throw new HttpError(400, 'Pick an active account');
  }
  if (b.collections_account_id) {
    const a = (await query('SELECT 1 FROM accounts WHERE id=$1 AND active', [b.collections_account_id])).rows[0];
    if (!a) throw new HttpError(400, 'Pick an active account for cash collections');
    const box = b.account_id || (await petty.cashAccount({ account_id: null }))?.id;
    if (Number(b.collections_account_id) === Number(box)) throw new HttpError(400, 'Cash collections and the petty cash box must be two different accounts');
  }
  const cur = await petty.config();
  const next = { ...cur, account_id: b.account_id || null, collections_account_id: b.collections_account_id || null, float: b.float, low_at: b.low_at, approval: b.approval };
  await petty.saveConfig(next);
  await audit(req.user.id, 'update', 'petty_cash_settings', null, { float: b.float, low_at: b.low_at, approval: b.approval });
  res.json(await petty.status());
}));

// Cash taken out of the bank (or any account) and put in the cash box. A transfer — not an expense.
router.post('/topup', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const b = parse(z.object({ amount: z.coerce.number().positive(), from_account_id: z.coerce.number().int(),
    entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), note: z.string().max(300).nullable().optional() }), req.body);
  const cfg = await petty.config(); const acct = await petty.cashAccount(cfg);
  if (!acct) throw new HttpError(400, 'No cash account — add one in Settings → Accounts');
  if (Number(b.from_account_id) === acct.id) throw new HttpError(400, 'Pick the account the cash came from — not the petty cash box itself');
  const id = await tx(async (client) => {
    const newId = await insertEntry(client, { entry_date: b.entry_date || todayIST(), type: 'transfer', amount: b.amount, account_id: b.from_account_id,
      to_account_id: acct.id, note: b.note || 'Cash for petty cash box', source: 'transfer', created_by: req.user.id });
    await audit(req.user.id, 'create', 'entry', newId, { petty_topup: b.amount }, client);
    return newId;
  });
  res.status(201).json({ id, status: await petty.status() });
}));

// End-of-day handover: the day's cash collected (in the "Cash collections" account) moves to the bank or to cash in hand.
router.post('/handover', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const b = parse(z.object({ amount: z.coerce.number().positive(), to_account_id: z.coerce.number().int(),
    entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), note: z.string().max(300).nullable().optional() }), req.body);
  const cfg = await petty.config(); const box = await petty.cashAccount(cfg); const col = await petty.collectionsAccount(cfg, box);
  if (!col) throw new HttpError(400, 'Choose the Cash collections account first (Petty cash → Settings)');
  if (Number(b.to_account_id) === col.id) throw new HttpError(400, 'Pick where the cash is going — not the collections account itself');
  const bal = round2((await accountBalances()).find((a) => a.id === col.id)?.balance || 0);
  if (round2(b.amount) > bal + 0.001) throw new HttpError(400, `Only ₹${bal.toLocaleString('en-IN')} is recorded in ${col.name}. Enter the cash received in Book first, then hand it over.`);
  const id = await tx(async (client) => {
    const newId = await insertEntry(client, { entry_date: b.entry_date || todayIST(), type: 'transfer', amount: b.amount, account_id: col.id,
      to_account_id: b.to_account_id, note: b.note || 'Cash handed over', source: 'transfer', created_by: req.user.id });
    await audit(req.user.id, 'create', 'entry', newId, { cash_handover: b.amount }, client);
    return newId;
  });
  res.status(201).json({ id, status: await petty.status() });
}));

// Count the cash in the box and compare with what the Book says. The result is kept as a record (last 24).
router.post('/count', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const b = parse(z.object({ counted: z.coerce.number().min(0), note: z.string().max(300).nullable().optional() }), req.body);
  const cfg = await petty.config(); const acct = await petty.cashAccount(cfg);
  if (!acct) throw new HttpError(400, 'No cash account — add one in Settings → Accounts');
  const book = round2((await accountBalances()).find((a) => a.id === acct.id)?.balance || 0);
  const row = { date: todayIST(), counted: round2(b.counted), book, diff: round2(b.counted - book), note: b.note || null, by: req.user.name };
  await petty.saveConfig({ ...cfg, counts: [row, ...cfg.counts].slice(0, 24) });
  await audit(req.user.id, 'cash_count', 'petty_cash', acct.id, row);
  if (row.diff !== 0) notifyAdmins('Cash count differs', `${req.user.name} counted ₹${row.counted.toLocaleString('en-IN')} in the cash box; the Book says ₹${book.toLocaleString('en-IN')} (${row.diff < 0 ? 'short' : 'extra'} ₹${Math.abs(row.diff).toLocaleString('en-IN')}).`).catch(() => {});
  res.status(201).json({ count: row, status: await petty.status() });
}));

module.exports = router;

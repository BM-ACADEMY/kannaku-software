// Bank statement import → auto-match → rules. Admin + accounts.
const router = require('express').Router();
const crypto = require('crypto');
const { z } = require('zod');
const { query, tx } = require('../lib/db');
const { ah, parse, HttpError } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { parseStatement, lineHash } = require('../lib/bankcsv');
const { autoReconcile, candidates } = require('../lib/reconcile');
const { insertEntry } = require('../lib/ledger');

router.use(requireRole('admin', 'accounts'));

// Step 1 — read the file and show what will be imported (nothing saved yet)
router.post('/preview', ah(async (req, res) => {
  const b = parse(z.object({ csv: z.string().min(10).max(5_000_000), mapping: z.record(z.any()).nullable().optional() }), req.body);
  const r = parseStatement(b.csv, b.mapping || null);
  if (!r.ok) return res.json(r);
  res.json({ ...r, lines: r.lines.slice(0, 50), total_lines: r.lines.length,
    totals: { debit: r.lines.reduce((s, l) => s + l.debit, 0), credit: r.lines.reduce((s, l) => s + l.credit, 0) },
    from: r.lines[0]?.line_date, to: r.lines[r.lines.length - 1]?.line_date });
}));

// Step 2 — import into an account, skip lines already imported, then auto-match + apply rules
router.post('/import', ah(async (req, res) => {
  const b = parse(z.object({ account_id: z.coerce.number().int(), csv: z.string().min(10).max(5_000_000),
    mapping: z.record(z.any()).nullable().optional() }), req.body);
  const acc = (await query('SELECT id, name FROM accounts WHERE id=$1', [b.account_id])).rows[0];
  if (!acc) throw new HttpError(400, 'Pick the bank account this statement belongs to');
  const r = parseStatement(b.csv, b.mapping || null);
  if (!r.ok) throw new HttpError(400, r.error);
  const importId = crypto.randomBytes(6).toString('hex');
  let added = 0; let dup = 0; const seen = {};
  await tx(async (client) => {
    for (const l of r.lines) {
      const k = `${l.line_date}|${l.description}|${l.debit}|${l.credit}`;
      seen[k] = (seen[k] || 0) + 1;
      const hash = lineHash(acc.id, l, seen[k]);
      const ins = await client.query(`INSERT INTO bank_lines (account_id,line_date,description,ref,debit,credit,balance,hash,import_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (hash) DO NOTHING RETURNING id`,
      [acc.id, l.line_date, l.description, l.ref, l.debit, l.credit, l.balance, hash, importId]);
      if (ins.rows[0]) added++; else dup++;
    }
    await audit(req.user.id, 'bank_import', 'account', acc.id, { added, duplicates: dup, from: r.lines[0]?.line_date, to: r.lines.at(-1)?.line_date }, client);
  });
  const ap = (await query("SELECT value FROM settings WHERE key='autopilot'")).rows[0]?.value || {};
  const auto = await autoReconcile({ importId, allowAutoPost: ap.enabled !== false && ap.jobs?.bank_autopost?.on !== false });
  res.json({ added, duplicates: dup, skipped: r.skipped, ...auto });
}));

router.get('/lines', ah(async (req, res) => {
  const f = parse(z.object({ status: z.enum(['unmatched', 'matched', 'ignored', 'all']).default('unmatched'),
    account_id: z.coerce.number().optional(), q: z.string().optional() }), req.query);
  const where = ['TRUE']; const p = [];
  if (f.status !== 'all') { p.push(f.status); where.push(`bl.status=$${p.length}`); }
  if (f.account_id) { p.push(f.account_id); where.push(`bl.account_id=$${p.length}`); }
  if (f.q) { p.push(`%${f.q}%`); where.push(`bl.description ILIKE $${p.length}`); }
  const { rows } = await query(`SELECT bl.*, a.name AS account_name, e.status AS entry_status, e.party AS entry_party, br.pattern AS rule_pattern
    FROM bank_lines bl JOIN accounts a ON a.id=bl.account_id LEFT JOIN entries e ON e.id=bl.entry_id LEFT JOIN bank_rules br ON br.id=bl.rule_id
    WHERE ${where.join(' AND ')} ORDER BY bl.line_date DESC, bl.id DESC LIMIT 500`, p);
  const counts = (await query("SELECT status, COUNT(*)::int AS n FROM bank_lines GROUP BY status")).rows;
  res.json({ rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) });
}));

// Possible Book entries for one line (for the "link" button)
router.get('/lines/:id/candidates', ah(async (req, res) => {
  const line = (await query('SELECT * FROM bank_lines WHERE id=$1', [req.params.id])).rows[0];
  if (!line) throw new HttpError(404, 'Line not found');
  const ids = (await candidates(line, line.account_id)).map((c) => c.id);
  const { SELECT } = require('./entries');
  const rows = ids.length ? (await query(`${SELECT} WHERE e.id = ANY($1) ORDER BY e.entry_date`, [ids])).rows : [];
  // open invoices / bills with exactly this balance — "this NEFT is probably invoice 0007"
  const amt = Number(line.credit) > 0 ? line.credit : line.debit;
  const docs = (await query(`SELECT d.id, d.number, d.doc_type, c.name AS party, (d.total-d.amount_paid-d.amount_credited) AS balance
    FROM documents d JOIN customers c ON c.id=d.customer_id
    WHERE d.doc_type = $1 AND d.status IN ('unpaid','partial') AND abs((d.total-d.amount_paid-d.amount_credited) - $2) < 0.01
    ORDER BY d.doc_date LIMIT 10`, [Number(line.credit) > 0 ? 'invoice' : 'bill', amt])).rows;
  res.json({ entries: rows, documents: docs });
}));

router.post('/lines/:id/link', ah(async (req, res) => {
  const { entry_id } = parse(z.object({ entry_id: z.coerce.number().int() }), req.body);
  const used = (await query('SELECT id FROM bank_lines WHERE entry_id=$1', [entry_id])).rows[0];
  if (used) throw new HttpError(400, 'That entry is already linked to another bank line');
  await query("UPDATE bank_lines SET status='matched', entry_id=$1 WHERE id=$2", [entry_id, req.params.id]);
  res.json({ ok: true });
}));

// Create a Book entry from the line. remember=true also saves a rule so the next statement does this by itself.
router.post('/lines/:id/create', ah(async (req, res) => {
  const b = parse(z.object({
    brand_id: z.coerce.number().int().nullable().optional(), split_preset_id: z.coerce.number().int().nullable().optional(),
    category_id: z.coerce.number().int().nullable().optional(), party: z.string().max(200).nullable().optional(),
    gst_amount: z.coerce.number().min(0).default(0), note: z.string().max(500).nullable().optional(),
    to_account_id: z.coerce.number().int().nullable().optional(),       // set → it's a transfer between our accounts
    remember: z.boolean().default(false), pattern: z.string().max(80).optional(), auto_post: z.boolean().default(false),
  }), req.body);
  const line = (await query("SELECT * FROM bank_lines WHERE id=$1 AND status='unmatched'", [req.params.id])).rows[0];
  if (!line) throw new HttpError(400, 'Line not found or already handled');
  const isIn = Number(line.credit) > 0;
  const out = await tx(async (client) => {
    let split = null;
    if (b.split_preset_id) split = (await client.query('SELECT rules FROM split_presets WHERE id=$1', [b.split_preset_id])).rows[0]?.rules || null;
    const transfer = !!b.to_account_id;
    const id = await insertEntry(client, {
      entry_date: line.line_date, type: transfer ? 'transfer' : isIn ? 'in' : 'out', amount: isIn ? line.credit : line.debit,
      // money arriving here from another of our accounts: from = other, to = this one
      account_id: transfer && isIn ? b.to_account_id : line.account_id, to_account_id: transfer ? (isIn ? line.account_id : b.to_account_id) : null,
      brand_id: b.brand_id, split, split_preset_id: b.split_preset_id, category_id: b.category_id, party: b.party,
      gst_amount: b.gst_amount, note: b.note || line.description.slice(0, 300), ref: line.ref, source: 'bank', created_by: req.user.id });
    let ruleId = null;
    if (b.remember && b.pattern && !transfer) {
      const r = await client.query(`INSERT INTO bank_rules (pattern,direction,brand_id,split_preset_id,category_id,party,auto_post)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [b.pattern.trim(), isIn ? 'in' : 'out', split ? null : b.brand_id || null,
        b.split_preset_id || null, b.category_id || null, b.party || null, b.auto_post]);
      ruleId = r.rows[0].id;
    }
    await client.query("UPDATE bank_lines SET status='matched', entry_id=$1, rule_id=$2 WHERE id=$3", [id, ruleId, line.id]);
    await audit(req.user.id, 'create', 'entry', id, { from_bank_line: line.id, rule: ruleId }, client);
    return { entry_id: id, rule_id: ruleId };
  });
  // a new rule may clear other waiting lines straight away
  const more = out.rule_id ? await autoReconcile({ allowAutoPost: true }) : null;
  res.json({ ...out, more });
}));

router.post('/lines/:id/ignore', ah(async (req, res) => {
  await query("UPDATE bank_lines SET status=CASE WHEN status='ignored' THEN 'unmatched' ELSE 'ignored' END WHERE id=$1 AND status<>'matched'", [req.params.id]);
  res.json({ ok: true });
}));
router.post('/lines/:id/unlink', ah(async (req, res) => {
  await query("UPDATE bank_lines SET status='unmatched', entry_id=NULL, rule_id=NULL WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
}));
router.post('/reconcile', ah(async (_req, res) => res.json(await autoReconcile({ allowAutoPost: true }))));

// Rules
const ruleSchema = z.object({ pattern: z.string().trim().min(2).max(80), direction: z.enum(['any', 'in', 'out']).default('any'),
  brand_id: z.coerce.number().int().nullable().optional(), split_preset_id: z.coerce.number().int().nullable().optional(),
  category_id: z.coerce.number().int().nullable().optional(), party: z.string().max(200).nullable().optional(),
  auto_post: z.boolean().default(false), active: z.boolean().default(true) });
router.get('/rules', ah(async (_req, res) => {
  const { rows } = await query(`SELECT r.*, b.name AS brand_name, sp.name AS preset_name, c.name AS category_name FROM bank_rules r
    LEFT JOIN brands b ON b.id=r.brand_id LEFT JOIN split_presets sp ON sp.id=r.split_preset_id LEFT JOIN categories c ON c.id=r.category_id
    ORDER BY r.active DESC, r.hits DESC, r.pattern`);
  res.json(rows);
}));
router.post('/rules', ah(async (req, res) => {
  const r = parse(ruleSchema, req.body);
  if (!r.brand_id && !r.split_preset_id) throw new HttpError(400, 'A rule needs a brand or a split rule');
  const { rows } = await query(`INSERT INTO bank_rules (pattern,direction,brand_id,split_preset_id,category_id,party,auto_post,active)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [r.pattern, r.direction, r.split_preset_id ? null : r.brand_id || null, r.split_preset_id || null,
    r.category_id || null, r.party || null, r.auto_post, r.active]);
  res.status(201).json(rows[0]);
}));
router.put('/rules/:id', ah(async (req, res) => {
  const r = parse(ruleSchema, req.body);
  const { rows } = await query(`UPDATE bank_rules SET pattern=$1,direction=$2,brand_id=$3,split_preset_id=$4,category_id=$5,party=$6,auto_post=$7,active=$8
    WHERE id=$9 RETURNING *`, [r.pattern, r.direction, r.split_preset_id ? null : r.brand_id || null, r.split_preset_id || null, r.category_id || null,
    r.party || null, r.auto_post, r.active, req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Rule not found');
  res.json(rows[0]);
}));
router.delete('/rules/:id', ah(async (req, res) => {
  await query('UPDATE bank_lines SET rule_id=NULL WHERE rule_id=$1', [req.params.id]);
  await query('DELETE FROM bank_rules WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;

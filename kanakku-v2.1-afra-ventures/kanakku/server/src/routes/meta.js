// Brands, categories, accounts, company settings, users
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { query } = require('../lib/db');
const { ah, parse, HttpError } = require('../lib/http');
const { requireRole, forgetUser } = require('../middleware/auth');
const { accountBalances, clearLockCache } = require('../lib/books');
const { sendEmail } = require('../lib/notify');
const { audit } = require('../lib/audit');
const { normaliseRules } = require('../lib/split');
const integrations = require('../lib/integrations');
const razorpay = require('../lib/razorpay');
const { grokChat } = require('../lib/ai');

router.get('/bootstrap', ah(async (_req, res) => {
  const [brands, categories, accounts, company, presets, bookCfg] = await Promise.all([
    query('SELECT * FROM brands ORDER BY sort_order, name'),
    query('SELECT * FROM categories WHERE active ORDER BY kind, name'),
    query('SELECT * FROM accounts WHERE active ORDER BY id'),
    query("SELECT value FROM settings WHERE key='company'"),
    query('SELECT * FROM split_presets WHERE active ORDER BY name'),
    query("SELECT value FROM settings WHERE key='books'"),
  ]);
  res.json({ brands: brands.rows, categories: categories.rows, accounts: accounts.rows, company: company.rows[0]?.value || {}, presets: presets.rows,
    books: bookCfg.rows[0]?.value || {} });
}));

const brandSchema = z.object({
  code: z.string().min(1).max(6).transform((s) => s.toUpperCase()),
  name: z.string().min(1),
  color: z.string().default('#1B2A4A'),
  in_investor_pool: z.boolean().default(false),
  active: z.boolean().default(true),
  sort_order: z.number().int().default(0),
});
router.post('/brands', requireRole('admin'), ah(async (req, res) => {
  const b = parse(brandSchema, req.body);
  const { rows } = await query(`INSERT INTO brands (code,name,color,in_investor_pool,active,sort_order)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [b.code, b.name, b.color, b.in_investor_pool, b.active, b.sort_order]);
  await audit(req.user.id, 'create', 'brand', rows[0].id, b);
  res.status(201).json(rows[0]);
}));
router.put('/brands/:id', requireRole('admin'), ah(async (req, res) => {
  const b = parse(brandSchema, req.body);
  const { rows } = await query(`UPDATE brands SET code=$1,name=$2,color=$3,in_investor_pool=$4,active=$5,sort_order=$6
    WHERE id=$7 RETURNING *`, [b.code, b.name, b.color, b.in_investor_pool, b.active, b.sort_order, req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Brand not found');
  await audit(req.user.id, 'update', 'brand', rows[0].id, b);
  res.json(rows[0]);
}));

router.post('/categories', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const c = parse(z.object({ name: z.string().min(1), kind: z.enum(['in', 'out']) }), req.body);
  const { rows } = await query(`INSERT INTO categories (name,kind) VALUES ($1,$2)
    ON CONFLICT (name,kind) DO UPDATE SET active=TRUE RETURNING *`, [c.name, c.kind]);
  res.status(201).json(rows[0]);
}));

// Category → suggested split preset (e.g. EB → Office overheads)
router.put('/categories/:id', requireRole('admin'), ah(async (req, res) => {
  const c = parse(z.object({ name: z.string().min(1), default_preset_id: z.coerce.number().int().nullable().optional(), active: z.boolean().default(true) }), req.body);
  const { rows } = await query('UPDATE categories SET name=$1, default_preset_id=$2, active=$3 WHERE id=$4 RETURNING *',
    [c.name, c.default_preset_id || null, c.active, req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Category not found');
  res.json(rows[0]);
}));

// Shared-cost split presets
const presetSchema = z.object({ name: z.string().min(1), rules: z.array(z.object({ brand_id: z.coerce.number(), pct: z.coerce.number() })), active: z.boolean().default(true) });
router.post('/presets', requireRole('admin'), ah(async (req, res) => {
  const p = parse(presetSchema, req.body);
  const rules = normaliseRules(p.rules);
  const { rows } = await query('INSERT INTO split_presets (name,rules,active) VALUES ($1,$2,$3) RETURNING *', [p.name, JSON.stringify(rules), p.active]);
  await audit(req.user.id, 'create', 'split_preset', rows[0].id, p);
  res.status(201).json(rows[0]);
}));
router.put('/presets/:id', requireRole('admin'), ah(async (req, res) => {
  const p = parse(presetSchema, req.body);
  const rules = normaliseRules(p.rules);
  const { rows } = await query('UPDATE split_presets SET name=$1, rules=$2, active=$3 WHERE id=$4 RETURNING *', [p.name, JSON.stringify(rules), p.active, req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Preset not found');
  await audit(req.user.id, 'update', 'split_preset', rows[0].id, p);
  res.json(rows[0]);
}));

// Payment accounts — where money sits (cash box, bank, UPI, gateway). Bootstrap only lists active ones.
// Opening balance = what the account held on opening_date (e.g. 12 Sep 2026, the day Afra was incorporated)
const accountSchema = z.object({ name: z.string().trim().min(1), kind: z.enum(['cash', 'bank', 'upi', 'gateway']), active: z.boolean().default(true),
  opening_balance: z.coerce.number().default(0), opening_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-09-12') });
router.get('/accounts', requireRole('admin', 'accounts'), ah(async (_req, res) => {
  const bal = await accountBalances();
  const { rows } = await query(`SELECT a.id, (SELECT COUNT(*)::int FROM entries e WHERE (e.account_id=a.id OR e.to_account_id=a.id) AND e.deleted_at IS NULL) AS entry_count
    FROM accounts a`);
  const counts = Object.fromEntries(rows.map((r) => [r.id, r.entry_count]));
  res.json(bal.map((b) => ({ ...b, entry_count: counts[b.id] || 0 })));
}));
router.post('/accounts', requireRole('admin'), ah(async (req, res) => {
  const a = parse(accountSchema, req.body);
  const { rows } = await query('INSERT INTO accounts (name,kind,active,opening_balance,opening_date) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [a.name, a.kind, a.active, a.opening_balance, a.opening_date]);
  await audit(req.user.id, 'create', 'account', rows[0].id, a);
  res.status(201).json(rows[0]);
}));
router.put('/accounts/:id', requireRole('admin'), ah(async (req, res) => {
  const a = parse(accountSchema, req.body);
  const { rows } = await query('UPDATE accounts SET name=$1,kind=$2,active=$3,opening_balance=$4,opening_date=$5 WHERE id=$6 RETURNING *',
    [a.name, a.kind, a.active, a.opening_balance, a.opening_date, req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Account not found');
  await audit(req.user.id, 'update', 'account', rows[0].id, a);
  res.json(rows[0]);
}));

// Integrations — AI / Razorpay / WhatsApp keys. Secrets are never sent back, only masked.
router.get('/integrations', requireRole('admin'), ah(async (_req, res) => {
  const last = (await query(`SELECT entry_date, amount, ref, created_at FROM entries WHERE source='razorpay' AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1`)).rows[0] || null;
  res.json({ ...(await integrations.publicView()), app_url: process.env.APP_URL || '', api_url: process.env.API_URL || '', razorpay_last: last, razorpay_sync: await razorpay.syncState() });
}));
router.post('/integrations/razorpay/sync', requireRole('admin'), ah(async (_req, res) => {
  try {
    res.json({ ok: true, ...(await razorpay.syncPayments()) });
  } catch (err) {
    res.json({ ok: false, message: err.message.slice(0, 300) });
  }
}));
router.put('/integrations/:group', requireRole('admin'), ah(async (req, res) => {
  const fields = integrations.FIELDS[req.params.group];
  if (!fields) throw new HttpError(404, 'Unknown integration');
  const patch = parse(z.object(Object.fromEntries(Object.keys(fields).map((k) => [k, z.string().max(2000).optional()]))), req.body);
  const changed = await integrations.saveGroup(req.params.group, patch);
  await audit(req.user.id, 'update', 'integration', null, { name: req.params.group, fields: changed }); // names only, never values
  res.json(await integrations.publicView());
}));
router.post('/integrations/:group/test', requireRole('admin'), ah(async (req, res) => {
  const cfg = await integrations.getConfig();
  const started = Date.now();
  try {
    if (req.params.group === 'ai') {
      if (!cfg.ai.api_key) throw new Error('No API key saved');
      const reply = await grokChat([{ role: 'user', content: 'Reply with just: OK' }], { maxTokens: 20 });
      return res.json({ ok: true, message: `${cfg.ai.model} replied "${String(reply).trim().slice(0, 40)}" in ${Date.now() - started} ms` });
    }
    if (req.params.group === 'whatsapp') {
      if (!cfg.whatsapp.phone_number_id || !cfg.whatsapp.token) throw new Error('Phone number ID and token are both needed');
      const r = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.whatsapp.phone_number_id)}?fields=display_phone_number,verified_name,quality_rating`,
        { headers: { authorization: `Bearer ${cfg.whatsapp.token}` }, signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error?.message || `Meta returned ${r.status}`);
      return res.json({ ok: true, message: `Connected: ${j.verified_name || 'number'} ${j.display_phone_number || ''}${j.quality_rating ? ` · quality ${j.quality_rating}` : ''}` });
    }
    if (req.params.group === 'razorpay') {
      const r = cfg.razorpay;
      if (r.key_id && r.key_secret) {
        const mode = await razorpay.checkKeys(r);
        return res.json({ ok: true, message: `Keys work (${mode} mode).${r.webhook_secret ? ' Webhook secret also saved.' : ' Payments sync every 5 minutes.'}` });
      }
      if (!r.webhook_secret) throw new Error('Save the Key ID + Key Secret (or a webhook secret) first');
      return res.json({ ok: true, message: 'Webhook secret saved. Razorpay checks it on every webhook — make a ₹1 test-mode payment to confirm.' });
    }
    if (req.params.group === 'email') {
      if (!cfg.email.host || !cfg.email.user || !cfg.email.pass) throw new Error('Server, username and password are all needed');
      const r = await sendEmail(req.user.email, 'Kanakku test email', 'Email from Kanakku is working. Password reset links and alerts will arrive like this.');
      if (!r.ok) throw new Error(r.error);
      return res.json({ ok: true, message: `Test email sent to ${req.user.email}` });
    }
    throw new HttpError(404, 'Unknown integration');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    res.json({ ok: false, message: err.message.slice(0, 300) });
  }
}));

// Activity log — newest first, paged by id cursor (?before=<id>)
router.get('/audit', requireRole('admin'), ah(async (req, res) => {
  const f = parse(z.object({
    entity: z.string().optional(), user_id: z.coerce.number().int().optional(),
    before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
  }), req.query);
  const where = []; const params = [];
  if (f.entity) { params.push(f.entity); where.push(`l.entity=$${params.length}`); }
  if (f.user_id) { params.push(f.user_id); where.push(`l.user_id=$${params.length}`); }
  if (f.before) { params.push(f.before); where.push(`l.id<$${params.length}`); }
  params.push(f.limit + 1);
  const { rows } = await query(`SELECT l.id, l.action, l.entity, l.entity_id, l.detail, l.created_at, u.name AS user_name, u.role AS user_role
    FROM audit_log l LEFT JOIN users u ON u.id=l.user_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.id DESC LIMIT $${params.length}`, params);
  const more = rows.length > f.limit;
  const page = more ? rows.slice(0, f.limit) : rows;
  res.json({ rows: page, next: more ? page[page.length - 1].id : null });
}));

router.put('/settings/company', requireRole('admin'), ah(async (req, res) => {
  const value = parse(z.record(z.any()), req.body);
  await query(`INSERT INTO settings (key,value) VALUES ('company',$1)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(value)]);
  await audit(req.user.id, 'update', 'settings', null, { key: 'company' });
  res.json(value);
}));

// Users (admin only)
router.get('/users', requireRole('admin'), ah(async (_req, res) => {
  const { rows } = await query(`SELECT u.id,u.name,u.email,u.phone,u.role,u.active,u.created_at,u.totp_enabled,u.investor_id,i.name AS investor_name
    FROM users u LEFT JOIN investors i ON i.id=u.investor_id ORDER BY u.id`);
  res.json(rows);
}));
const ROLES = ['admin', 'accounts', 'sales', 'investor'];
async function checkInvestorLink(role, investorId) {
  if (role !== 'investor') return null;
  if (!investorId) throw new HttpError(400, 'Pick which investor this login is for');
  const i = (await query('SELECT id FROM investors WHERE id=$1', [investorId])).rows[0];
  if (!i) throw new HttpError(400, 'Investor not found');
  return i.id;
}
router.post('/users', requireRole('admin'), ah(async (req, res) => {
  const u = parse(z.object({
    name: z.string().min(1), email: z.string().email(), phone: z.string().optional().nullable(),
    role: z.enum(ROLES), password: z.string().min(8), investor_id: z.coerce.number().int().nullable().optional(),
  }), req.body);
  const investorId = await checkInvestorLink(u.role, u.investor_id);
  const { rows } = await query(`INSERT INTO users (name,email,phone,role,password_hash,investor_id) VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING id,name,email,phone,role,active,investor_id`, [u.name, u.email.toLowerCase(), u.phone || null, u.role, await bcrypt.hash(u.password, 10), investorId]);
  await audit(req.user.id, 'create', 'user', rows[0].id, { email: u.email, role: u.role });
  res.status(201).json(rows[0]);
}));
router.put('/users/:id', requireRole('admin'), ah(async (req, res) => {
  const u = parse(z.object({
    name: z.string().min(1), phone: z.string().optional().nullable(),
    role: z.enum(ROLES), active: z.boolean(), password: z.string().min(8).optional(),
    investor_id: z.coerce.number().int().nullable().optional(), reset_2fa: z.boolean().optional(),
  }), req.body);
  if (Number(req.params.id) === req.user.id && (!u.active || u.role !== 'admin')) throw new HttpError(400, 'You cannot remove your own admin access');
  const investorId = await checkInvestorLink(u.role, u.investor_id);
  const before = (await query('SELECT active, role FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!before) throw new HttpError(404, 'User not found');
  // Deactivating, changing role or setting a password logs the person out on every device
  const bump = !u.active || u.role !== before.role || !!u.password || !!u.reset_2fa;
  const { rows } = await query(`UPDATE users SET name=$1,phone=$2,role=$3,active=$4,investor_id=$5,token_version=token_version+$6 WHERE id=$7
    RETURNING id,name,email,phone,role,active,investor_id,totp_enabled`, [u.name, u.phone || null, u.role, u.active, investorId, bump ? 1 : 0, req.params.id]);
  if (u.password) await query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(u.password, 10), req.params.id]);
  if (u.reset_2fa) await query('UPDATE users SET totp_enabled=FALSE, totp_secret=NULL WHERE id=$1', [req.params.id]);
  forgetUser(req.params.id);
  await audit(req.user.id, 'update', 'user', rows[0].id, { role: u.role, active: u.active, ...(u.password ? { password_reset: true } : {}), ...(u.reset_2fa ? { reset_2fa: true } : {}) });
  res.json(rows[0]);
}));

// ── Books: month lock + security rules ──
router.get('/settings/books', requireRole('admin', 'accounts'), ah(async (_req, res) => {
  res.json((await query("SELECT value FROM settings WHERE key='books'")).rows[0]?.value || {});
}));
router.put('/settings/books', requireRole('admin'), ah(async (req, res) => {
  const b = parse(z.object({
    lock_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    autolock_day: z.coerce.number().int().min(0).max(28).default(10),  // 0 = never lock automatically
    require_admin_2fa: z.boolean().default(false),
  }), req.body);
  const cur = (await query("SELECT value FROM settings WHERE key='books'")).rows[0]?.value || {};
  await query(`INSERT INTO settings (key,value) VALUES ('books',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify({ ...cur, ...b })]);
  clearLockCache();
  if ((cur.lock_until || null) !== b.lock_until) await audit(req.user.id, b.lock_until && (!cur.lock_until || b.lock_until > cur.lock_until) ? 'close_books' : 'reopen_books', 'settings', null, { from: cur.lock_until, to: b.lock_until });
  res.json({ ...cur, ...b });
}));

module.exports = router;

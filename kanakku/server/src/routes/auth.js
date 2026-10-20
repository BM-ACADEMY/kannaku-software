// Login (with optional 2-step code), forgot / reset password, 2-step setup, log out everywhere.
const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { query } = require('../lib/db');
const { ah, parse, HttpError } = require('../lib/http');
const { requireAuth, forgetUser } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const totp = require('../lib/totp');
const { encrypt, decrypt } = require('../lib/secrets');
const { sendEmail } = require('../lib/notify');

const sign = (u) => jwt.sign({ id: u.id, name: u.name, email: u.email, role: u.role, tv: u.token_version || 0 },
  process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, investor_id: u.investor_id || null, totp_enabled: !!u.totp_enabled });

async function books() {
  return (await query("SELECT value FROM settings WHERE key='books'")).rows[0]?.value || {};
}

router.post('/login', ah(async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
  const { rows } = await query('SELECT * FROM users WHERE lower(email)=lower($1) AND active', [email]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new HttpError(401, 'Wrong email or password');
  if (u.totp_enabled) {
    // Half-way token, only good for /login/otp for 5 minutes
    const pending = jwt.sign({ id: u.id, purpose: 'otp' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    return res.json({ need_otp: true, pending });
  }
  const mustSetup = u.role === 'admin' && (await books()).require_admin_2fa;
  res.json({ token: sign(u), user: publicUser(u), must_setup_2fa: !!mustSetup });
}));

router.post('/login/otp', ah(async (req, res) => {
  const { pending, code } = parse(z.object({ pending: z.string(), code: z.string() }), req.body);
  let p;
  try { p = jwt.verify(pending, process.env.JWT_SECRET); } catch { throw new HttpError(401, 'Took too long — log in again'); }
  if (p.purpose !== 'otp') throw new HttpError(401, 'Log in again');
  const u = (await query('SELECT * FROM users WHERE id=$1 AND active', [p.id])).rows[0];
  if (!u || !u.totp_enabled || !totp.verify(decrypt(u.totp_secret), code)) throw new HttpError(401, 'Wrong code — check the time on your phone and try the newest code');
  res.json({ token: sign(u), user: publicUser(u) });
}));

router.get('/me', requireAuth, ah(async (req, res) => {
  const u = (await query('SELECT * FROM users WHERE id=$1', [req.user.id])).rows[0];
  const mustSetup = u.role === 'admin' && !u.totp_enabled && (await books()).require_admin_2fa;
  res.json({ user: publicUser(u), must_setup_2fa: !!mustSetup });
}));

router.post('/change-password', requireAuth, ah(async (req, res) => {
  const { current, next } = parse(z.object({ current: z.string(), next: z.string().min(8) }), req.body);
  const { rows } = await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(current, rows[0].password_hash))) throw new HttpError(400, 'Current password is wrong');
  const u = (await query('UPDATE users SET password_hash=$1, token_version=token_version+1 WHERE id=$2 RETURNING *',
    [await bcrypt.hash(next, 10), req.user.id])).rows[0];
  forgetUser(req.user.id);
  await audit(req.user.id, 'change_password', 'user', req.user.id);
  res.json({ ok: true, token: sign(u) }); // other devices are logged out; this one gets a fresh token
}));

// ── Forgot password: emails a one-time link valid for 30 minutes ──
router.post('/forgot', ah(async (req, res) => {
  const { email } = parse(z.object({ email: z.string().email() }), req.body);
  const u = (await query('SELECT id, name, email FROM users WHERE lower(email)=lower($1) AND active', [email])).rows[0];
  // Same answer whether or not the email exists, so nobody can probe for accounts
  const answer = { ok: true, message: 'If that email has an account, a reset link is on its way. Check spam too.' };
  if (!u) return res.json(answer);
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await query('DELETE FROM password_resets WHERE user_id=$1 OR expires_at < now()', [u.id]);
  await query("INSERT INTO password_resets (token_hash,user_id,expires_at) VALUES ($1,$2,now() + interval '30 minutes')", [hash, u.id]);
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const link = `${base}/reset?token=${raw}`;
  const sent = await sendEmail(u.email, 'Reset your Kanakku password',
    `Hi ${u.name.split(' ')[0]},\n\nOpen this link to set a new Kanakku password (valid for 30 minutes):\n${link}\n\nIf you didn't ask for this, ignore this email — your password stays the same.\n\n— Kanakku, Afra Ventures`);
  if (!sent.ok) {
    console.error('[forgot] email not sent:', sent.error);
    return res.json({ ok: false, message: 'Email is not set up yet, so a reset link could not be sent. Ask your admin to reset your password in Settings → Team.' });
  }
  await audit(u.id, 'forgot_password', 'user', u.id);
  res.json(answer);
}));

router.post('/reset', ah(async (req, res) => {
  const { token, password } = parse(z.object({ token: z.string().min(20), password: z.string().min(8) }), req.body);
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const r = (await query('SELECT * FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()', [hash])).rows[0];
  if (!r) throw new HttpError(400, 'This link has expired or was already used. Ask for a new one.');
  await query('UPDATE password_resets SET used_at=now() WHERE token_hash=$1', [hash]);
  await query('UPDATE users SET password_hash=$1, token_version=token_version+1 WHERE id=$2', [await bcrypt.hash(password, 10), r.user_id]);
  forgetUser(r.user_id);
  await audit(r.user_id, 'reset_password', 'user', r.user_id);
  res.json({ ok: true });
}));

// ── 2-step login setup (any user can turn it on for themselves) ──
router.post('/2fa/setup', requireAuth, ah(async (req, res) => {
  const secret = totp.newSecret();
  await query('UPDATE users SET totp_secret=$1 WHERE id=$2 AND NOT totp_enabled', [encrypt(secret), req.user.id]);
  const u = (await query('SELECT totp_enabled FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (u.totp_enabled) throw new HttpError(400, '2-step login is already on. Turn it off first to set up a new phone.');
  let qr = null;
  try { qr = await require('qrcode').toDataURL(totp.otpauthUrl(secret, req.user.email), { margin: 1, width: 220 }); } catch { /* manual key still works */ }
  res.json({ secret, otpauth: totp.otpauthUrl(secret, req.user.email), qr });
}));

router.post('/2fa/enable', requireAuth, ah(async (req, res) => {
  const { code } = parse(z.object({ code: z.string() }), req.body);
  const u = (await query('SELECT totp_secret FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (!u?.totp_secret || !totp.verify(decrypt(u.totp_secret), code)) throw new HttpError(400, 'That code is not right — type the 6 digits showing now in the app');
  await query('UPDATE users SET totp_enabled=TRUE WHERE id=$1', [req.user.id]);
  await audit(req.user.id, 'enable_2fa', 'user', req.user.id);
  res.json({ ok: true });
}));

router.post('/2fa/disable', requireAuth, ah(async (req, res) => {
  const { password } = parse(z.object({ password: z.string() }), req.body);
  const u = (await query('SELECT * FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (!(await bcrypt.compare(password, u.password_hash))) throw new HttpError(400, 'Password is wrong');
  if (u.role === 'admin' && (await books()).require_admin_2fa) throw new HttpError(400, '2-step login is required for admins (Settings → Books)');
  await query('UPDATE users SET totp_enabled=FALSE, totp_secret=NULL WHERE id=$1', [u.id]);
  await audit(u.id, 'disable_2fa', 'user', u.id);
  res.json({ ok: true });
}));

// Log out on every device (e.g. a phone was lost)
router.post('/logout-all', requireAuth, ah(async (req, res) => {
  await query('UPDATE users SET token_version=token_version+1 WHERE id=$1', [req.user.id]);
  forgetUser(req.user.id);
  res.json({ ok: true });
}));

module.exports = router;

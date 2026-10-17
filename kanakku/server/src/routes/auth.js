const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { query } = require('../lib/db');
const { ah, parse, HttpError } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { audit } = require('../lib/audit');

const sign = (u) => jwt.sign({ id: u.id, name: u.name, email: u.email, role: u.role },
  process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

router.post('/login', ah(async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
  const { rows } = await query('SELECT * FROM users WHERE lower(email)=lower($1) AND active', [email]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new HttpError(401, 'Wrong email or password');
  res.json({ token: sign(u), user: { id: u.id, name: u.name, email: u.email, role: u.role } });
}));

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

router.post('/change-password', requireAuth, ah(async (req, res) => {
  const { current, next } = parse(z.object({ current: z.string(), next: z.string().min(8) }), req.body);
  const { rows } = await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(current, rows[0].password_hash))) throw new HttpError(400, 'Current password is wrong');
  await query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(next, 10), req.user.id]);
  await audit(req.user.id, 'change_password', 'user', req.user.id);
  res.json({ ok: true });
}));

module.exports = router;

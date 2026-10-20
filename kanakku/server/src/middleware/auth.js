const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { HttpError } = require('../lib/http');
const { query } = require('../lib/db');

// Users are re-checked against the database (cached 30 s): a deactivated user, a changed role,
// or "log out everywhere" (token_version bump) takes effect right away instead of when the token expires.
const cache = new Map();
async function currentUser(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 30000) return hit.user;
  const u = (await query('SELECT id, name, email, role, active, token_version, investor_id FROM users WHERE id=$1', [id])).rows[0] || null;
  cache.set(id, { at: Date.now(), user: u });
  return u;
}
const forgetUser = (id) => cache.delete(Number(id));

async function requireAuth(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Login required'));
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return next(new HttpError(401, 'Session expired, please log in again'));
  }
  if (payload.purpose) return next(new HttpError(401, 'Finish logging in first')); // 2-step half-token
  try {
    const u = await currentUser(payload.id);
    if (!u || !u.active || (u.token_version || 0) !== (payload.tv || 0)) return next(new HttpError(401, 'Session ended, please log in again'));
    req.user = { id: u.id, name: u.name, email: u.email, role: u.role, investor_id: u.investor_id };
    next();
  } catch (err) { next(err); }
}

// requireRole('admin','accounts')
const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user?.role) ? next() : next(new HttpError(403, 'You do not have access to this'));

// For n8n / server-to-server calls
// n8n reaches /api/internal over the public URL, so the key is the only guard:
// refuse placeholder/short keys and compare in constant time.
function requireInternalKey(req, _res, next) {
  const key = process.env.INTERNAL_API_KEY || '';
  const got = String(req.headers['x-internal-key'] || '');
  const ok = key.length >= 24 && !key.startsWith('CHANGE_ME') && got.length === key.length
    && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key));
  if (!ok) return next(new HttpError(401, 'Bad internal key'));
  next();
}

module.exports = { requireAuth, requireRole, requireInternalKey, forgetUser };

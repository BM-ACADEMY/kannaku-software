const jwt = require('jsonwebtoken');
const { HttpError } = require('../lib/http');

function requireAuth(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Login required'));
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new HttpError(401, 'Session expired, please log in again'));
  }
}

// requireRole('admin','accounts')
const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user?.role) ? next() : next(new HttpError(403, 'You do not have access to this'));

// For n8n / server-to-server calls
function requireInternalKey(req, _res, next) {
  const key = process.env.INTERNAL_API_KEY;
  if (!key || req.headers['x-internal-key'] !== key) return next(new HttpError(401, 'Bad internal key'));
  next();
}

module.exports = { requireAuth, requireRole, requireInternalKey };

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireInternalKey } = require('./middleware/auth');
const { HttpError } = require('./lib/http');
const { pool } = require('./lib/db');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.startsWith('CHANGE_ME')) {
  console.error('Set a real JWT_SECRET in .env'); process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: (process.env.CORS_ORIGIN || '').split(',').filter(Boolean).length ? process.env.CORS_ORIGIN.split(',') : true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Webhooks need the raw body for signature checks — mount before express.json()
app.use('/api/webhooks', require('./routes/webhooks'));
// Bigger bodies only where needed: bank statements (CSV text) and bill photos (base64)
app.use(['/api/attachments', '/api/bank'], express.json({ limit: '12mb' }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, app: 'kanakku', company: 'Afra Ventures' }); }
  catch { res.status(503).json({ ok: false }); }
});

// Brute-force guard on password checks only — /auth/me runs on every page load and must not count
const passwordLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
app.use(['/api/auth/login', '/api/auth/login/otp', '/api/auth/change-password', '/api/auth/2fa/disable'], passwordLimit);
// Forgot / reset: stricter — stops anyone flooding inboxes or guessing links
app.use(['/api/auth/forgot', '/api/auth/reset'], rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/internal', requireInternalKey, require('./routes/internal'));
// Investor logins see only their own statement (+ brand names) — everything else is staff-only
app.use('/api', requireAuth, (req, _res, next) => {
  if (req.user.role !== 'investor' || req.path === '/bootstrap' || req.path.startsWith('/portal/')) return next();
  next(new HttpError(403, 'You do not have access to this'));
});
app.use('/api/portal', requireAuth, require('./routes/portal'));
app.use('/api/bank', requireAuth, require('./routes/bank'));
app.use('/api/recurring', requireAuth, require('./routes/recurring'));
app.use('/api/attachments', requireAuth, require('./routes/attachments'));
app.use('/api/autopilot', requireAuth, require('./routes/autopilot'));
app.use('/api', requireAuth, require('./routes/meta'));
app.use('/api/entries', requireAuth, require('./routes/entries'));
app.use('/api/deals', requireAuth, require('./routes/deals'));
app.use('/api/dues', requireAuth, require('./routes/dues'));
app.use('/api/investors', requireAuth, require('./routes/investors'));
app.use('/api/reports', requireAuth, require('./routes/reports'));
app.use('/api/ai', requireAuth, require('./routes/ai'));

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

// Optional: serve the built React app (web/dist) from the same process
const dist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.code === '23505') return res.status(409).json({ error: 'Already exists', detail: err.detail });
  if (err.code === '23503') return res.status(400).json({ error: 'Linked record not found', detail: err.detail });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message, details: err.details });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`Kanakku API on :${port}`));
require('./lib/razorpay').startAutoSync(); // pulls Razorpay payments every 5 min when Key ID + Secret are saved
require('./lib/autopilot').start();         // daily jobs: recurring, reminders, briefs, statements, month close, alerts
require('./lib/integrations').reencryptAll().then((n) => n && console.log(`[secrets] re-saved ${n} key(s) with INTEGRATIONS_KEY`)).catch(() => {});
if (!process.env.INTEGRATIONS_KEY) console.warn('[secrets] INTEGRATIONS_KEY is not set — saved keys are tied to JWT_SECRET. Run ./kanakku.sh update to add one.');

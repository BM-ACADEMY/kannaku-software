// Google Calendar feed: a private link (secret token in the URL) that calendar apps subscribe to.
//   GET  /api/calendar/feed/<token>.ics        — no login (calendar apps can't log in); token is the key
//   GET  /api/calendar/settings                — admin: the link + what it includes
//   POST /api/calendar/settings                — admin: turn on/off, choose what to include, make a new link (old one stops)
const router = require('express').Router();
const crypto = require('crypto');
const { z } = require('zod');
const { query } = require('../lib/db');
const { ah, parse, HttpError } = require('../lib/http');
const { requireAuth, requireRole } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { upcoming, addDays } = require('../lib/upcoming');
const { buildIcs } = require('../lib/ics');
const { todayIST } = require('../lib/books');

const DEFAULTS = { enabled: false, token: null, include_in: true, days_ahead: 120 };
async function cfg() { return { ...DEFAULTS, ...((await query("SELECT value FROM settings WHERE key='calendar'")).rows[0]?.value || {}) }; }
async function save(v) { await query(`INSERT INTO settings (key,value) VALUES ('calendar',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(v)]); }
const feedUrl = (req, token) => `${(process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')}/api/calendar/feed/${token}.ics`;

router.get('/feed/:file', ah(async (req, res) => {
  const c = await cfg();
  const token = String(req.params.file).replace(/\.ics$/, '');
  const ok = c.enabled && c.token && token.length === c.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(c.token));
  if (!ok) throw new HttpError(404, 'Not found');
  const today = todayIST();
  let items = await upcoming({ from: addDays(today, -30), to: addDays(today, Number(c.days_ahead) || 120) });
  if (!c.include_in) items = items.filter((i) => i.direction === 'out');
  const co = (await query("SELECT value FROM settings WHERE key='company'")).rows[0]?.value || {};
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="kanakku.ics"');
  res.setHeader('Cache-Control', 'private, max-age=900');
  res.end(buildIcs(items, { name: `Kanakku · ${co.short_name || 'Afra Ventures'}`, domain: co.website || 'afraventures.in', appUrl: process.env.APP_URL || '' }));
}));

router.get('/settings', requireAuth, requireRole('admin'), ah(async (req, res) => {
  const c = await cfg();
  res.json({ enabled: c.enabled, include_in: c.include_in, days_ahead: c.days_ahead, url: c.enabled && c.token ? feedUrl(req, c.token) : null });
}));

router.post('/settings', requireAuth, requireRole('admin'), ah(async (req, res) => {
  const b = parse(z.object({ enabled: z.boolean(), include_in: z.boolean().default(true), days_ahead: z.coerce.number().int().min(30).max(365).default(120),
    new_link: z.boolean().default(false) }), req.body);
  const c = await cfg();
  const token = b.new_link || !c.token ? crypto.randomBytes(24).toString('hex') : c.token;
  await save({ enabled: b.enabled, include_in: b.include_in, days_ahead: b.days_ahead, token });
  await audit(req.user.id, b.new_link ? 'new_calendar_link' : 'update', 'settings', null, { key: 'calendar', enabled: b.enabled });
  res.json({ enabled: b.enabled, include_in: b.include_in, days_ahead: b.days_ahead, url: b.enabled ? feedUrl(req, token) : null });
}));

// What's coming (for the Autopilot page list)
router.get('/upcoming', requireAuth, requireRole('admin', 'accounts'), ah(async (req, res) => {
  const days = Math.min(120, Math.max(7, Number(req.query.days) || 30));
  res.json(await upcoming({ to: addDays(todayIST(), days) }));
}));

module.exports = router;

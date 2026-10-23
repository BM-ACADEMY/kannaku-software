// Autopilot settings, run log, run-now. Admin edits; accounts can look.
const router = require('express').Router();
const { z } = require('zod');
const { query } = require('../lib/db');
const { ah, parse, HttpError } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const ap = require('../lib/autopilot');
const obl = require('../lib/obligations');

// Monthly money dates (rent, EB, water, statutory, investor payouts, salaries)
router.get('/obligations', requireRole('admin', 'accounts'), ah(async (_req, res) => {
  res.json(await obl.schedule());
}));

router.put('/obligations', requireRole('admin'), ah(async (req, res) => {
  const { items } = parse(z.object({ items: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,50}$/), name: z.string().trim().min(1).max(60),
    day: z.union([z.coerce.number().int().min(1).max(31), z.literal('last')]),
    amount: z.coerce.number().min(0).max(100000000).default(0),
  })).max(40) }), req.body);
  const ids = new Set(items.map((i) => i.id));
  if (ids.size !== items.length) throw new HttpError(400, 'Two items have the same id');
  await query(`INSERT INTO settings (key,value) VALUES ('obligations',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(items)]);
  await audit(req.user.id, 'update', 'settings', null, { key: 'obligations', count: items.length });
  res.json(items);
}));

router.get('/', requireRole('admin', 'accounts'), ah(async (_req, res) => {
  const s = await ap.settings();
  const state = (await query("SELECT value FROM settings WHERE key='autopilot_state'")).rows[0]?.value || {};
  const last = (await query(`SELECT DISTINCT ON (job) job, ok, summary, ran_at FROM autopilot_log ORDER BY job, ran_at DESC`)).rows;
  const log = (await query('SELECT id, job, ok, summary, ran_at FROM autopilot_log ORDER BY ran_at DESC LIMIT 60')).rows;
  const books = (await query("SELECT value FROM settings WHERE key='books'")).rows[0]?.value || {};
  res.json({ ...s, names: ap.JOB_NAMES, last: Object.fromEntries(last.map((l) => [l.job, l])), state, log, now: ap.nowIST(), books });
}));

router.put('/', requireRole('admin'), ah(async (req, res) => {
  const b = parse(z.object({ enabled: z.boolean(), jobs: z.record(z.object({ on: z.boolean() }).passthrough()) }), req.body);
  for (const [k, v] of Object.entries(b.jobs)) {
    if (!ap.DEFAULTS.jobs[k]) throw new HttpError(400, `Unknown job ${k}`);
    if (v.at && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.at)) throw new HttpError(400, `Time for ${k} must be HH:MM`);
  }
  const cur = await ap.settings();
  const next = { enabled: true, jobs: Object.fromEntries(Object.entries(cur.jobs).map(([k, v]) => [k, { ...v, ...(b.jobs[k] || {}) }])) };
  // Mandatory: the "to pay" alert to admins can never be switched off (autopilot itself stays on)
  next.jobs.pay_reminders = { ...next.jobs.pay_reminders, on: true };
  await query(`INSERT INTO settings (key,value) VALUES ('autopilot',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(next)]);
  await audit(req.user.id, 'update', 'settings', null, { key: 'autopilot', enabled: b.enabled });
  res.json(next);
}));

router.post('/run/:job', requireRole('admin'), ah(async (req, res) => {
  if (!ap.JOBS[req.params.job]) throw new HttpError(404, 'Unknown job');
  res.json(await ap.runJob(req.params.job, { force: true }));
}));

module.exports = router;

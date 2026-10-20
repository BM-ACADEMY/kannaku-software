// Autopilot — the jobs Kanakku runs by itself, every day, without anyone opening the app.
// Settings → Autopilot turns each job on/off and sets its time (India time). Every run is written to autopilot_log.
//
//   recurring            06:00  rent, salaries, subscriptions → Book (to confirm, or posted)
//   month_lock           07:00  on the "auto-close day" (default 10th), close last month so its numbers can't change
//   alerts               08:00  money running out in the next N days · a brand over budget · backups missing · bills overdue
//   weekly_brief         09:00  Monday: money summary to admins on WhatsApp + email
//   reminders            10:00  polite WhatsApp reminders for invoices/dues due soon or overdue (not more than every N days)
//   investor_statements  11:00  on each investor's statement day: last month's profit-share statement
//   bank_autopost        —      lets saved bank rules post entries straight to the Book (otherwise they wait to be confirmed)
//
// A job claims its run for the day with one atomic UPDATE, so two copies of the app never send twice.
const fs = require('fs');
const path = require('path');
const { query } = require('./db');
const { todayIST, lockUntil, clearLockCache, round2 } = require('./books');
const { sendWhatsApp, sendEmail, notifyAdmins } = require('./notify');

const DEFAULTS = {
  enabled: true,
  jobs: {
    recurring: { on: true, at: '06:00' },
    month_lock: { on: true, at: '07:00' },
    alerts: { on: true, at: '08:00', low_cash_days: 30, budget_pct: 90, backup_hours: 36 },
    weekly_brief: { on: true, at: '09:00', weekday: 1 },
    reminders: { on: true, at: '10:00', days_before: 2, repeat_days: 3 },
    investor_statements: { on: true, at: '11:00' },
    bank_autopost: { on: true },
  },
};
const JOB_NAMES = {
  recurring: 'Recurring entries', month_lock: 'Close last month', alerts: 'Alerts', weekly_brief: 'Monday money brief',
  reminders: 'Payment reminders', investor_statements: 'Investor statements', bank_autopost: 'Bank rules post directly',
};

const fmt = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const nowIST = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: todayIST(), hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1 };
};

async function settings() {
  const v = (await query("SELECT value FROM settings WHERE key='autopilot'")).rows[0]?.value || {};
  const jobs = {};
  for (const [k, d] of Object.entries(DEFAULTS.jobs)) jobs[k] = { ...d, ...(v.jobs?.[k] || {}) };
  return { enabled: v.enabled !== false, jobs };
}

// Atomically mark job as run for `key` (usually today's date). Returns false if it already ran.
async function claim(job, key) {
  await query("INSERT INTO settings (key,value) VALUES ('autopilot_state','{}') ON CONFLICT (key) DO NOTHING");
  const r = await query(`UPDATE settings SET value = jsonb_set(value, $1::text[], to_jsonb($2::text), true)
    WHERE key='autopilot_state' AND COALESCE(value->>$3, '') <> $2 RETURNING 1`, [`{${job}}`, key, job]);
  return r.rowCount > 0;
}

async function log(job, ok, summary, detail) {
  await query('INSERT INTO autopilot_log (job, ok, summary, detail) VALUES ($1,$2,$3,$4)', [job, ok, summary, detail ? JSON.stringify(detail) : null]);
  await query("DELETE FROM autopilot_log WHERE ran_at < now() - interval '120 days'");
}

const prevMonth = (iso) => { const [y, m] = iso.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const lastDayOf = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };

// ── Jobs ── each returns { summary, detail }
const JOBS = {
  async recurring() {
    const r = await require('./recurring').runDue();
    return { summary: r.created ? `${r.created} entr${r.created === 1 ? 'y' : 'ies'} made (${r.posted} posted, ${r.created - r.posted} to confirm)` : 'Nothing due today', detail: r, ok: !r.errors.length };
  },

  async month_lock(cfg, now) {
    const books = (await query("SELECT value FROM settings WHERE key='books'")).rows[0]?.value || {};
    const day = Number(books.autolock_day ?? 10);
    if (!day) return { summary: 'Auto-close is off (Settings → Books)' };
    if (Number(now.date.slice(8, 10)) < day) return { summary: `Waits for day ${day}` };
    const target = lastDayOf(prevMonth(now.date));
    const cur = await lockUntil();
    if (cur && cur >= target) return { summary: `Already closed up to ${cur}` };
    const pending = (await query("SELECT COUNT(*)::int AS n FROM entries WHERE status='pending' AND deleted_at IS NULL AND entry_date <= $1", [target])).rows[0].n;
    if (pending) {
      await notifyAdmins('Month not closed', `${pending} entr${pending === 1 ? 'y' : 'ies'} from last month still waiting to be confirmed in the Book. Confirm or delete them, and autopilot will close the month tomorrow.`);
      return { summary: `Not closed: ${pending} entries still to confirm`, ok: false };
    }
    await query(`UPDATE settings SET value = jsonb_set(value, '{lock_until}', to_jsonb($1::text)) WHERE key='books'`, [target]);
    clearLockCache();
    await query("INSERT INTO audit_log (user_id, action, entity, detail) VALUES (NULL, 'close_books', 'settings', $1)", [JSON.stringify({ to: target, by: 'autopilot' })]);
    await notifyAdmins('Month closed', `Books are closed up to ${target}. Entries on or before that date can no longer be changed. An admin can reopen in Settings → Books.`);
    return { summary: `Closed books up to ${target}` };
  },

  async alerts(cfg, now) {
    const said = [];
    const { forecast } = require('./forecast');
    const fc = await forecast(Number(cfg.low_cash_days || 30));
    if (fc.runs_out_on) said.push(`Cash may run out on ${fc.runs_out_on} (lowest ₹${fmt(fc.low.balance)}). Collect dues or move bills.`);
    // budgets this month
    const ym = now.date.slice(0, 7);
    const { pnl, monthRange } = require('./reports');
    const act = await pnl(monthRange(ym));
    const budgets = (await query('SELECT b.*, br.name FROM budgets b JOIN brands br ON br.id=b.brand_id WHERE month=$1 AND expense_limit > 0', [ym])).rows;
    for (const b of budgets) {
      const a = act.brands.find((x) => x.brand_id === b.brand_id);
      const pct = a ? Math.round((a.expense / Number(b.expense_limit)) * 100) : 0;
      if (pct >= Number(cfg.budget_pct || 90) && await claim(`budget_${b.brand_id}_${ym}_${pct >= 100 ? 100 : 90}`, ym)) {
        said.push(`${b.name} has spent ${pct}% of its ₹${fmt(b.expense_limit)} budget for ${ym}.`);
      }
    }
    // backups
    const dir = process.env.BACKUP_DIR;
    if (dir) {
      let newest = 0;
      try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.sql.gz')) newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs); } catch { /* folder missing */ }
      const hours = newest ? (Date.now() - newest) / 36e5 : Infinity;
      if (hours > Number(cfg.backup_hours || 36)) said.push(newest ? `Last database backup was ${Math.round(hours)} hours ago — check the backup service.` : 'No database backups found — check the backup service.');
    }
    // bills overdue
    const bills = (await query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total-amount_paid-amount_credited),0) AS amt FROM documents
      WHERE doc_type='bill' AND status IN ('unpaid','partial') AND due_date < $1`, [now.date])).rows[0];
    if (bills.n) said.push(`${bills.n} vendor bill${bills.n === 1 ? '' : 's'} overdue (₹${fmt(bills.amt)}).`);
    if (!said.length) return { summary: 'All good — nothing to alert' };
    await notifyAdmins('Alert', said.join(' '));
    return { summary: said.join(' '), detail: { alerts: said } };
  },

  async weekly_brief(cfg, now, force) {
    if (!force && now.weekday !== Number(cfg.weekday || 1)) return { summary: 'Not the brief day', skip: true };
    const { pnl } = require('./reports');
    const { cfoBrief } = require('./ai');
    const to = now.date; const from = new Date(new Date(`${to}T00:00:00Z`).getTime() - 6 * 864e5).toISOString().slice(0, 10);
    const r = await pnl({ from, to });
    const recv = (await query(`SELECT COALESCE(SUM(total-amount_paid-amount_credited),0) AS amt, COUNT(*) FILTER (WHERE due_date<CURRENT_DATE)::int AS overdue
      FROM documents WHERE doc_type='invoice' AND status IN ('unpaid','partial')`)).rows[0];
    const pay = (await query(`SELECT COALESCE((SELECT SUM(amount-amount_settled) FROM dues WHERE status='open' AND direction='payable' AND document_id IS NULL),0)
      + COALESCE((SELECT SUM(total-amount_paid-amount_credited) FROM documents WHERE doc_type='bill' AND status IN ('unpaid','partial')),0) AS amt`)).rows[0];
    const { accountBalances } = require('./books');
    const cash = (await accountBalances()).filter((a) => a.active).reduce((s, a) => s + Number(a.balance), 0);
    const text = await cfoBrief({ ...r, receivable: Number(recv.amt), overdue: Number(recv.overdue), payable: Number(pay.amt), cash_in_bank: round2(cash) });
    const res = await notifyAdmins('Weekly money brief', text);
    return { summary: `Sent to ${res.filter((x) => x.whatsapp || x.email).length} of ${res.length} admins`, detail: { text, res } };
  },

  async reminders(cfg, now) {
    const days = Number(cfg.days_before ?? 2); const repeat = Number(cfg.repeat_days ?? 3);
    const inv = (await query(`SELECT 'invoice' AS kind, d.id, d.number, c.name AS party, c.phone, (d.total-d.amount_paid-d.amount_credited) AS balance, d.due_date, b.name AS brand_name
      FROM documents d JOIN customers c ON c.id=d.customer_id JOIN brands b ON b.id=d.brand_id
      WHERE d.doc_type='invoice' AND d.status IN ('unpaid','partial') AND d.due_date IS NOT NULL AND d.due_date <= $1::date + $2::int
        AND c.phone IS NOT NULL AND (d.last_reminded_at IS NULL OR d.last_reminded_at < now() - make_interval(days => $3::int))`, [now.date, days, repeat])).rows;
    const man = (await query(`SELECT 'due' AS kind, d.id, NULL AS number, d.party, d.phone, (d.amount-d.amount_settled) AS balance, d.due_date, b.name AS brand_name
      FROM dues d JOIN brands b ON b.id=d.brand_id
      WHERE d.status='open' AND d.direction='receivable' AND d.document_id IS NULL AND d.phone IS NOT NULL AND d.due_date <= $1::date + $2::int
        AND (d.last_reminded_at IS NULL OR d.last_reminded_at < now() - make_interval(days => $3::int))`, [now.date, days, repeat])).rows;
    let sent = 0; const failed = [];
    for (const r of [...inv, ...man]) {
      const res = await sendWhatsApp(r.phone, 'afv_payment_reminder', [r.party, fmt(r.balance), r.brand_name, r.number ? `invoice ${r.number}` : 'your account', String(r.due_date).slice(0, 10)]);
      if (res.ok) {
        sent++;
        await query(`UPDATE ${r.kind === 'invoice' ? 'documents' : 'dues'} SET last_reminded_at=now() WHERE id=$1`, [r.id]);
      } else failed.push(`${r.party}: ${res.error}`);
    }
    const total = inv.length + man.length;
    return { summary: total ? `${sent} of ${total} reminders sent${failed.length ? ` · ${failed.length} failed (${failed[0]})` : ''}` : 'No one to remind today', detail: { failed }, ok: !failed.length || sent > 0 };
  },

  async investor_statements(cfg, now) {
    const { investorStatement } = require('./reports');
    const day = Number(now.date.slice(8, 10));
    const ym = prevMonth(now.date);
    const invs = (await query(`SELECT i.id, i.name, i.phone, i.email, i.statement_day,
        to_char(COALESCE(i.start_date, (SELECT MIN(received_on) FROM investor_contributions c WHERE c.investor_id=i.id)), 'YYYY-MM') AS start_ym
      FROM investors i WHERE i.active AND i.statement_day <= $1`, [day])).rows;
    const done = [];
    const state = (await query("SELECT value FROM settings WHERE key='autopilot_state'")).rows[0]?.value || {};
    for (const i of invs) {
      if (i.start_ym && ym < i.start_ym) continue;              // no statement for months before they invested
      if (state[`statement_${i.id}`] === ym) continue;          // already delivered this month
      const s = await investorStatement(i.id, ym);
      const m = s.months.find((x) => x.month === ym);
      const lines = (m?.brands || []).map((b) => `${b.brand_name}: net ₹${fmt(b.net)} × ${b.share_pct}% = ₹${fmt(b.share)}`);
      const text = `Afra Ventures — profit statement for ${ym}\n${lines.join('\n')}\nYour share this month: ₹${fmt(m?.share)}\nTotal accrued, unpaid: ₹${fmt(s.accrued_unpaid)}${s.due_now ? `\nPayable now: ₹${fmt(s.due_now)}` : ''}`;
      const w = i.phone ? await sendWhatsApp(i.phone, 'afv_investor_statement', [i.name, ym, fmt(m?.net_profit), fmt(m?.share), fmt(s.accrued_unpaid)]) : { ok: false, error: 'no phone' };
      const e = i.email ? await sendEmail(i.email, `Afra Ventures — profit statement ${ym}`, text) : { ok: false, error: 'no email' };
      // Only mark as sent when it reached them — otherwise it tries again tomorrow (e.g. once WhatsApp is set up)
      if (w.ok || e.ok) await claim(`statement_${i.id}`, ym);
      done.push({ investor: i.name, whatsapp: w.ok, email: e.ok, error: !w.ok && !e.ok ? `${w.error}; ${e.error}` : undefined });
    }
    return { summary: done.length ? `Statements for ${ym}: ${done.map((d) => `${d.investor} (${[d.whatsapp && 'WhatsApp', d.email && 'email'].filter(Boolean).join(' + ') || 'not delivered'})`).join(', ')}` : 'No statements due today', detail: done };
  },
};

// Run one job now (from the screen, or from the clock). force=true skips the once-a-day claim.
async function runJob(name, { force = false } = {}) {
  const s = await settings();
  if (!JOBS[name]) throw new Error('Unknown job');
  const now = nowIST();
  if (!force && !(await claim(name, now.date))) return { skipped: 'already ran today' };
  try {
    const r = await JOBS[name](s.jobs[name] || {}, now, force);
    if (!r.skip || force) await log(name, r.ok !== false, r.summary, r.detail);
    return r;
  } catch (err) {
    await log(name, false, err.message.slice(0, 500));
    return { ok: false, summary: err.message };
  }
}

let timer = null;
async function tick() {
  try {
    const s = await settings();
    if (!s.enabled) return;
    const now = nowIST();
    for (const [name, cfg] of Object.entries(s.jobs)) {
      if (!JOBS[name] || !cfg.on || !cfg.at) continue;
      if (now.hm >= cfg.at) await runJob(name);
    }
  } catch (err) {
    console.error('[autopilot]', err.message);
  }
}

function start() {
  if (timer || process.env.AUTOPILOT === 'off') return;
  setTimeout(tick, 20000);                 // shortly after start-up
  timer = setInterval(tick, 5 * 60 * 1000); // then every 5 minutes
}

module.exports = { start, tick, runJob, settings, DEFAULTS, JOB_NAMES, JOBS, nowIST };

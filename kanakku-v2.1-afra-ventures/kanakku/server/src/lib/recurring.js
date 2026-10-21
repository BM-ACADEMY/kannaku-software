// Recurring entries: rent on the 5th, salaries on the 1st, software every year…
// Autopilot calls runDue() every morning: each due item becomes a Book entry — 'pending' (to confirm)
// or posted straight away if auto_post is on. Missed days (server was off) are caught up, one entry per period.
const { query, tx } = require('./db');
const { insertEntry } = require('./ledger');
const { lockUntil } = require('./books');

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

// Day 31 in a 30-day month → the 30th (and the 28th/29th in February)
function onDay(y, m, day) { return new Date(Date.UTC(y, m, Math.min(day, lastDay(y, m)))); }

function nextAfter(dateStr, frequency, day) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (frequency === 'weekly') return isoDate(new Date(d.getTime() + 7 * 864e5));
  const months = { monthly: 1, quarterly: 3, yearly: 12 }[frequency];
  const m = d.getUTCMonth() + months;
  return isoDate(onDay(d.getUTCFullYear() + Math.floor(m / 12), m % 12, day));
}

// First date on or after `from` that fits the schedule
function firstOnOrAfter(fromStr, frequency, day) {
  const from = new Date(`${fromStr}T00:00:00Z`);
  if (frequency === 'weekly') {
    const want = ((Number(day) - 1) % 7 + 7) % 7 + 1; // 1 = Monday
    const cur = from.getUTCDay() || 7;
    return isoDate(new Date(from.getTime() + (((want - cur) % 7 + 7) % 7) * 864e5));
  }
  let cand = onDay(from.getUTCFullYear(), from.getUTCMonth(), day);
  if (cand < from) { const m = from.getUTCMonth() + 1; cand = onDay(from.getUTCFullYear() + Math.floor(m / 12), m % 12, day); }
  return isoDate(cand);
}

async function runDue(today = require('./books').todayIST()) {
  const items = (await query('SELECT * FROM recurring WHERE active AND next_date <= $1 ORDER BY next_date, id', [today])).rows;
  const lock = await lockUntil();
  const out = { created: 0, posted: 0, skipped_locked: 0, errors: [] };
  for (const r of items) {
    let next = String(r.next_date).slice(0, 10);
    let guard = 0;
    while (next <= today && (!r.end_date || next <= String(r.end_date).slice(0, 10)) && guard++ < 24) {
      if (lock && next <= lock) { out.skipped_locked++; next = nextAfter(next, r.frequency, r.day); continue; }
      const t = r.template || {};
      const dateNow = next;
      try {
        await tx(async (client) => {
          // never make the same period twice (e.g. if the job ran twice)
          const dup = await client.query('SELECT 1 FROM entries WHERE recurring_id=$1 AND entry_date=$2 AND deleted_at IS NULL', [r.id, dateNow]);
          if (dup.rows[0]) return;
          await insertEntry(client, { ...t, entry_date: dateNow, source: 'recurring', recurring_id: r.id, status: r.auto_post ? 'posted' : 'pending',
            note: t.note || r.name, created_by: r.created_by });
          out.created++; if (r.auto_post) out.posted++;
        });
      } catch (err) {
        out.errors.push(`${r.name}: ${err.message}`);
        break; // leave next_date here so it retries tomorrow
      }
      next = nextAfter(next, r.frequency, r.day);
    }
    const ended = r.end_date && next > String(r.end_date).slice(0, 10);
    await query('UPDATE recurring SET next_date=$1, last_run=$2, active=$3 WHERE id=$4', [next, today, !ended, r.id]);
  }
  return out;
}

module.exports = { nextAfter, firstOnOrAfter, runDue, isoDate };

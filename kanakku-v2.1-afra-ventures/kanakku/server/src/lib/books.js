// Book-keeping rules shared by every route: month lock, GST/TDS split of payments, account balances.
const { query } = require('./db');
const { HttpError } = require('./http');

// Today's date in India (the server may run on UTC)
const todayIST = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ── Month lock ──
// settings.books.lock_until = 'YYYY-MM-DD' → nothing dated on or before it can be added, changed or deleted.
let lockCache = { at: 0, value: null };
async function lockUntil(q = query) {
  if (Date.now() - lockCache.at < 5000) return lockCache.value;
  const r = await q("SELECT value->>'lock_until' AS d FROM settings WHERE key='books'");
  lockCache = { at: Date.now(), value: r.rows[0]?.d || null };
  return lockCache.value;
}
function clearLockCache() { lockCache = { at: 0, value: null }; }

// Throws if any of the dates falls in a closed month. Pass every date the change touches (old and new).
async function assertOpen(dates, q = query) {
  const lock = await lockUntil(q);
  if (!lock) return;
  for (const d of [].concat(dates).filter(Boolean)) {
    if (String(d).slice(0, 10) <= lock) {
      throw new HttpError(423, `Books are closed up to ${lock}. Ask an admin to reopen the month in Settings → Books before changing anything dated ${String(d).slice(0, 10)}.`);
    }
  }
}

// ── Payments on invoices / bills ──
// How much of a settlement is GST. `settle` = cash received + TDS. The last payment takes whatever GST is left,
// so the GST on an invoice always adds up exactly, whatever the rounding on part payments.
function gstShare({ total, gst, settledBefore, gstBefore, settle }) {
  const T = Number(total); const G = Number(gst);
  if (!T || !G) return 0;
  const closes = Number(settledBefore) + Number(settle) >= T - 0.01;
  if (closes) return round2(G - Number(gstBefore));
  return round2((Number(settle) * G) / T);
}

// What's still owed on an invoice/bill
const docBalance = (d) => round2(Number(d.total) - Number(d.amount_paid) - Number(d.amount_credited || 0));

// ── Account balances ──
// opening_balance on opening_date + every posted entry from that date on. Transfers move money between accounts.
async function accountBalances(asOf = null, q = query) {
  const { rows } = await q(`
    SELECT a.id, a.name, a.kind, a.opening_balance, a.opening_date, a.active,
      a.opening_balance
      + COALESCE((SELECT SUM(CASE WHEN e.type='in' THEN e.amount WHEN e.type IN ('out','transfer') THEN -e.amount END)
          FROM entries e WHERE e.account_id=a.id AND e.deleted_at IS NULL AND e.status='posted'
            AND e.entry_date >= a.opening_date AND ($1::date IS NULL OR e.entry_date <= $1::date)), 0)
      + COALESCE((SELECT SUM(e.amount) FROM entries e WHERE e.to_account_id=a.id AND e.type='transfer'
            AND e.deleted_at IS NULL AND e.status='posted' AND e.entry_date >= a.opening_date
            AND ($1::date IS NULL OR e.entry_date <= $1::date)), 0) AS balance,
      (SELECT COUNT(*) FROM entries e WHERE e.account_id IS NULL AND e.deleted_at IS NULL AND e.status='posted' AND e.type<>'transfer')::int AS unassigned
    FROM accounts a ORDER BY a.active DESC, a.id`, [asOf]);
  return rows.map((r) => ({ ...r, balance: round2(r.balance) }));
}

module.exports = { todayIST, round2, lockUntil, clearLockCache, assertOpen, gstShare, docBalance, accountBalances };

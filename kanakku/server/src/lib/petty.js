// Petty cash: the cash box balance, float and top-up, staff-spend approval rule, bills missing, cash counts.
const { query } = require('./db');
const { accountBalances, todayIST, round2 } = require('./books');

const DEFAULTS = { account_id: null, float: 10000, low_at: 2000, approval: { on: false, above: 500, cash_only: true }, counts: [] };

async function config(q = query) {
  const v = (await q("SELECT value FROM settings WHERE key='petty_cash'")).rows[0]?.value || {};
  return { ...DEFAULTS, ...v, approval: { ...DEFAULTS.approval, ...(v.approval || {}) }, counts: Array.isArray(v.counts) ? v.counts : [] };
}
async function saveConfig(cfg, q = query) {
  await q(`INSERT INTO settings (key,value) VALUES ('petty_cash',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(cfg)]);
}

// The cash box: the account chosen in settings, else the first active account of kind "cash"
async function cashAccount(cfg, q = query) {
  const rows = (await q("SELECT id, name, kind, active FROM accounts WHERE kind='cash' OR id=$1 ORDER BY (id=$1) DESC, id", [cfg.account_id || 0])).rows;
  return rows.find((a) => a.active) || null;
}

// Does this new/edited entry need an admin's OK? Only staff (not admin) spends — money out, over the limit.
// accountKind: 'cash' | 'bank' | 'upi' | … (kind of the account it is paid from)
function needsApproval(cfg, { role, type, amount, accountKind }) {
  const a = cfg.approval || {};
  if (!a.on || role === 'admin' || type !== 'out') return false;
  if (a.cash_only !== false && accountKind !== 'cash') return false;
  return Number(amount) > Number(a.above || 0);
}

const addDays = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);

async function status(today = todayIST()) {
  const cfg = await config();
  const acct = await cashAccount(cfg);
  const out = { config: cfg, account: null };
  if (!acct) return { ...out, message: 'No cash account yet — add one in Settings → Accounts (kind: cash).' };
  const bal = (await accountBalances()).find((a) => a.id === acct.id);
  const balance = round2(bal?.balance || 0);
  const monthStart = `${today.slice(0, 7)}-01`;
  const spent = (await query(`SELECT COALESCE(c.name,'No category') AS name, SUM(e.amount) AS amount, COUNT(*)::int AS n FROM entries e LEFT JOIN categories c ON c.id=e.category_id
    WHERE e.account_id=$1 AND e.type='out' AND e.status='posted' AND e.deleted_at IS NULL AND e.entry_date >= $2 GROUP BY 1 ORDER BY 2 DESC`, [acct.id, monthStart])).rows
    .map((r) => ({ name: r.name, amount: Number(r.amount), n: r.n }));
  // Cash spends from the last 60 days with no bill photo, not marked "no bill" — give people a week before nagging
  const missing = (await query(`SELECT e.id, e.entry_date, e.amount, e.party, e.note, c.name AS category_name, u.name AS created_by_name
    FROM entries e JOIN accounts a ON a.id=e.account_id LEFT JOIN categories c ON c.id=e.category_id LEFT JOIN users u ON u.id=e.created_by
    WHERE a.kind='cash' AND e.type='out' AND e.status='posted' AND e.deleted_at IS NULL AND NOT e.no_bill AND e.entry_date >= $1
      AND NOT EXISTS (SELECT 1 FROM attachments x WHERE x.entity='entry' AND x.entity_id=e.id) ORDER BY e.entry_date DESC, e.id DESC LIMIT 100`, [addDays(today, -60)])).rows;
  const noBill = (await query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS amt FROM entries
    WHERE no_bill AND type='out' AND status='posted' AND deleted_at IS NULL AND entry_date >= $1`, [addDays(today, -90)])).rows[0];
  const pending = (await query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS amt FROM entries WHERE approval_required AND status='pending' AND deleted_at IS NULL`)).rows[0];
  const low = balance < Number(cfg.low_at || 0);
  return { ...out, account: { id: acct.id, name: acct.name }, balance, float: Number(cfg.float || 0), low_at: Number(cfg.low_at || 0), low,
    topup_suggest: round2(Math.max(0, Number(cfg.float || 0) - balance)), month: { from: monthStart, total: round2(spent.reduce((s, x) => s + x.amount, 0)), by_category: spent },
    bills_missing: { count: missing.length, amount: round2(missing.reduce((s, x) => s + Number(x.amount), 0)), rows: missing.slice(0, 50) },
    no_bill: { days: 90, count: noBill.n, amount: Number(noBill.amt) }, awaiting_approval: { count: pending.n, amount: Number(pending.amt) },
    counts: cfg.counts.slice(0, 6) };
}

module.exports = { config, saveConfig, cashAccount, needsApproval, status, DEFAULTS };

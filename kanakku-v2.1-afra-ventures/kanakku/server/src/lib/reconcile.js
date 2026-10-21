// Bank reconciliation: tie each bank statement line to a Book entry.
//  1. Match: an entry on the same account, same direction, same amount, within ±4 days (closest date wins;
//     if two are equally close and neither shares the bank reference, the line is left for a person).
//  2. Rule: description contains a saved pattern ("TNEB" → EB bill, Office overheads split) → create the entry.
//     Rule entries are 'pending' (to confirm) unless the rule says auto-post AND autopilot's bank_autopost is on.
const { query, tx } = require('./db');
const { insertEntry } = require('./ledger');
const { lockUntil } = require('./books');

async function candidates(line, accountId, q = query) {
  const type = Number(line.credit) > 0 ? 'in' : 'out';
  const amount = Number(line.credit) > 0 ? line.credit : line.debit;
  // a transfer out of this account is a debit here; a transfer into this account is a credit here
  const { rows } = await q(`SELECT e.id, e.entry_date, e.ref, e.status, abs(e.entry_date - $3::date) AS gap FROM entries e
    WHERE e.deleted_at IS NULL AND e.amount = $2
      AND e.entry_date BETWEEN $3::date - 4 AND $3::date + 4
      AND ( (e.type = $4 AND (e.account_id = $1 OR e.account_id IS NULL))
         OR ($4 = 'out' AND e.type = 'transfer' AND e.account_id = $1)
         OR ($4 = 'in'  AND e.type = 'transfer' AND e.to_account_id = $1) )
      AND NOT EXISTS (SELECT 1 FROM bank_lines bl WHERE bl.entry_id = e.id)
    ORDER BY gap, e.id`, [accountId, amount, line.line_date, type]);
  return rows;
}

function pickMatch(line, cands) {
  if (!cands.length) return null;
  const ref = (line.ref || '').toLowerCase();
  if (ref) {
    const byRef = cands.find((c) => c.ref && ref.includes(String(c.ref).toLowerCase()));
    if (byRef) return byRef;
  }
  if (cands.length === 1) return cands[0];
  if (Number(cands[0].gap) < Number(cands[1].gap)) return cands[0];
  return null; // two equally good — let a person choose
}

async function matchingRule(line, q = query) {
  const dir = Number(line.credit) > 0 ? 'in' : 'out';
  const { rows } = await q(`SELECT * FROM bank_rules WHERE active AND (direction='any' OR direction=$1)
    AND position(lower(pattern) in lower($2)) > 0 ORDER BY length(pattern) DESC, id LIMIT 1`, [dir, line.description]);
  return rows[0] || null;
}

// Run over unmatched lines (all, or one import). Returns counts.
async function autoReconcile({ importId = null, allowAutoPost = true } = {}) {
  const lines = (await query(`SELECT * FROM bank_lines WHERE status='unmatched' AND ($1::text IS NULL OR import_id=$1) ORDER BY line_date, id`, [importId])).rows;
  const lock = await lockUntil();
  const out = { matched: 0, by_rule: 0, posted: 0, left: 0 };
  for (const line of lines) {
    const m = pickMatch(line, await candidates(line, line.account_id));
    if (m) {
      await query("UPDATE bank_lines SET status='matched', entry_id=$1 WHERE id=$2 AND status='unmatched'", [m.id, line.id]);
      out.matched++; continue;
    }
    const rule = await matchingRule(line);
    if (rule && !(lock && line.line_date <= lock)) {
      const isIn = Number(line.credit) > 0;
      let split = null;
      if (rule.split_preset_id) split = (await query('SELECT rules FROM split_presets WHERE id=$1', [rule.split_preset_id])).rows[0]?.rules || null;
      const post = rule.auto_post && allowAutoPost;
      await tx(async (client) => {
        const id = await insertEntry(client, { entry_date: line.line_date, type: isIn ? 'in' : 'out', amount: isIn ? line.credit : line.debit,
          brand_id: rule.brand_id, split, split_preset_id: rule.split_preset_id, category_id: rule.category_id, account_id: line.account_id,
          party: rule.party, note: line.description.slice(0, 300), ref: line.ref, source: 'bank', status: post ? 'posted' : 'pending' });
        await client.query("UPDATE bank_lines SET status='matched', entry_id=$1, rule_id=$2 WHERE id=$3", [id, rule.id, line.id]);
        await client.query('UPDATE bank_rules SET hits=hits+1 WHERE id=$1', [rule.id]);
      });
      out.by_rule++; if (post) out.posted++;
      continue;
    }
    out.left++;
  }
  return out;
}

module.exports = { candidates, pickMatch, matchingRule, autoReconcile };

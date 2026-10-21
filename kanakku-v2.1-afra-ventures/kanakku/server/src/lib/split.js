// Turn a split rule [{brand_id, pct}] into exact rupee amounts that add up to the entry amount.
const { HttpError } = require('./http');

function normaliseRules(rules) {
  const clean = (rules || []).map((r) => ({ brand_id: Number(r.brand_id), pct: Number(r.pct) })).filter((r) => r.brand_id && r.pct > 0);
  const ids = new Set(clean.map((r) => r.brand_id));
  if (ids.size !== clean.length) throw new HttpError(400, 'A brand appears twice in the split');
  const total = clean.reduce((s, r) => s + r.pct, 0);
  if (clean.length < 2) throw new HttpError(400, 'A split needs at least two brands');
  if (Math.abs(total - 100) > 0.01) throw new HttpError(400, `Split must total 100% (now ${Math.round(total * 100) / 100}%)`);
  return clean;
}

function allocate(amount, rules) {
  const clean = normaliseRules(rules);
  const paise = Math.round(Number(amount) * 100);
  const lines = clean.map((r) => ({ ...r, paise: Math.floor((paise * r.pct) / 100) }));
  let left = paise - lines.reduce((s, l) => s + l.paise, 0);
  // give leftover paise to the biggest shares first
  [...lines].sort((a, b) => b.pct - a.pct).forEach((l) => { if (left > 0) { l.paise += 1; left -= 1; } });
  return lines.map((l) => ({ brand_id: l.brand_id, pct: l.pct, amount: l.paise / 100 }));
}

module.exports = { allocate, normaliseRules };

const { query } = require('./db');

// Profit & loss for a date range, optionally limited to some brands.
// Reads entry_lines (view): shared costs are already split onto brands.
// Uses pnl_amount: GST taken out, customer TDS added back. Categories with in_pnl=false
// (investor capital/payouts, GST paid to govt, loans) and transfers are not profit or loss.
// excludeShared: leave out split shared costs (used for investors who agreed to that).
async function pnl({ from, to, brandIds, excludeShared = false }) {
  const p = [from, to];
  let extra = '';
  if (brandIds && brandIds.length) { p.push(brandIds); extra += ` AND l.brand_id = ANY($${p.length})`; }
  if (excludeShared) extra += ' AND NOT l.shared';
  const base = `FROM entry_lines l LEFT JOIN categories c ON c.id=l.category_id
    WHERE l.deleted_at IS NULL AND l.entry_date BETWEEN $1 AND $2 ${extra}
    AND COALESCE(c.in_pnl, TRUE)`;
  const byBrand = await query(`SELECT b.id AS brand_id, b.name AS brand_name, b.code AS brand_code, b.color AS brand_color,
      COALESCE(SUM(l.pnl_amount) FILTER (WHERE l.type='in'),0) AS income,
      COALESCE(SUM(l.pnl_amount) FILTER (WHERE l.type='out'),0) AS expense,
      COALESCE(SUM(l.pnl_amount) FILTER (WHERE l.type='out' AND l.shared),0) AS shared_expense
    ${base.replace('FROM entry_lines l', 'FROM entry_lines l JOIN brands b ON b.id=l.brand_id')}
    GROUP BY b.id ORDER BY b.sort_order`, p);
  const byCategory = await query(`SELECT l.type, COALESCE(c.name,'Uncategorised') AS category, SUM(l.pnl_amount) AS total
    ${base} GROUP BY l.type, c.name ORDER BY l.type, total DESC`, p);
  const brands = byBrand.rows.map((r) => ({ ...r, net: r.income - r.expense }));
  const income = brands.reduce((s, r) => s + r.income, 0);
  const expense = brands.reduce((s, r) => s + r.expense, 0);
  const shared = brands.reduce((s, r) => s + r.shared_expense, 0);
  return { from, to, income, expense, shared_expense: shared, net: income - expense, brands, categories: byCategory.rows };
}

function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

function monthsBetween(startYm, endYm) {
  const out = []; let [y, m] = startYm.split('-').map(Number); const [ey, em] = endYm.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

const r2 = (n) => Math.round(n * 100) / 100;

// Which brands an investor shares in, and at what %.
// New way: rows in investor_brands. Old way (fallback): profit_share_pct on every in_investor_pool brand.
// Versioned: for month ym, the latest set with effective_from <= ym applies.
async function investorBrandShares(inv, ym = '9999-12') {
  const anyRows = (await query('SELECT 1 FROM investor_brands WHERE investor_id=$1 LIMIT 1', [inv.id])).rows.length;
  if (anyRows) {
    return (await query(`SELECT ib.brand_id, ib.share_pct, ib.effective_from, b.name AS brand_name, b.code AS brand_code, b.color AS brand_color
      FROM investor_brands ib JOIN brands b ON b.id=ib.brand_id
      WHERE ib.investor_id=$1 AND ib.share_pct > 0
        AND ib.effective_from = (SELECT MAX(effective_from) FROM investor_brands WHERE investor_id=$1 AND effective_from <= $2)
      ORDER BY b.sort_order`, [inv.id, ym])).rows;
  }
  return (await query(`SELECT id AS brand_id, $1::numeric AS share_pct, name AS brand_name, code AS brand_code, color AS brand_color
    FROM brands WHERE in_investor_pool ORDER BY sort_order`, [inv.profit_share_pct])).rows;
}

// Investor statement: per month, each brand's net profit × that brand's share %.
//  loss_rule 'pooled'    → add up all brand shares, then floor the month at 0 (a weak brand pulls the month down)
//  loss_rule 'per_brand' → floor each brand at 0 separately (a loss-making brand just gives nothing)
async function investorStatement(investorId, uptoYm) {
  const inv = (await query('SELECT * FROM investors WHERE id=$1', [investorId])).rows[0];
  if (!inv) return null;
  const contributions = (await query('SELECT * FROM investor_contributions WHERE investor_id=$1 ORDER BY received_on', [investorId])).rows;
  const payouts = (await query('SELECT * FROM investor_payouts WHERE investor_id=$1 ORDER BY period, paid_on', [investorId])).rows;
  const startYm = (inv.start_date || contributions[0]?.received_on || `${uptoYm}-01`).slice(0, 7);
  const months = startYm <= uptoYm ? monthsBetween(startYm, uptoYm) : [];
  const rows = [];
  for (const [i, ym] of months.entries()) {
    const shares = await investorBrandShares(inv, ym);
    const r = await pnl({ ...monthRange(ym), brandIds: shares.map((s) => s.brand_id), excludeShared: !inv.include_shared_costs });
    const brands = shares.map((s) => {
      const b = r.brands.find((x) => x.brand_id === s.brand_id) || { income: 0, expense: 0, net: 0, shared_expense: 0 };
      const raw = (b.net * Number(s.share_pct)) / 100;
      return { brand_id: s.brand_id, brand_name: s.brand_name, brand_code: s.brand_code, brand_color: s.brand_color, share_pct: Number(s.share_pct),
        income: b.income, expense: b.expense, shared_expense: b.shared_expense, net: b.net,
        share: r2(inv.loss_rule === 'per_brand' ? Math.max(0, raw) : raw) };
    });
    const sum = brands.reduce((s, b) => s + b.share, 0);
    const share = r2(Math.max(0, sum));
    const paid = payouts.filter((p) => p.period === ym).reduce((s, p) => s + Number(p.amount), 0);
    rows.push({ month: ym, month_no: i + 1, income: r.income, expense: r.expense, net_profit: r.net, share, paid,
      payable_now: i + 1 >= inv.payout_from_month, brands });
  }
  const totalShare = r2(rows.reduce((s, r) => s + r.share, 0));
  const totalPaid = payouts.reduce((s, p) => s + Number(p.amount), 0);
  const payableShare = rows.filter((r) => r.payable_now).length ? totalShare : 0;
  const current = await investorBrandShares(inv, uptoYm);
  const history = (await query(`SELECT ib.effective_from, json_agg(json_build_object('brand_id', ib.brand_id, 'brand_code', b.code, 'share_pct', ib.share_pct) ORDER BY b.sort_order) AS brands
    FROM investor_brands ib JOIN brands b ON b.id=ib.brand_id WHERE ib.investor_id=$1 GROUP BY ib.effective_from ORDER BY ib.effective_from`, [investorId])).rows;
  return {
    investor: inv, brand_shares: current, share_history: history, pool_brands: current.map((s) => ({ id: s.brand_id, name: s.brand_name })),
    contributions, payouts, months: rows,
    capital: contributions.reduce((s, c) => s + Number(c.amount), 0),
    total_share: totalShare, total_paid: totalPaid,
    accrued_unpaid: r2(totalShare - totalPaid),
    due_now: r2(Math.max(0, payableShare - totalPaid)),
  };
}

module.exports = { pnl, monthRange, investorStatement, investorBrandShares };

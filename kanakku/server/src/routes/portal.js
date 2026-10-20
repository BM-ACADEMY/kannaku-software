// Investor's own view: their statement, capital and payouts — nothing else.
const router = require('express').Router();
const { ah, HttpError } = require('../lib/http');
const { investorStatement } = require('../lib/reports');

router.get('/statement', ah(async (req, res) => {
  if (req.user.role !== 'investor' || !req.user.investor_id) throw new HttpError(403, 'This page is for investors');
  const upto = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const s = await investorStatement(req.user.investor_id, upto);
  if (!s) throw new HttpError(404, 'Investor not found');
  // only what an investor should see about themselves
  const { investor, ...rest } = s;
  res.json({ ...rest, investor: { name: investor.name, loss_rule: investor.loss_rule, include_shared_costs: investor.include_shared_costs,
    payout_from_month: investor.payout_from_month, start_date: investor.start_date } });
}));

module.exports = router;

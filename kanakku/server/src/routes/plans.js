// Payment plans (instalments on one invoice). Staff with money access only.
const router = require('express').Router();
const { z } = require('zod');
const { tx } = require('../lib/db');
const { ah, parse } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { todayIST } = require('../lib/books');
const { listPlans, createPlan, paySlab } = require('../lib/plans');

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = ['admin', 'accounts'];

router.get('/', requireRole(...money), ah(async (req, res) => {
  res.json(await listPlans(todayIST()));
}));

router.post('/from-invoice/:id', requireRole(...money), ah(async (req, res) => {
  const p = parse(z.object({ count: z.coerce.number().int().min(2).max(12), first_due: DATE,
    every_months: z.coerce.number().int().min(1).max(12).default(1), name: z.string().max(80).optional() }), req.body);
  const planId = await tx((client) => createPlan(client, Number(req.params.id), { ...p, userId: req.user.id }));
  await audit(req.user.id, 'create', 'payment_plan', planId, p);
  res.json(await listPlans(todayIST()));
}));

router.post('/slabs/:id/pay', requireRole(...money), ah(async (req, res) => {
  const p = parse(z.object({ amount: z.coerce.number().positive().optional(), paid_on: DATE.optional(),
    account_id: z.coerce.number().nullable().optional() }), req.body);
  await tx((client) => paySlab(client, Number(req.params.id), { amount: p.amount, paid_on: p.paid_on || todayIST(),
    account_id: p.account_id ?? null, userId: req.user.id }));
  await audit(req.user.id, 'payment', 'plan_slab', Number(req.params.id), p);
  res.json(await listPlans(todayIST()));
}));

module.exports = router;

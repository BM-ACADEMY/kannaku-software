const router = require('express').Router();
const { z } = require('zod');
const { query } = require('../lib/db');
const { ah, parse } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { parseEntry } = require('../lib/ai');

async function ctx() {
  const [b, c, a] = await Promise.all([
    query('SELECT id, code, name FROM brands WHERE active'),
    query('SELECT id, name, kind FROM categories WHERE active'),
    query('SELECT id, name FROM accounts WHERE active'),
  ]);
  return { brands: b.rows, categories: c.rows, accounts: a.rows };
}

// Returns a DRAFT entry for the user to confirm — never saves directly.
router.post('/parse-entry', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const { text } = parse(z.object({ text: z.string().min(2).max(500) }), req.body);
  res.json(await parseEntry(text, await ctx()));
}));

module.exports = router;
module.exports.ctx = ctx;

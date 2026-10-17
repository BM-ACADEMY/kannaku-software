const router = require('express').Router();
const { query } = require('../lib/db');
const { ah, HttpError } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { pnl, monthRange } = require('../lib/reports');

const today = () => new Date().toISOString().slice(0, 10);

router.get('/pnl', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) throw new HttpError(400, 'from and to are required');
  const brandIds = req.query.brand_id ? [Number(req.query.brand_id)] : null;
  const r = await pnl({ from, to, brandIds });
  // monthly trend (shared costs already split by the entry_lines view)
  const p = [from, to]; let bf = '';
  if (brandIds) { p.push(brandIds); bf = 'AND l.brand_id = ANY($3)'; }
  const trend = await query(`SELECT to_char(l.entry_date,'YYYY-MM') AS month,
      COALESCE(SUM(l.amount) FILTER (WHERE l.type='in'),0) AS income,
      COALESCE(SUM(l.amount) FILTER (WHERE l.type='out'),0) AS expense
    FROM entry_lines l LEFT JOIN categories c ON c.id=l.category_id
    WHERE l.deleted_at IS NULL AND l.entry_date BETWEEN $1 AND $2 ${bf} AND COALESCE(c.name,'')<>'Investor payout'
    GROUP BY 1 ORDER BY 1`, p);
  res.json({ ...r, trend: trend.rows });
}));

router.get('/gst', requireRole('admin', 'accounts'), ah(async (req, res) => {
  const ym = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  const { from, to } = monthRange(ym);
  const { rows } = await query(`SELECT d.number, d.doc_date, c.name AS customer, c.gstin, d.place_of_supply, b.name AS brand_name,
      d.subtotal, d.cgst, d.sgst, d.igst, d.total
    FROM documents d JOIN customers c ON c.id=d.customer_id JOIN brands b ON b.id=d.brand_id
    WHERE d.doc_type='invoice' AND d.status<>'cancelled' AND d.doc_date BETWEEN $1 AND $2 ORDER BY d.doc_date, d.number`, [from, to]);
  const t = rows.reduce((a, r) => ({ taxable: a.taxable + r.subtotal, cgst: a.cgst + r.cgst, sgst: a.sgst + r.sgst, igst: a.igst + r.igst, total: a.total + r.total }),
    { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 });
  res.json({ month: ym, rows, totals: t, b2b: rows.filter((r) => r.gstin).length, b2c: rows.filter((r) => !r.gstin).length });
}));

// Dashboard — what everyone sees first
router.get('/dashboard', ah(async (req, res) => {
  const t = today(); const ym = t.slice(0, 7);
  const { from, to } = monthRange(ym);
  const [day, month, recv, pay, quotes, recent] = await Promise.all([
    query(`SELECT COALESCE(SUM(amount) FILTER (WHERE type='in'),0) AS income, COALESCE(SUM(amount) FILTER (WHERE type='out'),0) AS expense
      FROM entries WHERE deleted_at IS NULL AND entry_date=$1`, [t]),
    pnl({ from, to }),
    query(`SELECT COALESCE(SUM(total-amount_paid),0) AS amt, COUNT(*) AS n,
      COUNT(*) FILTER (WHERE due_date < CURRENT_DATE) AS overdue
      FROM documents WHERE doc_type='invoice' AND status IN ('unpaid','partial')`),
    query(`SELECT COALESCE(SUM(amount-amount_settled) FILTER (WHERE direction='payable'),0) AS payable,
      COALESCE(SUM(amount-amount_settled) FILTER (WHERE direction='receivable'),0) AS receivable
      FROM dues WHERE status='open' AND document_id IS NULL`),
    query(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS amt FROM documents WHERE doc_type='quote' AND status IN ('draft','sent','accepted')`),
    query(`SELECT e.id,e.entry_date,e.type,e.amount,e.party,e.note,b.code AS brand_code,b.color AS brand_color,c.name AS category_name
      FROM entries e JOIN brands b ON b.id=e.brand_id LEFT JOIN categories c ON c.id=e.category_id
      WHERE e.deleted_at IS NULL ORDER BY e.created_at DESC LIMIT 8`),
  ]);
  const showMoney = req.user.role !== 'sales';
  res.json({
    today: showMoney ? day.rows[0] : null,
    month: showMoney ? month : null,
    receivable: Number(recv.rows[0].amt) + Number(pay.rows[0].receivable),
    overdue_invoices: Number(recv.rows[0].overdue),
    payable: showMoney ? Number(pay.rows[0].payable) : null,
    open_quotes: { count: Number(quotes.rows[0].n), amount: Number(quotes.rows[0].amt) },
    recent: showMoney ? recent.rows : [],
  });
}));

module.exports = router;

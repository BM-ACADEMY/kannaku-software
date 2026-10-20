// Money logic that must never silently break. Run: npm test   (or ./kanakku.sh test on the server)
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTotals, fyCode, checkGstin } = require('../src/lib/gst');
const { allocate } = require('../src/lib/split');
const { parseStatement, parseDate, parseAmount } = require('../src/lib/bankcsv');
const totp = require('../src/lib/totp');
const { gstr1, gstr3b } = require('../src/lib/gstr');

test('GST: same state → CGST+SGST that add up exactly, other state → IGST', () => {
  const a = computeTotals([{ qty: 1, rate: 40000, gst_rate: 18 }, { qty: 1, rate: 20000, gst_rate: 18 }], '34', '34');
  assert.deepEqual([a.subtotal, a.cgst, a.sgst, a.igst, a.total], [60000, 5400, 5400, 0, 70800]);
  const odd = computeTotals([{ qty: 1, rate: 100.05, gst_rate: 5 }], '34', '34'); // tax 5.00 → but try odd paise
  assert.equal(Math.round((odd.cgst + odd.sgst) * 100), Math.round(odd.tax * 100));
  const odd2 = computeTotals([{ qty: 3, rate: 33.33, gst_rate: 18 }], '34', '34');
  assert.equal(Math.round((odd2.cgst + odd2.sgst) * 100), Math.round(odd2.tax * 100));
  const i = computeTotals([{ qty: 2, rate: 1000, gst_rate: 18 }], '34', '33');
  assert.deepEqual([i.cgst, i.sgst, i.igst, i.total], [0, 0, 360, 2360]);
});

test('Financial year code', () => {
  assert.equal(fyCode('2026-04-01'), '2627');
  assert.equal(fyCode('2027-03-31'), '2627');
  assert.equal(fyCode('2026-03-31'), '2526');
});

test('GSTIN check digit', () => {
  assert.equal(checkGstin('34ABGCA7083D1ZS').ok, true);          // Afra Ventures
  assert.equal(checkGstin('34abgca7083d1zs').state_code, '34');
  assert.equal(checkGstin('34ABGCA7083D1ZX').ok, false);
  assert.equal(checkGstin('').ok, true);                           // no GSTIN = B2C
});

test('Shared-cost split always adds up to the bill, to the paisa', () => {
  for (const amt of [15500, 4200, 999.99, 1000, 1, 0.07]) {
    const r = allocate(amt, [{ brand_id: 1, pct: 33.33 }, { brand_id: 2, pct: 33.33 }, { brand_id: 3, pct: 33.34 }]);
    assert.equal(Math.round(r.reduce((s, x) => s + x.amount, 0) * 100), Math.round(amt * 100), `amount ${amt}`);
  }
  assert.throws(() => allocate(100, [{ brand_id: 1, pct: 60 }, { brand_id: 2, pct: 30 }]), /100%/);
});

test('Payment GST share: part payments add up to the invoice GST exactly', () => {
  const { gstShare } = require('../src/lib/books');
  const inv = { total: 70800, gst: 10800 };
  let settled = 0; let gst = 0;
  for (const pay of [33333.33, 20000, 17466.67]) {
    gst += gstShare({ total: inv.total, gst: inv.gst, settledBefore: settled, gstBefore: gst, settle: pay });
    settled += pay;
  }
  assert.equal(Math.round(gst * 100), 1080000);
});

test('Bank CSV: RBL style with header lines, Dr/Cr style, dates and amounts', () => {
  const rbl = 'RBL Bank\nAccount No:,408220969669\n\nTxn Date,Value Date,Description,Ref No./Cheque No.,Withdrawal Amt.,Deposit Amt.,Balance\n'
    + '01/10/2026,01/10/2026,"NEFT-SRI MURUGAN",UTR1,,"45,000.00","1,45,000.00"\n03/10/2026,03/10/2026,UPI/TNEB,UPI9,4200.00,,"1,40,800.00"\n';
  const r = parseStatement(rbl);
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines.map((l) => [l.line_date, l.debit, l.credit]), [['2026-10-01', 0, 45000], ['2026-10-03', 4200, 0]]);
  const drcr = parseStatement('Date,Narration,Ref,Amount,Dr/Cr\n16-Oct-2026,SWIGGY,A,1250.50,DR\n17-Oct-26,RAZORPAY,B,9800,CR\n');
  assert.deepEqual(drcr.lines.map((l) => [l.line_date, l.debit, l.credit]), [['2026-10-16', 1250.5, 0], ['2026-10-17', 0, 9800]]);
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseAmount('(1,200.00)'), -1200);
});

test('2-step login codes match the RFC 6238 test vector', () => {
  const s = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp.codeAt(s, 1), '287082');
  assert.equal(totp.verify(s, '287082', 59000), true);
  assert.equal(totp.verify(s, '287083', 59000), false);
});

test('GSTR-1 totals net off credit notes; GSTR-3B uses input credit in the legal order', () => {
  const docs = [
    { id: 1, doc_type: 'invoice', number: 'AFV/TX/INV/2627/0001', total: 70800, place_of_supply: '34', gstin: '34ABGCA7083D1ZS' },
    { id: 2, doc_type: 'invoice', number: 'AFV/TX/INV/2627/0002', total: 236000, place_of_supply: '33', gstin: null },
    { id: 3, doc_type: 'credit_note', number: 'AFV/TX/CN/2627/0001', total: 11800, place_of_supply: '34', gstin: '34ABGCA7083D1ZS' },
  ];
  const items = { 1: [{ hsn_sac: '998314', qty: 1, gst_rate: 18, amount: 60000 }], 2: [{ hsn_sac: '998314', qty: 1, gst_rate: 18, amount: 200000 }],
    3: [{ hsn_sac: '998314', qty: 1, gst_rate: 18, amount: 10000 }] };
  const r = gstr1(docs, items, '34');
  assert.deepEqual(r.totals, { taxable: 250000, igst: 36000, cgst: 4500, sgst: 4500 });
  assert.equal(r.b2b.length, 1); assert.equal(r.b2cl.length, 1); assert.equal(r.cdnr.length, 1);
  const b = gstr3b(r.totals, [{ itc_eligible: true, subtotal: 10000, igst: 1800, cgst: 0, sgst: 0 }]);
  assert.deepEqual(b.cash_payable, { igst: 34200, cgst: 4500, sgst: 4500, total: 43200 });
});

test('Recurring dates: month-end rules', () => {
  const { nextAfter, firstOnOrAfter } = require('../src/lib/recurring');
  assert.equal(nextAfter('2026-01-31', 'monthly', 31), '2026-02-28');
  assert.equal(nextAfter('2026-02-28', 'monthly', 31), '2026-03-31');
  assert.equal(firstOnOrAfter('2026-10-20', 'monthly', 5), '2026-11-05');
  assert.equal(firstOnOrAfter('2026-10-20', 'weekly', 1), '2026-10-26');
});

test('Cash forecast finds the first day money runs out', () => {
  const { project } = require('../src/lib/forecast');
  const p = project(10000, [{ date: '2026-10-21', amount: -15500 }, { date: '2026-10-25', amount: 20000 }], '2026-10-20', 10);
  assert.equal(p.runs_out_on, '2026-10-21');
  assert.deepEqual(p.low, { date: '2026-10-21', balance: -5500 });
  assert.equal(p.end_balance, 14500);
});

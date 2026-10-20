// GSTR-1 and GSTR-3B working sheets for the CA, built from the month's invoices, credit notes and purchase bills.
// Pure functions over plain rows (easy to test); the route loads the rows.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const B2CL_LIMIT = 100000; // inter-state B2C invoice above ₹1 lakh is reported invoice-wise (B2CL)

// Split one document into rate-wise lines: [{ rate, taxable, igst, cgst, sgst }]
function rateLines(doc, items, companyState) {
  const intra = String(doc.place_of_supply) === String(companyState);
  const by = {};
  for (const it of items) {
    const r = Number(it.gst_rate);
    by[r] = by[r] || { rate: r, taxable: 0, tax: 0 };
    by[r].taxable += Number(it.amount);
    by[r].tax += round2((Number(it.amount) * r) / 100);
  }
  return Object.values(by).map((x) => {
    const tax = round2(x.tax); const cg = intra ? round2(tax / 2) : 0;
    return { rate: x.rate, taxable: round2(x.taxable), igst: intra ? 0 : tax, cgst: cg, sgst: intra ? round2(tax - cg) : 0 };
  });
}

const add = (a, b) => ({ taxable: round2(a.taxable + b.taxable), igst: round2(a.igst + b.igst), cgst: round2(a.cgst + b.cgst), sgst: round2(a.sgst + b.sgst) });
const zero = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0 });

// docs: [{ id, doc_type, number, doc_date, total, place_of_supply, status, gstin, customer, against_number, against_date }]
// itemsByDoc: { [docId]: [{ hsn_sac, description, qty, gst_rate, amount }] }
function gstr1(docs, itemsByDoc, companyState = '34') {
  const out = { b2b: [], b2cl: [], b2cs: {}, cdnr: [], cdnur: [], hsn: {}, docs: {}, warnings: [], totals: zero() };
  for (const d of docs) {
    // Table 13 (documents issued) is per number series: AFV/TX/INV/2627, AFV/AC/INV/2627 …
    const series = String(d.number).replace(/\/\d+$/, '');
    const key = `${d.doc_type === 'credit_note' ? 'Credit notes' : 'Invoices'}|${series}`;
    out.docs[key] = out.docs[key] || { from: null, to: null, total: 0, cancelled: 0 };
    const ds = out.docs[key];
    ds.total++; if (d.status === 'cancelled') ds.cancelled++;
    if (!ds.from || d.number < ds.from) ds.from = d.number;
    if (!ds.to || d.number > ds.to) ds.to = d.number;
    if (d.status === 'cancelled') continue;

    const items = itemsByDoc[d.id] || [];
    const lines = rateLines(d, items, companyState);
    const sign = d.doc_type === 'credit_note' ? -1 : 1;
    const inter = String(d.place_of_supply) !== String(companyState);
    for (const l of lines) out.totals = add(out.totals, { taxable: sign * l.taxable, igst: sign * l.igst, cgst: sign * l.cgst, sgst: sign * l.sgst });

    if (d.doc_type === 'credit_note') {
      const row = { number: d.number, date: d.doc_date, against: d.against_number, against_date: d.against_date, gstin: d.gstin, customer: d.customer,
        pos: d.place_of_supply, value: Number(d.total), lines };
      (d.gstin ? out.cdnr : out.cdnur).push(row);
    } else if (d.gstin) {
      out.b2b.push({ number: d.number, date: d.doc_date, gstin: d.gstin, customer: d.customer, pos: d.place_of_supply, value: Number(d.total), lines });
    } else if (inter && Number(d.total) > B2CL_LIMIT) {
      out.b2cl.push({ number: d.number, date: d.doc_date, customer: d.customer, pos: d.place_of_supply, value: Number(d.total), lines });
    } else {
      for (const l of lines) {
        const k = `${d.place_of_supply}|${l.rate}`;
        out.b2cs[k] = add(out.b2cs[k] || { pos: d.place_of_supply, rate: l.rate, ...zero() }, l);
        out.b2cs[k].pos = d.place_of_supply; out.b2cs[k].rate = l.rate;
      }
    }
    // HSN summary (table 12) — B2B and B2C reported separately
    const intra = !inter;
    for (const it of items) {
      if (!it.hsn_sac) { out.warnings.push(`${d.number}: "${String(it.description).slice(0, 40)}" has no HSN/SAC code`); }
      const k = `${d.gstin ? 'B2B' : 'B2C'}|${it.hsn_sac || '—'}|${Number(it.gst_rate)}`;
      const tax = round2((Number(it.amount) * Number(it.gst_rate)) / 100); const cg = intra ? round2(tax / 2) : 0;
      const h = out.hsn[k] || { type: d.gstin ? 'B2B' : 'B2C', hsn: it.hsn_sac || '—', rate: Number(it.gst_rate), qty: 0, ...zero() };
      out.hsn[k] = { ...add(h, { taxable: sign * Number(it.amount), igst: sign * (intra ? 0 : tax), cgst: sign * cg, sgst: sign * (intra ? round2(tax - cg) : 0) }),
        type: h.type, hsn: h.hsn, rate: h.rate, qty: round2(h.qty + sign * Number(it.qty)) };
    }
  }
  out.b2cs = Object.values(out.b2cs);
  out.hsn = Object.values(out.hsn).sort((a, b) => a.type.localeCompare(b.type) || a.hsn.localeCompare(b.hsn));
  out.docs = Object.entries(out.docs).map(([k, v]) => { const [kind, series] = k.split('|'); return { kind, series, ...v }; })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.series.localeCompare(b.series));
  out.warnings = [...new Set(out.warnings)].slice(0, 50);
  return out;
}

// Output tax from GSTR-1 totals, input tax from eligible purchase bills; ITC set-off in the order the law uses:
// IGST credit → IGST, then CGST, then SGST; CGST credit → CGST, then IGST; SGST credit → SGST, then IGST.
function gstr3b(outTotals, bills) {
  const itc = bills.filter((b) => b.itc_eligible && b.status !== 'cancelled').reduce((a, b) => add(a,
    { taxable: Number(b.subtotal), igst: Number(b.igst), cgst: Number(b.cgst), sgst: Number(b.sgst) }), zero());
  const blocked = bills.filter((b) => !b.itc_eligible && b.status !== 'cancelled').reduce((s, b) => s + Number(b.igst) + Number(b.cgst) + Number(b.sgst), 0);
  const pay = { igst: Math.max(0, outTotals.igst), cgst: Math.max(0, outTotals.cgst), sgst: Math.max(0, outTotals.sgst) };
  const cr = { igst: itc.igst, cgst: itc.cgst, sgst: itc.sgst };
  const use = (from, to) => { const u = Math.min(cr[from], pay[to]); cr[from] = round2(cr[from] - u); pay[to] = round2(pay[to] - u); };
  use('igst', 'igst'); use('igst', 'cgst'); use('igst', 'sgst');
  use('cgst', 'cgst'); use('cgst', 'igst');
  use('sgst', 'sgst'); use('sgst', 'igst');
  return {
    outward: outTotals, itc, itc_blocked: round2(blocked),
    cash_payable: { igst: round2(pay.igst), cgst: round2(pay.cgst), sgst: round2(pay.sgst), total: round2(pay.igst + pay.cgst + pay.sgst) },
    credit_carried_forward: { igst: round2(cr.igst), cgst: round2(cr.cgst), sgst: round2(cr.sgst) },
  };
}

module.exports = { gstr1, gstr3b, rateLines, B2CL_LIMIT };

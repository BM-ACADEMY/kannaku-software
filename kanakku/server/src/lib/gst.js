// GST calculation. Company is registered in Puducherry (state code 34).
// Same state as place of supply → CGST + SGST (half each). Different state → IGST.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function computeTotals(items, companyState, placeOfSupply) {
  const intra = String(companyState) === String(placeOfSupply);
  let subtotal = 0, cgst = 0, sgst = 0, igst = 0;
  const lines = items.map((it, i) => {
    const amount = round2(Number(it.qty) * Number(it.rate));
    const tax = round2((amount * Number(it.gst_rate)) / 100);
    subtotal += amount;
    if (intra) { cgst += tax / 2; sgst += tax / 2; } else { igst += tax; }
    return { ...it, position: i, amount };
  });
  subtotal = round2(subtotal); cgst = round2(cgst); sgst = round2(sgst); igst = round2(igst);
  return { lines, subtotal, cgst, sgst, igst, total: round2(subtotal + cgst + sgst + igst), intra };
}

// Indian financial year code: Apr 2026–Mar 2027 → "2627"
function fyCode(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return String(y % 100).padStart(2, '0') + String((y + 1) % 100).padStart(2, '0');
}

module.exports = { computeTotals, fyCode, round2 };

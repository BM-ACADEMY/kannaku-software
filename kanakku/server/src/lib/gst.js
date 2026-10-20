// GST calculation. Company is registered in Puducherry (state code 34).
// Same state as place of supply → CGST + SGST (half each). Different state → IGST.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function computeTotals(items, companyState, placeOfSupply) {
  const intra = String(companyState) === String(placeOfSupply);
  let subtotal = 0; let tax = 0;
  const lines = items.map((it, i) => {
    const amount = round2(Number(it.qty) * Number(it.rate));
    subtotal += amount;
    tax += round2((amount * Number(it.gst_rate)) / 100);
    return { ...it, position: i, amount };
  });
  subtotal = round2(subtotal); tax = round2(tax);
  // CGST gets the half, SGST the rest — so the two always add up to the tax exactly, even with odd paise
  const cgst = intra ? round2(tax / 2) : 0;
  const sgst = intra ? round2(tax - cgst) : 0;
  const igst = intra ? 0 : tax;
  return { lines, subtotal, cgst, sgst, igst, tax, total: round2(subtotal + tax), intra };
}

// Indian financial year code: Apr 2026–Mar 2027 → "2627"
function fyCode(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return String(y % 100).padStart(2, '0') + String((y + 1) % 100).padStart(2, '0');
}

// GSTIN check: format + the official check digit. Returns { ok, state_code, error }.
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function checkGstin(raw) {
  const g = String(raw || '').trim().toUpperCase();
  if (!g) return { ok: true, gstin: null };
  if (g.length !== 15) return { ok: false, error: 'GSTIN must be 15 characters' };
  if (!GSTIN_RE.test(g)) return { ok: false, error: 'GSTIN format is wrong (e.g. 34ABCDE1234F1Z5)' };
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  const check = CHARS[(36 - (sum % 36)) % 36];
  if (check !== g[14]) return { ok: false, error: `GSTIN check digit doesn't match — please re-check the number (last character should be ${check})` };
  return { ok: true, gstin: g, state_code: g.slice(0, 2) };
}

module.exports = { computeTotals, fyCode, round2, checkGstin };

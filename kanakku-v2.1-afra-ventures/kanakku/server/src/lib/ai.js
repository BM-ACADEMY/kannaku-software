// AI helpers — Grok (x.ai, OpenAI-compatible) with a rule-based fallback so the app works without a key.
const { getConfig } = require('./integrations');
const IN_WORDS = ['vanthuchu', 'vandhuchu', 'vanthathu', 'vandhadhu', 'vanthu', 'received', 'recd', 'got', 'credit', 'credited',
  'kidaichuchu', 'kedachuchu', 'vaanginom', 'vangunom', 'collected', 'income', 'advance', 'in'];
const OUT_WORDS = ['kuduthen', 'kudutha', 'koduthen', 'koduthom', 'kuduthom', 'kodutha', 'paid', 'pay', 'spent', 'selavu', 'sent',
  'debit', 'debited', 'expense', 'out', 'potten', 'pottom', 'katunom', 'kattinom'];
const MODES = { cash: 'Cash box', kaasu: 'Cash box', gpay: 'Company UPI', phonepe: 'Company UPI', paytm: 'Company UPI', upi: 'Company UPI',
  bank: 'Company bank', neft: 'Company bank', imps: 'Company bank', rtgs: 'Company bank', cheque: 'Company bank', razorpay: 'Razorpay' };
const CATEGORY_HINTS = [
  [/salary|sambalam|samabalam/i, 'Salary'], [/\brent\b|vaadagai|vadagai/i, 'Rent'], [/\beb\b|\beb bill|current bill|electric|power bill|water bill/i, 'Electricity & utilities'],
  [/wifi|internet|recharge|mobile/i, 'Internet & phone'], [/ads?|meta|facebook|insta|google ads|boost/i, 'Ads & marketing'],
  [/petrol|diesel|fuel|travel|bus|auto|cab/i, 'Travel & fuel'], [/vegetable|kaikari|chicken|mutton|rice|arisi|masala|grocery|oil/i, 'Raw material'],
  [/esi|pf|epf/i, 'ESI / PF'], [/gst/i, 'GST paid'], [/tea|snacks|stationery|office|xerox|print/i, 'Office expense'],
  [/software|hosting|domain|subscription|chatgpt|claude|canva/i, 'Software & tools'],
  [/commission/i, 'Commission'], [/fee|course|batch|student/i, 'Course fee'], [/order|catering|biryani/i, 'Catering order'],
  [/package|trip|tour|booking/i, 'Package booking'], [/placement|candidate|joining/i, 'Placement fee'], [/advance/i, 'Advance received'],
];

function parseAmount(text) {
  const m = text.toLowerCase().replace(/,/g, '').match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(k|l|lakh|lakhs|lac|thousand|ayiram)?\b/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (['k', 'thousand', 'ayiram'].includes(m[2])) n *= 1000;
  if (['l', 'lakh', 'lakhs', 'lac'].includes(m[2])) n *= 100000;
  return Math.round(n * 100) / 100;
}

function ruleParse(text, { brands, categories, accounts }) {
  const t = ` ${text.toLowerCase()} `;
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  const brand = brands.find((b) => words.includes(b.code.toLowerCase()))
    || brands.find((b) => t.includes(b.name.toLowerCase()))
    || brands.find((b) => b.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3 && !['the', 'bm'].includes(w)).some((w) => t.includes(w.replace(/'s$/, ''))));
  const isOut = words.some((w) => OUT_WORDS.includes(w));
  const isIn = words.some((w) => IN_WORDS.includes(w));
  const type = isOut && !isIn ? 'out' : isIn && !isOut ? 'in' : (isOut ? 'out' : 'in');
  const modeKey = words.find((w) => MODES[w]);
  const account = accounts.find((a) => a.name === MODES[modeKey]);
  const hint = CATEGORY_HINTS.find(([re]) => re.test(text));
  let category = hint && categories.find((c) => c.name === hint[1] && c.kind === type);
  if (!category) category = categories.find((c) => c.name === (type === 'in' ? 'Client payment' : 'Other expense'));
  return {
    type, amount: parseAmount(text), brand_id: brand?.id || null, category_id: category?.id || null,
    account_id: account?.id || null, party: null, note: text.trim(), confidence: brand && parseAmount(text) ? 0.6 : 0.3, engine: 'rules',
  };
}

// Keys come from Settings → Integrations (falls back to XAI_* in .env)
const aiConfig = async () => (await getConfig()).ai;

async function grokChat(messages, { json = false, maxTokens = 600 } = {}) {
  const ai = await aiConfig();
  const res = await fetch(`${ai.base_url.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ai.api_key}` },
    body: JSON.stringify({ model: ai.model, messages, temperature: 0.1, max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}) }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Grok error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function parseEntry(text, ctx) {
  if (!(await aiConfig()).api_key) return ruleParse(text, ctx);
  const sys = `You turn short finance notes (English, Tamil, or Tanglish) into one book entry for Afra Ventures.
Return ONLY JSON: {"type":"in"|"out","amount":number,"brand_code":string|null,"category":string|null,"account":string|null,"party":string|null,"note":string,"confidence":0..1}
Tanglish hints: vanthuchu/kidaichuchu/received = in; kuduthen/koduthom/selavu/paid = out. 5k=5000, 1.5L=150000.
Brands (code: name): ${ctx.brands.map((b) => `${b.code}: ${b.name}`).join('; ')}
Categories in: ${ctx.categories.filter((c) => c.kind === 'in').map((c) => c.name).join(', ')}
Categories out: ${ctx.categories.filter((c) => c.kind === 'out').map((c) => c.name).join(', ')}
Accounts: ${ctx.accounts.map((a) => a.name).join(', ')}. gpay/upi → Company UPI, cash → Cash box, bank/neft → Company bank.
Use exact names from the lists or null. "note" is a clean short English description.`;
  try {
    const raw = await grokChat([{ role: 'system', content: sys }, { role: 'user', content: text }], { json: true });
    const j = JSON.parse(raw.replace(/^```json|```$/g, '').trim());
    const type = j.type === 'out' ? 'out' : 'in';
    const brand = ctx.brands.find((b) => b.code === j.brand_code);
    const cat = ctx.categories.find((c) => c.name === j.category && c.kind === type);
    const acc = ctx.accounts.find((a) => a.name === j.account);
    return { type, amount: Number(j.amount) || null, brand_id: brand?.id || null, category_id: cat?.id || null, account_id: acc?.id || null,
      party: j.party || null, note: j.note || text, confidence: Number(j.confidence) || 0.7, engine: 'grok' };
  } catch (err) {
    console.warn('[ai] Grok parse failed, using rules:', err.message);
    return ruleParse(text, ctx);
  }
}

async function cfoBrief(summary) {
  const fallback = () => {
    const l = [`*Afra Ventures — weekly money brief* (${summary.from} to ${summary.to})`,
      `In: ₹${fmt(summary.income)} | Out: ₹${fmt(summary.expense)} | Net: ₹${fmt(summary.net)}`];
    summary.brands.forEach((b) => l.push(`• ${b.brand_name}: net ₹${fmt(b.net)}`));
    l.push(`To collect: ₹${fmt(summary.receivable)} (${summary.overdue} overdue invoices)`);
    l.push(`To pay: ₹${fmt(summary.payable)}`);
    return l.join('\n');
  };
  if (!(await aiConfig()).api_key) return fallback();
  try {
    return await grokChat([
      { role: 'system', content: 'You are the CFO of Afra Ventures, a multi-brand company in Puducherry. Write a WhatsApp-friendly weekly brief for the founder in simple English (max 12 lines): headline numbers, best and weakest brand, cash risks, 2 concrete actions. Use ₹ and Indian number format. No markdown headers.' },
      { role: 'user', content: JSON.stringify(summary) },
    ], { maxTokens: 500 });
  } catch (err) {
    console.warn('[ai] Grok brief failed:', err.message);
    return fallback();
  }
}

const fmt = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

module.exports = { parseEntry, ruleParse, cfoBrief, fmt, grokChat };

// End-to-end smoke test against a running API. Usage: API=http://localhost:4000 npm run smoke
require('dotenv').config();
const API = process.env.API || `http://localhost:${process.env.PORT || 4000}`;
let token;
async function call(method, path, body) {
  const r = await fetch(API + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const ok = (m) => console.log('✓', m);
(async () => {
  const today = new Date().toISOString().slice(0, 10);
  token = (await call('POST', '/auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })).token; ok('login');
  const boot = await call('GET', '/bootstrap'); ok(`bootstrap: ${boot.brands.length} brands`);
  const tx = boot.brands.find((b) => b.code === 'TX');
  const draft = await call('POST', '/ai/parse-entry', { text: 'techx 5k vanthuchu ravi gpay' }); ok(`ai parse: ${draft.type} ${draft.amount} brand ${draft.brand_id} (${draft.engine})`);
  await call('POST', '/entries', { entry_date: today, brand_id: tx.id, type: 'out', amount: 1200, note: 'Meta ads', category_id: boot.categories.find((c) => c.name === 'Ads & marketing').id }); ok('book entry');
  const rent = boot.categories.find((c) => c.name === 'Rent');
  const preset = boot.presets[0];
  const shared = await call('POST', '/entries', { entry_date: today, type: 'out', amount: 15500, category_id: rent.id, note: 'Office rent',
    split: preset.rules, split_preset_id: preset.id });
  const sum = shared.allocations.reduce((s, a) => s + Number(a.amount), 0);
  if (Math.abs(sum - 15500) > 0.001) throw new Error('split does not add up: ' + sum);
  ok(`shared rent split over ${shared.allocations.length} brands (TX gets ₹${shared.allocations.find((a) => a.brand_id === tx.id)?.amount})`);
  const cust = await call('POST', '/deals/customers', { name: 'Smoke Test Traders', phone: '9876543210', state_code: '34' }); ok('customer');
  const q = await call('POST', '/deals/documents', { doc_type: 'quote', brand_id: tx.id, customer_id: cust.id, doc_date: today,
    items: [{ description: 'Website design', qty: 1, rate: 20000, gst_rate: 18, hsn_sac: '998314' }] });
  ok(`quote ${q.number} total ₹${q.total} (CGST ${q.cgst} + SGST ${q.sgst})`);
  const inv = await call('POST', `/deals/documents/${q.id}/convert`, { due_date: today }); ok(`invoice ${inv.number}`);
  const paid = await call('POST', `/deals/documents/${inv.id}/payments`, { amount: 10000, paid_on: today }); ok(`payment → ${paid.status}, paid ₹${paid.amount_paid}`);
  const dues = await call('GET', '/dues'); ok(`dues receivable ₹${dues.totals.receivable}`);
  const pool = boot.brands.filter((b) => b.in_investor_pool);
  const investor = await call('POST', '/investors', { name: 'Test Investor', profit_share_pct: 14, start_date: today, loss_rule: 'pooled',
    include_shared_costs: true, brands: pool.map((b) => ({ brand_id: b.id, share_pct: b.code === 'TX' ? 20 : 14 })) });
  await call('POST', `/investors/${investor.id}/contributions`, { amount: 500000, received_on: today });
  const st = await call('GET', `/investors/${investor.id}/statement`); ok(`investor statement: capital ₹${st.capital}, share ₹${st.total_share} — ` + st.months.at(-1).brands.map((b) => `${b.brand_code} ${b.share_pct}%→₹${b.share}`).join(', '));
  const p = await call('GET', `/reports/pnl?from=${today.slice(0, 8)}01&to=${today}`); ok(`P&L net ₹${p.net}`);
  const g = await call('GET', '/reports/gst'); ok(`GST month taxable ₹${g.totals.taxable}`);
  const d = await call('GET', '/reports/dashboard'); ok(`dashboard receivable ₹${d.receivable}`);
  console.log('\nAll good.');
})().catch((e) => { console.error('✗', e.message); process.exit(1); });

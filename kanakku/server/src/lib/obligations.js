// Monthly money dates: rent, statutory payments, investor payouts, salaries.
// They appear in the "to pay" alert 3 days before and on the day. Amount 0 = not fixed yet (shown as "amount to enter").
// Stored in settings 'obligations' when edited; these are the defaults until then. Dates to be confirmed by the CA.
const { query } = require('./db');

const DEFAULT_SCHEDULE = [
  { id: 'rent', name: 'Rent (cash)', day: 5, amount: 15500, account: 'cash' },
  { id: 'investors', name: 'Investor payouts', day: 6, amount: 0 },
  { id: 'tds', name: 'TDS payment', day: 7, amount: 0 },
  { id: 'gstr1', name: 'GSTR-1 filing', day: 11, amount: 0 },
  { id: 'esi', name: 'ESI challan', day: 15, amount: 0 },
  { id: 'pf', name: 'PF challan', day: 15, amount: 0 },
  { id: 'gstr3b', name: 'GST payment (GSTR-3B)', day: 20, amount: 0 },
  { id: 'salary', name: 'Salaries', day: 'last', amount: 0 },
];

async function schedule(q = query) {
  const v = (await q("SELECT value FROM settings WHERE key='obligations'")).rows[0]?.value;
  return Array.isArray(v) ? v : DEFAULT_SCHEDULE;
}

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

// Every date in [from, to] for each schedule line
async function scheduleItems({ from, to }, q = query) {
  const items = [];
  const [fy, fm] = from.split('-').map(Number); const [ty, tm] = to.split('-').map(Number);
  for (const o of await schedule(q)) {
    for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, m = 1) : m++) {
      const ld = lastDay(y, m);
      const day = o.day === 'last' ? ld : Math.min(Number(o.day), ld);
      const date = `${y}-${pad(m)}-${pad(day)}`;
      if (date < from || date > to) continue;
      items.push({ key: `ob-${o.id}-${date}`, date, direction: 'out', amount: Number(o.amount) || 0, party: o.name, brand: null,
        kind: 'Scheduled', title: `Pay · ${o.name}`, ref: Number(o.amount) ? '' : 'amount to enter' });
    }
  }
  return items;
}

module.exports = { DEFAULT_SCHEDULE, schedule, scheduleItems };

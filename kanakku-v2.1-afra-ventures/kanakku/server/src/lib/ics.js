// Builds an iCalendar (.ics) feed. Google Calendar, Apple Calendar and Outlook can subscribe to the URL
// ("From URL") and keep it updated by themselves (Google refreshes every few hours).
const fmtINR = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

// RFC 5545: escape \ ; , and new lines; fold lines longer than 75 bytes
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  const out = []; let cur = ''; let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const ymd = (iso) => iso.replace(/-/g, '');
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// items: [{ key, date, direction, amount, title, party, brand, ref, kind }]
function buildIcs(items, { name = 'Kanakku · Afra Ventures', domain = 'afraventures.in', appUrl = '' } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Afra Ventures//Kanakku//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`, 'X-WR-TIMEZONE:Asia/Kolkata', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H'];
  const now = stamp();
  for (const i of items) {
    const next = new Date(new Date(`${i.date}T00:00:00Z`).getTime() + 864e5).toISOString().slice(0, 10);
    const sign = i.direction === 'out' ? '🔴' : '🟢';
    const overdue = i.days_left < 0 ? ' (overdue)' : '';
    lines.push('BEGIN:VEVENT',
      `UID:${i.key}@kanakku.${domain}`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${ymd(i.date)}`,
      `DTEND;VALUE=DATE:${ymd(next)}`,
      `SUMMARY:${esc(`${sign} ${i.title} ₹${fmtINR(i.amount)}${overdue}`)}`,
      `DESCRIPTION:${esc([`${i.kind}${i.brand ? ` · ${i.brand}` : ''}`, i.ref, `₹${fmtINR(i.amount)} ${i.direction === 'out' ? 'to pay' : 'to receive'}`, appUrl && `Open Kanakku: ${appUrl}`].filter(Boolean).join('\n'))}`,
      'TRANSP:TRANSPARENT',
      `CATEGORIES:${i.direction === 'out' ? 'To pay' : 'To collect'}`,
      // A reminder the day before at 9 am (Apple/Outlook use it; Google uses its own calendar notification settings)
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(i.title)}`, 'TRIGGER:-PT15H', 'END:VALARM',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildIcs, esc, fold };

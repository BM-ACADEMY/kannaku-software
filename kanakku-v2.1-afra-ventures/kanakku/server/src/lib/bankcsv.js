// Reads a bank statement CSV (RBL, HDFC, ICICI, SBI, Axis… net-banking "Download as CSV").
// Banks put address/account lines above the table, use DD/MM/YYYY or 16-Oct-2026 dates, and either
// separate Withdrawal/Deposit columns or one Amount column with Dr/Cr. This finds the table and normalises it.
const crypto = require('crypto');

// RFC 4180-ish CSV: quotes, commas and new lines inside quotes
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/); // Indian banks: day first
  if (m) return iso(fullYear(+m[3]), +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[\s/-]([A-Za-z]{3})[A-Za-z]*[\s/-](\d{2,4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(fullYear(+m[3]), MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}
const fullYear = (y) => (y < 100 ? 2000 + y : y);
function iso(y, mo, d) {
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y > 1990)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return dt.toISOString().slice(0, 10);
}

function parseAmount(v) {
  const s = String(v || '').replace(/[₹,\s]|INR|Rs\.?/gi, '');
  if (!s || s === '-') return 0;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  const n = parseFloat(s.replace(/[()-]/g, '').replace(/(cr|dr)$/i, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
}

const has = (h, ...words) => words.some((w) => h.includes(w));
// Work out which column is which from the header names
function detectColumns(header) {
  const h = header.map((c) => c.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim());
  const find = (fn) => h.findIndex(fn);
  const map = {
    date: find((c) => has(c, 'txn date', 'transaction date', 'tran date', 'value date', 'posting date') || c === 'date'),
    description: find((c) => has(c, 'description', 'narration', 'particulars', 'remarks', 'details', 'transaction remarks')),
    ref: find((c) => has(c, 'ref', 'cheque', 'chq', 'utr', 'instrument')),
    debit: find((c) => has(c, 'withdrawal', 'debit', 'dr amount', 'paid out') && !has(c, 'credit')),
    credit: find((c) => has(c, 'deposit', 'credit', 'cr amount', 'paid in') && !has(c, 'debit')),
    amount: find((c) => c === 'amount' || c === 'transaction amount' || c === 'amount inr'),
    drcr: find((c) => c === 'dr cr' || c === 'cr dr' || c === 'type' || c === 'debit credit'),
    balance: find((c) => has(c, 'balance')),
  };
  if (map.date < 0) map.date = find((c) => c.includes('date'));
  return map;
}

// Find the header row: the first row that has a date column and money columns
function findTable(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const m = detectColumns(rows[i]);
    if (m.date >= 0 && m.description >= 0 && (m.debit >= 0 || m.credit >= 0 || m.amount >= 0)) return { headerRow: i, map: m };
  }
  return null;
}

// mapping (optional) overrides the guessed columns: { date, description, ref, debit, credit, amount, drcr, balance } → column index
function parseStatement(text, mapping = null) {
  const rows = parseCsv(text);
  const found = mapping ? { headerRow: mapping.headerRow ?? 0, map: mapping } : findTable(rows);
  if (!found) return { ok: false, error: "Couldn't find the transactions table. Pick the columns by hand.", preview: rows.slice(0, 15) };
  const { headerRow, map } = found;
  const lines = []; const skipped = [];
  for (const r of rows.slice(headerRow + 1)) {
    const date = parseDate(r[map.date]);
    if (!date) { skipped.push(r.join(' | ').slice(0, 120)); continue; } // totals / footer / opening balance rows
    let debit = 0; let credit = 0;
    if (map.debit >= 0 || map.credit >= 0) {
      debit = Math.abs(parseAmount(r[map.debit])); credit = Math.abs(parseAmount(r[map.credit]));
    } else if (map.amount >= 0) {
      const raw = r[map.amount]; const a = parseAmount(raw);
      const flag = String(map.drcr >= 0 ? r[map.drcr] : raw).toLowerCase();
      if (/\bdr\b|debit|^d$/.test(flag) || (!/\bcr\b|credit|^c$/.test(flag) && a < 0)) debit = Math.abs(a); else credit = Math.abs(a);
    }
    if (!debit && !credit) { skipped.push(r.join(' | ').slice(0, 120)); continue; }
    const description = String(r[map.description] || '').replace(/\s+/g, ' ').trim() || '(no description)';
    const ref = map.ref >= 0 ? String(r[map.ref] || '').trim() || null : null;
    const balance = map.balance >= 0 ? parseAmount(r[map.balance]) : null;
    lines.push({ line_date: date, description, ref, debit: round2(debit), credit: round2(credit), balance });
  }
  return { ok: true, headerRow, map, header: rows[headerRow], lines, skipped: skipped.length, skipped_examples: skipped.slice(0, 5) };
}
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Same line imported twice (overlapping statements) → same hash → skipped. The running balance makes two
// identical same-day payments distinct; without a balance column, `seq` (position within same-day duplicates) does.
function lineHash(accountId, l, seq = 0) {
  return crypto.createHash('sha256')
    .update([accountId, l.line_date, l.description.toLowerCase(), l.ref || '', l.debit, l.credit, l.balance ?? '', l.balance == null ? seq : ''].join('|'))
    .digest('hex').slice(0, 40);
}

module.exports = { parseCsv, parseDate, parseAmount, detectColumns, parseStatement, lineHash };

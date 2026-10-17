import React, { useState } from 'react';
import { api, qs } from '../lib/api.js';
import { fmtDate, fmtMonth, inr, inr2, monthStart, today } from '../lib/format.js';
import { BrandSelect, BrandTag, Empty, Err, Loader, Stat, useAsync } from '../components/ui.jsx';

function presets() {
  const t = today(); const [y, m] = t.split('-').map(Number);
  const lm = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const lmEnd = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
  const fyStart = m >= 4 ? `${y}-04-01` : `${y - 1}-04-01`;
  return [['This month', monthStart(t), t], ['Last month', `${lm}-01`, lmEnd], ['This FY', fyStart, t]];
}

function downloadCsv(name, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name; a.click();
}

function Pnl() {
  const [f, setF] = useState({ from: monthStart(), to: today(), brand_id: '' });
  const { data, error } = useAsync(() => api(`/reports/pnl${qs(f)}`), [JSON.stringify(f)]);
  const max = data ? Math.max(1, ...data.trend.flatMap((t) => [t.income, t.expense])) : 1;
  return (
    <>
      <div className="filters">
        <div className="seg">{presets().map(([l, a, b]) => <button key={l} className={f.from === a && f.to === b ? 'on' : ''} onClick={() => setF({ ...f, from: a, to: b })}>{l}</button>)}</div>
        <input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <div style={{ minWidth: 180 }}><BrandSelect all includeInactive value={f.brand_id} onChange={(v) => setF({ ...f, brand_id: v })} /></div>
        {data && <button className="btn" onClick={() => downloadCsv(`pnl_${f.from}_${f.to}.csv`, [['Brand', 'Income', 'Expense', 'Net'],
          ...data.brands.map((b) => [b.brand_name, b.income, b.expense, b.net]), ['Total', data.income, data.expense, data.net]].map((r, i) => (i === 0 ? [...r.slice(0, 3), 'Shared costs', r[3]] : [...r.slice(0, 3), i <= data.brands.length ? data.brands[i - 1].shared_expense : data.shared_expense, r[3]])))}>Export CSV</button>}
      </div>
      <Err error={error} />
      {!data && !error && <Loader />}
      {data && (
        <>
          <div className="grid g3" style={{ marginBottom: 14 }}>
            <Stat label="Income" value={inr(data.income)} tone="in" />
            <Stat label="Expense" value={inr(data.expense)} tone="out" />
            <Stat label="Net profit" value={inr(data.net)} tone={data.net >= 0 ? 'in' : 'out'} hint={data.income ? `${Math.round((data.net / data.income) * 100)}% margin` : ''} />
          </div>
          {data.trend.length > 1 && (
            <div className="card card-pad" style={{ marginBottom: 14 }}>
              <div className="row"><h3 style={{ margin: 0 }}>Month by month</h3><span className="spacer" />
                <span className="small"><span className="in">■</span> Income &nbsp; <span className="out">■</span> Expense</span></div>
              <div className="bars">{data.trend.map((t) => (
                <div className="bar-col" key={t.month} title={`${fmtMonth(t.month)}: in ${inr(t.income)}, out ${inr(t.expense)}`}>
                  <div className="bar-pair"><div className="bar in" style={{ height: `${(t.income / max) * 100}%` }} /><div className="bar out" style={{ height: `${(t.expense / max) * 100}%` }} /></div>
                  <div className="small muted">{fmtMonth(t.month).slice(0, 3)}</div>
                </div>))}</div>
            </div>
          )}
          <div className="grid g2">
            <div className="card table-wrap">
              <table className="t">
                <thead><tr><th>Brand</th><th className="num">Income</th><th className="num">Expense</th><th className="num hide-sm">of which shared</th><th className="num">Net</th></tr></thead>
                <tbody>{data.brands.map((b) => (
                  <tr key={b.brand_id}><td><BrandTag name={b.brand_name} color={b.brand_color} /></td>
                    <td className="num">{inr(b.income)}</td><td className="num">{inr(b.expense)}</td>
                    <td className="num hide-sm muted">{b.shared_expense ? inr(b.shared_expense) : '—'}</td>
                    <td className={`num ${b.net >= 0 ? 'in' : 'out'}`} style={{ fontWeight: 600 }}>{inr(b.net)}</td></tr>))}
                </tbody>
                <tfoot><tr><td>Total</td><td className="num">{inr(data.income)}</td><td className="num">{inr(data.expense)}</td><td className="num hide-sm">{inr(data.shared_expense)}</td><td className="num">{inr(data.net)}</td></tr></tfoot>
              </table>
              {data.brands.length === 0 && <Empty>No entries in this period.</Empty>}
            </div>
            <div className="card table-wrap">
              <table className="t">
                <thead><tr><th>Category</th><th className="num">Amount</th></tr></thead>
                <tbody>{data.categories.map((c) => (
                  <tr key={c.type + c.category}><td>{c.category} <span className={`small ${c.type}`}>{c.type === 'in' ? 'in' : 'out'}</span></td>
                    <td className={`num ${c.type}`}>{inr(c.total)}</td></tr>))}</tbody>
              </table>
            </div>
          </div>
          <p className="muted small">Shared bills (EB, rent…) are shown on each brand by their split rule. Investor payouts are a share of profit, not an expense, so they are left out.</p>
        </>
      )}
    </>
  );
}

function Gst() {
  const [month, setMonth] = useState(today().slice(0, 7));
  const { data, error } = useAsync(() => api(`/reports/gst?month=${month}`), [month]);
  return (
    <>
      <div className="filters">
        <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        {data && <button className="btn" onClick={() => downloadCsv(`gst_sales_${month}.csv`, [['Invoice', 'Date', 'Customer', 'GSTIN', 'Place of supply', 'Brand', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total'],
          ...data.rows.map((r) => [r.number, r.doc_date, r.customer, r.gstin, r.place_of_supply, r.brand_name, r.subtotal, r.cgst, r.sgst, r.igst, r.total])])}>Export for CA (CSV)</button>}
      </div>
      <Err error={error} />
      {!data && !error && <Loader />}
      {data && (
        <>
          <div className="grid g4" style={{ marginBottom: 14 }}>
            <Stat label="Taxable value" value={inr(data.totals.taxable)} hint={`${data.b2b} B2B · ${data.b2c} B2C`} />
            <Stat label="CGST" value={inr2(data.totals.cgst)} />
            <Stat label="SGST" value={inr2(data.totals.sgst)} />
            <Stat label="IGST" value={inr2(data.totals.igst)} />
          </div>
          <div className="card table-wrap">
            {data.rows.length === 0 ? <Empty>No invoices in {fmtMonth(month)}.</Empty> : (
              <table className="t">
                <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th className="hide-sm">GSTIN</th><th className="num">Taxable</th><th className="num">Tax</th><th className="num">Total</th></tr></thead>
                <tbody>{data.rows.map((r) => (
                  <tr key={r.number}><td style={{ fontWeight: 600 }}>{r.number}</td><td>{fmtDate(r.doc_date)}</td><td>{r.customer}</td><td className="hide-sm">{r.gstin || 'B2C'}</td>
                    <td className="num">{inr2(r.subtotal)}</td><td className="num">{inr2(r.cgst + r.sgst + r.igst)}</td><td className="num">{inr2(r.total)}</td></tr>))}</tbody>
              </table>
            )}
          </div>
          <p className="muted small">This is a sales register to hand to your CA for GSTR-1 / GSTR-3B. Input tax credit on purchases is not tracked here.</p>
        </>
      )}
    </>
  );
}

export default function Reports() {
  const [tab, setTab] = useState('pnl');
  return (
    <>
      <div className="page-head">
        <div><h1>Reports</h1><p>Profit & loss across brands, and the monthly GST sales register.</p></div>
        <span className="spacer" />
        <div className="seg"><button className={tab === 'pnl' ? 'on' : ''} onClick={() => setTab('pnl')}>P&L</button><button className={tab === 'gst' ? 'on' : ''} onClick={() => setTab('gst')}>GST</button></div>
      </div>
      {tab === 'pnl' ? <Pnl /> : <Gst />}
    </>
  );
}

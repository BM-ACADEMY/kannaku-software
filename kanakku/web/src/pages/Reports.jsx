import React, { useEffect, useState } from 'react';
import { api, qs } from '../lib/api.js';
import { fmtDate, fmtMonth, inr, inr2, monthStart, today } from '../lib/format.js';
import { BrandSelect, BrandTag, Empty, Err, Loader, Stat, useApp, useAsync } from '../components/ui.jsx';

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
          <p className="muted small">Income and spend are shown without GST (GST is the government's money) and with customer TDS counted as received. Shared bills are split by their rule. Investor capital, payouts, loans and GST payments are not profit or loss, so they are left out.</p>
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

const sumRow = (o) => inr2((o?.igst || 0) + (o?.cgst || 0) + (o?.sgst || 0));
const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };

function GstReturns() {
  const [month, setMonth] = useState(prevMonth());
  const { data, error } = useAsync(() => api(`/reports/gstr?month=${month}`), [month]);
  const r1 = data?.gstr1; const r3 = data?.gstr3b;
  const exportAll = () => {
    const rows = [['Section', 'Number / HSN', 'Date', 'GSTIN', 'Party', 'Place of supply', 'Rate %', 'Taxable', 'IGST', 'CGST', 'SGST']];
    const push = (sec, d) => d.lines.forEach((l) => rows.push([sec, d.number, d.date, d.gstin || '', d.customer || '', d.pos, l.rate, l.taxable, l.igst, l.cgst, l.sgst]));
    r1.b2b.forEach((d) => push('B2B', d)); r1.b2cl.forEach((d) => push('B2CL', d));
    r1.b2cs.forEach((b) => rows.push(['B2CS', '', '', '', '', b.pos, b.rate, b.taxable, b.igst, b.cgst, b.sgst]));
    r1.cdnr.forEach((d) => push(`CDNR (against ${d.against})`, d)); r1.cdnur.forEach((d) => push(`CDNUR (against ${d.against})`, d));
    r1.hsn.forEach((h) => rows.push([`HSN ${h.type}`, h.hsn, '', '', `qty ${h.qty}`, '', h.rate, h.taxable, h.igst, h.cgst, h.sgst]));
    data.bills.forEach((b) => rows.push([`Purchase${b.itc_eligible ? ' (ITC)' : ' (no ITC)'}`, `${b.number} / ${b.vendor_ref || ''}`, b.doc_date, b.gstin || '', b.vendor, '', '', b.subtotal, b.igst, b.cgst, b.sgst]));
    downloadCsv(`gst_${month}_${data.gstin || ''}.csv`, rows);
  };
  return (
    <>
      <div className="filters">
        <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        {data && <button className="btn" onClick={exportAll}>Download for CA (CSV)</button>}
      </div>
      <Err error={error} />
      {!data && !error && <Loader />}
      {data && (
        <>
          {r1.warnings.length > 0 && <div className="banner" style={{ display: 'block' }}><strong>Fix before filing:</strong>{r1.warnings.slice(0, 8).map((w) => <div key={w} className="small">• {w}</div>)}{r1.warnings.length > 8 && <div className="small">…and {r1.warnings.length - 8} more</div>}</div>}
          <div className="grid g4" style={{ marginBottom: 14 }}>
            <Stat label="Sales (taxable, after credit notes)" value={inr(r1.totals.taxable)} />
            <Stat label="GST on sales" value={sumRow(r1.totals)} />
            <Stat label="Input credit (bills)" value={sumRow(r3.itc)} hint={r3.itc_blocked ? `${inr2(r3.itc_blocked)} not claimable` : ''} />
            <Stat label="GST to pay in cash" value={inr2(r3.cash_payable.total)} tone={r3.cash_payable.total > 0 ? 'out' : 'in'} hint="GSTR-3B estimate" />
          </div>
          <div className="grid g2">
            <div className="card card-pad">
              <h3>GSTR-1 — sales</h3>
              <table className="t"><tbody>
                <tr><td>B2B invoices (customers with GSTIN)</td><td className="num">{r1.b2b.length}</td></tr>
                <tr><td>B2C large (other state, above ₹1 lakh)</td><td className="num">{r1.b2cl.length}</td></tr>
                <tr><td>B2C small — summary rows</td><td className="num">{r1.b2cs.length}</td></tr>
                <tr><td>Credit notes — registered / unregistered</td><td className="num">{r1.cdnr.length} / {r1.cdnur.length}</td></tr>
                <tr><td>HSN/SAC summary rows</td><td className="num">{r1.hsn.length}</td></tr>
              </tbody></table>
              <h3 style={{ marginTop: 14 }}>Documents issued</h3>
              <table className="t"><tbody>{r1.docs.map((d) => <tr key={d.series + d.kind}><td>{d.kind}<div className="muted small">{d.from} → {d.to}</div></td><td className="num">{d.total}{d.cancelled ? ` (${d.cancelled} cancelled)` : ''}</td></tr>)}</tbody></table>
            </div>
            <div className="card card-pad">
              <h3>GSTR-3B — summary</h3>
              <table className="t">
                <thead><tr><th /><th className="num">IGST</th><th className="num">CGST</th><th className="num">SGST</th></tr></thead>
                <tbody>
                  <tr><td>Output tax</td><td className="num">{inr2(r3.outward.igst)}</td><td className="num">{inr2(r3.outward.cgst)}</td><td className="num">{inr2(r3.outward.sgst)}</td></tr>
                  <tr><td>Input credit</td><td className="num">{inr2(r3.itc.igst)}</td><td className="num">{inr2(r3.itc.cgst)}</td><td className="num">{inr2(r3.itc.sgst)}</td></tr>
                  <tr style={{ fontWeight: 700 }}><td>Pay in cash</td><td className="num">{inr2(r3.cash_payable.igst)}</td><td className="num">{inr2(r3.cash_payable.cgst)}</td><td className="num">{inr2(r3.cash_payable.sgst)}</td></tr>
                  {(r3.credit_carried_forward.igst + r3.credit_carried_forward.cgst + r3.credit_carried_forward.sgst) > 0 && <tr><td>Credit left for next month</td><td className="num">{inr2(r3.credit_carried_forward.igst)}</td><td className="num">{inr2(r3.credit_carried_forward.cgst)}</td><td className="num">{inr2(r3.credit_carried_forward.sgst)}</td></tr>}
                </tbody>
              </table>
              <p className="muted small">Input credit counts only purchase bills entered in Kanakku from vendors with a GSTIN. Your CA checks it against GSTR-2B before filing.</p>
            </div>
          </div>
          <div className="card table-wrap" style={{ marginTop: 14 }}>
            <table className="t">
              <thead><tr><th>HSN/SAC</th><th>Type</th><th className="num">Rate</th><th className="num">Qty</th><th className="num">Taxable</th><th className="num">Tax</th></tr></thead>
              <tbody>{r1.hsn.map((h) => <tr key={h.type + h.hsn + h.rate}><td>{h.hsn}</td><td>{h.type}</td><td className="num">{h.rate}%</td><td className="num">{h.qty}</td><td className="num">{inr2(h.taxable)}</td><td className="num">{sumRow(h)}</td></tr>)}</tbody>
            </table>
            {r1.hsn.length === 0 && <Empty>No invoices in {fmtMonth(month)}.</Empty>}
          </div>
        </>
      )}
    </>
  );
}

function Tds() {
  const [f, setF] = useState({ from: presets()[2][1], to: today() });
  const { data, error } = useAsync(() => api(`/reports/tds${qs(f)}`), [JSON.stringify(f)]);
  return (
    <>
      <div className="filters">
        <input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        {data && <button className="btn" onClick={() => downloadCsv(`tds_${f.from}_${f.to}.csv`, [['Date', 'Customer', 'Invoice', 'Brand', 'Received', 'TDS'], ...data.rows.map((r) => [r.entry_date, r.party, r.invoice, r.brand_name, r.received, r.tds_amount])])}>Download (CSV)</button>}
      </div>
      <Err error={error} />
      {data && <>
        <div className="grid g2" style={{ marginBottom: 14 }}><Stat label="TDS deducted by customers" value={inr2(data.total)} tone="in" hint="Claim in the company's income-tax return" /><Stat label="Payments with TDS" value={data.rows.length} /></div>
        <div className="card table-wrap">{data.rows.length === 0 ? <Empty>No TDS recorded in these dates.</Empty> : (
          <table className="t"><thead><tr><th>Date</th><th>Customer</th><th>Invoice</th><th className="num">Received</th><th className="num">TDS</th></tr></thead>
            <tbody>{data.rows.map((r, i) => <tr key={i}><td>{fmtDate(r.entry_date)}</td><td>{r.party}</td><td>{r.invoice || '—'}</td><td className="num">{inr2(r.received)}</td><td className="num">{inr2(r.tds_amount)}</td></tr>)}</tbody></table>)}
        </div>
        <p className="muted small">Match this with Form 26AS / AIS every quarter — if a customer kept TDS but didn't deposit it, ask them for the TDS certificate (Form 16A).</p>
      </>}
    </>
  );
}

function Forecast() {
  const [days, setDays] = useState(60);
  const { data, error } = useAsync(() => api(`/reports/forecast?days=${days}`), [days]);
  if (error) return <Err error={error} />;
  if (!data) return <Loader />;
  const max = Math.max(1, ...data.series.map((s) => Math.abs(s.balance)));
  return (
    <>
      <div className="filters"><div className="seg">{[30, 60, 90].map((d) => <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d} days</button>)}</div></div>
      {data.runs_out_on && <div className="banner bad">At this rate money runs short on <strong>{fmtDate(data.runs_out_on)}</strong> (lowest {inr(data.low.balance)} on {fmtDate(data.low.date)}). Collect dues earlier or move some bills.</div>}
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Stat label="Money now" value={inr(data.start)} />
        <Stat label={`Coming in (${days}d)`} value={inr(data.expected_in)} tone="in" />
        <Stat label={`Going out (${days}d)`} value={inr(data.expected_out)} tone="out" />
        <Stat label={`In ${days} days`} value={inr(data.end_balance)} tone={data.end_balance < 0 ? 'out' : ''} hint={`Lowest ${inr(data.low.balance)} on ${fmtDate(data.low.date)}`} />
      </div>
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <h3>Balance day by day</h3>
        <div className="spark">{data.series.map((s) => <div key={s.date} title={`${fmtDate(s.date)}: ${inr(s.balance)}`} style={{ height: `${Math.max(2, (Math.abs(s.balance) / max) * 100)}%`, background: s.balance < 0 ? 'var(--out)' : 'var(--navy)', opacity: s.in || s.out ? 1 : 0.55 }} />)}</div>
        <div className="row small muted"><span>{fmtDate(data.today)}</span><span className="spacer" /><span>{fmtDate(data.series.at(-1).date)}</span></div>
      </div>
      <div className="card table-wrap">
        {data.upcoming.length === 0 ? <Empty>Nothing expected in or out.</Empty> : (
          <table className="t"><thead><tr><th>Date</th><th>What</th><th className="num">Amount</th></tr></thead>
            <tbody>{data.upcoming.map((e, i) => <tr key={i}><td>{fmtDate(e.date)}</td><td>{e.what}</td><td className={`num ${e.amount > 0 ? 'in' : 'out'}`}>{inr(e.amount)}</td></tr>)}</tbody></table>)}
      </div>
      <p className="muted small">Uses: money in all active accounts, unpaid invoices and bills (by due date; overdue invoices assumed a week late), dues, recurring entries, and entries waiting to be confirmed.</p>
    </>
  );
}

function Budget() {
  const { user, notify } = useApp();
  const [month, setMonth] = useState(today().slice(0, 7));
  const { data, error, reload } = useAsync(() => api(`/reports/budget?month=${month}`), [month]);
  const [rows, setRows] = useState(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (data) setRows(data.rows); }, [data]);
  const admin = user.role === 'admin';
  const save = async () => {
    await api('/reports/budget', { method: 'PUT', body: { month, rows: rows.map((r) => ({ brand_id: r.brand_id, income_target: Number(r.income_target) || 0, expense_limit: Number(r.expense_limit) || 0 })) } });
    setEditing(false); reload(); notify('Budget saved');
  };
  const copy = async () => { await api('/reports/budget/copy', { method: 'POST', body: { from: month, months: 11 } }); notify('Copied to the next 11 months'); };
  if (error) return <Err error={error} />;
  if (!rows) return <Loader />;
  const set = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const bar = (pct, bad) => <div className="bar-track"><div style={{ width: `${Math.min(100, pct || 0)}%`, background: bad ? 'var(--out)' : 'var(--in)' }} /></div>;
  return (
    <>
      <div className="filters">
        <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        {admin && !editing && <button className="btn" onClick={() => setEditing(true)}>Set targets</button>}
        {admin && editing && <><button className="btn primary" onClick={save}>Save</button><button className="btn" onClick={() => { setRows(data.rows); setEditing(false); }}>Cancel</button></>}
        {admin && !editing && <button className="btn" onClick={copy}>Copy to next 11 months</button>}
      </div>
      <div className="card table-wrap">
        <table className="t">
          <thead><tr><th>Brand</th><th className="num">Income</th><th>vs target</th><th className="num">Spend</th><th>vs limit</th><th className="num">Net</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={r.brand_id}>
              <td><BrandTag name={r.brand_name} color={r.brand_color} /></td>
              <td className="num">{inr(r.income)}</td>
              <td style={{ minWidth: 150 }}>{editing ? <input className="input" type="number" value={r.income_target} onChange={(e) => set(i, 'income_target', e.target.value)} placeholder="Target ₹" />
                : r.income_target ? <>{bar(r.income_pct, false)}<div className="small muted">{r.income_pct}% of {inr(r.income_target)}</div></> : <span className="muted small">no target</span>}</td>
              <td className="num">{inr(r.expense)}</td>
              <td style={{ minWidth: 150 }}>{editing ? <input className="input" type="number" value={r.expense_limit} onChange={(e) => set(i, 'expense_limit', e.target.value)} placeholder="Limit ₹" />
                : r.expense_limit ? <>{bar(r.expense_pct, r.expense_pct >= 100)}<div className={`small ${r.expense_pct >= 90 ? 'out' : 'muted'}`}>{r.expense_pct}% of {inr(r.expense_limit)}</div></> : <span className="muted small">no limit</span>}</td>
              <td className={`num ${r.net >= 0 ? 'in' : 'out'}`} style={{ fontWeight: 600 }}>{inr(r.net)}</td>
            </tr>))}</tbody>
        </table>
      </div>
      <p className="muted small">Spend includes each brand's share of office costs. Autopilot alerts admins when a brand passes the alert % of its limit.</p>
    </>
  );
}

const TABS = [['pnl', 'P&L'], ['budget', 'Budget'], ['forecast', 'Cash forecast'], ['gstr', 'GST returns'], ['gst', 'Sales register'], ['tds', 'TDS']];

export default function Reports() {
  const [tab, setTab] = useState(() => { try { return localStorage.getItem('reports-tab') || 'pnl'; } catch { return 'pnl'; } });
  useEffect(() => { try { localStorage.setItem('reports-tab', tab); } catch { /* ignore */ } }, [tab]);
  const El = { pnl: Pnl, budget: Budget, forecast: Forecast, gstr: GstReturns, gst: Gst, tds: Tds }[tab] || Pnl;
  return (
    <>
      <div className="page-head">
        <div><h1>Reports</h1><p>Profit by brand, budgets, cash forecast, and everything your CA needs for GST and TDS.</p></div>
      </div>
      <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      <El />
    </>
  );
}

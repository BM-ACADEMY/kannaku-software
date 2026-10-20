import React, { Fragment, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtDate, fmtMonth, inr, today } from '../lib/format.js';
import { BrandTag, Empty, Err, Loader, Stat, useApp, useAsync } from '../components/ui.jsx';

// What an investor sees when they log in: only their own statement.
export default function Portal() {
  const { user } = useApp();
  const [month, setMonth] = useState(today().slice(0, 7));
  const [open, setOpen] = useState(null);
  const { data, error } = useAsync(() => api(`/portal/statement?month=${month}`), [month]);
  return (
    <>
      <div className="page-head">
        <div><h1>Your profit share</h1><p>Hello {user.name.split(' ')[0]} — this is your statement from Afra Ventures, updated as the books are kept.</p></div>
        <span className="spacer" />
        <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 'auto' }} />
      </div>
      <Err error={error} />
      {!data && !error && <Loader />}
      {data && (
        <>
          <div className="grid g4" style={{ marginBottom: 14 }}>
            <Stat label="Your capital" value={inr(data.capital)} hint={`${data.contributions.length} payment(s)`} />
            <Stat label="Share earned" value={inr(data.total_share)} tone="in" />
            <Stat label="Paid to you" value={inr(data.total_paid)} />
            <Stat label="Still to come" value={inr(data.accrued_unpaid)} hint={data.due_now ? `${inr(data.due_now)} payable now` : `Payouts start from month ${data.investor.payout_from_month}`} />
          </div>
          <div className="row" style={{ marginBottom: 8, gap: 6 }}><span className="muted small">Your share:</span>
            {data.brand_shares.map((b) => <BrandTag key={b.brand_id} code={`${b.brand_name} ${Number(b.share_pct)}%`} color={b.brand_color} />)}</div>
          <div className="card table-wrap" style={{ marginBottom: 14 }}>
            {data.months.length === 0 ? <Empty>No months yet.</Empty> : (
              <table className="t">
                <thead><tr><th>Month</th><th className="num">Net profit</th><th className="num">Your share</th><th className="num">Paid</th></tr></thead>
                <tbody>{data.months.map((m) => (
                  <Fragment key={m.month}>
                    <tr className="click" onClick={() => setOpen(open === m.month ? null : m.month)}>
                      <td>{open === m.month ? '▾' : '▸'} {fmtMonth(m.month)}</td>
                      <td className={`num ${m.net_profit >= 0 ? 'in' : 'out'}`}>{inr(m.net_profit)}</td>
                      <td className="num" style={{ fontWeight: 600 }}>{inr(m.share)}</td><td className="num">{m.paid ? inr(m.paid) : '—'}</td>
                    </tr>
                    {open === m.month && m.brands.map((b) => (
                      <tr key={b.brand_id} className="brk"><td style={{ paddingLeft: 30 }}>{b.brand_name} · {b.share_pct}%</td>
                        <td className={`num ${b.net >= 0 ? 'in' : 'out'}`}>{inr(b.net)}</td><td className="num">{inr(b.share)}</td><td /></tr>))}
                  </Fragment>))}</tbody>
              </table>
            )}
          </div>
          <div className="grid g2">
            <div className="card card-pad"><h3>Capital you put in</h3>{data.contributions.map((c) => <div key={c.id} className="row" style={{ padding: '6px 0' }}><span>{fmtDate(c.received_on)}</span><span className="spacer" /><strong className="num">{inr(c.amount)}</strong></div>)}</div>
            <div className="card card-pad"><h3>Payouts</h3>{data.payouts.length === 0 ? <div className="muted">None yet.</div> : data.payouts.map((p) => <div key={p.id} className="row" style={{ padding: '6px 0' }}><span>{fmtMonth(p.period)}</span><span className="muted small">paid {fmtDate(p.paid_on)}</span><span className="spacer" /><strong className="num">{inr(p.amount)}</strong></div>)}</div>
          </div>
          <p className="muted small">Profit is counted without GST (it belongs to the government).{data.investor.loss_rule === 'pooled' ? ' A loss in one brand reduces that month\'s share from the others.' : ' A brand that makes a loss in a month counts as zero.'} Months already closed in the books never change.</p>
        </>
      )}
    </>
  );
}

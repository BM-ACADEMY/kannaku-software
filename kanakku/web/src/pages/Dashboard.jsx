import React from 'react';
import { api } from '../lib/api.js';
import { inr, fmtDate, fmtMonth, today } from '../lib/format.js';
import { BrandTag, Empty, Err, Loader, Money, Stat, useApp, useAsync } from '../components/ui.jsx';

export default function Dashboard() {
  const { user, go } = useApp();
  const { data, error } = useAsync(() => api('/reports/dashboard'), []);
  if (error) return <Err error={error} />;
  if (!data) return <Loader />;
  const m = data.month;
  const maxNet = m ? Math.max(1, ...m.brands.map((b) => Math.abs(b.net))) : 1;

  return (
    <>
      <div className="page-head">
        <div><h1>Vanakkam, {user.name.split(' ')[0]}</h1><p>{fmtDate(today())} · Afra Ventures</p></div>
      </div>

      {m ? (
        <div className="grid g4" style={{ marginBottom: 14 }}>
          <Stat label="Today in / out" value={<><span className="in">{inr(data.today.income)}</span> <span className="muted" style={{ fontWeight: 400 }}>/</span> <span className="out">{inr(data.today.expense)}</span></>} />
          <Stat label={`${fmtMonth(today().slice(0, 7))} net`} value={inr(m.net)} tone={m.net >= 0 ? 'in' : 'out'} hint={`In ${inr(m.income)} · Out ${inr(m.expense)}`} />
          <Stat label="To collect" value={inr(data.receivable)} hint={data.overdue_invoices ? `${data.overdue_invoices} invoice${data.overdue_invoices > 1 ? 's' : ''} overdue` : 'Nothing overdue'} />
          <Stat label="To pay" value={inr(data.payable)} hint="Open payables" />
        </div>
      ) : (
        <div className="grid g2" style={{ marginBottom: 14 }}>
          <Stat label="Open quotes" value={data.open_quotes.count} hint={inr(data.open_quotes.amount)} />
          <Stat label="To collect" value={inr(data.receivable)} hint={`${data.overdue_invoices} overdue`} />
        </div>
      )}

      {m && (
        <div className="grid g2">
          <div className="card card-pad">
            <h3>This month by brand</h3>
            {m.brands.length === 0 && <Empty>No entries this month yet.</Empty>}
            <div className="grid" style={{ gap: 12 }}>
              {m.brands.map((b) => (
                <div key={b.brand_id}>
                  <div className="row" style={{ marginBottom: 5 }}>
                    <span>{b.brand_name}</span><span className="spacer" />
                    <span className={`num ${b.net >= 0 ? 'in' : 'out'}`} style={{ fontWeight: 600 }}>{inr(b.net)}</span>
                  </div>
                  <div className="brand-bar"><div style={{ width: `${(Math.abs(b.net) / maxNet) * 100}%`, background: b.net >= 0 ? b.brand_color : 'var(--out)' }} /></div>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="card-pad row" style={{ paddingBottom: 6 }}>
              <h3 style={{ margin: 0 }}>Latest entries</h3><span className="spacer" />
              <button className="btn sm" onClick={() => go('book')}>Open Book</button>
            </div>
            {data.recent.length === 0 ? <Empty>No entries yet.</Empty> : (
              <table className="t"><tbody>
                {data.recent.map((e) => (
                  <tr key={e.id}>
                    <td><BrandTag code={e.brand_code} color={e.brand_color} /></td>
                    <td><div>{e.party || e.category_name || '—'}</div><div className="muted small">{fmtDate(e.entry_date)}</div></td>
                    <td className="num"><Money v={e.amount} type={e.type} /></td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </div>
        </div>
      )}
    </>
  );
}

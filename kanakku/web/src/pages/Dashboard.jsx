import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { inr, fmtDate, fmtMonth, today } from '../lib/format.js';
import { BrandTag, Empty, Err, Loader, Money, Stat, useApp, useAsync } from '../components/ui.jsx';

const STATE = { paid: ['Paid'], due: ['Due today'], overdue: ['Overdue'], partial: ['Part paid'], upcoming: ['Upcoming'] };

// Instalment plans: progress per plan, and one-tap recording of the next instalment
function PaymentPlans({ plans, reload }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState('');
  const pay = async (plan, slab) => {
    if (!window.confirm(`Record ₹${Math.round(slab.left).toLocaleString('en-IN')} received from ${plan.customer} for instalment ${slab.position}?`)) return;
    setBusy(slab.id); setErr('');
    try { await api(`/plans/slabs/${slab.id}/pay`, { method: 'POST', body: {} }); reload(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };
  return (
    <div className="card card-pad">
      <div className="row" style={{ marginBottom: 10 }}><h3 style={{ margin: 0 }}>Payment plans</h3><span className="spacer" /><span className="small muted">Split invoices</span></div>
      <Err error={err} />
      {plans.length === 0 && <Empty>No instalment plans. Open an invoice in Deals and press “Split into instalments”.</Empty>}
      {plans.map((pl) => {
        const pct = pl.total ? Math.min(100, Math.round((pl.paid / pl.total) * 100)) : 0;
        return (
          <div key={pl.id} className="plan">
            <div className="row"><b className="ellipsis">{pl.customer}</b><span className="spacer" /><span className="num">{inr(pl.paid)} of {inr(pl.total)}</span></div>
            <div className="small muted">{pl.name} · {pl.number} · {pl.brand}{pl.overdue ? ` · ${pl.overdue} overdue` : ''}</div>
            <div className="plan-bar"><i style={{ width: `${pct}%` }} /></div>
            <div className="plan-slabs">
              {pl.slabs.map((s) => (
                <span key={s.id} className={`slab ${s.state}`}>{s.position} · {inr(s.amount)} · {new Date(`${s.due_date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} · {STATE[s.state][0]}</span>
              ))}
            </div>
            {pl.next && (
              <div className="row" style={{ marginTop: 8 }}>
                <span className="small">Next: instalment {pl.next.position} · {inr(pl.next.left)}</span><span className="spacer" />
                <button className="btn sm green" disabled={busy === pl.next.id} onClick={() => pay(pl, pl.next)}>{busy === pl.next.id ? 'Saving…' : 'Record received'}</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Top accounts with each account's change over the last 7 days. Tap two to compare them.
function TopAccounts({ accounts }) {
  const [sel, setSel] = useState([]);
  const list = [...accounts].sort((x, y) => y.balance - x.balance);
  const max = Math.max(1, ...list.map((x) => Math.abs(x.balance)));
  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((v) => v !== id) : [...s, id].slice(-2)));
  const [a, b] = sel.map((id) => list.find((x) => x.id === id)).filter(Boolean);
  return (
    <div className="card card-pad">
      <div className="row" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Top accounts</h3><span className="spacer" />
        <span className="small muted">{sel.length === 2 ? 'Comparing two' : 'Tap two to compare'}</span>
      </div>
      <div>
        {list.map((x, i) => (
          <button key={x.id} className={`acc-row ${sel.includes(x.id) ? 'on' : ''}`} onClick={() => toggle(x.id)}>
            <span className="acc-name">{x.name}</span>
            <span className="acc-bar"><i style={{ width: `${(Math.max(0, x.balance) / max) * 100}%`, animationDelay: `${i * 0.08}s` }} /></span>
            <span className="acc-val num">
              {inr(x.balance)}
              <small className={x.change7 >= 0 ? 'in' : 'out'}>{x.change7 >= 0 ? ' ▲ ' : ' ▼ '}{inr(Math.abs(x.change7))} in 7 days</small>
            </span>
          </button>
        ))}
      </div>
      {a && b && (
        <div className="acc-compare">
          <div><span className="muted small">{a.name}</span><b>{inr(a.balance)}</b></div>
          <div className="acc-vs">vs</div>
          <div style={{ textAlign: 'right' }}><span className="muted small">{b.name}</span><b>{inr(b.balance)}</b>
            <div className="small muted">Difference {inr(Math.abs(a.balance - b.balance))}</div></div>
        </div>
      )}
    </div>
  );
}

const ACTION_WORDS = { create: 'added', update: 'changed', delete: 'deleted', confirm: 'confirmed', approve: 'approved', close_books: 'closed the books' };
const ENTITY_PAGE = { entry: 'book', entries: 'book', account: 'money', petty_cash: 'money', document: 'deals', investor: 'investors', settings: 'settings', user: 'settings', brand: 'settings' };

// Activity history: who changed what, newest first. Admin only (the audit endpoint is admin-only).
function Activity() {
  const { go } = useApp();
  const { data, error } = useAsync(() => api('/audit?limit=8'), []);
  const [more, setMore] = useState([]);
  const [next, setNext] = useState(undefined);
  const [busy, setBusy] = useState(false);
  if (error) return <div className="card card-pad"><Err error={error} /></div>;
  if (!data) return <div className="card card-pad"><Loader /></div>;
  const rows = [...data.rows, ...more];
  const cursor = next !== undefined ? next : data.next;
  const loadMore = async () => {
    setBusy(true);
    try { const r = await api(`/audit?limit=8&before=${cursor}`); setMore((m) => [...m, ...r.rows]); setNext(r.next); } finally { setBusy(false); }
  };
  return (
    <div className="card card-pad">
      <div className="row" style={{ marginBottom: 6 }}><h3 style={{ margin: 0 }}>Activity</h3><span className="spacer" /><span className="small muted">Newest first</span></div>
      {rows.length === 0 && <Empty>No activity yet.</Empty>}
      {rows.map((r) => {
        const page = ENTITY_PAGE[r.entity];
        const when = new Date(r.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
        return (
          <div key={r.id} className="act-row" onClick={() => page && go(page)} style={{ cursor: page ? 'pointer' : 'default' }}>
            <span className="act-dot" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div><b>{r.user_name || 'Autopilot'}</b> {ACTION_WORDS[r.action] || r.action} {r.entity.replace(/_/g, ' ')}{r.entity_id ? ` #${r.entity_id}` : ''}</div>
              <div className="small muted">{when}</div>
            </div>
          </div>
        );
      })}
      {cursor && rows.length > 0 && (
        <button className="btn sm" style={{ marginTop: 10 }} disabled={busy} onClick={loadMore}>{busy ? 'Loading…' : 'Show more'}</button>
      )}
    </div>
  );
}

export default function Dashboard() {
  const { user, go } = useApp();
  const { data, error, reload } = useAsync(() => api('/reports/dashboard'), []);
  if (error) return <Err error={error} />;
  if (!data) return <Loader />;
  const m = data.month;
  const a = data.attention; // only sent to admin and accounts
  // One scale for every brand, so the bars can be compared
  const maxVal = m ? Math.max(1, ...m.brands.flatMap((b) => [b.income, b.expense])) : 1;

  // Things that need a person today, most urgent first
  const items = [];
  if (a) {
    if (a.cash_waiting > 0) items.push({ tone: 'bad', text: `${inr(a.cash_waiting)} cash from before today not handed over`, to: 'money', btn: 'Open' });
    if (a.cash_low) items.push({ tone: 'warn', text: `Petty cash box is low (${inr(a.cash_balance)})`, to: 'money', btn: 'Top up' });
    if (a.pending_approval > 0) items.push({ tone: 'warn', text: `${a.pending_approval} staff spend${a.pending_approval === 1 ? '' : 's'} waiting for approval`, to: 'book', btn: 'Review' });
    if (data.pending_count > 0) items.push({ tone: 'warn', text: `${data.pending_count} autopilot entr${data.pending_count === 1 ? 'y' : 'ies'} to confirm`, to: 'book', btn: 'Confirm' });
    if (a.bills_missing > 0) items.push({ tone: 'warn', text: `${a.bills_missing} cash spend${a.bills_missing === 1 ? '' : 's'} with no bill photo`, to: 'money', btn: 'Open' });
    if (data.unmatched_bank > 0) items.push({ tone: 'info', text: `${data.unmatched_bank} bank line${data.unmatched_bank === 1 ? '' : 's'} to sort`, to: 'money', btn: 'Sort' });
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Vanakkam, {user.name.split(' ')[0]}</h1><p>{fmtDate(today())} · Afra Ventures</p></div>
      </div>

      {items.length > 0 ? (
        <div className="attn-row" role="list" aria-label="Needs your action">
          {items.map((it) => (
            <button key={it.text} role="listitem" className={`attn ${it.tone}`} onClick={() => go(it.to)}>
              <span>{it.text}</span><span className="attn-go">{it.btn} →</span>
            </button>
          ))}
        </div>
      ) : a && <div className="attn-ok">✓ Nothing needs your action right now.</div>}

      {m && data.forecast?.runs_out_on && (
        <div className="banner bad">Cash may run short on {fmtDate(data.forecast.runs_out_on)} (lowest {inr(data.forecast.low.balance)}).<button className="btn sm" onClick={() => go('reports')}>See forecast</button></div>
      )}
      {m ? (
        <div className="grid g4" style={{ marginBottom: 14 }}>
          <Stat label="Money in accounts" value={inr(data.cash_total)} tone={data.cash_total < 0 ? 'out' : ''}
            hint={data.forecast ? `In 30 days: ${inr(data.forecast.end_balance)}` : `${data.balances?.length || 0} accounts`} />
          <Stat label={`${fmtMonth(today().slice(0, 7))} net`} value={inr(m.net)} tone={m.net >= 0 ? 'in' : 'out'} hint={`In ${inr(m.income)} · Out ${inr(m.expense)}`} />
          <Stat label="To collect" value={inr(data.receivable)} hint={data.overdue_invoices ? `${data.overdue_invoices} invoice${data.overdue_invoices > 1 ? 's' : ''} overdue` : 'Nothing overdue'} />
          <Stat label="To pay" value={inr(data.payable)} hint={`Today: in ${inr(data.today.income)} · out ${inr(data.today.expense)}`} />
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
            <div className="row" style={{ marginBottom: 14 }}>
              <h3 style={{ margin: 0 }}>This month by brand</h3><span className="spacer" />
              <span className="legend"><span className="sw in" />Money in <span className="sw out" />Money out</span>
            </div>
            {m.brands.length === 0 && <Empty>No entries this month yet.</Empty>}
            <div className="grid" style={{ gap: 16 }}>
              {m.brands.map((b) => (
                <div key={b.brand_id}>
                  <div className="row" style={{ marginBottom: 6 }}>
                    <span className="brand-name"><span className="dot" style={{ background: b.brand_color || '#71717a' }} />{b.brand_name}</span>
                    <span className="spacer" />
                    <span className={`num ${b.net >= 0 ? 'in' : 'out'}`} style={{ fontWeight: 600 }}>{b.net >= 0 ? '+' : '−'}{inr(Math.abs(b.net))}</span>
                  </div>
                  <div className="brand-bar"><div style={{ width: `${(b.income / maxVal) * 100}%`, background: 'var(--in)' }} /></div>
                  <div className="brand-bar thin"><div style={{ width: `${(b.expense / maxVal) * 100}%`, background: 'var(--out)' }} /></div>
                  <div className="brand-sub">In {inr(b.income)} · Out {inr(b.expense)}</div>
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
                {data.recent.map((e) => {
                  const primary = e.party || e.category_name || 'No description';
                  const sub = [e.party && e.category_name, fmtDate(e.entry_date), e.account_name].filter(Boolean).join(' · ');
                  return (
                    <tr key={e.id}>
                      <td style={{ width: 1 }}><BrandTag code={e.brand_code} color={e.brand_color} /></td>
                      <td><div className="ellipsis">{primary}</div><div className="muted small ellipsis">{sub}</div></td>
                      <td className="num">
                        {e.type === 'transfer'
                          ? <span className="muted" title="Moved between our own accounts">⇄ {inr(e.amount)}</span>
                          : <Money v={e.amount} type={e.type} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody></table>
            )}
          </div>
        </div>
      )}

      {m && data.accounts && (
        <div className="grid g2" style={{ marginTop: 14 }}>
          <TopAccounts accounts={data.accounts} />
          {user.role === 'admin' && <Activity />}
        </div>
      )}
      {m && data.plans && (
        <div className="grid" style={{ marginTop: 14 }}>
          <PaymentPlans plans={data.plans} reload={reload} />
        </div>
      )}
    </>
  );
}

import React, { Fragment, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtDate, fmtMonth, inr, today } from '../lib/format.js';
import { BrandTag, Empty, Err, Field, Loader, Modal, Stat, useApp, useAsync } from '../components/ui.jsx';
import { splitBrands } from '../components/SplitEditor.jsx';

function InvestorForm({ initial, onClose, onSaved }) {
  const { boot } = useApp();
  const brands = splitBrands(boot);
  const [i, setI] = useState(() => {
    const base = initial || { name: '', phone: '', email: '', profit_share_pct: 14, start_date: today(), payout_from_month: 4, statement_day: 10, notes: '', active: true,
      loss_rule: 'pooled', include_shared_costs: true };
    // per-brand %: saved rows, or the old single % on investor-pool brands
    const own = initial?.brands?.length ? initial.brands : null;
    const shares = Object.fromEntries(brands.map((b) => [b.id,
      own ? (own.find((x) => x.brand_id === b.id)?.share_pct ?? '') : (b.in_investor_pool ? base.profit_share_pct : '')]));
    return { ...base, shares, brands_effective_from: today().slice(0, 7) };
  });
  const [error, setError] = useState('');
  const set = (k) => (e) => setI({ ...i, [k]: e.target.value });
  const setShare = (id, v) => setI({ ...i, shares: { ...i.shares, [id]: v } });
  const allTo = (v) => setI({ ...i, shares: Object.fromEntries(Object.entries(i.shares).map(([k, x]) => [k, x === '' || Number(x) === 0 ? x : v])) });
  const picked = Object.entries(i.shares).filter(([, v]) => Number(v) > 0);
  const save = async () => {
    try {
      const body = { ...i, payout_from_month: Number(i.payout_from_month), statement_day: Number(i.statement_day),
        brands: picked.map(([id, v]) => ({ brand_id: Number(id), share_pct: Number(v) })),
        profit_share_pct: picked.length ? Math.max(...picked.map(([, v]) => Number(v))) : 0 };
      delete body.shares;
      onSaved(i.id ? await api(`/investors/${i.id}`, { method: 'PUT', body }) : await api('/investors', { method: 'POST', body }));
    } catch (e) { setError(e.message); }
  };
  return (
    <Modal wide title={i.id ? 'Edit investor' : 'New investor'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={!i.name || !picked.length}>Save</button></>}>
      <Err error={error} />
      <div className="grid g4">
        <Field label="Name"><input className="input" value={i.name} onChange={set('name')} /></Field>
        <Field label="WhatsApp number"><input className="input" value={i.phone || ''} onChange={set('phone')} /></Field>
        <Field label="Email"><input className="input" value={i.email || ''} onChange={set('email')} /></Field>
        <Field label="Start date"><input className="input" type="date" value={i.start_date || ''} onChange={set('start_date')} /></Field>
      </div>

      <div>
        <div className="row" style={{ marginBottom: 6 }}>
          <strong>Profit share by brand</strong><span className="muted small">— leave blank for brands they don't share in</span><span className="spacer" />
          <span className="small muted">Set all picked to</span>
          {[10, 14, 15, 20].map((v) => <button key={v} type="button" className="btn sm" onClick={() => allTo(v)}>{v}%</button>)}
        </div>
        <div className="split-box"><div className="split-grid">
          {brands.map((b) => (
            <label key={b.id} className={`split-row${Number(i.shares[b.id]) > 0 ? ' on' : ''}`} style={{ gridTemplateColumns: '10px 1fr 70px 12px' }}>
              <span className="dot" style={{ background: b.color }} /><span className="split-name">{b.name}</span>
              <input className="input" type="number" step="0.01" min="0" max="100" placeholder="—" value={i.shares[b.id]} onChange={(e) => setShare(b.id, e.target.value)} />
              <span className="small muted">%</span>
            </label>
          ))}
        </div></div>
      </div>

      <div className="grid g4">
        {i.id && <Field label="These % apply from month"><input className="input" type="month" value={i.brands_effective_from} onChange={set('brands_effective_from')} /></Field>}
        <Field label="Loss in one brand">
          <select className="input" value={i.loss_rule} onChange={set('loss_rule')}>
            <option value="pooled">Reduces the other brands' share (pooled)</option>
            <option value="per_brand">Counts as zero (each brand on its own)</option>
          </select>
        </Field>
        <Field label="Shared office costs (EB, rent…)">
          <select className="input" value={i.include_shared_costs ? '1' : '0'} onChange={(e) => setI({ ...i, include_shared_costs: e.target.value === '1' })}>
            <option value="1">Deducted — brand's slice counts</option><option value="0">Not deducted</option>
          </select>
        </Field>
        <Field label="First payout in month #"><input className="input" type="number" value={i.payout_from_month} onChange={set('payout_from_month')} /></Field>
      </div>
      {i.id && <div className="note-box">Changing a % only affects months from the month you pick. Earlier months keep the old %, so past statements don't change.</div>}
      <div className="grid g2">
        <Field label="Statement due by day"><input className="input" type="number" value={i.statement_day} onChange={set('statement_day')} /></Field>
        <Field label="Active"><select className="input" value={i.active ? '1' : '0'} onChange={(e) => setI({ ...i, active: e.target.value === '1' })}><option value="1">Yes</option><option value="0">No</option></select></Field>
      </div>
      <Field label="Notes"><textarea className="input" value={i.notes || ''} onChange={set('notes')} /></Field>
    </Modal>
  );
}

function MoneyForm({ title, fields, onClose, onSubmit }) {
  const [v, setV] = useState(Object.fromEntries(fields.map((f) => [f.k, f.def ?? ''])));
  const [error, setError] = useState('');
  const save = async () => { try { await onSubmit(v); } catch (e) { setError(e.message); } };
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      <Err error={error} />
      <div className="grid g2">
        {fields.map((f) => <Field key={f.k} label={f.label}><input className="input" type={f.type || 'text'} value={v[f.k]} onChange={(e) => setV({ ...v, [f.k]: e.target.value })} /></Field>)}
      </div>
    </Modal>
  );
}

function Statement({ inv, onBack, onEdit }) {
  const { user, notify } = useApp();
  const [month, setMonth] = useState(today().slice(0, 7));
  const [mode, setMode] = useState(null);
  const [openMonth, setOpenMonth] = useState(null);
  const { data, error, reload } = useAsync(() => api(`/investors/${inv.id}/statement?month=${month}`), [inv.id, month, inv]);
  const admin = user.role === 'admin';

  const shareText = data && encodeURIComponent(`Afra Ventures — profit statement up to ${fmtMonth(month)}\n` +
    data.months.map((m) => `${fmtMonth(m.month)}: ` + m.brands.map((b) => `${b.brand_code} ${inr(b.net)}×${b.share_pct}%`).join(', ') + ` → your share ${inr(m.share)}`).join('\n') +
    `\nTotal share: ${inr(data.total_share)} · Paid: ${inr(data.total_paid)} · Balance: ${inr(data.accrued_unpaid)}`);

  return (
    <>
      <div className="page-head">
        <div><button className="btn ghost sm" onClick={onBack} style={{ padding: 0, marginBottom: 6 }}>← All investors</button>
          <h1>{inv.name}</h1><p>{inv.loss_rule === 'per_brand' ? 'Each brand counted on its own' : 'Brands pooled — losses offset gains'} · shared costs {inv.include_shared_costs ? 'deducted' : 'not deducted'} · payouts from month {inv.payout_from_month}</p></div>
        <span className="spacer" />
        <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 'auto' }} />
        {admin && <button className="btn" onClick={onEdit}>Edit</button>}
        {admin && <button className="btn" onClick={() => setMode('contrib')}>+ Capital received</button>}
        {admin && <button className="btn primary" onClick={() => setMode('payout')}>+ Payout</button>}
      </div>
      <Err error={error} />
      {!data && !error && <Loader />}
      {data && (
        <>
          <div className="grid g4" style={{ marginBottom: 14 }}>
            <Stat label="Capital in" value={inr(data.capital)} hint={`${data.contributions.length} tranche(s)`} />
            <Stat label="Total share earned" value={inr(data.total_share)} />
            <Stat label="Paid out" value={inr(data.total_paid)} />
            <Stat label="Balance owed" value={inr(data.accrued_unpaid)} tone={data.accrued_unpaid > 0 ? 'out' : ''} hint={data.due_now ? `${inr(data.due_now)} payable now` : 'Accruing — not payable yet'} />
          </div>
          <div className="row" style={{ marginBottom: 8, gap: 6 }}>
            <span className="muted small">Share now:</span>
            {data.brand_shares.map((b) => <BrandTag key={b.brand_id} code={`${b.brand_code} ${Number(b.share_pct)}%`} color={b.brand_color} />)}
            {data.share_history.length > 1 && <span className="muted small">· changed {data.share_history.length - 1}× (see each month)</span>}
          </div>
          <div className="card table-wrap" style={{ marginBottom: 14 }}>
            {data.months.length === 0 ? <Empty>No months yet.</Empty> : (
              <table className="t">
                <thead><tr><th>Month</th><th className="num">Income</th><th className="num">Expense</th><th className="num">Net profit</th><th className="num">Share</th><th className="num">Paid</th></tr></thead>
                <tbody>{data.months.map((m) => (
                  <Fragment key={m.month}>
                    <tr className="click" onClick={() => setOpenMonth(openMonth === m.month ? null : m.month)}>
                      <td>{openMonth === m.month ? '▾' : '▸'} {fmtMonth(m.month)} <span className="muted small">#{m.month_no}{!m.payable_now ? ' · accrues' : ''}</span></td>
                      <td className="num">{inr(m.income)}</td><td className="num">{inr(m.expense)}</td>
                      <td className={`num ${m.net_profit >= 0 ? 'in' : 'out'}`}>{inr(m.net_profit)}</td>
                      <td className="num" style={{ fontWeight: 600 }}>{inr(m.share)}</td><td className="num">{m.paid ? inr(m.paid) : '—'}</td>
                    </tr>
                    {openMonth === m.month && m.brands.map((b) => (
                      <tr key={b.brand_id} className="brk">
                        <td style={{ paddingLeft: 30 }}><BrandTag name={b.brand_name} color={b.brand_color} /> <span className="muted small">{b.share_pct}%</span></td>
                        <td className="num">{inr(b.income)}</td>
                        <td className="num">{inr(b.expense)}{b.shared_expense > 0 && <div className="muted small">incl. {inr(b.shared_expense)} shared</div>}</td>
                        <td className={`num ${b.net >= 0 ? 'in' : 'out'}`}>{inr(b.net)}</td>
                        <td className="num">{inr(b.share)}</td><td />
                      </tr>
                    ))}
                  </Fragment>
                ))}</tbody>
                <tfoot><tr><td>Total</td><td /><td /><td /><td className="num">{inr(data.total_share)}</td><td className="num">{inr(data.total_paid)}</td></tr></tfoot>
              </table>
            )}
          </div>
          <div className="grid g2">
            <div className="card card-pad"><h3>Capital received</h3>
              {data.contributions.length === 0 ? <div className="muted">None yet.</div> : data.contributions.map((c) => (
                <div key={c.id} className="row" style={{ padding: '6px 0' }}><span>{fmtDate(c.received_on)}</span><span className="muted small">{c.mode}</span><span className="spacer" /><strong className="num">{inr(c.amount)}</strong></div>))}
            </div>
            <div className="card card-pad"><h3>Payouts</h3>
              {data.payouts.length === 0 ? <div className="muted">None yet.</div> : data.payouts.map((p) => (
                <div key={p.id} className="row" style={{ padding: '6px 0' }}><span>{fmtMonth(p.period)}</span><span className="muted small">paid {fmtDate(p.paid_on)}</span><span className="spacer" /><strong className="num">{inr(p.amount)}</strong></div>))}
            </div>
          </div>
          {inv.phone && <div style={{ marginTop: 14 }}><a className="btn" target="_blank" rel="noreferrer"
            href={`https://wa.me/${inv.phone.replace(/\D/g, '').replace(/^(\d{10})$/, '91$1')}?text=${shareText}`}>Send statement on WhatsApp</a></div>}
        </>
      )}
      {mode === 'contrib' && <MoneyForm title="Capital received" onClose={() => setMode(null)}
        fields={[{ k: 'amount', label: 'Amount ₹', type: 'number' }, { k: 'received_on', label: 'Received on', type: 'date', def: today() }, { k: 'mode', label: 'Mode (bank / cash)' }, { k: 'note', label: 'Note' }]}
        onSubmit={async (v) => { await api(`/investors/${inv.id}/contributions`, { method: 'POST', body: { ...v, amount: Number(v.amount) } }); setMode(null); reload(); notify('Saved'); }} />}
      {mode === 'payout' && <MoneyForm title="Record payout" onClose={() => setMode(null)}
        fields={[{ k: 'period', label: 'For month (YYYY-MM)', def: month }, { k: 'amount', label: 'Amount ₹', type: 'number', def: data?.due_now || '' }, { k: 'paid_on', label: 'Paid on', type: 'date', def: today() }, { k: 'note', label: 'Note' }]}
        onSubmit={async (v) => { await api(`/investors/${inv.id}/payouts`, { method: 'POST', body: { ...v, amount: Number(v.amount) } }); setMode(null); reload(); notify('Payout recorded'); }} />}
    </>
  );
}

export default function Investors() {
  const { user, notify } = useApp();
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState(null);
  const { data, error, reload } = useAsync(() => api('/investors'), []);
  const current = open && data?.find((i) => i.id === open);

  return (
    <>
      {current ? <Statement inv={current} onBack={() => setOpen(null)} onEdit={() => setForm(current)} /> : (
        <>
          <div className="page-head">
            <div><h1>Investors</h1><p>Profit-share partners — capital in, monthly share, payouts.</p></div>
            <span className="spacer" />
            {user.role === 'admin' && <button className="btn primary" onClick={() => setForm({})}>+ New investor</button>}
          </div>
          <Err error={error} />
          {!data && !error && <Loader />}
          {data && (
            <div className="card table-wrap">
              {data.length === 0 ? <Empty>No investors added.</Empty> : (
                <table className="t">
                  <thead><tr><th>Name</th><th>Share by brand</th><th className="num">Capital</th><th className="num">Paid out</th><th>Since</th></tr></thead>
                  <tbody>{data.map((i) => (
                    <tr key={i.id} className="click" onClick={() => setOpen(i.id)}>
                      <td style={{ fontWeight: 600 }}>{i.name}{!i.active && <span className="pill" style={{ marginLeft: 6 }}>inactive</span>}</td>
                      <td>{i.brands?.length ? <div className="split-chips">{i.brands.map((b) => <span key={b.brand_id} className="tag">{b.brand_code} {Number(b.share_pct)}%</span>)}</div> : `${i.profit_share_pct}% on pool brands`}</td><td className="num">{inr(i.capital)}</td><td className="num">{inr(i.paid_out)}</td><td>{fmtDate(i.start_date)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
      {form && <InvestorForm initial={form.id ? form : null} onClose={() => setForm(null)} onSaved={() => { setForm(null); reload(); notify('Saved'); }} />}
    </>
  );
}

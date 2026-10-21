import React, { useState } from 'react';
import { api, qs } from '../lib/api.js';
import { fmtDate, inr, inr2, today } from '../lib/format.js';
import { BrandSelect, BrandTag, Empty, Err, Field, Loader, Modal, Stat, useApp, useAsync } from '../components/ui.jsx';

function DueForm({ initial, onClose, onSaved }) {
  const [d, setD] = useState(initial || { direction: 'receivable', brand_id: '', party: '', phone: '', amount: '', due_date: '', note: '' });
  const [error, setError] = useState('');
  const set = (k) => (e) => setD({ ...d, [k]: e?.target ? e.target.value : e });
  const save = async () => {
    try {
      const body = { ...d, amount: Number(d.amount), due_date: d.due_date || null };
      onSaved(d.id ? await api(`/dues/${d.id}`, { method: 'PUT', body }) : await api('/dues', { method: 'POST', body }));
    } catch (e) { setError(e.message); }
  };
  return (
    <Modal title={d.id ? 'Edit due' : 'New due'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={save} disabled={!d.brand_id || !d.party || !d.amount}>Save</button></>}>
      <Err error={error} />
      <div className="seg">
        <button className={d.direction === 'receivable' ? 'on in' : ''} onClick={() => setD({ ...d, direction: 'receivable' })}>We must collect</button>
        <button className={d.direction === 'payable' ? 'on out' : ''} onClick={() => setD({ ...d, direction: 'payable' })}>We must pay</button>
      </div>
      <div className="grid g2">
        <Field label="Brand"><BrandSelect value={d.brand_id} onChange={set('brand_id')} /></Field>
        <Field label="Amount ₹"><input className="input" type="number" value={d.amount} onChange={set('amount')} /></Field>
        <Field label="Party"><input className="input" value={d.party} onChange={set('party')} /></Field>
        <Field label="WhatsApp number"><input className="input" value={d.phone || ''} onChange={set('phone')} /></Field>
        <Field label="Due date"><input className="input" type="date" value={d.due_date || ''} onChange={set('due_date')} /></Field>
      </div>
      <Field label="Note"><input className="input" value={d.note || ''} onChange={set('note')} /></Field>
    </Modal>
  );
}

function SettleForm({ due, onClose, onSaved }) {
  const { boot } = useApp();
  const type = due.direction === 'receivable' ? 'in' : 'out';
  const [p, setP] = useState({ amount: due.balance, paid_on: today(), account_id: '', category_id: '', ref: '' });
  const [error, setError] = useState('');
  const save = async () => {
    try { onSaved(await api(`/dues/${due.id}/settle`, { method: 'POST', body: { ...p, account_id: p.account_id || null, category_id: p.category_id || null } })); }
    catch (e) { setError(e.message); }
  };
  return (
    <Modal title={`Settle — ${due.party}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn green" onClick={save}>Settle</button></>}>
      <Err error={error} />
      <div className="note-box">Balance {inr2(due.balance)}. A "{type === 'in' ? 'Money in' : 'Money out'}" entry will be added to the Book.</div>
      <div className="grid g2">
        <Field label="Amount ₹"><input className="input" type="number" value={p.amount} onChange={(e) => setP({ ...p, amount: e.target.value })} /></Field>
        <Field label="Date"><input className="input" type="date" value={p.paid_on} onChange={(e) => setP({ ...p, paid_on: e.target.value })} /></Field>
        <Field label="Via"><select className="input" value={p.account_id} onChange={(e) => setP({ ...p, account_id: e.target.value })}>
          <option value="">—</option>{boot.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Category"><select className="input" value={p.category_id} onChange={(e) => setP({ ...p, category_id: e.target.value })}>
          <option value="">—</option>{boot.categories.filter((c) => c.kind === type).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      </div>
    </Modal>
  );
}

export default function Dues() {
  const { user, notify, go } = useApp();
  const [show, setShow] = useState('open');
  const [dir, setDir] = useState('receivable');
  const [form, setForm] = useState(null);
  const [settle, setSettle] = useState(null);
  const { data, error, reload } = useAsync(() => api(`/dues${qs({ status: show })}`), [show]);
  const canEdit = user.role !== 'sales';
  const rows = (data?.rows || []).filter((r) => r.direction === dir);

  const remind = async (r) => {
    const phone = String(r.phone || '').replace(/\D/g, '').replace(/^(\d{10})$/, '91$1');
    const text = encodeURIComponent(`Hello ${r.party}, a gentle reminder that ${inr2(r.balance)} is due${r.number ? ` for invoice ${r.number}` : ''} to ${r.brand_name}${r.due_date ? ` (due ${fmtDate(r.due_date)})` : ''}. Thank you!`);
    window.open(`https://wa.me/${phone}?text=${text}`, '_blank');
    if (r.origin === 'manual') await api(`/dues/${r.id}/reminded`, { method: 'POST' }).catch(() => {});
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Dues</h1><p>Unpaid invoices show up here on their own. Add anything else by hand.</p></div>
        <span className="spacer" />
        {canEdit && <button className="btn primary" onClick={() => setForm({ direction: dir, brand_id: '', party: '', phone: '', amount: '', due_date: '', note: '' })}>+ New due</button>}
      </div>
      <Err error={error} />
      {!data && !error && <Loader />}
      {data && (
        <div className="grid g2" style={{ marginBottom: 14 }}>
          <Stat label="To collect" value={inr(data.totals.receivable)} tone="in" />
          {canEdit && <Stat label="To pay" value={inr(data.totals.payable)} tone="out" />}
        </div>
      )}
      <div className="filters">
        <div className="seg">
          <button className={dir === 'receivable' ? 'on' : ''} onClick={() => setDir('receivable')}>To collect</button>
          {canEdit && <button className={dir === 'payable' ? 'on' : ''} onClick={() => setDir('payable')}>To pay</button>}
        </div>
        <select className="input" value={show} onChange={(e) => setShow(e.target.value)}><option value="open">Open only</option><option value="all">Everything</option></select>
      </div>
      {data && (
        <div className="card table-wrap">
          {rows.length === 0 ? <Empty>Nothing here. 🎉</Empty> : (
            <table className="t">
              <thead><tr><th>Party</th><th>Brand</th><th>Due</th><th className="num">Balance</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const overdue = r.status === 'open' && r.due_date && r.due_date < today();
                  return (
                    <tr key={`${r.origin}-${r.id || r.document_id}`}>
                      <td><div style={{ fontWeight: 600 }}>{r.party}</div><div className="muted small">{r.number || r.note || ''}</div></td>
                      <td><BrandTag code={r.brand_code} color={r.brand_color} /></td>
                      <td>{r.due_date ? <span className={overdue ? 'out' : ''}>{fmtDate(r.due_date)}{overdue ? ' · overdue' : ''}</span> : '—'}</td>
                      <td className="num" style={{ fontWeight: 600 }}>{inr(r.balance)}</td>
                      <td className="num">
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                          {r.status === 'open' && r.direction === 'receivable' && r.phone && <button className="btn sm" onClick={() => remind(r)}>Remind</button>}
                          {r.origin !== 'manual' && <button className="btn sm" onClick={() => go('deals')}>{r.origin === 'invoice' ? 'Invoice' : r.origin === 'bill' ? 'Bill' : 'Credit note'}</button>}
                          {r.origin === 'manual' && r.status === 'open' && canEdit && <>
                            <button className="btn sm" onClick={() => setForm(r)}>Edit</button>
                            <button className="btn sm green" onClick={() => setSettle(r)}>Settle</button>
                          </>}
                          {r.status !== 'open' && <span className={`pill ${r.status}`}>{r.status.replace('_', ' ')}</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
      {form && <DueForm initial={form} onClose={() => setForm(null)} onSaved={() => { setForm(null); reload(); notify('Saved'); }} />}
      {settle && <SettleForm due={settle} onClose={() => setSettle(null)} onSaved={() => { setSettle(null); reload(); notify('Settled'); }} />}
    </>
  );
}

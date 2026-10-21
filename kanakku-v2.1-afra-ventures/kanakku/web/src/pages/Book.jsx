import React, { useState } from 'react';
import { api, qs } from '../lib/api.js';
import { fmtDate, inr, inr2, monthStart, today } from '../lib/format.js';
import { BrandSelect, BrandTag, Empty, Err, Field, Loader, Modal, Money, Stat, useApp, useAsync } from '../components/ui.jsx';
import SplitEditor, { splitTotal } from '../components/SplitEditor.jsx';
import Attachments from '../components/Attachments.jsx';

const blank = () => ({ entry_date: today(), brand_id: '', type: 'in', amount: '', gst_amount: '', tds_amount: '', category_id: '', account_id: '',
  to_account_id: '', party: '', note: '', ref: '', source: 'manual' });
const AUTO = ['razorpay', 'invoice', 'bill', 'investor', 'refund'];
const SOURCE_LABEL = { razorpay: 'Razorpay', invoice: 'invoice', bill: 'bill', investor: 'investor', refund: 'refund', recurring: 'recurring', bank: 'bank', ai: 'typed' };

export function EntryForm({ initial, onClose, onSaved }) {
  const { boot, user } = useApp();
  const [f, setF] = useState(() => {
    const base = { ...blank(), ...initial };
    const allocs = initial?.allocations || [];
    return { ...base, gst_amount: Number(base.gst_amount) || '', tds_amount: Number(base.tds_amount) || '',
      shared: allocs.length > 0, split: allocs.map((a) => ({ brand_id: a.brand_id, pct: Number(a.pct) })), split_preset_id: initial?.split_preset_id || '' };
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  const isTransfer = f.type === 'transfer';
  const cats = boot.categories.filter((c) => c.kind === f.type);
  const presets = boot.presets || [];
  const applyPreset = (id, extra = {}) => {
    const p = presets.find((x) => x.id === Number(id));
    setF({ ...f, ...extra, split_preset_id: id || '', split: p ? p.rules.map((r) => ({ brand_id: r.brand_id, pct: Number(r.pct) })) : f.split });
  };
  const pickCategory = (e) => {
    const id = e.target.value;
    const cat = cats.find((c) => c.id === Number(id));
    if (f.type === 'out' && cat?.default_preset_id && !f.id && !f.shared) applyPreset(cat.default_preset_id, { category_id: id, shared: true });
    else setF({ ...f, category_id: id });
  };
  const splitOk = !f.shared || isTransfer || Math.abs(splitTotal(f.split) - 100) < 0.01;
  const locked = AUTO.includes(f.source) && user.role !== 'admin';
  const linked = !!(f.document_id || f.bill_id);
  const pending = f.status === 'pending';
  const closedUntil = boot.books?.lock_until;
  const inClosed = closedUntil && f.entry_date <= closedUntil;
  const cat = boot.categories.find((c) => c.id === Number(f.category_id));
  const valid = Number(f.amount) > 0 && (isTransfer ? f.account_id && f.to_account_id && f.account_id !== f.to_account_id : (f.shared || f.brand_id)) && splitOk;

  const body = () => {
    const b = { ...f, amount: Number(f.amount), gst_amount: Number(f.gst_amount) || 0, tds_amount: f.type === 'in' ? Number(f.tds_amount) || 0 : 0,
      category_id: isTransfer ? null : f.category_id || null, account_id: f.account_id || null, to_account_id: isTransfer ? f.to_account_id || null : null,
      source: f.source === 'ai' ? 'ai' : 'manual', brand_id: f.shared || isTransfer ? null : f.brand_id,
      split: f.shared && !isTransfer ? f.split : null, split_preset_id: f.shared && !isTransfer ? f.split_preset_id || null : null };
    ['shared', 'allocations', 'status', 'document_id', 'bill_id', 'attachment_count'].forEach((k) => delete b[k]);
    return b;
  };
  const save = async (confirm = false) => {
    setBusy(true); setError('');
    try {
      const r = f.id ? await api(`/entries/${f.id}`, { method: 'PUT', body: body() }) : await api('/entries', { method: 'POST', body: body() });
      if (confirm) await api('/entries/confirm', { method: 'POST', body: { ids: [r.id] } });
      onSaved(r, confirm ? 'Confirmed' : 'Saved');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!window.confirm(pending ? 'Throw away this draft?' : 'Delete this entry?')) return;
    try { await api(`/entries/${f.id}`, { method: 'DELETE' }); onSaved(null, 'Deleted'); } catch (e) { setError(e.message); }
  };

  return (
    <Modal title={pending ? 'Confirm entry' : f.id ? 'Edit entry' : 'New entry'} onClose={onClose} footer={<>
      {f.id && (user.role === 'admin' || pending) && !linked && <button className="btn danger" onClick={del}>{pending ? 'Discard' : 'Delete'}</button>}
      <span className="spacer" />
      <button className="btn" onClick={onClose}>Cancel</button>
      {pending
        ? <button className="btn green" onClick={() => save(true)} disabled={busy || locked || !valid}>{busy ? 'Saving…' : 'Confirm'}</button>
        : <button className="btn primary" onClick={() => save(false)} disabled={busy || locked || !valid}>{busy ? 'Saving…' : 'Save'}</button>}
    </>}>
      <Err error={error} />
      {locked && <div className="note-box">This entry was made automatically (from an {SOURCE_LABEL[f.source]}). Only admin can change it.</div>}
      {pending && <div className="note-box">Autopilot prepared this from {f.source === 'bank' ? 'the bank statement' : 'a recurring bill'}. Check it, change anything, then confirm. It doesn't count anywhere until you do.</div>}
      {f.source === 'ai' && !f.id && <div className="note-box">Filled in from your note — check the details, then save.</div>}
      {inClosed && <div className="banner bad">Books are closed up to {fmtDate(closedUntil)} — this date can't be saved unless an admin reopens the month.</div>}
      <div className="row">
        <div className="seg">
          <button className={f.type === 'in' ? 'on in' : ''} disabled={linked} onClick={() => setF({ ...f, type: 'in', category_id: '', shared: false })}>Money in</button>
          <button className={f.type === 'out' ? 'on out' : ''} disabled={linked} onClick={() => setF({ ...f, type: 'out', category_id: '', tds_amount: '' })}>Money out</button>
          <button className={isTransfer ? 'on' : ''} disabled={linked} onClick={() => setF({ ...f, type: 'transfer', category_id: '', shared: false, gst_amount: '', tds_amount: '' })}>Transfer</button>
        </div>
        <span className="spacer" />
        {f.type === 'out' && !linked && (
          <label className="toggle"><input type="checkbox" checked={f.shared} onChange={(e) => setF({ ...f, shared: e.target.checked })} />Shared cost — split across brands</label>
        )}
      </div>
      {isTransfer ? (
        <>
          <div className="muted small">Moving our own money between accounts (e.g. depositing cash into RBL). Not income or expense.</div>
          <div className="grid g2">
            <Field label="Amount (₹)"><input className="input" type="number" inputMode="decimal" min="0" value={f.amount} onChange={set('amount')} autoFocus /></Field>
            <Field label="Date"><input className="input" type="date" value={f.entry_date} onChange={set('entry_date')} /></Field>
            <Field label="From"><select className="input" value={f.account_id || ''} onChange={set('account_id')}><option value="">—</option>{boot.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
            <Field label="To"><select className="input" value={f.to_account_id || ''} onChange={set('to_account_id')}><option value="">—</option>{boot.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          </div>
        </>
      ) : (
        <div className="grid g2">
          <Field label="Amount (₹) — what actually moved"><input className="input" type="number" inputMode="decimal" min="0" value={f.amount} onChange={set('amount')} autoFocus /></Field>
          <Field label="Date"><input className="input" type="date" value={f.entry_date} onChange={set('entry_date')} /></Field>
          {f.shared && f.type === 'out' ? (
            <Field label="Split rule">
              <select className="input" value={f.split_preset_id || ''} onChange={(e) => applyPreset(e.target.value)}>
                <option value="">Custom %</option>{presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          ) : <Field label="Brand"><BrandSelect value={f.brand_id} onChange={set('brand_id')} /></Field>}
          <Field label="Category">
            <select className="input" value={f.category_id || ''} onChange={pickCategory}>
              <option value="">—</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}{c.in_pnl === false ? ' (not profit/loss)' : ''}</option>)}
            </select>
          </Field>
          <Field label={f.type === 'in' ? 'Received in' : 'Paid from'}>
            <select className="input" value={f.account_id || ''} onChange={set('account_id')}>
              <option value="">—</option>{boot.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label={f.type === 'in' ? 'Received from' : 'Paid to'}><input className="input" value={f.party || ''} onChange={set('party')} /></Field>
          {f.type === 'out' && !linked && (
            <Field label="GST in this bill (₹) — claimable">
              <input className="input" type="number" min="0" value={f.gst_amount} onChange={set('gst_amount')} placeholder="0 if no GST bill" />
            </Field>
          )}
          {f.type === 'in' && !linked && (
            <Field label="TDS the customer kept (₹)">
              <input className="input" type="number" min="0" value={f.tds_amount} onChange={set('tds_amount')} placeholder="0" />
            </Field>
          )}
        </div>
      )}
      {!isTransfer && (Number(f.gst_amount) > 0 || Number(f.tds_amount) > 0) && (
        <div className="money-hint">Counts in P&L as {inr2(Number(f.amount || 0) + Number(f.tds_amount || 0) - Number(f.gst_amount || 0))}
          {Number(f.gst_amount) > 0 && ` · GST ${inr2(f.gst_amount)} kept aside`}{Number(f.tds_amount) > 0 && ` · TDS ${inr2(f.tds_amount)} claimable in tax return`}</div>
      )}
      {cat && cat.in_pnl === false && <div className="money-hint">"{cat.name}" moves money but is not profit or loss — it won't show in P&L or investor share.</div>}
      {f.shared && f.type === 'out' && (
        <SplitEditor rules={f.split} amount={f.amount} onChange={(split) => setF({ ...f, split, split_preset_id: '' })} />
      )}
      <Field label="Note"><input className="input" value={f.note || ''} onChange={set('note')} /></Field>
      <Field label="Reference (UTR / cheque no.)"><input className="input" value={f.ref || ''} onChange={set('ref')} /></Field>
      {f.id ? <Attachments entity="entry" id={f.id} /> : <div className="muted small">Save first, then you can attach the bill photo.</div>}
    </Modal>
  );
}

function PendingList({ onOpen, onChanged }) {
  const { notify } = useApp();
  const { data, error, reload } = useAsync(() => api('/entries?status=pending&limit=200'), []);
  const [picked, setPicked] = useState([]);
  if (error) return <Err error={error} />;
  if (!data) return <Loader />;
  const all = data.rows.map((r) => r.id);
  const confirm = async (ids) => {
    try { const r = await api('/entries/confirm', { method: 'POST', body: { ids } }); notify(`${r.confirmed} confirmed`); setPicked([]); reload(); onChanged(); }
    catch (e) { notify(e.message); }
  };
  return (
    <>
      <div className="banner info">These were prepared by autopilot from recurring bills and the bank statement. Nothing here counts until it's confirmed.
        {picked.length > 0 && <button className="btn green sm" onClick={() => confirm(picked)}>Confirm {picked.length}</button>}
      </div>
      <div className="card table-wrap">
        {data.rows.length === 0 ? <Empty>Nothing waiting. 🎉</Empty> : (
          <table className="t">
            <thead><tr>
              <th className="check-col"><input type="checkbox" checked={picked.length === all.length} onChange={(e) => setPicked(e.target.checked ? all : [])} /></th>
              <th>Date</th><th>Brand</th><th>Details</th><th className="hide-sm">From</th><th className="num">Amount</th></tr></thead>
            <tbody>{data.rows.map((r) => (
              <tr key={r.id} className="click" onClick={() => onOpen(r)}>
                <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} /></td>
                <td>{fmtDate(r.entry_date)}</td>
                <td>{r.allocations?.length ? <span className="tag">Shared · {r.allocations.length}</span> : <BrandTag code={r.brand_code} color={r.brand_color} />}</td>
                <td><div>{r.party || r.category_name || '—'}</div><div className="muted small">{r.note}</div></td>
                <td className="hide-sm"><span className="pill pending">{SOURCE_LABEL[r.source] || r.source}</span></td>
                <td className="num"><Money v={r.amount} type={r.type} /></td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

export default function Book() {
  const { notify, boot } = useApp();
  const [tab, setTab] = useState('book');
  const [filters, setFilters] = useState({ from: monthStart(), to: today(), brand_id: '', type: '', account_id: '', q: '' });
  const [limit, setLimit] = useState(100);
  const [editing, setEditing] = useState(null);
  const [quick, setQuick] = useState('');
  const [parsing, setParsing] = useState(false);
  const [quickErr, setQuickErr] = useState('');
  const { data, error, reload } = useAsync(() => api(`/entries${qs({ ...filters, limit })}`), [JSON.stringify(filters), limit]);
  const setFl = (k) => (v) => { setLimit(100); setFilters({ ...filters, [k]: v?.target ? v.target.value : v }); };

  const runQuick = async (e) => {
    e.preventDefault();
    if (!quick.trim()) return;
    setParsing(true); setQuickErr('');
    try {
      const d = await api('/ai/parse-entry', { method: 'POST', body: { text: quick } });
      const cat = boot.categories.find((c) => c.id === d.category_id);
      const preset = d.type === 'out' && !d.brand_id && cat?.default_preset_id && (boot.presets || []).find((p) => p.id === cat.default_preset_id);
      setEditing({ ...blank(), type: d.type, amount: d.amount || '', brand_id: d.brand_id || '', category_id: d.category_id || '',
        account_id: d.account_id || '', party: d.party || '', note: d.note || quick, source: 'ai',
        ...(preset ? { allocations: preset.rules, split_preset_id: preset.id } : {}) });
      setQuick('');
    } catch (err) { setQuickErr(err.message); } finally { setParsing(false); }
  };
  const open = async (r) => { try { setEditing(await api(`/entries/${r.id}`)); } catch { setEditing(r); } };

  return (
    <>
      <div className="page-head">
        <div><h1>Book</h1><p>Every rupee in and out, across all brands.</p></div>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEditing(blank())}>+ New entry</button>
      </div>

      <div className="tabs">
        <button className={tab === 'book' ? 'on' : ''} onClick={() => setTab('book')}>Book</button>
        <button className={tab === 'pending' ? 'on' : ''} onClick={() => setTab('pending')}>To confirm{data?.pending ? <span className="count">{data.pending}</span> : null}</button>
      </div>

      {tab === 'pending' ? <PendingList onOpen={open} onChanged={reload} /> : (
        <>
          <form className="card card-pad quick" onSubmit={runQuick} style={{ marginBottom: 14 }}>
            <input className="input" placeholder='Type it like you say it — e.g. "techx 5k vanthuchu ravi gpay" or "eb 4200 kattinom"'
              value={quick} onChange={(e) => setQuick(e.target.value)} />
            <button className="btn primary" disabled={parsing}>{parsing ? 'Reading…' : 'Fill entry'}</button>
          </form>
          <Err error={quickErr} />

          <div className="filters">
            <input className="input" type="date" value={filters.from} onChange={setFl('from')} />
            <input className="input" type="date" value={filters.to} onChange={setFl('to')} />
            <div style={{ minWidth: 180 }}><BrandSelect all includeInactive value={filters.brand_id} onChange={setFl('brand_id')} /></div>
            <select className="input" value={filters.type} onChange={setFl('type')}>
              <option value="">All types</option><option value="in">Money in</option><option value="out">Money out</option><option value="transfer">Transfers</option>
            </select>
            <select className="input" value={filters.account_id} onChange={setFl('account_id')}>
              <option value="">All accounts</option>{boot.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <input className="input" placeholder="Search name, note, ref" value={filters.q} onChange={setFl('q')} />
          </div>

          <Err error={error} />
          {!data && !error && <Loader />}
          {data && (
            <>
              <div className="grid g3" style={{ marginBottom: 14 }}>
                <Stat label="Money in" value={inr(data.totals.in)} tone="in" hint={[data.totals.gst_in > 0 && `incl. GST ${inr(data.totals.gst_in)}`, data.totals.tds > 0 && `+ TDS ${inr(data.totals.tds)}`].filter(Boolean).join(' · ')} />
                <Stat label="Money out" value={inr(data.totals.out)} tone="out" hint={data.totals.gst_out > 0 ? `incl. claimable GST ${inr(data.totals.gst_out)}` : ''} />
                <Stat label="Net" value={inr(data.totals.net)} tone={data.totals.net >= 0 ? 'in' : 'out'} hint={`${data.count} entries`} />
              </div>
              <div className="card table-wrap">
                {data.rows.length === 0 ? <Empty>No entries for these filters.</Empty> : (
                  <table className="t">
                    <thead><tr><th>Date</th><th>Brand</th><th>Details</th><th className="hide-sm">Category</th><th className="hide-sm">Via</th><th className="num">Amount</th></tr></thead>
                    <tbody>
                      {data.rows.map((r) => (
                        <tr key={r.id} className="click" onClick={() => open(r)}>
                          <td>{fmtDate(r.entry_date)}</td>
                          <td>{r.type === 'transfer' ? <span className="pill transfer">transfer</span> : r.allocations?.length ? (
                            <><span className="tag">Shared · {r.allocations.length}</span>
                              <div className="split-chips">{r.allocations.slice(0, 4).map((a) => <BrandTag key={a.brand_id} code={`${a.brand_code} ${Number(a.pct)}%`} color={a.brand_color} />)}
                                {r.allocations.length > 4 && <span className="muted small">+{r.allocations.length - 4}</span>}</div></>
                          ) : <BrandTag code={r.brand_code} color={r.brand_color} />}</td>
                          <td><div>{r.type === 'transfer' ? `${r.account_name || '?'} → ${r.to_account_name || '?'}` : r.party || '—'}{r.attachment_count > 0 && <span title="Bill attached"> 📎</span>}</div>
                            {r.note && <div className="muted small">{r.note}</div>}</td>
                          <td className="hide-sm">{r.category_name || '—'}</td>
                          <td className="hide-sm muted">{r.type !== 'transfer' && (r.account_name || '—')}{r.source !== 'manual' && <span className="pill" style={{ marginLeft: 6 }}>{SOURCE_LABEL[r.source] || r.source}</span>}</td>
                          <td className="num">{r.type === 'transfer' ? <span className="num muted">{inr(r.amount)}</span> : <Money v={r.brand_amount ?? r.amount} type={r.type} />}
                            {r.brand_amount !== undefined && r.brand_amount !== r.amount && r.type !== 'transfer' && <div className="muted small">of {inr(r.amount)}</div>}
                            {Number(r.gst_amount) > 0 && <div className="muted small">GST {inr(r.gst_amount)}</div>}
                            {Number(r.tds_amount) > 0 && <div className="muted small">+TDS {inr(r.tds_amount)}</div>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              {data.count > data.rows.length && (
                <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
                  <span className="muted small">Showing {data.rows.length} of {data.count}</span>
                  <button className="btn sm" onClick={() => setLimit(limit + 200)}>Show more</button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {editing && <EntryForm initial={editing} onClose={() => setEditing(null)}
        onSaved={(_r, msg) => { setEditing(null); reload(); notify(msg || 'Saved'); }} />}
    </>
  );
}

import React, { useState } from 'react';
import { api, qs } from '../lib/api.js';
import { fmtDate, inr, monthStart, today } from '../lib/format.js';
import { BrandSelect, BrandTag, Empty, Err, Field, Loader, Modal, Money, Stat, useApp, useAsync } from '../components/ui.jsx';
import SplitEditor, { splitTotal } from '../components/SplitEditor.jsx';

const blank = () => ({ entry_date: today(), brand_id: '', type: 'in', amount: '', category_id: '', account_id: '', party: '', note: '', ref: '', source: 'manual' });

export function EntryForm({ initial, onClose, onSaved }) {
  const { boot, user } = useApp();
  const [f, setF] = useState(() => {
    const base = { ...blank(), ...initial };
    const allocs = initial?.allocations || [];
    return { ...base, shared: allocs.length > 0, split: allocs.map((a) => ({ brand_id: a.brand_id, pct: Number(a.pct) })),
      split_preset_id: initial?.split_preset_id || '' };
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  const cats = boot.categories.filter((c) => c.kind === f.type);
  const presets = boot.presets || [];
  const applyPreset = (id, extra = {}) => {
    const p = presets.find((x) => x.id === Number(id));
    setF({ ...f, ...extra, split_preset_id: id || '', split: p ? p.rules.map((r) => ({ brand_id: r.brand_id, pct: Number(r.pct) })) : f.split });
  };
  // Picking a category like EB / Rent switches on its usual split
  const pickCategory = (e) => {
    const id = e.target.value;
    const cat = cats.find((c) => c.id === Number(id));
    if (f.type === 'out' && cat?.default_preset_id && !f.id && !f.shared) applyPreset(cat.default_preset_id, { category_id: id, shared: true });
    else setF({ ...f, category_id: id });
  };
  const splitOk = !f.shared || Math.abs(splitTotal(f.split) - 100) < 0.01;
  const locked = ['razorpay', 'invoice'].includes(f.source) && user.role !== 'admin';

  const save = async () => {
    setBusy(true); setError('');
    try {
      const body = { ...f, amount: Number(f.amount), category_id: f.category_id || null, account_id: f.account_id || null,
        source: f.source === 'ai' ? 'ai' : 'manual', brand_id: f.shared ? null : f.brand_id,
        split: f.shared ? f.split : null, split_preset_id: f.shared ? f.split_preset_id || null : null };
      delete body.shared; delete body.allocations;
      const r = f.id ? await api(`/entries/${f.id}`, { method: 'PUT', body }) : await api('/entries', { method: 'POST', body });
      onSaved(r);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!window.confirm('Delete this entry?')) return;
    try { await api(`/entries/${f.id}`, { method: 'DELETE' }); onSaved(null); } catch (e) { setError(e.message); }
  };

  return (
    <Modal title={f.id ? 'Edit entry' : 'New entry'} onClose={onClose} footer={<>
      {f.id && user.role === 'admin' && <button className="btn danger" onClick={del}>Delete</button>}
      <span className="spacer" />
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={save} disabled={busy || locked || (!f.shared && !f.brand_id) || !f.amount || !splitOk}>{busy ? 'Saving…' : 'Save'}</button>
    </>}>
      <Err error={error} />
      {locked && <div className="note-box">This entry was created automatically from an invoice or Razorpay. Only admin can change it.</div>}
      {f.source === 'ai' && !f.id && <div className="note-box">Filled in from your note — check the details, then save.</div>}
      <div className="row">
        <div className="seg">
          <button className={f.type === 'in' ? 'on in' : ''} onClick={() => setF({ ...f, type: 'in', category_id: '' })}>Money in</button>
          <button className={f.type === 'out' ? 'on out' : ''} onClick={() => setF({ ...f, type: 'out', category_id: '' })}>Money out</button>
        </div>
        <span className="spacer" />
        {f.type === 'out' && !f.document_id && (
          <label className="toggle"><input type="checkbox" checked={f.shared} onChange={(e) => setF({ ...f, shared: e.target.checked })} />Shared cost — split across brands</label>
        )}
      </div>
      <div className="grid g2">
        <Field label="Amount (₹)"><input className="input" type="number" inputMode="decimal" min="0" value={f.amount} onChange={set('amount')} autoFocus /></Field>
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
            <option value="">—</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Paid via">
          <select className="input" value={f.account_id || ''} onChange={set('account_id')}>
            <option value="">—</option>{boot.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label={f.type === 'in' ? 'Received from' : 'Paid to'}><input className="input" value={f.party || ''} onChange={set('party')} /></Field>
      </div>
      {f.shared && f.type === 'out' && (
        <SplitEditor rules={f.split} amount={f.amount} onChange={(split) => setF({ ...f, split, split_preset_id: '' })} />
      )}
      <Field label="Note"><input className="input" value={f.note || ''} onChange={set('note')} /></Field>
      <Field label="Reference (UTR / cheque no.)"><input className="input" value={f.ref || ''} onChange={set('ref')} /></Field>
    </Modal>
  );
}

export default function Book() {
  const { notify, boot } = useApp();
  const [filters, setFilters] = useState({ from: monthStart(), to: today(), brand_id: '', type: '', q: '' });
  const [editing, setEditing] = useState(null);
  const [quick, setQuick] = useState('');
  const [parsing, setParsing] = useState(false);
  const [quickErr, setQuickErr] = useState('');
  const { data, error, reload } = useAsync(() => api(`/entries${qs(filters)}`), [JSON.stringify(filters)]);
  const setFl = (k) => (v) => setFilters({ ...filters, [k]: v?.target ? v.target.value : v });

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

  return (
    <>
      <div className="page-head">
        <div><h1>Book</h1><p>Every rupee in and out, across all brands.</p></div>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEditing(blank())}>+ New entry</button>
      </div>

      <form className="card card-pad quick" onSubmit={runQuick} style={{ marginBottom: 14 }}>
        <input className="input" placeholder='Type it like you say it — e.g. "techx 5k vanthuchu ravi gpay" or "dk 1200 vegetables cash kuduthen"'
          value={quick} onChange={(e) => setQuick(e.target.value)} />
        <button className="btn primary" disabled={parsing}>{parsing ? 'Reading…' : 'Fill entry'}</button>
      </form>
      <Err error={quickErr} />

      <div className="filters">
        <input className="input" type="date" value={filters.from} onChange={setFl('from')} />
        <input className="input" type="date" value={filters.to} onChange={setFl('to')} />
        <div style={{ minWidth: 180 }}><BrandSelect all includeInactive value={filters.brand_id} onChange={setFl('brand_id')} /></div>
        <select className="input" value={filters.type} onChange={setFl('type')}>
          <option value="">In & out</option><option value="in">Money in</option><option value="out">Money out</option>
        </select>
        <input className="input" placeholder="Search name, note, ref" value={filters.q} onChange={setFl('q')} />
      </div>

      <Err error={error} />
      {!data && !error && <Loader />}
      {data && (
        <>
          <div className="grid g3" style={{ marginBottom: 14 }}>
            <Stat label="Money in" value={inr(data.totals.in)} tone="in" />
            <Stat label="Money out" value={inr(data.totals.out)} tone="out" />
            <Stat label="Net" value={inr(data.totals.net)} tone={data.totals.net >= 0 ? 'in' : 'out'} />
          </div>
          <div className="card table-wrap">
            {data.rows.length === 0 ? <Empty>No entries for these filters.</Empty> : (
              <table className="t">
                <thead><tr><th>Date</th><th>Brand</th><th>Details</th><th className="hide-sm">Category</th><th className="hide-sm">Via</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className="click" onClick={() => setEditing(r)}>
                      <td>{fmtDate(r.entry_date)}</td>
                      <td>{r.allocations?.length ? (
                        <><span className="tag">Shared · {r.allocations.length}</span>
                          <div className="split-chips">{r.allocations.slice(0, 4).map((a) => <BrandTag key={a.brand_id} code={`${a.brand_code} ${Number(a.pct)}%`} color={a.brand_color} />)}
                            {r.allocations.length > 4 && <span className="muted small">+{r.allocations.length - 4}</span>}</div></>
                      ) : <BrandTag code={r.brand_code} color={r.brand_color} />}</td>
                      <td><div>{r.party || '—'}</div>{r.note && <div className="muted small">{r.note}</div>}</td>
                      <td className="hide-sm">{r.category_name || '—'}</td>
                      <td className="hide-sm muted">{r.account_name || '—'}{r.source !== 'manual' && <span className="pill" style={{ marginLeft: 6 }}>{r.source}</span>}</td>
                      <td className="num"><Money v={r.brand_amount ?? r.amount} type={r.type} />
                        {r.brand_amount !== undefined && r.brand_amount !== r.amount && <div className="muted small">of {inr(r.amount)}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {editing && <EntryForm initial={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); reload(); notify('Saved'); }} />}
    </>
  );
}

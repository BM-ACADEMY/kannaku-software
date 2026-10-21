import React, { useState } from 'react';
import { api, qs } from '../lib/api.js';
import { fmtDate, inr, inr2 } from '../lib/format.js';
import { BrandSelect, BrandTag, Empty, Err, Field, Loader, Modal, Stat, useApp, useAsync } from '../components/ui.jsx';

const KIND = { cash: 'Cash', bank: 'Bank', upi: 'UPI', gateway: 'Gateway' };

function Balances() {
  const { data, error } = useAsync(() => api('/accounts'), []);
  if (error) return <Err error={error} />;
  if (!data) return <Loader />;
  const active = data.filter((a) => a.active);
  const total = active.reduce((s, a) => s + Number(a.balance), 0);
  return (
    <>
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Stat label="Total money now" value={inr(total)} tone={total >= 0 ? 'in' : 'out'} hint={`${active.length} accounts`} />
        {active.slice(0, 3).map((a) => <Stat key={a.id} label={a.name} value={inr(a.balance)} tone={a.balance < 0 ? 'out' : ''} hint={KIND[a.kind]} />)}
      </div>
      <div className="card table-wrap">
        <table className="t">
          <thead><tr><th>Account</th><th>Type</th><th className="num">Opening</th><th className="hide-sm">From</th><th className="num">Balance now</th></tr></thead>
          <tbody>{data.map((a) => (
            <tr key={a.id}><td style={{ fontWeight: 600 }}>{a.name}{!a.active && <span className="pill" style={{ marginLeft: 6 }}>inactive</span>}</td><td>{KIND[a.kind]}</td>
              <td className="num">{inr(a.opening_balance)}</td><td className="hide-sm">{fmtDate(a.opening_date)}</td>
              <td className={`num ${a.balance < 0 ? 'out' : ''}`} style={{ fontWeight: 700 }}>{inr2(a.balance)}</td></tr>))}</tbody>
        </table>
      </div>
      {data[0]?.unassigned > 0 && <div className="banner" style={{ marginTop: 14 }}>{data[0].unassigned} Book entries have no account ("Paid via" empty), so they're not in any balance. Open them and pick the account.</div>}
      <p className="muted small">Set opening balances in Settings → Accounts (what each account held on the day you started using Kanakku). Compare "Balance now" with the bank app — if they differ, import the statement in the next tab.</p>
    </>
  );
}

function ImportCard({ onDone }) {
  const { boot } = useApp();
  const [acc, setAcc] = useState(boot.accounts.find((a) => a.kind === 'bank')?.id || '');
  const [csv, setCsv] = useState('');
  const [name, setName] = useState('');
  const [prev, setPrev] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pick = async (file) => {
    setError(''); setPrev(null);
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) { setError('Download the statement as CSV from net banking (Excel files: open and "Save as CSV").'); return; }
    const text = await file.text(); setCsv(text); setName(file.name);
    try { setPrev(await api('/bank/preview', { method: 'POST', body: { csv: text } })); } catch (e) { setError(e.message); }
  };
  const doImport = async () => {
    setBusy(true); setError('');
    try { const r = await api('/bank/import', { method: 'POST', body: { account_id: Number(acc), csv } }); setPrev(null); setCsv(''); setName(''); onDone(r); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="card card-pad" style={{ marginBottom: 14 }}>
      <h3>Import bank statement</h3>
      <div className="row">
        <select className="input" style={{ width: 'auto' }} value={acc} onChange={(e) => setAcc(e.target.value)}>
          <option value="">Which account?</option>{boot.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label className="btn">{name || 'Choose CSV file…'}<input type="file" accept=".csv,text/csv" hidden onChange={(e) => pick(e.target.files[0])} /></label>
        {prev?.ok && <button className="btn primary" disabled={!acc || busy} onClick={doImport}>{busy ? 'Importing…' : `Import ${prev.total_lines} lines`}</button>}
      </div>
      <Err error={error} />
      {prev && !prev.ok && <div className="err">{prev.error}</div>}
      {prev?.ok && (
        <div style={{ marginTop: 10 }}>
          <div className="muted small">{fmtDate(prev.from)} → {fmtDate(prev.to)} · out {inr(prev.totals.debit)} · in {inr(prev.totals.credit)}{prev.skipped ? ` · ${prev.skipped} non-transaction rows skipped` : ''}. Lines already imported are skipped automatically.</div>
          <table className="t" style={{ marginTop: 8 }}><tbody>{prev.lines.slice(0, 5).map((l, i) => (
            <tr key={i}><td>{fmtDate(l.line_date)}</td><td>{l.description}</td><td className="num out">{l.debit ? inr2(l.debit) : ''}</td><td className="num in">{l.credit ? inr2(l.credit) : ''}</td></tr>))}</tbody></table>
        </div>
      )}
      <p className="muted small" style={{ marginBottom: 0 }}>RBL net banking → Accounts → Statement → pick dates → Download → CSV. Works with most Indian bank CSVs.</p>
    </div>
  );
}

function LineAction({ line, onClose, onDone }) {
  const { boot } = useApp();
  const isIn = Number(line.credit) > 0;
  const amt = isIn ? line.credit : line.debit;
  const { data } = useAsync(() => api(`/bank/lines/${line.id}/candidates`), [line.id]);
  const firstWord = (line.description.match(/[A-Za-z]{4,}/g) || []).find((w) => !/^(NEFT|IMPS|RTGS|UPI|TRANSFER|PAYMENT|CREDIT|DEBIT)$/i.test(w)) || '';
  const [f, setF] = useState({ mode: 'new', brand_id: '', split_preset_id: '', category_id: '', party: '', gst_amount: '', note: '', to_account_id: '',
    remember: false, pattern: firstWord.toUpperCase(), auto_post: false });
  const [error, setError] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e });
  const create = async () => {
    try {
      const body = { brand_id: f.split_preset_id ? null : Number(f.brand_id) || null, split_preset_id: Number(f.split_preset_id) || null,
        category_id: Number(f.category_id) || null, party: f.party || null, gst_amount: Number(f.gst_amount) || 0, note: f.note || null,
        to_account_id: f.mode === 'transfer' ? Number(f.to_account_id) : null, remember: f.mode === 'new' && f.remember, pattern: f.pattern, auto_post: f.auto_post };
      const r = await api(`/bank/lines/${line.id}/create`, { method: 'POST', body });
      onDone(r.more?.by_rule ? `Saved · rule also handled ${r.more.by_rule} more line(s)` : 'Saved');
    } catch (e) { setError(e.message); }
  };
  const link = async (entryId) => { try { await api(`/bank/lines/${line.id}/link`, { method: 'POST', body: { entry_id: entryId } }); onDone('Linked'); } catch (e) { setError(e.message); } };
  const cats = boot.categories.filter((c) => c.kind === (isIn ? 'in' : 'out'));
  return (
    <Modal title={`${isIn ? 'Money in' : 'Money out'} ${inr2(amt)} · ${fmtDate(line.line_date)}`} onClose={onClose} wide footer={<>
      <span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button>
      {f.mode !== 'link' && <button className="btn primary" onClick={create} disabled={f.mode === 'transfer' ? !f.to_account_id : !(f.brand_id || f.split_preset_id)}>Save to Book</button>}
    </>}>
      <div className="code-box" style={{ letterSpacing: 0 }}>{line.description}{line.ref ? ` · ${line.ref}` : ''}</div>
      <Err error={error} />
      {data && (data.entries.length > 0 || data.documents.length > 0) && (
        <div className="banner info" style={{ display: 'block' }}>
          <strong>Already in Kanakku?</strong>
          {data.entries.map((e) => <div key={e.id} className="row" style={{ marginTop: 6 }}><span>{fmtDate(e.entry_date)} · {e.party || e.note} · {inr2(e.amount)}{e.status === 'pending' ? ' (to confirm)' : ''}</span><span className="spacer" /><button className="btn sm" onClick={() => link(e.id)}>This one</button></div>)}
          {data.documents.map((d) => <div key={d.id} className="muted small" style={{ marginTop: 6 }}>Open {d.doc_type} {d.number} ({d.party}) has the same balance — record the payment from Deals, then link it here.</div>)}
        </div>
      )}
      <div className="seg">
        <button className={f.mode === 'new' ? 'on' : ''} onClick={() => setF({ ...f, mode: 'new' })}>New {isIn ? 'income' : 'expense'}</button>
        <button className={f.mode === 'transfer' ? 'on' : ''} onClick={() => setF({ ...f, mode: 'transfer' })}>Transfer between our accounts</button>
      </div>
      {f.mode === 'transfer' ? (
        <Field label={isIn ? 'Came from which of our accounts?' : 'Went to which of our accounts?'}>
          <select className="input" value={f.to_account_id} onChange={set('to_account_id')}><option value="">—</option>{boot.accounts.filter((a) => a.id !== line.account_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </Field>
      ) : (
        <>
          <div className="grid g2">
            <Field label="Brand"><BrandSelect value={f.brand_id} onChange={(v) => setF({ ...f, brand_id: v, split_preset_id: '' })} /></Field>
            {!isIn && <Field label="…or shared (split rule)"><select className="input" value={f.split_preset_id} onChange={(e) => setF({ ...f, split_preset_id: e.target.value, brand_id: '' })}>
              <option value="">Not shared</option>{(boot.presets || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
            <Field label="Category"><select className="input" value={f.category_id} onChange={set('category_id')}><option value="">—</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label={isIn ? 'Received from' : 'Paid to'}><input className="input" value={f.party} onChange={set('party')} /></Field>
            {!isIn && <Field label="GST in this bill (₹, claimable)"><input className="input" type="number" value={f.gst_amount} onChange={set('gst_amount')} placeholder="0" /></Field>}
          </div>
          <label className="toggle"><input type="checkbox" checked={f.remember} onChange={set('remember')} />Remember: next time a line contains</label>
          {f.remember && (
            <div className="row">
              <input className="input" style={{ maxWidth: 220 }} value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value.toUpperCase() })} />
              <span className="muted small">→ same brand & category</span>
              <label className="toggle"><input type="checkbox" checked={f.auto_post} onChange={set('auto_post')} />post directly (don't ask me)</label>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function Reconcile() {
  const { notify } = useApp();
  const [status, setStatus] = useState('unmatched');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const { data, error, reload } = useAsync(() => api(`/bank/lines${qs({ status, q })}`), [status, q]);
  const run = async () => { const r = await api('/bank/reconcile', { method: 'POST' }); notify(`Matched ${r.matched}, by rules ${r.by_rule}, left ${r.left}`); reload(); };
  const ignore = async (l) => { await api(`/bank/lines/${l.id}/ignore`, { method: 'POST' }); reload(); };
  const unlink = async (l) => { await api(`/bank/lines/${l.id}/unlink`, { method: 'POST' }); reload(); };
  return (
    <>
      <ImportCard onDone={(r) => { notify(`${r.added} new lines · ${r.matched} matched · ${r.by_rule} by rules${r.duplicates ? ` · ${r.duplicates} already imported` : ''}`); reload(); }} />
      <div className="filters">
        <div className="seg">
          {[['unmatched', 'To sort'], ['matched', 'Matched'], ['ignored', 'Ignored'], ['all', 'All']].map(([k, l]) => (
            <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}{data?.counts?.[k] ? ` (${data.counts[k]})` : ''}</button>))}
        </div>
        <input className="input" placeholder="Search description" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={run}>Match again</button>
      </div>
      <Err error={error} />
      {!data && !error && <Loader />}
      {data && (
        <div className="card table-wrap">
          {data.rows.length === 0 ? <Empty>{status === 'unmatched' ? 'Every bank line is in the Book. 🎉' : 'Nothing here.'}</Empty> : (
            <table className="t">
              <thead><tr><th>Date</th><th>Description</th><th className="hide-sm">Account</th><th className="num">Out</th><th className="num">In</th><th /></tr></thead>
              <tbody>{data.rows.map((l) => (
                <tr key={l.id}>
                  <td>{fmtDate(l.line_date)}</td>
                  <td><div>{l.description}</div>{l.status === 'matched' && <div className="muted small">→ {l.entry_party || 'Book entry'}{l.entry_status === 'pending' ? ' (to confirm)' : ''}{l.rule_pattern ? ` · rule "${l.rule_pattern}"` : ''}</div>}</td>
                  <td className="hide-sm muted">{l.account_name}</td>
                  <td className="num out">{Number(l.debit) ? inr2(l.debit) : ''}</td><td className="num in">{Number(l.credit) ? inr2(l.credit) : ''}</td>
                  <td className="num"><div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                    {l.status === 'unmatched' && <><button className="btn sm primary" onClick={() => setOpen(l)}>Sort</button><button className="btn sm" onClick={() => ignore(l)}>Ignore</button></>}
                    {l.status === 'ignored' && <button className="btn sm" onClick={() => ignore(l)}>Bring back</button>}
                    {l.status === 'matched' && <button className="btn sm" onClick={() => unlink(l)}>Unlink</button>}
                  </div></td>
                </tr>))}</tbody>
            </table>
          )}
        </div>
      )}
      {open && <LineAction line={open} onClose={() => setOpen(null)} onDone={(m) => { setOpen(null); notify(m); reload(); }} />}
    </>
  );
}

function Rules() {
  const { boot, notify } = useApp();
  const { data, error, reload } = useAsync(() => api('/bank/rules'), []);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const save = async () => {
    try {
      const body = { ...edit, brand_id: Number(edit.brand_id) || null, split_preset_id: Number(edit.split_preset_id) || null, category_id: Number(edit.category_id) || null };
      if (edit.id) await api(`/bank/rules/${edit.id}`, { method: 'PUT', body }); else await api('/bank/rules', { method: 'POST', body });
      setEdit(null); reload(); notify('Rule saved');
    } catch (e) { setErr(e.message); }
  };
  const del = async (r) => { if (window.confirm(`Delete rule "${r.pattern}"?`)) { await api(`/bank/rules/${r.id}`, { method: 'DELETE' }); reload(); } };
  if (error) return <Err error={error} />;
  if (!data) return <Loader />;
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><p className="muted small" style={{ margin: 0 }}>When a bank line contains the text, autopilot books it like this. "Post directly" skips the To-confirm step.</p><span className="spacer" />
        <button className="btn primary sm" onClick={() => { setErr(''); setEdit({ pattern: '', direction: 'out', brand_id: '', split_preset_id: '', category_id: '', party: '', auto_post: false, active: true }); }}>+ New rule</button></div>
      <div className="card table-wrap">
        {data.length === 0 ? <Empty>No rules yet — tick "Remember" when you sort a bank line.</Empty> : (
          <table className="t">
            <thead><tr><th>If description has</th><th>Direction</th><th>Book as</th><th className="hide-sm">Category</th><th className="num">Used</th><th /></tr></thead>
            <tbody>{data.map((r) => (
              <tr key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}>
                <td style={{ fontWeight: 600 }}>{r.pattern}</td><td>{r.direction}</td>
                <td>{r.preset_name ? <span className="tag">Shared · {r.preset_name}</span> : r.brand_name}{r.auto_post && <span className="pill" style={{ marginLeft: 6 }}>auto</span>}</td>
                <td className="hide-sm">{r.category_name || '—'}</td><td className="num">{r.hits}</td>
                <td className="num"><button className="btn sm" onClick={() => { setErr(''); setEdit({ ...r, brand_id: r.brand_id || '', split_preset_id: r.split_preset_id || '', category_id: r.category_id || '' }); }}>Edit</button> <button className="btn sm danger" onClick={() => del(r)}>Delete</button></td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
      {edit && (
        <Modal title={edit.id ? 'Edit rule' : 'New rule'} onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" onClick={save} disabled={!edit.pattern || !(edit.brand_id || edit.split_preset_id)}>Save</button></>}>
          <Err error={err} />
          <div className="grid g2">
            <Field label="Description contains"><input className="input" value={edit.pattern} onChange={(e) => setEdit({ ...edit, pattern: e.target.value.toUpperCase() })} placeholder="e.g. TNEB" /></Field>
            <Field label="Direction"><select className="input" value={edit.direction} onChange={(e) => setEdit({ ...edit, direction: e.target.value })}><option value="out">Money out</option><option value="in">Money in</option><option value="any">Either</option></select></Field>
            <Field label="Brand"><BrandSelect value={edit.brand_id} onChange={(v) => setEdit({ ...edit, brand_id: v, split_preset_id: '' })} /></Field>
            <Field label="…or split rule"><select className="input" value={edit.split_preset_id} onChange={(e) => setEdit({ ...edit, split_preset_id: e.target.value, brand_id: '' })}><option value="">—</option>{(boot.presets || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            <Field label="Category"><select className="input" value={edit.category_id} onChange={(e) => setEdit({ ...edit, category_id: e.target.value })}><option value="">—</option>{boot.categories.map((c) => <option key={c.id} value={c.id}>{c.kind === 'in' ? '↓' : '↑'} {c.name}</option>)}</select></Field>
            <Field label="Party name"><input className="input" value={edit.party || ''} onChange={(e) => setEdit({ ...edit, party: e.target.value })} /></Field>
          </div>
          <label className="toggle"><input type="checkbox" checked={edit.auto_post} onChange={(e) => setEdit({ ...edit, auto_post: e.target.checked })} />Post directly to the Book (no confirming)</label>
          <label className="toggle"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />Active</label>
        </Modal>
      )}
    </>
  );
}

export default function Money() {
  const [tab, setTab] = useState('balances');
  return (
    <>
      <div className="page-head"><div><h1>Money</h1><p>What's in each account, and the bank statement matched against the Book.</p></div></div>
      <div className="tabs">
        {[['balances', 'Balances'], ['bank', 'Bank statement'], ['rules', 'Auto rules']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'balances' && <Balances />}
      {tab === 'bank' && <Reconcile />}
      {tab === 'rules' && <Rules />}
    </>
  );
}



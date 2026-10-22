import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { fmtDate, inr, inr2, today } from '../lib/format.js';
import { Empty, Err, Field, Loader, Modal, Stat, useApp, useAsync } from '../components/ui.jsx';
import { EntryForm } from './Book.jsx';

function TopUp({ st, onClose, onDone }) {
  const { boot } = useApp();
  const from = boot.accounts.filter((a) => a.id !== st.account.id);
  const [f, setF] = useState({ amount: st.topup_suggest || '', from_account_id: from.find((a) => a.kind === 'bank')?.id || from[0]?.id || '', entry_date: today(), note: '' });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError('');
    try { await api('/petty/topup', { method: 'POST', body: { ...f, amount: Number(f.amount), from_account_id: Number(f.from_account_id), note: f.note || null } }); onDone('Cash added to the box'); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Top up the cash box" onClose={onClose} footer={<><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || !(Number(f.amount) > 0) || !f.from_account_id} onClick={save}>{busy ? 'Saving…' : 'Add cash'}</button></>}>
      <Err error={error} />
      <div className="muted small">You gave cash for small spends — taken from the bank, your cash in hand or the day's collections. It's a transfer between our own accounts, not an expense.</div>
      <div className="grid g2">
        <Field label="Amount (₹)"><input className="input" type="number" inputMode="decimal" min="0" autoFocus value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Date"><input className="input" type="date" value={f.entry_date} onChange={(e) => setF({ ...f, entry_date: e.target.value })} /></Field>
        <Field label="Taken from"><select className="input" value={f.from_account_id} onChange={(e) => setF({ ...f, from_account_id: e.target.value })}>
          {from.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="optional" /></Field>
      </div>
      {st.topup_suggest > 0 && <div className="money-hint">To bring the box back to its float of {inr(st.float)}: {inr(st.topup_suggest)}</div>}
    </Modal>
  );
}

function Handover({ st, onClose, onDone }) {
  const { boot } = useApp();
  const col = st.collections;
  const to = boot.accounts.filter((a) => a.id !== col.id && a.id !== st.account.id);
  const [f, setF] = useState({ amount: col.balance > 0 ? col.balance : '', to_account_id: to.find((a) => a.kind === 'bank')?.id || to[0]?.id || '', entry_date: today(), note: '' });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError('');
    try { await api('/petty/handover', { method: 'POST', body: { ...f, amount: Number(f.amount), to_account_id: Number(f.to_account_id), note: f.note || null } }); onDone('Cash handed over'); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Hand over the day's cash" onClose={onClose} footer={<><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || !(Number(f.amount) > 0) || !f.to_account_id} onClick={save}>{busy ? 'Saving…' : 'Hand over'}</button></>}>
      <Err error={error} />
      <div className="muted small">{col.name} holds <strong>{inr2(col.balance)}</strong> in the Book. Moving it to the bank, or to cash in hand with you, is a transfer — not income or expense. If the cash you received isn't in the Book yet, enter it first.</div>
      <div className="grid g2">
        <Field label="Amount handed over (₹)"><input className="input" type="number" inputMode="decimal" min="0" autoFocus value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Date"><input className="input" type="date" value={f.entry_date} onChange={(e) => setF({ ...f, entry_date: e.target.value })} /></Field>
        <Field label="Handed over to"><select className="input" value={f.to_account_id} onChange={(e) => setF({ ...f, to_account_id: e.target.value })}>
          {to.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="optional" /></Field>
      </div>
    </Modal>
  );
}

function Count({ st, onClose, onDone }) {
  const [counted, setCounted] = useState(''); const [note, setNote] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const diff = counted === '' ? null : Math.round((Number(counted) - st.balance) * 100) / 100;
  const save = async () => {
    setBusy(true); setError('');
    try { const r = await api('/petty/count', { method: 'POST', body: { counted: Number(counted), note: note || null } }); onDone(r.count.diff === 0 ? 'Cash matches the Book ✔' : `Saved — ${r.count.diff < 0 ? 'short' : 'extra'} ${inr(Math.abs(r.count.diff))}`); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Count the cash" onClose={onClose} footer={<><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || counted === ''} onClick={save}>{busy ? 'Saving…' : 'Save count'}</button></>}>
      <Err error={error} />
      <div className="muted small">Count the notes and coins in the box. The Book says there should be <strong>{inr2(st.balance)}</strong>.</div>
      <Field label="Cash counted (₹)"><input className="input" type="number" inputMode="decimal" min="0" autoFocus value={counted} onChange={(e) => setCounted(e.target.value)} /></Field>
      {diff !== null && <div className={`banner ${diff === 0 ? 'info' : 'bad'}`}>{diff === 0 ? 'Matches the Book.' : `${diff < 0 ? 'Short' : 'Extra'} by ${inr2(Math.abs(diff))} — find the missing/extra entry, then save this count. Admins are told when a count differs.`}</div>}
      <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" /></Field>
    </Modal>
  );
}

function Settings({ st, onClose, onDone }) {
  const { boot } = useApp();
  const c = st.config;
  const [f, setF] = useState({ account_id: c.account_id || st.account?.id || '', collections_account_id: c.collections_account_id || '', float: c.float, low_at: c.low_at, on: !!c.approval.on, above: c.approval.above, cash_only: c.approval.cash_only !== false });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError('');
    try {
      await api('/petty/settings', { method: 'PUT', body: { account_id: f.account_id ? Number(f.account_id) : null, collections_account_id: f.collections_account_id ? Number(f.collections_account_id) : null, float: Number(f.float), low_at: Number(f.low_at),
        approval: { on: f.on, above: Number(f.above), cash_only: f.cash_only } } });
      onDone('Saved');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Petty cash settings" onClose={onClose} footer={<><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <Err error={error} />
      <div className="grid g2">
        <Field label="Cash box account"><select className="input" value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}>
          {boot.accounts.filter((a) => a.kind === 'cash').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Cash collections account (optional)"><select className="input" value={f.collections_account_id} onChange={(e) => setF({ ...f, collections_account_id: e.target.value })}>
          <option value="">— none —</option>{boot.accounts.filter((a) => a.kind === 'cash' && String(a.id) !== String(f.account_id)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <div className="muted small" style={{ gridColumn: '1 / -1' }}>Customers' cash is recorded into the <strong>collections</strong> account and handed over each day. The <strong>petty cash box</strong> only holds the small float you give out. Need another account? Settings → Accounts → add one with type Cash.</div>
        <Field label="Float — usual cash in the box (₹)"><input className="input" type="number" min="0" value={f.float} onChange={(e) => setF({ ...f, float: e.target.value })} /></Field>
        <Field label="Warn me when below (₹)"><input className="input" type="number" min="0" value={f.low_at} onChange={(e) => setF({ ...f, low_at: e.target.value })} /></Field>
      </div>
      <div className="split-box" style={{ display: 'grid', gap: 10 }}>
        <label className="toggle"><input type="checkbox" checked={f.on} onChange={(e) => setF({ ...f, on: e.target.checked })} /><strong>Staff spends need my approval</strong></label>
        <div className="muted small">When on, money out entered by staff (not admin) over the limit waits in Book → To confirm. It doesn't count anywhere until an admin approves, and admins get a message.</div>
        {f.on && (
          <div className="grid g2">
            <Field label="Approval needed above (₹)"><input className="input" type="number" min="0" value={f.above} onChange={(e) => setF({ ...f, above: e.target.value })} /></Field>
            <label className="toggle" style={{ alignSelf: 'end', paddingBottom: 8 }}><input type="checkbox" checked={f.cash_only} onChange={(e) => setF({ ...f, cash_only: e.target.checked })} />Cash spends only</label>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function PettyCash() {
  const { user, notify } = useApp();
  const { data: st, error, reload } = useAsync(() => api('/petty'), []);
  const [modal, setModal] = useState(null);
  const [editing, setEditing] = useState(null);
  if (error) return <Err error={error} />;
  if (!st) return <Loader />;
  if (!st.account) return <div className="banner">{st.message}</div>;
  const done = (msg) => { setModal(null); reload(); notify(msg); };
  const open = async (r) => { try { setEditing(await api(`/entries/${r.id}`)); } catch (e) { notify(e.message); } };
  const admin = user.role === 'admin';

  return (
    <>
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="muted small">Small cash spends for the office — tea, repairs, printing, fuel. Enter them in <strong>Book</strong> with "Paid from {st.account.name}".</div>
        <span className="spacer" />
        {st.collections && <button className="btn primary" onClick={() => setModal('handover')}>Hand over cash</button>}
        <button className={`btn${st.collections ? '' : ' primary'}`} onClick={() => setModal('topup')}>Top up</button>
        <button className="btn" onClick={() => setModal('count')}>Count the cash</button>
        {admin && <button className="btn" onClick={() => setModal('settings')}>Settings</button>}
      </div>
      {st.collections && (
        <div className={`banner ${st.collections.yesterday_balance > 0.5 ? 'bad' : 'info'}`} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span><strong>{st.collections.name}:</strong> {inr2(st.collections.balance)} waiting to be handed over
            {st.collections.yesterday_balance > 0.5 && ` — ${inr2(st.collections.yesterday_balance)} of it is from before today`}.
            {st.collections.last_handover && ` Last handover ${fmtDate(st.collections.last_handover.date)} (${inr(st.collections.last_handover.amount)}).`}</span>
          <span className="spacer" />
        </div>
      )}
      {st.low && <div className="banner bad">The cash box is low ({inr(st.balance)}, warning level {inr(st.low_at)}). Top up about {inr(st.topup_suggest)} from the bank.</div>}
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Stat label={st.account.name} value={inr(st.balance)} tone={st.low ? 'out' : 'in'} hint={`float ${inr(st.float)}`} />
        <Stat label="Spent this month" value={inr(st.month.total)} tone="out" hint={(() => { const n = st.month.by_category.reduce((s, c) => s + c.n, 0); return `${n} spend${n === 1 ? '' : 's'}`; })()} />
        <Stat label="Bills missing" value={String(st.bills_missing.count)} tone={st.bills_missing.count ? 'out' : ''} hint={st.bills_missing.count ? `${inr(st.bills_missing.amount)} — no photo` : 'all have a bill'} />
        <Stat label="Waiting for approval" value={String(st.awaiting_approval.count)} hint={st.awaiting_approval.count ? inr(st.awaiting_approval.amount) : st.config.approval.on ? `staff over ${inr(st.config.approval.above)}` : 'approval is off'} />
      </div>

      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <h3 style={{ margin: '0 0 8px' }}>Bills missing</h3>
        <div className="muted small" style={{ marginBottom: 8 }}>Cash spends in the last 60 days with no bill photo. Open one and add the photo — or tick <strong>No bill / receipt</strong> if there truly isn't one (tea, auto fare). The CA sees those separately.</div>
        {st.bills_missing.rows.length === 0 ? <Empty>Nothing missing. 🎉</Empty> : (
          <table className="t">
            <thead><tr><th>Date</th><th>Details</th><th className="hide-sm">Category</th><th className="hide-sm">By</th><th className="num">Amount</th></tr></thead>
            <tbody>{st.bills_missing.rows.map((r) => (
              <tr key={r.id} className="click" onClick={() => open(r)}>
                <td>{fmtDate(r.entry_date)}</td><td><div>{r.party || '—'}</div>{r.note && <div className="muted small">{r.note}</div>}</td>
                <td className="hide-sm">{r.category_name || '—'}</td><td className="hide-sm muted">{r.created_by_name || '—'}</td><td className="num">{inr(r.amount)}</td>
              </tr>))}</tbody>
          </table>
        )}
        {st.no_bill.count > 0 && <p className="muted small" style={{ marginBottom: 0 }}>Marked "no bill" in the last {st.no_bill.days} days: {st.no_bill.count} spend{st.no_bill.count === 1 ? '' : 's'}, {inr(st.no_bill.amount)}.</p>}
      </div>

      <div className="grid g2">
        <div className="card card-pad">
          <h3 style={{ margin: '0 0 8px' }}>Spent this month, by category</h3>
          {st.month.by_category.length === 0 ? <Empty>No cash spends yet this month.</Empty> : (
            <table className="t"><tbody>{st.month.by_category.map((c) => <tr key={c.name}><td>{c.name} <span className="muted small">· {c.n}</span></td><td className="num">{inr(c.amount)}</td></tr>)}</tbody></table>
          )}
        </div>
        <div className="card card-pad">
          <h3 style={{ margin: '0 0 8px' }}>Cash counts</h3>
          {st.counts.length === 0 ? <Empty>No count yet. Count the box once a week.</Empty> : (
            <table className="t"><thead><tr><th>Date</th><th className="num">Counted</th><th className="num">Book</th><th className="num">Difference</th></tr></thead>
              <tbody>{st.counts.map((c, i) => <tr key={i}><td>{fmtDate(c.date)}<div className="muted small">{c.by}</div></td><td className="num">{inr(c.counted)}</td><td className="num">{inr(c.book)}</td>
                <td className={`num ${c.diff ? 'out' : ''}`}>{c.diff === 0 ? '✔' : `${c.diff < 0 ? '−' : '+'}${inr(Math.abs(c.diff))}`}</td></tr>)}</tbody></table>
          )}
        </div>
      </div>

      {modal === 'topup' && <TopUp st={st} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'handover' && st.collections && <Handover st={st} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'count' && <Count st={st} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'settings' && <Settings st={st} onClose={() => setModal(null)} onDone={done} />}
      {editing && <EntryForm initial={editing} onClose={() => setEditing(null)} onSaved={(_r, msg) => { setEditing(null); reload(); notify(msg || 'Saved'); }} />}
    </>
  );
}

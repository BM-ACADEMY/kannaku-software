import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtDate, inr } from '../lib/format.js';
import { BrandSelect, Empty, Err, Field, Loader, Modal, useApp, useAsync } from '../components/ui.jsx';
import SplitEditor, { splitTotal } from '../components/SplitEditor.jsx';

const JOBS = [
  { key: 'recurring', what: 'Makes rent, salaries, subscriptions and other repeating entries on their day. They wait in Book → To confirm unless set to post directly.' },
  { key: 'pay_reminders', what: 'Reminds you (admins) on WhatsApp + email about what WE must pay — rent, EMIs, salaries, vendor bills, refunds — a few days before, the day before, on the day, and every day once overdue.', extra: [['days_before', 'First reminder (days before)', 'number']] },
  { key: 'reminders', what: 'WhatsApps customers a polite reminder for invoices and dues that are due soon or overdue.', extra: [['days_before', 'Days before due', 'number'], ['repeat_days', 'Repeat every (days)', 'number']] },
  { key: 'weekly_brief', what: 'Sends admins a short money summary — income, spend, cash, what to collect and pay.', extra: [['weekday', 'Day', 'weekday']] },
  { key: 'investor_statements', what: "On each investor's statement day, sends last month's profit-share statement by WhatsApp and email." },
  { key: 'month_lock', what: 'Closes last month on the day set in Settings → Books, so its numbers can no longer change.' },
  { key: 'alerts', what: 'Warns admins if money may run out, a brand goes over budget, backups stop, or vendor bills are overdue.', extra: [['low_cash_days', 'Look ahead (days)', 'number'], ['budget_pct', 'Budget alert at %', 'number']] },
  { key: 'bank_autopost', what: 'Lets bank rules marked "post directly" go straight into the Book. Off = everything from the bank waits for you to confirm.' },
];
const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ago = (t) => { const m = Math.round((Date.now() - new Date(t)) / 60000); return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

function Jobs({ data, reload }) {
  const { user, notify } = useApp();
  const [s, setS] = useState({ enabled: data.enabled, jobs: data.jobs });
  const [busy, setBusy] = useState('');
  const admin = user.role === 'admin';
  useEffect(() => setS({ enabled: data.enabled, jobs: data.jobs }), [data]);
  const save = async (next) => { setS(next); try { await api('/autopilot', { method: 'PUT', body: next }); notify('Saved'); reload(); } catch (e) { notify(e.message); } };
  const setJob = (k, patch) => save({ ...s, jobs: { ...s.jobs, [k]: { ...s.jobs[k], ...patch } } });
  const run = async (k) => { setBusy(k); try { const r = await api(`/autopilot/run/${k}`, { method: 'POST' }); notify(r.summary || 'Done'); reload(); } catch (e) { notify(e.message); } setBusy(''); };
  return (
    <>
      <div className={`banner ${s.enabled ? 'info' : 'bad'}`}>
        <strong>{s.enabled ? 'Autopilot is on' : 'Autopilot is off'}</strong>
        <span>{s.enabled ? `Kanakku checks every 5 minutes and runs each job once a day at its time (India time, now ${data.now.hm}).` : 'No job runs by itself until you switch it back on.'}</span>
        {admin && <label className="switch" style={{ marginLeft: 'auto' }}><input type="checkbox" checked={s.enabled} onChange={(e) => save({ ...s, enabled: e.target.checked })} /><span /></label>}
      </div>
      <div className="card">
        {JOBS.map((j) => {
          const cfg = s.jobs[j.key] || {}; const last = data.last[j.key];
          return (
            <div className="job" key={j.key}>
              <div>
                <div className="title">{data.names[j.key]}</div>
                <div className="desc">{j.what}</div>
                {last && <div className={`last ${last.ok ? 'muted' : 'out'}`}>Last: {ago(last.ran_at)} — {last.summary}</div>}
                {cfg.on && j.extra && admin && (
                  <div className="row" style={{ marginTop: 6 }}>{j.extra.map(([k, l, t]) => (
                    <label key={k} className="small muted row" style={{ gap: 6 }}>{l}
                      {t === 'weekday' ? <select className="input" style={{ width: 'auto', padding: '3px 6px' }} value={cfg[k]} onChange={(e) => setJob(j.key, { [k]: Number(e.target.value) })}>{WEEKDAYS.slice(1).map((w, i) => <option key={w} value={i + 1}>{w}</option>)}</select>
                        : <input className="input" type="number" style={{ width: 70, padding: '3px 6px' }} value={cfg[k]} onChange={(e) => setJob(j.key, { [k]: Number(e.target.value) })} />}
                    </label>))}</div>
                )}
              </div>
              <div className="controls">
                {cfg.at !== undefined && <input className="input" type="time" style={{ width: 110 }} value={cfg.at} disabled={!admin || !cfg.on} onChange={(e) => setJob(j.key, { at: e.target.value })} />}
                {admin && j.key !== 'bank_autopost' && <button className="btn sm" disabled={busy === j.key} onClick={() => run(j.key)}>{busy === j.key ? 'Running…' : 'Run now'}</button>}
                <label className="switch"><input type="checkbox" checked={!!cfg.on} disabled={!admin} onChange={(e) => setJob(j.key, { on: e.target.checked })} /><span /></label>
              </div>
            </div>
          );
        })}
      </div>
      <p className="muted small">WhatsApp and email need their keys in Settings → Integrations. Without them, jobs still run and the log says what couldn't be sent.</p>
    </>
  );
}

const blankRec = () => ({ name: '', frequency: 'monthly', day: 1, start_date: new Date().toISOString().slice(0, 10), end_date: '', auto_post: false, active: true,
  shared: false, template: { type: 'out', amount: '', gst_amount: '', brand_id: '', split: [], category_id: '', account_id: '', party: '', note: '' } });

function RecurringForm({ initial, onClose, onSaved }) {
  const { boot } = useApp();
  const [r, setR] = useState(() => initial ? { ...initial, start_date: String(initial.next_date).slice(0, 10), end_date: initial.end_date ? String(initial.end_date).slice(0, 10) : '',
    shared: !!initial.template.split?.length, template: { ...blankRec().template, ...initial.template } } : blankRec());
  const [error, setError] = useState('');
  const t = r.template; const setT = (patch) => setR({ ...r, template: { ...t, ...patch } });
  const ok = r.name && Number(t.amount) > 0 && (r.shared ? Math.abs(splitTotal(t.split) - 100) < 0.01 : t.brand_id);
  const save = async () => {
    try {
      const body = { name: r.name, frequency: r.frequency, day: Number(r.day), start_date: r.start_date, end_date: r.end_date || null, auto_post: r.auto_post, active: r.active,
        template: { type: t.type, amount: Number(t.amount), gst_amount: Number(t.gst_amount) || 0, brand_id: r.shared ? null : Number(t.brand_id), split: r.shared ? t.split : null,
          category_id: Number(t.category_id) || null, account_id: Number(t.account_id) || null, party: t.party || null, note: t.note || r.name } };
      onSaved(r.id ? await api(`/recurring/${r.id}`, { method: 'PUT', body }) : await api('/recurring', { method: 'POST', body }));
    } catch (e) { setError(e.message); }
  };
  return (
    <Modal wide title={r.id ? `Edit ${r.name}` : 'New recurring entry'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!ok} onClick={save}>Save</button></>}>
      <Err error={error} />
      <div className="grid g4">
        <Field label="Name"><input className="input" value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="e.g. Office rent" autoFocus /></Field>
        <Field label="Repeats"><select className="input" value={r.frequency} onChange={(e) => setR({ ...r, frequency: e.target.value, day: e.target.value === 'weekly' ? 1 : r.day })}>
          <option value="monthly">Every month</option><option value="weekly">Every week</option><option value="quarterly">Every 3 months</option><option value="yearly">Every year</option></select></Field>
        <Field label={r.frequency === 'weekly' ? 'Day of week' : 'Day of month'}>{r.frequency === 'weekly'
          ? <select className="input" value={r.day} onChange={(e) => setR({ ...r, day: e.target.value })}>{WEEKDAYS.slice(1).map((w, i) => <option key={w} value={i + 1}>{w}</option>)}</select>
          : <input className="input" type="number" min="1" max="31" value={r.day} onChange={(e) => setR({ ...r, day: e.target.value })} />}</Field>
        <Field label="Starting from"><input className="input" type="date" value={r.start_date} onChange={(e) => setR({ ...r, start_date: e.target.value })} /></Field>
      </div>
      <div className="row">
        <div className="seg"><button className={t.type === 'out' ? 'on out' : ''} onClick={() => setT({ type: 'out' })}>Money out</button><button className={t.type === 'in' ? 'on in' : ''} onClick={() => { setT({ type: 'in', gst_amount: '' }); setR((x) => ({ ...x, shared: false })); }}>Money in</button></div>
        <span className="spacer" />
        {t.type === 'out' && <label className="toggle"><input type="checkbox" checked={r.shared} onChange={(e) => setR({ ...r, shared: e.target.checked })} />Shared — split across brands</label>}
      </div>
      <div className="grid g4">
        <Field label="Amount ₹"><input className="input" type="number" value={t.amount} onChange={(e) => setT({ amount: e.target.value })} /></Field>
        {!r.shared && <Field label="Brand"><BrandSelect value={t.brand_id} onChange={(v) => setT({ brand_id: v })} /></Field>}
        <Field label="Category"><select className="input" value={t.category_id || ''} onChange={(e) => setT({ category_id: e.target.value })}><option value="">—</option>{boot.categories.filter((c) => c.kind === t.type).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Account"><select className="input" value={t.account_id || ''} onChange={(e) => setT({ account_id: e.target.value })}><option value="">—</option>{boot.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label={t.type === 'out' ? 'Paid to' : 'From'}><input className="input" value={t.party || ''} onChange={(e) => setT({ party: e.target.value })} /></Field>
        {t.type === 'out' && <Field label="GST in it ₹ (claimable)"><input className="input" type="number" value={t.gst_amount} onChange={(e) => setT({ gst_amount: e.target.value })} placeholder="0" /></Field>}
        <Field label="Stop after (optional)"><input className="input" type="date" value={r.end_date || ''} onChange={(e) => setR({ ...r, end_date: e.target.value })} /></Field>
      </div>
      {r.shared && <div className="row">
        <select className="input" style={{ width: 'auto' }} onChange={(e) => { const p = (boot.presets || []).find((x) => x.id === Number(e.target.value)); if (p) setT({ split: p.rules.map((x) => ({ brand_id: x.brand_id, pct: Number(x.pct) })) }); }}>
          <option value="">Use a split rule…</option>{(boot.presets || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}
      {r.shared && <SplitEditor rules={t.split || []} amount={t.amount} onChange={(split) => setT({ split })} />}
      <label className="toggle"><input type="checkbox" checked={r.auto_post} onChange={(e) => setR({ ...r, auto_post: e.target.checked })} />Post straight to the Book (don't ask me) — best for fixed amounts like rent</label>
      <div className="muted small">Salary per brand: make one recurring entry per person, category Salary, shared across the brands they work for (e.g. TechX 60% / Academy 40%).</div>
    </Modal>
  );
}

function Recurring() {
  const { notify, user } = useApp();
  const { data, error, reload } = useAsync(() => api('/recurring'), []);
  const [edit, setEdit] = useState(null);
  const stop = async (r) => { if (window.confirm(`Stop "${r.name}"? Entries already made stay.`)) { await api(`/recurring/${r.id}`, { method: 'DELETE' }); reload(); } };
  const runNow = async () => { const r = await api('/recurring/run', { method: 'POST' }); notify(`${r.created} made${r.errors.length ? ` · ${r.errors[0]}` : ''}`); reload(); };
  if (error) return <Err error={error} />;
  if (!data) return <Loader />;
  const monthly = data.filter((r) => r.active && r.frequency === 'monthly' && r.template.type === 'out').reduce((s, r) => s + Number(r.template.amount), 0);
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted">Fixed monthly spend set up: <strong>{inr(monthly)}</strong></span><span className="spacer" />
        {user.role === 'admin' && <button className="btn sm" onClick={runNow}>Make due ones now</button>}
        <button className="btn primary sm" onClick={() => setEdit(blankRec())}>+ New recurring</button>
      </div>
      <div className="card table-wrap">
        {data.length === 0 ? <Empty>Nothing set up. Add rent, salaries, internet, software…</Empty> : (
          <table className="t">
            <thead><tr><th>Name</th><th>Repeats</th><th className="num">Amount</th><th>Brand</th><th>Next</th><th className="hide-sm">Mode</th><th /></tr></thead>
            <tbody>{data.map((r) => (
              <tr key={r.id} className="click" style={{ opacity: r.active ? 1 : 0.5 }} onClick={() => setEdit(r)}>
                <td style={{ fontWeight: 600 }}>{r.name}<div className="muted small">{r.made} made so far</div></td>
                <td>{r.frequency === 'weekly' ? `Weekly, ${WEEKDAYS[r.day]}` : `${r.frequency[0].toUpperCase()}${r.frequency.slice(1)}, day ${r.day}`}</td>
                <td className={`num ${r.template.type}`}>{inr(r.template.amount)}</td>
                <td>{r.template.split?.length ? <span className="tag">Shared · {r.template.split.length}</span> : r.brand_name || '—'}</td>
                <td>{r.active ? fmtDate(r.next_date) : 'stopped'}</td>
                <td className="hide-sm"><span className={`pill ${r.auto_post ? 'paid' : 'pending'}`}>{r.auto_post ? 'posts' : 'to confirm'}</span></td>
                <td className="num" onClick={(e) => e.stopPropagation()}>{r.active && <button className="btn sm danger" onClick={() => stop(r)}>Stop</button>}</td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
      {edit && <RecurringForm initial={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); notify('Saved'); }} />}
    </>
  );
}

function Coming() {
  const { user, notify } = useApp();
  const admin = user.role === 'admin';
  const [days, setDays] = useState(30);
  const { data: list, error } = useAsync(() => api(`/calendar/upcoming?days=${days}`), [days]);
  const { data: cal, reload } = useAsync(() => (admin ? api('/calendar/settings') : Promise.resolve(null)), [admin]);
  const [busy, setBusy] = useState(false);
  const setCal = async (patch) => {
    setBusy(true);
    try { await api('/calendar/settings', { method: 'POST', body: { enabled: cal.enabled, include_in: cal.include_in, days_ahead: cal.days_ahead, ...patch } }); reload(); notify('Saved'); }
    catch (e) { notify(e.message); } setBusy(false);
  };
  const copy = async () => { try { await navigator.clipboard.writeText(cal.url); notify('Link copied'); } catch { notify('Select the link and copy it'); } };
  const out = (list || []).filter((i) => i.direction === 'out'); const inn = (list || []).filter((i) => i.direction === 'in');
  const sum = (a) => a.reduce((s, i) => s + i.amount, 0);
  const when = (d) => (d < 0 ? <span className="out">overdue {-d}d</span> : d === 0 ? <strong>today</strong> : d === 1 ? 'tomorrow' : `in ${d} days`);
  return (
    <>
      {admin && cal && (
        <div className="card card-pad" style={{ marginBottom: 14 }}>
          <div className="row"><h3 style={{ margin: 0 }}>📅 Google Calendar</h3><span className="spacer" />
            <label className="switch"><input type="checkbox" checked={cal.enabled} disabled={busy} onChange={(e) => setCal({ enabled: e.target.checked })} /><span /></label></div>
          {!cal.enabled ? <p className="muted small" style={{ marginBottom: 0 }}>Turn on to get a private link. Add it once to Google Calendar and every rent, EMI, salary, bill due date{cal.include_in ? ' and expected customer payment' : ''} shows up there and keeps itself updated.</p> : <>
            <div className="row" style={{ marginTop: 10 }}>
              <input className="input" readOnly value={cal.url} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 240, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
              <button className="btn primary sm" onClick={copy}>Copy link</button>
            </div>
            <ol className="small" style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
              <li>On a computer open <strong>calendar.google.com</strong> → left side, <strong>Other calendars</strong> → <strong>+</strong> → <strong>From URL</strong>.</li>
              <li>Paste the link → <strong>Add calendar</strong>. It appears on your phone's Google Calendar too.</li>
              <li>To get pop-up alerts: click the new calendar's ⋮ → <strong>Settings</strong> → <strong>Event notifications</strong> → e.g. 1 day before, 9:00.</li>
            </ol>
            <div className="row" style={{ marginTop: 10 }}>
              <label className="toggle"><input type="checkbox" checked={cal.include_in} disabled={busy} onChange={(e) => setCal({ include_in: e.target.checked })} />Also show money coming in (customer invoices)</label>
              <span className="spacer" />
              <button className="btn sm" disabled={busy} onClick={() => window.confirm('Make a new link? The old link stops working — you will need to add the new one to Google Calendar again.') && setCal({ new_link: true })}>New link</button>
            </div>
            <p className="muted small" style={{ marginBottom: 0 }}>Anyone with this link can see these dates and amounts — keep it private. Google refreshes it every few hours, so a change in Kanakku can take a while to show.</p>
          </>}
        </div>
      )}
      <div className="filters"><div className="seg">{[7, 30, 60, 90].map((d) => <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d} days</button>)}</div>
        {list && <span className="muted small">To pay <strong className="out">{inr(sum(out))}</strong> · to collect <strong className="in">{inr(sum(inn))}</strong></span>}</div>
      <Err error={error} />
      {!list && !error && <Loader />}
      {list && (
        <div className="card table-wrap">
          {list.length === 0 ? <Empty>Nothing due.</Empty> : (
            <table className="t">
              <thead><tr><th>When</th><th>What</th><th className="hide-sm">Type</th><th className="num">Amount</th></tr></thead>
              <tbody>{list.map((i) => (
                <tr key={i.key}><td style={{ whiteSpace: 'nowrap' }}>{fmtDate(i.date)}<div className="small muted">{when(i.days_left)}</div></td>
                  <td>{i.title}<div className="muted small">{[i.brand, i.ref].filter(Boolean).join(' · ')}</div></td>
                  <td className="hide-sm"><span className="pill">{i.kind}</span></td>
                  <td className={`num ${i.direction}`}>{i.direction === 'out' ? '−' : ''}{inr(i.amount)}</td></tr>))}</tbody>
            </table>
          )}
        </div>
      )}
      <p className="muted small">Loans: add the EMI as a recurring entry (Money out, category <strong>Loan repaid</strong>) — it shows here as EMI, reminds you, and goes to the calendar. Money borrowed goes in the Book as <strong>Loan received</strong>. Neither counts as profit or loss.</p>
    </>
  );
}

function Log({ data }) {
  return (
    <div className="card table-wrap">
      {data.log.length === 0 ? <Empty>Nothing has run yet.</Empty> : (
        <table className="t">
          <thead><tr><th>When</th><th>Job</th><th>Result</th></tr></thead>
          <tbody>{data.log.map((l) => (
            <tr key={l.id}><td className="muted" style={{ whiteSpace: 'nowrap' }}>{new Date(l.ran_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
              <td>{data.names[l.job] || l.job}</td><td className={l.ok ? '' : 'out'}>{l.summary}</td></tr>))}</tbody>
        </table>
      )}
    </div>
  );
}

export default function Autopilot() {
  const [tab, setTab] = useState('jobs');
  const { data, error, reload } = useAsync(() => api('/autopilot'), []);
  return (
    <>
      <div className="page-head"><div><h1>Autopilot</h1><p>What Kanakku does by itself every day — and what it did.</p></div></div>
      <div className="tabs">{[['jobs', 'Daily jobs'], ['coming', 'Coming up & calendar'], ['recurring', 'Recurring entries'], ['log', 'What it did']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      <Err error={error} />
      {tab === 'coming' ? <Coming /> : tab === 'recurring' ? <Recurring /> : !data ? <Loader /> : tab === 'jobs' ? <Jobs data={data} reload={reload} /> : <Log data={data} />}
    </>
  );
}

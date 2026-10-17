import React, { useEffect, useState } from 'react';
import { api, qs } from '../lib/api.js';
import { fmtDate, inr } from '../lib/format.js';
import { Avatar, BrandTag, Err, Field, Icon, Loader, Modal, useApp, useAsync } from '../components/ui.jsx';
import SplitEditor, { splitTotal } from '../components/SplitEditor.jsx';

// Section header above a settings card: title, one-line help, optional action on the right
const Section = ({ title, desc, action, children }) => (
  <section className="set-section">
    <div className="set-head">
      <div><h2>{title}</h2>{desc && <p>{desc}</p>}</div>
      {action}
    </div>
    {children}
  </section>
);

const YesNo = ({ on, yes = 'Yes', no = 'No' }) => <span className={`status ${on ? 'on' : 'off'}`}>{on ? yes : no}</span>;

function Company() {
  const { boot, reloadBoot, notify } = useApp();
  const [c, setC] = useState(boot.company);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setC({ ...c, [k]: e.target.value });
  const save = async () => {
    setSaving(true); setError('');
    try { await api('/settings/company', { method: 'PUT', body: c }); await reloadBoot(); notify('Company details saved'); } catch (e) { setError(e.message); }
    setSaving(false);
  };
  const F = (k, label, area) => <Field label={label}>{area ? <textarea className="input" value={c[k] || ''} onChange={set(k)} /> : <input className="input" value={c[k] || ''} onChange={set(k)} />}</Field>;
  return (
    <Section title="Company profile" desc="These details print on every quotation and invoice.">
      <div className="card">
        <Err error={error} />
        <div className="set-block">
          <div className="set-block-title">Identity</div>
          <div className="grid g2">{F('legal_name', 'Legal name')}{F('short_name', 'Short name')}{F('gstin', 'GSTIN')}{F('cin', 'CIN')}</div>
        </div>
        <div className="set-block">
          <div className="set-block-title">Documents & contact</div>
          <div className="grid g2">{F('state_code', 'GST state code')}{F('doc_prefix', 'Document number prefix')}{F('email', 'Email')}{F('website', 'Website')}</div>
        </div>
        <div className="set-block">
          <div className="set-block-title">Address, bank & terms</div>
          <div className="grid">{F('address', 'Registered address', true)}{F('bank_details', 'Bank details for invoices', true)}{F('invoice_terms', 'Default invoice terms', true)}</div>
        </div>
        <div className="set-foot"><button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save company details'}</button></div>
      </div>
    </Section>
  );
}

function Brands() {
  const { boot, reloadBoot, notify } = useApp();
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState('');
  const save = async () => {
    try {
      const body = { ...edit, sort_order: Number(edit.sort_order || 0) };
      if (edit.id) await api(`/brands/${edit.id}`, { method: 'PUT', body }); else await api('/brands', { method: 'POST', body });
      setEdit(null); await reloadBoot(); notify('Brand saved');
    } catch (e) { setError(e.message); }
  };
  const active = boot.brands.filter((b) => b.active).length;
  return (
    <Section title="Brands" desc={`${active} active of ${boot.brands.length}. The code appears in document numbers.`}
      action={<button className="btn primary sm" onClick={() => { setError(''); setEdit({ code: '', name: '', color: '#1B2A4A', in_investor_pool: false, active: true, sort_order: 50 }); }}>+ Add brand</button>}>
      <div className="card table-wrap">
        <table className="t">
          <thead><tr><th>Brand</th><th>Code</th><th>Investor pool</th><th>Status</th><th /></tr></thead>
          <tbody>{boot.brands.map((b) => (
            <tr key={b.id} className={b.active ? '' : 'dim'}><td><BrandTag name={b.name} color={b.color} /></td><td><code className="code">{b.code}</code></td>
              <td>{b.in_investor_pool ? <YesNo on yes="In pool" /> : <span className="muted">—</span>}</td><td><YesNo on={b.active} yes="Active" no="Inactive" /></td>
              <td className="num"><button className="btn sm ghost" onClick={() => { setError(''); setEdit(b); }}>Edit</button></td></tr>))}</tbody>
        </table>
      </div>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'New brand'} onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
          <Err error={error} />
          {edit.id && <div className="note-box">Changing the code only affects new documents. Old numbers stay as they are.</div>}
          <div className="grid g2">
            <Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Code (in doc numbers)"><input className="input" value={edit.code} maxLength={6} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Colour"><input className="input" type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} /></Field>
            <Field label="Sort order"><input className="input" type="number" value={edit.sort_order} onChange={(e) => setEdit({ ...edit, sort_order: e.target.value })} /></Field>
            <Field label="Counts in investor profit pool"><select className="input" value={edit.in_investor_pool ? '1' : '0'} onChange={(e) => setEdit({ ...edit, in_investor_pool: e.target.value === '1' })}><option value="0">No</option><option value="1">Yes</option></select></Field>
            <Field label="Active"><select className="input" value={edit.active ? '1' : '0'} onChange={(e) => setEdit({ ...edit, active: e.target.value === '1' })}><option value="1">Yes</option><option value="0">No</option></select></Field>
          </div>
        </Modal>
      )}
    </Section>
  );
}

function Presets() {
  const { boot, reloadBoot, notify } = useApp();
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState('');
  const name = (id) => boot.brands.find((b) => b.id === id)?.code || '?';
  const save = async () => {
    try {
      const body = { name: edit.name, rules: edit.rules, active: edit.active !== false };
      if (edit.id) await api(`/presets/${edit.id}`, { method: 'PUT', body }); else await api('/presets', { method: 'POST', body });
      setEdit(null); await reloadBoot(); notify('Split rule saved');
    } catch (e) { setError(e.message); }
  };
  const presets = boot.presets || [];
  return (
    <Section title="Shared cost splits" desc="How common bills (EB, rent, internet, tools) are divided across brands, so each brand's P&L carries its own share."
      action={<button className="btn primary sm" onClick={() => { setError(''); setEdit({ name: '', rules: [] }); }}>+ New split rule</button>}>
      <div className="card table-wrap">
        {presets.length ? (
          <table className="t">
            <thead><tr><th>Rule</th><th>Split</th><th /></tr></thead>
            <tbody>{presets.map((p) => (
              <tr key={p.id}><td style={{ fontWeight: 600 }}>{p.name}</td>
                <td><div className="split-chips">{p.rules.map((r) => <span key={r.brand_id} className="tag">{name(r.brand_id)} {Number(r.pct)}%</span>)}</div></td>
                <td className="num"><button className="btn sm ghost" onClick={() => { setError(''); setEdit({ ...p, rules: p.rules.map((r) => ({ brand_id: r.brand_id, pct: Number(r.pct) })) }); }}>Edit</button></td></tr>))}</tbody>
          </table>
        ) : <div className="empty">No split rules yet.</div>}
      </div>
      <div className="set-note">Editing a rule only changes new entries. Entries already saved keep the split they were saved with — open one in the Book to change it.</div>
      {edit && (
        <Modal wide title={edit.id ? `Edit ${edit.name}` : 'New split rule'} onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={!edit.name || Math.abs(splitTotal(edit.rules) - 100) > 0.01}>Save</button></>}>
          <Err error={error} />
          <Field label="Name"><input className="input" value={edit.name} placeholder="e.g. Office overheads" onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <SplitEditor rules={edit.rules} amount={10000} onChange={(rules) => setEdit({ ...edit, rules })} />
          <div className="muted small">Amounts shown are for a ₹10,000 bill.</div>
        </Modal>
      )}
    </Section>
  );
}

function Categories() {
  const { boot, reloadBoot, notify } = useApp();
  const [n, setN] = useState({ name: '', kind: 'out' });
  const [pick, setPick] = useState('');
  const pickCat = boot.categories.find((c) => c.id === Number(pick));
  const setDefault = async (presetId) => {
    await api(`/categories/${pickCat.id}`, { method: 'PUT', body: { name: pickCat.name, default_preset_id: presetId ? Number(presetId) : null } });
    await reloadBoot(); notify(presetId ? `${pickCat.name} will be split automatically` : 'Auto-split removed');
  };
  const add = async () => { if (!n.name) return; await api('/categories', { method: 'POST', body: n }); setN({ ...n, name: '' }); await reloadBoot(); notify('Category added'); };
  return (
    <Section title="Categories" desc="Used on every Book entry and in the P&L.">
      <div className="grid g2">
        {['in', 'out'].map((k) => {
          const list = boot.categories.filter((c) => c.kind === k);
          return (
            <div key={k} className="card card-pad">
              <div className="cat-head"><span className={`cat-dot ${k}`} />{k === 'in' ? 'Money in' : 'Money out'}<span className="muted small">{list.length}</span></div>
              <div className="row" style={{ gap: 6 }}>{list.map((c) => <span key={c.id} className="tag">{c.name}{c.default_preset_id ? ' · split' : ''}</span>)}</div>
            </div>
          );
        })}
      </div>
      <div className="card card-pad" style={{ marginTop: 14 }}>
        <div className="set-block-title">Add a category</div>
        <div className="row">
          <input className="input" style={{ maxWidth: 260 }} placeholder="Category name" value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <div className="seg">{['in', 'out'].map((k) => <button key={k} className={n.kind === k ? `on ${k}` : ''} onClick={() => setN({ ...n, kind: k })}>{k === 'in' ? 'Money in' : 'Money out'}</button>)}</div>
          <button className="btn primary" onClick={add} disabled={!n.name}>Add</button>
        </div>
        <div className="set-block-title" style={{ marginTop: 18 }}>Auto-split a money-out category</div>
        <div className="row">
          <select className="input" style={{ width: 'auto' }} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Pick a category…</option>{boot.categories.filter((c) => c.kind === 'out').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {pickCat && <select className="input" style={{ width: 'auto' }} value={pickCat.default_preset_id || ''} onChange={(e) => setDefault(e.target.value)}>
            <option value="">No auto-split</option>{(boot.presets || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>}
        </div>
      </div>
    </Section>
  );
}

const ROLES = [
  { key: 'admin', label: 'Admin', desc: 'Everything — settings, brands, users, investors, deletes and write-offs.' },
  { key: 'accounts', label: 'Accounts', desc: 'Book, deals, payments, dues, investors (view), P&L and GST.' },
  { key: 'sales', label: 'Sales', desc: 'Customers, quotations and what is due to collect.' },
];

function Users() {
  const { user: me, notify } = useApp();
  const { data, reload } = useAsync(() => api('/users'), []);
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const users = data || [];
  const open = (u) => { setError(''); setShowPw(false); setEdit(u); };
  const blank = (role = 'accounts') => open({ name: '', email: '', phone: '', role, password: '', active: true });
  const invalid = edit && (!edit.name.trim() || (!edit.id && !/^\S+@\S+\.\S+$/.test(edit.email)) || (!edit.id && edit.password.length < 8) || (edit.password && edit.password.length < 8));
  const save = async () => {
    setSaving(true); setError('');
    try {
      const body = { ...edit }; if (!body.password) delete body.password;
      if (edit.id) await api(`/users/${edit.id}`, { method: 'PUT', body }); else await api('/users', { method: 'POST', body });
      setEdit(null); reload(); notify('User saved');
    } catch (e) { setError(e.message); }
    setSaving(false);
  };
  return (
    <Section title="Team & roles" desc="Who can log in and what they can see."
      action={<button className="btn primary sm" onClick={() => blank()}>+ Add user</button>}>
      <div className="grid g3 role-cards">
        {ROLES.map((r) => {
          const n = users.filter((u) => u.role === r.key && u.active).length;
          return (
            <div key={r.key} className="card role-card">
              <div className="row"><span className={`role-badge ${r.key}`}>{r.label}</span><span className="spacer" /><span className="role-count">{n}</span></div>
              <p>{r.desc}</p>
              <button className="btn sm ghost" onClick={() => blank(r.key)}>+ Add {r.label.toLowerCase()}</button>
            </div>
          );
        })}
      </div>
      <div className="card table-wrap" style={{ marginTop: 14 }}>
        {!data ? <Loader /> : <table className="t">
          <thead><tr><th>User</th><th>Role</th><th className="hide-sm">WhatsApp</th><th>Status</th><th className="hide-sm">Added</th><th className="hide-sm" /></tr></thead>
          <tbody>{users.map((u) => (
            <tr key={u.id} className={`click${u.active ? '' : ' dim'}`} onClick={() => open({ ...u, phone: u.phone || '', password: '' })}>
              <td><div className="user-cell"><Avatar name={u.name} /><div><div className="user-name">{u.name}{u.id === me.id && <span className="you">You</span>}</div><div className="muted small">{u.email}</div></div></div></td>
              <td><span className={`role-badge ${u.role}`}>{u.role}</span></td>
              <td className="hide-sm">{u.phone || <span className="muted">—</span>}</td>
              <td><YesNo on={u.active} yes="Active" no="Disabled" /></td>
              <td className="hide-sm muted">{fmtDate(u.created_at)}</td>
              <td className="num hide-sm"><button className="btn sm ghost">Edit</button></td>
            </tr>))}</tbody>
        </table>}
      </div>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'New user'} onClose={() => setEdit(null)}
          footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" onClick={save} disabled={invalid || saving}>{saving ? 'Saving…' : edit.id ? 'Save changes' : 'Create user'}</button></>}>
          <Err error={error} />
          <div className="grid g2">
            <Field label="Full name"><input className="input" autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Email (login)"><input className="input" type="email" value={edit.email} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="WhatsApp number"><input className="input" value={edit.phone} placeholder="Admins get the weekly brief" onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
            <Field label={edit.id ? 'New password (blank = keep)' : 'Password (min 8)'}>
              <div className="pw">
                <input className="input" type={showPw ? 'text' : 'password'} value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} />
                <button type="button" className={`pw-eye${showPw ? ' on' : ''}`} aria-label="Show password" onClick={() => setShowPw(!showPw)}>{Icon.eye}</button>
              </div>
            </Field>
          </div>
          <div className="field"><span>Role</span>
            <div className="role-pick">{ROLES.map((r) => (
              <button type="button" key={r.key} className={`role-opt${edit.role === r.key ? ' on' : ''}`} onClick={() => setEdit({ ...edit, role: r.key })}>
                <span className={`role-badge ${r.key}`}>{r.label}</span><span className="small muted">{r.desc}</span>
              </button>))}</div>
          </div>
          {edit.id && edit.id !== me.id && (
            <label className="toggle"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />Can log in (untick to disable without deleting)</label>
          )}
        </Modal>
      )}
    </Section>
  );
}

const KINDS = { cash: 'Cash', bank: 'Bank', upi: 'UPI', gateway: 'Gateway' };

function Accounts() {
  const { reloadBoot, notify } = useApp();
  const { data, error: loadError, reload } = useAsync(() => api('/accounts'), []);
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState('');
  const save = async () => {
    try {
      const body = { name: edit.name, kind: edit.kind, active: edit.active };
      if (edit.id) await api(`/accounts/${edit.id}`, { method: 'PUT', body }); else await api('/accounts', { method: 'POST', body });
      setEdit(null); reload(); await reloadBoot(); notify('Account saved');
    } catch (e) { setError(e.message); }
  };
  return (
    <Section title="Payment accounts" desc="Where money sits — cash box, bank accounts, UPI, Razorpay. Picked on every Book entry and payment."
      action={<button className="btn primary sm" onClick={() => { setError(''); setEdit({ name: '', kind: 'bank', active: true }); }}>+ Add account</button>}>
      <Err error={loadError} />
      <div className="card table-wrap">
        {!data ? <Loader /> : (
          <table className="t">
            <thead><tr><th>Account</th><th>Type</th><th className="num">Entries</th><th>Status</th><th /></tr></thead>
            <tbody>{data.map((a) => (
              <tr key={a.id} className={a.active ? '' : 'dim'}>
                <td style={{ fontWeight: 600 }}>{a.name}</td>
                <td><span className={`kind-badge ${a.kind}`}>{KINDS[a.kind]}</span></td>
                <td className="num">{a.entry_count}</td>
                <td><YesNo on={a.active} yes="Active" no="Hidden" /></td>
                <td className="num"><button className="btn sm ghost" onClick={() => { setError(''); setEdit(a); }}>Edit</button></td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
      <div className="set-note">Accounts with entries can't be deleted — hide them instead. Hidden accounts stay on old entries but don't show in the pickers.</div>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'New payment account'} onClose={() => setEdit(null)}
          footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" onClick={save} disabled={!edit.name.trim()}>Save</button></>}>
          <Err error={error} />
          <Field label="Name"><input className="input" autoFocus value={edit.name} placeholder="e.g. HDFC current a/c" onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <div className="field"><span>Type</span>
            <div className="seg">{Object.entries(KINDS).map(([k, l]) => <button key={k} type="button" className={edit.kind === k ? 'on' : ''} onClick={() => setEdit({ ...edit, kind: k })}>{l}</button>)}</div>
          </div>
          <label className="toggle"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />Show in pickers</label>
        </Modal>
      )}
    </Section>
  );
}

const ACTIONS = {
  create: 'created', update: 'updated', delete: 'deleted', cancel: 'cancelled', convert: 'converted', payment: 'recorded a payment on',
  settle: 'settled', write_off: 'wrote off', contribution: 'added capital for', payout: 'paid out to', change_password: 'changed their password',
};
const ENTITIES = {
  entry: 'Book entry', quote: 'quotation', invoice: 'invoice', due: 'due', investor: 'investor', brand: 'brand', split_preset: 'split rule',
  user: 'user', settings: 'company settings', account: 'payment account',
};
const TONE = { delete: 'out', cancel: 'out', write_off: 'out', create: 'in', payment: 'in', settle: 'in' };

// One short line of what changed, from whatever the detail holds
function auditDetail(l) {
  const d = l.detail || {};
  const bits = [];
  if (d.number) bits.push(d.number);
  if (d.name) bits.push(d.name);
  if (d.email) bits.push(d.email);
  const amt = d.total ?? d.amount;
  if (amt != null && !Number.isNaN(Number(amt))) bits.push(inr(amt));
  if (l.entity === 'user' && d.role) bits.push(`role: ${d.role}`);
  if (d.active === false) bits.push('disabled');
  if (d.password_reset) bits.push('password reset');
  if (d.note) bits.push(`“${String(d.note).slice(0, 60)}”`);
  return bits.join(' · ');
}

function Activity() {
  const { data: users } = useAsync(() => api('/users'), []);
  const [f, setF] = useState({ entity: '', user_id: '' });
  const [rows, setRows] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const load = async (before) => {
    try {
      const r = await api(`/audit${qs({ ...f, before })}`);
      setRows((cur) => (before ? [...(cur || []), ...r.rows] : r.rows)); setNext(r.next); setError('');
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { setRows(null); load(); }, [f.entity, f.user_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadMore = async () => { setMore(true); await load(next); setMore(false); };
  let lastDay = '';
  return (
    <Section title="Activity log" desc="Who changed what, and when. Kept forever — nobody can edit it.">
      <div className="filters">
        <select className="input" value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })}>
          <option value="">Everything</option>{Object.entries(ENTITIES).map(([k, l]) => <option key={k} value={k}>{l[0].toUpperCase() + l.slice(1)}</option>)}
        </select>
        <select className="input" value={f.user_id} onChange={(e) => setF({ ...f, user_id: e.target.value })}>
          <option value="">All people</option>{(users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      <Err error={error} />
      <div className="card">
        {!rows ? <Loader /> : rows.length === 0 ? <div className="empty">Nothing recorded yet.</div> : (
          <ul className="log">{rows.map((l) => {
            const day = new Date(l.created_at).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
            const head = day !== lastDay; lastDay = day;
            const detail = auditDetail(l);
            return (
              <React.Fragment key={l.id}>
                {head && <li className="log-day">{day}</li>}
                <li className="log-row">
                  <Avatar name={l.user_name || 'System'} size={30} />
                  <div className="log-main">
                    <div><b>{l.user_name || 'System'}</b> <span className={TONE[l.action] || ''}>{ACTIONS[l.action] || l.action}</span>
                      {l.action !== 'change_password' && <> {ENTITIES[l.entity] || l.entity}{l.entity_id ? <span className="muted"> #{l.entity_id}</span> : null}</>}</div>
                    {detail && <div className="muted small">{detail}</div>}
                  </div>
                  <span className="muted small log-time">{new Date(l.created_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</span>
                </li>
              </React.Fragment>
            );
          })}</ul>
        )}
        {next && <div className="set-foot" style={{ justifyContent: 'center' }}><button className="btn" onClick={loadMore} disabled={more}>{more ? 'Loading…' : 'Load older'}</button></div>}
      </div>
    </Section>
  );
}

const INTEGRATIONS = [
  {
    key: 'ai', title: 'AI (Grok)', icon: Icon.spark,
    desc: 'Turns Tanglish notes into Book entries and writes the Monday brief. Works with OpenRouter or x.ai. Without a key a built-in parser is used.',
    fields: [
      { name: 'api_key', label: 'API key', placeholder: 'sk-or-v1-… or xai-…' },
      { name: 'model', label: 'Model', placeholder: 'x-ai/grok-4.3', list: ['x-ai/grok-4.3', 'x-ai/grok-build-0.1', 'grok-3-mini'] },
      { name: 'base_url', label: 'API base URL', placeholder: 'https://openrouter.ai/api/v1',
        presets: [['OpenRouter', 'https://openrouter.ai/api/v1'], ['x.ai', 'https://api.x.ai/v1']] },
    ],
  },
  {
    key: 'razorpay', title: 'Razorpay', icon: Icon.card,
    desc: 'Captured payments land in the Book by themselves and close the matching invoice.',
    ready: (v) => (v.key_id.set && v.key_secret.set) || v.webhook_secret.set,
    fields: [
      { name: 'key_id', label: 'Key ID', placeholder: 'rzp_test_… or rzp_live_…' },
      { name: 'key_secret', label: 'Key Secret', placeholder: 'Razorpay → Account & Settings → API Keys' },
      { name: 'webhook_secret', label: 'Webhook secret (optional)', placeholder: 'Only if you add a webhook in Razorpay' },
      { name: 'default_brand', label: 'Brand when a payment has no invoice/brand note', placeholder: 'HO', brand: true },
    ],
  },
  {
    key: 'whatsapp', title: 'WhatsApp (Meta Cloud API)', icon: Icon.chat,
    desc: 'Daily dues reminders, Monday brief and monthly investor statements — sent by the n8n workflows through Kanakku.',
    fields: [
      { name: 'phone_number_id', label: 'Phone number ID', placeholder: 'From Meta → WhatsApp → API Setup' },
      { name: 'token', label: 'Permanent access token', placeholder: 'System User token (EAAG…)' },
    ],
  },
];

function IntegrationCard({ def, view, onSaved, extra }) {
  const { boot, notify } = useApp();
  const init = () => Object.fromEntries(def.fields.map((f) => [f.name, view[f.name].secret ? '' : (view[f.name].source === 'panel' ? view[f.name].value : '')]));
  const [form, setForm] = useState(init);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { setForm(init()); }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const required = def.fields.filter((f) => !['model', 'base_url', 'default_brand'].includes(f.name));
  const connected = def.ready ? def.ready(view) : required.every((f) => view[f.name].set);
  const fromEnv = def.fields.some((f) => view[f.name].source === 'env');
  // Only send what changed: typed secrets, and non-secret fields that differ from what's saved in the panel
  const patch = Object.fromEntries(def.fields.filter((f) => (view[f.name].secret ? form[f.name] !== '' : form[f.name] !== (view[f.name].source === 'panel' ? view[f.name].value : '')))
    .map((f) => [f.name, form[f.name]]));
  const dirty = Object.keys(patch).length > 0;

  const save = async (p = patch) => {
    setSaving(true); setError(''); setTest(null);
    try { await api(`/integrations/${def.key}`, { method: 'PUT', body: p }); notify(`${def.title} saved`); await onSaved(); } catch (e) { setError(e.message); }
    setSaving(false);
  };
  const runTest = async () => {
    setTest({ running: true });
    try { setTest(await api(`/integrations/${def.key}/test`, { method: 'POST' })); } catch (e) { setTest({ ok: false, message: e.message }); }
  };

  return (
    <div className="card integ">
      <div className="integ-head">
        <span className="integ-icon">{def.icon}</span>
        <div className="integ-title"><h3>{def.title}</h3><p>{def.desc}</p></div>
        <span className={`status ${connected ? 'on' : 'off'}`}>{connected ? 'Connected' : 'Not set up'}</span>
      </div>
      <div className="integ-body">
        <Err error={error} />
        {fromEnv && <div className="note-box small">Some values come from the server's <code className="code">.env</code> file. Anything you save here overrides it.</div>}
        <div className="grid g2">
          {def.fields.map((f) => {
            const v = view[f.name];
            const src = v.source === 'panel' ? 'Saved here' : v.source === 'env' ? 'From .env' : v.source === 'default' ? 'Default' : '';
            return (
              <Field key={f.name} label={<>{f.label}{src && <em className="src">{src}</em>}</>}>
                {f.brand ? (
                  <select className="input" value={form[f.name] || v.value} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}>
                    {boot.brands.filter((b) => b.active).map((b) => <option key={b.id} value={b.code}>{b.code} — {b.name}</option>)}
                  </select>
                ) : (
                  <div className="secret-row">
                    <input className="input" type={v.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} list={f.list ? `${def.key}-${f.name}` : undefined}
                      placeholder={v.secret && v.set ? 'Saved — type a new key to replace' : (!v.secret && v.value && v.source !== 'panel' ? v.value : f.placeholder)}
                      value={form[f.name]} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })} />
                    {v.secret && v.source === 'panel' && <button type="button" className="btn sm ghost danger" title="Remove the saved key" onClick={() => save({ [f.name]: '' })}>Remove</button>}
                  </div>
                )}
                {f.list && <datalist id={`${def.key}-${f.name}`}>{f.list.map((o) => <option key={o} value={o} />)}</datalist>}
                {f.presets && <div className="row" style={{ gap: 6 }}>{f.presets.map(([l, u]) => <button key={l} type="button" className="chip-btn" onClick={() => setForm({ ...form, [f.name]: u })}>{l}</button>)}</div>}
              </Field>
            );
          })}
        </div>
        {extra}
        {test && !test.running && <div className={`test-result ${test.ok ? 'ok' : 'bad'}`}>{test.ok ? '✓ ' : '✕ '}{test.message}</div>}
      </div>
      <div className="set-foot integ-foot">
        <button className="btn" onClick={runTest} disabled={!connected || dirty || test?.running} title={dirty ? 'Save first' : undefined}>{test?.running ? 'Testing…' : 'Test connection'}</button>
        <button className="btn primary" onClick={() => save()} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

// Key-based sync: pulls captured payments from Razorpay (auto every 5 min on the server, or now)
function RazorpaySync({ state, hasKeys, onDone }) {
  const { notify } = useApp();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const run = async () => {
    setBusy(true); setResult(null);
    try {
      const r = await api('/integrations/razorpay/sync', { method: 'POST' });
      if (r.skipped) { setResult({ ok: false, message: r.skipped === 'no keys' ? 'Save the Key ID and Key Secret first' : 'A sync is already running — try again in a moment' }); setBusy(false); return; }
      setResult(r);
      if (r.ok) { notify(r.recorded || r.matched ? `${r.recorded + r.matched} new payment(s) added to the Book` : 'Up to date'); onDone(); }
    } catch (e) { setResult({ ok: false, message: e.message }); }
    setBusy(false);
  };
  const last = state?.last_run ? new Date(state.last_run * 1000).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null;
  return (
    <div className="integ-steps">
      <div className="copy-row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div className="set-block-title" style={{ margin: 0 }}>Payment sync</div>
          <div className="muted small">
            {!hasKeys ? 'Save the Key ID and Key Secret to start. Works on this computer too — no webhook or domain needed.'
              : last ? <>Checks Razorpay every 5 minutes. Last check {last}{state.last_error ? <span className="out"> — failed: {state.last_error}</span> : state.last_result ? ` — ${state.last_result.recorded + state.last_result.matched} new, ${state.last_result.duplicates} already in the Book` : ''}.</>
                : 'Checks Razorpay every 5 minutes. Not run yet.'}
          </div>
        </div>
        <button type="button" className="btn sm" onClick={run} disabled={!hasKeys || busy}>{busy ? 'Syncing…' : 'Sync now'}</button>
      </div>
      {result && (result.ok
        ? <div className="test-result ok">✓ Checked {result.fetched} payment(s): {result.recorded} added, {result.matched} matched to invoices, {result.duplicates} already in the Book.</div>
        : <div className="test-result bad">✕ {result.message}</div>)}
    </div>
  );
}

function Integrations() {
  const { notify } = useApp();
  const { data, error, reload } = useAsync(() => api('/integrations'), []);
  if (error) return <Err error={error} />;
  if (!data) return <Loader />;
  const hookUrl = `${(data.api_url || data.app_url || window.location.origin).replace(/\/+$/, '')}/api/webhooks/razorpay`;
  const copy = async (t) => { try { await navigator.clipboard.writeText(t); notify('Copied'); } catch { notify('Copy failed — select and copy by hand'); } };
  const local = /localhost|127\.0\.0\.1/.test(hookUrl);
  const extras = {
    razorpay: (
      <>
      <RazorpaySync state={data.razorpay_sync} hasKeys={data.razorpay.key_id.set && data.razorpay.key_secret.set} onDone={reload} />
      <details className="integ-steps">
        <summary className="set-block-title" style={{ margin: 0 }}>Optional: instant updates with a webhook (needs Kanakku on a live domain)</summary>
        <div className="copy-row"><span className="muted small">Webhook URL</span><code className="code">{hookUrl}</code><button type="button" className="btn sm" onClick={() => copy(hookUrl)}>Copy</button></div>
        <div className="copy-row"><span className="muted small">Active event</span><code className="code">payment.captured</code></div>
        {local && <div className="small out">This address only works on this computer. Razorpay can reach it only after Kanakku is deployed on a server with a domain.</div>}
        <div className="muted small">On a payment link, add a note <code className="code">invoice</code> = invoice number to close that invoice, or <code className="code">brand</code> = brand code.
          {data.razorpay_last ? <> Last payment received: <b>₹{Number(data.razorpay_last.amount).toLocaleString('en-IN')}</b> on {fmtDate(data.razorpay_last.entry_date)}.</> : ' No Razorpay payment received yet.'}</div>
      </details>
      </>
    ),
    whatsapp: (
      <div className="integ-steps">
        <div className="muted small">Templates needed in WhatsApp Manager (category Utility, English): <code className="code">afv_payment_reminder</code> <code className="code">afv_weekly_brief</code> <code className="code">afv_investor_statement</code>.
          Turn on the three workflows in n8n — they pick up these keys from here, no restart needed.</div>
      </div>
    ),
  };
  return (
    <Section title="Integrations" desc="Keys for AI, Razorpay and WhatsApp. Change them here any time — they're encrypted and never shown again.">
      <div className="grid">{INTEGRATIONS.map((d) => <IntegrationCard key={d.key} def={d} view={data[d.key]} onSaved={reload} extra={extras[d.key]} />)}</div>
    </Section>
  );
}

const TABS = [
  { key: 'company', label: 'Company', icon: Icon.company, el: Company },
  { key: 'brands', label: 'Brands', icon: Icon.brands, el: Brands },
  { key: 'splits', label: 'Split rules', icon: Icon.split, el: Presets },
  { key: 'categories', label: 'Categories', icon: Icon.tags, el: Categories },
  { key: 'accounts', label: 'Payment accounts', icon: Icon.wallet, el: Accounts },
  { key: 'integrations', label: 'Integrations', icon: Icon.plug, el: Integrations },
  { key: 'team', label: 'Team & roles', icon: Icon.team, el: Users },
  { key: 'activity', label: 'Activity log', icon: Icon.history, el: Activity },
];

export default function Settings() {
  const [tab, setTab] = useState(() => { try { return localStorage.getItem('settings-tab') || 'company'; } catch { return 'company'; } });
  useEffect(() => { try { localStorage.setItem('settings-tab', tab); } catch { /* ignore */ } }, [tab]);
  // On phones the tab strip scrolls — bring the remembered tab into view on open
  useEffect(() => { document.querySelector('.set-nav button.on')?.scrollIntoView({ block: 'nearest', inline: 'center' }); }, []);
  const Tab = (TABS.find((t) => t.key === tab) || TABS[0]).el;
  return (
    <>
      <div className="page-head"><div><h1>Settings</h1><p>Company details, brands, categories and who can log in.</p></div></div>
      <div className="settings">
        <nav className="set-nav">{TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={(e) => { setTab(t.key); e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); }}>{t.icon}<span>{t.label}</span></button>
        ))}</nav>
        <div className="set-body"><Tab /></div>
      </div>
    </>
  );
}

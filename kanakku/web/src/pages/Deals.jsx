import React, { useEffect, useMemo, useState } from 'react';
import { api, qs } from '../lib/api.js';
import { amountInWords, fmtDate, inr, inr2, today } from '../lib/format.js';
import { BrandSelect, BrandTag, Empty, Err, Field, Loader, Modal, useApp, useAsync } from '../components/ui.jsx';

const STATES = [['34', 'Puducherry'], ['33', 'Tamil Nadu'], ['32', 'Kerala'], ['29', 'Karnataka'], ['36', 'Telangana'], ['37', 'Andhra Pradesh'],
  ['27', 'Maharashtra'], ['07', 'Delhi'], ['24', 'Gujarat'], ['09', 'Uttar Pradesh'], ['19', 'West Bengal'], ['97', 'Other territory'], ['96', 'Outside India']];
const stateName = (c) => STATES.find((s) => s[0] === c)?.[1] || c;
const r2 = (n) => Math.round(n * 100) / 100;

function previewTotals(items, intra) {
  let sub = 0, tax = 0;
  items.forEach((i) => { const a = r2((Number(i.qty) || 0) * (Number(i.rate) || 0)); sub += a; tax += r2((a * (Number(i.gst_rate) || 0)) / 100); });
  return intra ? { sub, cgst: tax / 2, sgst: tax / 2, igst: 0, total: sub + tax } : { sub, cgst: 0, sgst: 0, igst: tax, total: sub + tax };
}

function CustomerForm({ onClose, onSaved }) {
  const [c, setC] = useState({ name: '', phone: '', email: '', gstin: '', state_code: '34', address: '' });
  const [error, setError] = useState('');
  const set = (k) => (e) => setC({ ...c, [k]: e.target.value });
  const save = async () => {
    try { onSaved(await api('/deals/customers', { method: 'POST', body: c })); } catch (e) { setError(e.message); }
  };
  return (
    <Modal title="New customer" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={!c.name}>Save customer</button></>}>
      <Err error={error} />
      <div className="grid g2">
        <Field label="Name / business"><input className="input" value={c.name} onChange={set('name')} autoFocus /></Field>
        <Field label="WhatsApp number"><input className="input" value={c.phone} onChange={set('phone')} /></Field>
        <Field label="Email"><input className="input" value={c.email} onChange={set('email')} /></Field>
        <Field label="GSTIN (if any)"><input className="input" value={c.gstin} onChange={set('gstin')} maxLength={15} /></Field>
        <Field label="State (place of supply)">
          <select className="input" value={c.state_code} onChange={set('state_code')}>{STATES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
      </div>
      <Field label="Billing address"><textarea className="input" value={c.address} onChange={set('address')} /></Field>
    </Modal>
  );
}

function DocEditor({ docType, initial, onClose, onSaved }) {
  const { boot } = useApp();
  const [customers, setCustomers] = useState([]);
  const [newCust, setNewCust] = useState(false);
  const [d, setD] = useState(initial || {
    doc_type: docType, brand_id: '', customer_id: '', doc_date: today(), due_date: '', notes: '', terms: boot.company.invoice_terms || '',
    items: [{ description: '', hsn_sac: '', qty: 1, rate: '', gst_rate: 18 }],
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/deals/customers').then(setCustomers); }, []);
  const cust = customers.find((c) => c.id === Number(d.customer_id));
  const intra = (cust?.state_code || '34') === (boot.company.state_code || '34');
  const t = useMemo(() => previewTotals(d.items, intra), [d.items, intra]);
  const setItem = (i, k, v) => setD({ ...d, items: d.items.map((it, j) => (j === i ? { ...it, [k]: v } : it)) });

  const save = async () => {
    setBusy(true); setError('');
    try {
      const body = { ...d, customer_id: Number(d.customer_id), due_date: d.due_date || null,
        items: d.items.filter((i) => i.description).map((i) => ({ ...i, qty: Number(i.qty), rate: Number(i.rate || 0), gst_rate: Number(i.gst_rate) })) };
      const r = d.id ? await api(`/deals/documents/${d.id}`, { method: 'PUT', body }) : await api('/deals/documents', { method: 'POST', body });
      onSaved(r);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const label = docType === 'quote' ? 'quotation' : 'invoice';
  return (
    <>
      <Modal wide title={d.id ? `Edit ${d.number}` : `New ${label}`} onClose={onClose} footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy || !d.brand_id || !d.customer_id || !d.items.some((i) => i.description)}>
          {busy ? 'Saving…' : `Save ${label}`}</button>
      </>}>
        <Err error={error} />
        <div className="grid g4">
          <Field label="Brand">{d.id ? <input className="input" value={d.brand_name} disabled /> : <BrandSelect value={d.brand_id} onChange={(v) => setD({ ...d, brand_id: v })} />}</Field>
          <Field label="Customer">
            <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
              <select className="input" value={d.customer_id} onChange={(e) => setD({ ...d, customer_id: e.target.value })}>
                <option value="">Select…</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button className="btn sm" onClick={() => setNewCust(true)} title="New customer">+</button>
            </div>
          </Field>
          <Field label="Date"><input className="input" type="date" value={d.doc_date} onChange={(e) => setD({ ...d, doc_date: e.target.value })} /></Field>
          <Field label={docType === 'quote' ? 'Valid till' : 'Due date'}><input className="input" type="date" value={d.due_date || ''} onChange={(e) => setD({ ...d, due_date: e.target.value })} /></Field>
        </div>
        {cust && <div className="muted small">Place of supply: {stateName(cust.state_code)} → {intra ? 'CGST + SGST' : 'IGST'}{cust.gstin ? ` · GSTIN ${cust.gstin}` : ' · No GSTIN (B2C)'}</div>}
        <div className="table-wrap">
          <table className="t items-table">
            <thead><tr><th style={{ width: '42%' }}>Item / service</th><th>HSN/SAC</th><th>Qty</th><th>Rate ₹</th><th>GST %</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {d.items.map((it, i) => (
                <tr key={i}>
                  <td><input className="input" value={it.description} onChange={(e) => setItem(i, 'description', e.target.value)} placeholder="e.g. Website design – 5 pages" /></td>
                  <td><input className="input" value={it.hsn_sac || ''} onChange={(e) => setItem(i, 'hsn_sac', e.target.value)} style={{ width: 90 }} /></td>
                  <td><input className="input" type="number" value={it.qty} onChange={(e) => setItem(i, 'qty', e.target.value)} style={{ width: 70 }} /></td>
                  <td><input className="input" type="number" value={it.rate} onChange={(e) => setItem(i, 'rate', e.target.value)} style={{ width: 110 }} /></td>
                  <td><select className="input" value={it.gst_rate} onChange={(e) => setItem(i, 'gst_rate', e.target.value)} style={{ width: 76 }}>
                    {[0, 5, 12, 18, 28].map((g) => <option key={g} value={g}>{g}%</option>)}</select></td>
                  <td className="num">{inr2((Number(it.qty) || 0) * (Number(it.rate) || 0))}</td>
                  <td>{d.items.length > 1 && <button className="btn ghost sm" onClick={() => setD({ ...d, items: d.items.filter((_, j) => j !== i) })}>✕</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <button className="btn sm" onClick={() => setD({ ...d, items: [...d.items, { description: '', hsn_sac: '', qty: 1, rate: '', gst_rate: 18 }] })}>+ Add line</button>
          <div className="totals">
            <div><span className="muted">Taxable value</span><span className="num">{inr2(t.sub)}</span></div>
            {intra ? <><div><span className="muted">CGST</span><span className="num">{inr2(t.cgst)}</span></div><div><span className="muted">SGST</span><span className="num">{inr2(t.sgst)}</span></div></>
              : <div><span className="muted">IGST</span><span className="num">{inr2(t.igst)}</span></div>}
            <div className="grand"><span>Total</span><span className="num">{inr2(t.total)}</span></div>
          </div>
        </div>
        <div className="grid g2">
          <Field label="Notes to customer"><textarea className="input" value={d.notes || ''} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
          <Field label="Terms"><textarea className="input" value={d.terms || ''} onChange={(e) => setD({ ...d, terms: e.target.value })} /></Field>
        </div>
      </Modal>
      {newCust && <CustomerForm onClose={() => setNewCust(false)} onSaved={(c) => { setCustomers([...customers, c]); setD({ ...d, customer_id: c.id }); setNewCust(false); }} />}
    </>
  );
}

export function DocSheet({ doc }) {
  const { boot } = useApp();
  const co = boot.company;
  const c = doc.customer || {};
  const intra = doc.place_of_supply === (co.state_code || '34');
  return (
    <div className="doc-sheet">
      <div className="head">
        <div>
          <div className="co-name">{(co.short_name || 'Afra Ventures').toUpperCase()}</div>
          <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>
            <strong>{co.legal_name}</strong> · {doc.brand_name}<br />{co.address}<br />
            GSTIN {co.gstin} · {co.email}
          </div>
        </div>
        <div>
          <div className="doc-title">{doc.doc_type === 'quote' ? 'Quotation' : 'Tax Invoice'}</div>
          <div style={{ fontSize: 13, textAlign: 'right', marginTop: 6, lineHeight: 1.6 }}>
            <strong>{doc.number}</strong><br />Date: {fmtDate(doc.doc_date)}
            {doc.due_date && <><br />{doc.doc_type === 'quote' ? 'Valid till' : 'Due'}: {fmtDate(doc.due_date)}</>}
          </div>
        </div>
      </div>
      <div className="meta">
        <div><div className="lbl">Bill to</div><strong>{c.name}</strong><br />{c.address && <>{c.address}<br /></>}{c.phone}{c.gstin && <><br />GSTIN {c.gstin}</>}</div>
        <div><div className="lbl">Place of supply</div>{stateName(doc.place_of_supply)} ({doc.place_of_supply})</div>
      </div>
      <table>
        <thead><tr><th>#</th><th>Description</th><th>HSN/SAC</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>GST</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
        <tbody>
          {doc.items.map((it, i) => (
            <tr key={it.id || i}><td>{i + 1}</td><td>{it.description}</td><td>{it.hsn_sac || '—'}</td>
              <td className="num">{it.qty}</td><td className="num">{inr2(it.rate)}</td><td className="num">{it.gst_rate}%</td><td className="num">{inr2(it.amount)}</td></tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', marginTop: 16, gap: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, fontSize: 12, minWidth: 220 }}>
          <div className="lbl">Amount in words</div>{amountInWords(doc.total)}
          {doc.notes && <><div className="lbl" style={{ marginTop: 12 }}>Notes</div>{doc.notes}</>}
          {co.bank_details && <><div className="lbl" style={{ marginTop: 12 }}>Bank details</div><div style={{ whiteSpace: 'pre-line' }}>{co.bank_details}</div></>}
          {doc.terms && <><div className="lbl" style={{ marginTop: 12 }}>Terms</div><div style={{ whiteSpace: 'pre-line' }}>{doc.terms}</div></>}
        </div>
        <div className="totals" style={{ fontSize: 13 }}>
          <div><span>Taxable value</span><span className="num">{inr2(doc.subtotal)}</span></div>
          {intra ? <><div><span>CGST</span><span className="num">{inr2(doc.cgst)}</span></div><div><span>SGST</span><span className="num">{inr2(doc.sgst)}</span></div></>
            : <div><span>IGST</span><span className="num">{inr2(doc.igst)}</span></div>}
          <div className="grand"><span>Total</span><span className="num">{inr2(doc.total)}</span></div>
          {doc.doc_type === 'invoice' && doc.amount_paid > 0 && <>
            <div><span>Paid</span><span className="num">{inr2(doc.amount_paid)}</span></div>
            <div style={{ fontWeight: 700 }}><span>Balance</span><span className="num">{inr2(doc.total - doc.amount_paid)}</span></div>
          </>}
        </div>
      </div>
      <div style={{ marginTop: 40, textAlign: 'right', fontSize: 12 }}>For {co.legal_name}<br /><br /><br />Authorised Signatory</div>
      <div style={{ marginTop: 20, fontSize: 11, color: '#6b7280', textAlign: 'center' }}>{co.cin && `CIN ${co.cin} · `}{co.website}</div>
    </div>
  );
}

function PaymentForm({ doc, onClose, onSaved }) {
  const { boot } = useApp();
  const [p, setP] = useState({ amount: r2(doc.total - doc.amount_paid), paid_on: today(), account_id: '', ref: '' });
  const [error, setError] = useState('');
  const save = async () => {
    try { onSaved(await api(`/deals/documents/${doc.id}/payments`, { method: 'POST', body: { ...p, account_id: p.account_id || null } })); }
    catch (e) { setError(e.message); }
  };
  return (
    <Modal title={`Payment for ${doc.number}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn green" onClick={save}>Record payment</button></>}>
      <Err error={error} />
      <div className="note-box">Balance {inr2(doc.total - doc.amount_paid)}. This also adds a "Money in" entry to the Book.</div>
      <div className="grid g2">
        <Field label="Amount ₹"><input className="input" type="number" value={p.amount} onChange={(e) => setP({ ...p, amount: e.target.value })} /></Field>
        <Field label="Received on"><input className="input" type="date" value={p.paid_on} onChange={(e) => setP({ ...p, paid_on: e.target.value })} /></Field>
        <Field label="Received in"><select className="input" value={p.account_id} onChange={(e) => setP({ ...p, account_id: e.target.value })}>
          <option value="">—</option>{boot.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="UTR / reference"><input className="input" value={p.ref} onChange={(e) => setP({ ...p, ref: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function DocView({ id, onClose, onChanged }) {
  const { user, notify, boot } = useApp();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState(null);
  useEffect(() => { api(`/deals/documents/${id}`).then(setDoc).catch((e) => setError(e.message)); }, [id]);
  const act = async (path, body, msg) => {
    try { const r = await api(`/deals/documents/${doc.id}/${path}`, { method: 'POST', body }); setDoc(r); onChanged(); notify(msg); return r; }
    catch (e) { setError(e.message); }
  };
  if (!doc) return <Modal title="Loading…" onClose={onClose}><Err error={error} /></Modal>;
  const canMoney = user.role !== 'sales';
  const isQuote = doc.doc_type === 'quote';
  const waText = encodeURIComponent(`Hello ${doc.customer.name}, here is your ${isQuote ? 'quotation' : 'invoice'} ${doc.number} from ${doc.brand_name} (${boot.company.short_name}) for ${inr2(doc.total)}${!isQuote && doc.amount_paid ? `, balance ${inr2(doc.total - doc.amount_paid)}` : ''}. Thank you!`);
  const wa = doc.customer.phone ? `https://wa.me/${doc.customer.phone.replace(/\D/g, '').replace(/^(\d{10})$/, '91$1')}?text=${waText}` : null;

  return (
    <>
      <Modal wide title={<span className="row">{doc.number} <span className={`pill ${doc.status}`}>{doc.status}</span></span>} onClose={onClose} footer={<>
        {user.role === 'admin' && !['cancelled', 'converted', 'paid'].includes(doc.status) && doc.amount_paid === 0 &&
          <button className="btn danger" onClick={() => window.confirm('Cancel this document?') && act('cancel', {}, 'Cancelled')}>Cancel doc</button>}
        <span className="spacer" />
        {wa && <a className="btn" href={wa} target="_blank" rel="noreferrer">WhatsApp</a>}
        <button className="btn" onClick={() => window.print()}>Print / PDF</button>
        {!['converted', 'cancelled', 'paid'].includes(doc.status) && doc.amount_paid === 0 && (isQuote || canMoney) &&
          <button className="btn" onClick={() => setMode('edit')}>Edit</button>}
        {isQuote && doc.status === 'draft' && <button className="btn" onClick={() => act('status', { status: 'sent' }, 'Marked sent')}>Mark sent</button>}
        {isQuote && ['draft', 'sent'].includes(doc.status) && <button className="btn" onClick={() => act('status', { status: 'accepted' }, 'Marked accepted')}>Accepted</button>}
        {isQuote && canMoney && !['converted', 'rejected', 'cancelled'].includes(doc.status) &&
          <button className="btn primary" onClick={async () => { const r = await act('convert', {}, 'Invoice created'); if (r) setDoc(r); }}>Convert to invoice</button>}
        {!isQuote && canMoney && ['unpaid', 'partial'].includes(doc.status) && <button className="btn green" onClick={() => setMode('pay')}>Record payment</button>}
      </>}>
        <Err error={error} />
        {doc.payments?.length > 0 && <div className="note-box">Payments: {doc.payments.map((p) => `${inr2(p.amount)} on ${fmtDate(p.entry_date)}${p.ref ? ` (${p.ref})` : ''}`).join(' · ')}</div>}
        <DocSheet doc={doc} />
      </Modal>
      {mode === 'pay' && <PaymentForm doc={doc} onClose={() => setMode(null)} onSaved={(r) => { setDoc(r); setMode(null); onChanged(); notify('Payment recorded'); }} />}
      {mode === 'edit' && <DocEditor docType={doc.doc_type} initial={{ ...doc, customer_id: doc.customer_id, due_date: doc.due_date || '' }}
        onClose={() => setMode(null)} onSaved={(r) => { setDoc(r); setMode(null); onChanged(); notify('Saved'); }} />}
    </>
  );
}

export default function Deals() {
  const { user, notify } = useApp();
  const [tab, setTab] = useState('quote');
  const [f, setF] = useState({ brand_id: '', status: '', q: '' });
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState(null);
  const { data, error, reload } = useAsync(() => api(`/deals/documents${qs({ doc_type: tab, ...f })}`), [tab, JSON.stringify(f)]);
  const canInvoice = user.role !== 'sales';
  const statuses = tab === 'quote' ? ['draft', 'sent', 'accepted', 'rejected', 'converted'] : ['unpaid', 'partial', 'paid', 'cancelled'];

  return (
    <>
      <div className="page-head">
        <div><h1>Deals</h1><p>Quotation → invoice → payment, with GST worked out for you.</p></div>
        <span className="spacer" />
        {(tab === 'quote' || canInvoice) && <button className="btn primary" onClick={() => setCreating(true)}>+ New {tab === 'quote' ? 'quotation' : 'invoice'}</button>}
      </div>
      <div className="filters">
        <div className="seg">
          <button className={tab === 'quote' ? 'on' : ''} onClick={() => { setTab('quote'); setF({ ...f, status: '' }); }}>Quotations</button>
          <button className={tab === 'invoice' ? 'on' : ''} onClick={() => { setTab('invoice'); setF({ ...f, status: '' }); }}>Invoices</button>
        </div>
        <div style={{ minWidth: 180 }}><BrandSelect all includeInactive value={f.brand_id} onChange={(v) => setF({ ...f, brand_id: v })} /></div>
        <select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">Any status</option>{statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input className="input" placeholder="Search number or customer" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      </div>
      <Err error={error} />
      {!data && !error && <Loader />}
      {data && (
        <div className="card table-wrap">
          {data.length === 0 ? <Empty>No {tab === 'quote' ? 'quotations' : 'invoices'} yet.</Empty> : (
            <table className="t">
              <thead><tr><th>Number</th><th>Customer</th><th>Brand</th><th className="hide-sm">Date</th><th>Status</th><th className="num">Total</th>{tab === 'invoice' && <th className="num hide-sm">Balance</th>}</tr></thead>
              <tbody>
                {data.map((d) => {
                  const overdue = tab === 'invoice' && ['unpaid', 'partial'].includes(d.status) && d.due_date && d.due_date < today();
                  return (
                    <tr key={d.id} className="click" onClick={() => setViewing(d.id)}>
                      <td style={{ fontWeight: 600 }}>{d.number}</td><td>{d.customer_name}</td>
                      <td><BrandTag code={d.brand_code} color={d.brand_color} /></td>
                      <td className="hide-sm">{fmtDate(d.doc_date)}</td>
                      <td><span className={`pill ${overdue ? 'overdue' : d.status}`}>{overdue ? 'overdue' : d.status}</span></td>
                      <td className="num">{inr(d.total)}</td>
                      {tab === 'invoice' && <td className="num hide-sm">{inr(d.total - d.amount_paid)}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
      {creating && <DocEditor docType={tab} onClose={() => setCreating(false)} onSaved={(r) => { setCreating(false); reload(); notify(`${r.number} created`); setViewing(r.id); }} />}
      {viewing && <DocView id={viewing} onClose={() => setViewing(null)} onChanged={reload} />}
    </>
  );
}

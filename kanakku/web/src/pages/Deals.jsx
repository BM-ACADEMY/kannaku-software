import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, qs } from '../lib/api.js';
import { amountInWords, fmtDate, inr, inr2, today } from '../lib/format.js';
import { BrandSelect, BrandTag, Empty, Err, Field, Loader, Modal, useApp, useAsync } from '../components/ui.jsx';
import SplitEditor, { splitTotal } from '../components/SplitEditor.jsx';
import Attachments from '../components/Attachments.jsx';

const STATES = [['34', 'Puducherry'], ['33', 'Tamil Nadu'], ['32', 'Kerala'], ['29', 'Karnataka'], ['36', 'Telangana'], ['37', 'Andhra Pradesh'],
  ['27', 'Maharashtra'], ['07', 'Delhi'], ['24', 'Gujarat'], ['09', 'Uttar Pradesh'], ['19', 'West Bengal'], ['97', 'Other territory'], ['96', 'Outside India']];
const stateName = (c) => STATES.find((s) => s[0] === c)?.[1] || c;
const r2 = (n) => Math.round(n * 100) / 100;
const LABEL = { quote: 'quotation', invoice: 'invoice', credit_note: 'credit note', bill: 'purchase bill' };
const TITLE = { quote: 'Quotation', invoice: 'Tax Invoice', credit_note: 'Credit Note', bill: 'Purchase Bill' };
const blankItem = () => ({ description: '', hsn_sac: '', qty: 1, rate: '', gst_rate: 18 });

function previewTotals(items, intra) {
  let sub = 0, tax = 0;
  items.forEach((i) => { const a = r2((Number(i.qty) || 0) * (Number(i.rate) || 0)); sub += a; tax += r2((a * (Number(i.gst_rate) || 0)) / 100); });
  tax = r2(tax); const cg = r2(tax / 2);
  return intra ? { sub: r2(sub), cgst: cg, sgst: r2(tax - cg), igst: 0, total: r2(sub + tax) } : { sub: r2(sub), cgst: 0, sgst: 0, igst: tax, total: r2(sub + tax) };
}

function PartyForm({ kind = 'customer', onClose, onSaved }) {
  const [c, setC] = useState({ name: '', phone: '', email: '', gstin: '', state_code: '34', address: '', kind, tds_rate: 0 });
  const [error, setError] = useState('');
  const set = (k) => (e) => setC({ ...c, [k]: e.target.value });
  const save = async () => {
    try { onSaved(await api('/deals/customers', { method: 'POST', body: { ...c, tds_rate: Number(c.tds_rate) || 0 } })); } catch (e) { setError(e.message); }
  };
  const vendor = kind === 'vendor';
  return (
    <Modal title={vendor ? 'New vendor' : 'New customer'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={!c.name}>Save</button></>}>
      <Err error={error} />
      <div className="grid g2">
        <Field label="Name / business"><input className="input" value={c.name} onChange={set('name')} autoFocus /></Field>
        <Field label="WhatsApp number"><input className="input" value={c.phone} onChange={set('phone')} /></Field>
        <Field label="Email"><input className="input" value={c.email} onChange={set('email')} /></Field>
        <Field label="GSTIN (if any) — checked automatically"><input className="input" value={c.gstin} onChange={(e) => setC({ ...c, gstin: e.target.value.toUpperCase(), state_code: /^\d{2}/.test(e.target.value) ? e.target.value.slice(0, 2) : c.state_code })} maxLength={15} /></Field>
        <Field label="State (place of supply)">
          <select className="input" value={c.state_code} onChange={set('state_code')} disabled={c.gstin.length >= 2}>{STATES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
        {!vendor && <Field label="TDS they usually deduct (%)"><select className="input" value={c.tds_rate} onChange={set('tds_rate')}>
          <option value="0">None</option><option value="1">1% (contract, individual)</option><option value="2">2% (contract, company)</option><option value="10">10% (professional / technical)</option></select></Field>}
      </div>
      <Field label="Address"><textarea className="input" value={c.address} onChange={set('address')} /></Field>
    </Modal>
  );
}

function DocEditor({ docType, initial, onClose, onSaved }) {
  const { boot } = useApp();
  const isBill = docType === 'bill';
  const [parties, setParties] = useState([]);
  const [newParty, setNewParty] = useState(false);
  const [d, setD] = useState(() => initial ? { ...initial, shared: !!initial.split, split: initial.split || [] } : {
    doc_type: docType, brand_id: '', customer_id: '', doc_date: today(), due_date: '', notes: '', terms: isBill ? '' : boot.company.invoice_terms || '',
    vendor_ref: '', itc_eligible: true, category_id: '', shared: false, split: [], items: [blankItem()],
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api(`/deals/customers${isBill ? '?kind=vendor' : '?kind=customer'}`).then(setParties); }, [isBill]);
  const party = parties.find((c) => c.id === Number(d.customer_id));
  const intra = (party?.state_code || '34') === (boot.company.state_code || '34');
  const t = useMemo(() => previewTotals(d.items, intra), [d.items, intra]);
  const setItem = (i, k, v) => setD({ ...d, items: d.items.map((it, j) => (j === i ? { ...it, [k]: v } : it)) });
  const splitOk = !d.shared || Math.abs(splitTotal(d.split) - 100) < 0.01;

  const save = async () => {
    setBusy(true); setError('');
    try {
      const body = { ...d, customer_id: Number(d.customer_id), due_date: d.due_date || null, brand_id: d.shared ? null : Number(d.brand_id) || null,
        category_id: d.category_id ? Number(d.category_id) : null, split: isBill && d.shared ? d.split : null,
        items: d.items.filter((i) => i.description).map((i) => ({ ...i, qty: Number(i.qty), rate: Number(i.rate || 0), gst_rate: Number(i.gst_rate) })) };
      ['shared', 'customer', 'items_view', 'payments', 'credit_notes'].forEach((k) => delete body[k]);
      const r = d.id ? await api(`/deals/documents/${d.id}`, { method: 'PUT', body }) : await api('/deals/documents', { method: 'POST', body });
      onSaved(r);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <Modal wide title={d.id ? `Edit ${d.number}` : `New ${LABEL[docType]}`} onClose={onClose} footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy || (!d.shared && !d.brand_id) || !d.customer_id || !d.items.some((i) => i.description) || !splitOk}>
          {busy ? 'Saving…' : `Save ${LABEL[docType]}`}</button>
      </>}>
        <Err error={error} />
        {isBill && <div className="note-box">Enter the vendor's bill as it is. Kanakku keeps the GST aside as input credit (if they charged GST to our GSTIN), and the rest becomes the brand's cost when you pay it.</div>}
        <div className="grid g4">
          {d.shared ? <Field label="Brand">
            <input className="input" value="Shared — see split below" disabled /></Field>
            : <Field label="Brand">{d.id && !isBill ? <input className="input" value={d.brand_name} disabled /> : <BrandSelect value={d.brand_id} onChange={(v) => setD({ ...d, brand_id: v })} />}</Field>}
          <Field label={isBill ? 'Vendor' : 'Customer'}>
            <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
              <select className="input" value={d.customer_id} onChange={(e) => setD({ ...d, customer_id: e.target.value })}>
                <option value="">Select…</option>{parties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button className="btn sm" onClick={() => setNewParty(true)} title="Add new">+</button>
            </div>
          </Field>
          <Field label={isBill ? 'Bill date' : 'Date'}><input className="input" type="date" value={d.doc_date} onChange={(e) => setD({ ...d, doc_date: e.target.value })} /></Field>
          <Field label={docType === 'quote' ? 'Valid till' : 'Due date'}><input className="input" type="date" value={d.due_date || ''} onChange={(e) => setD({ ...d, due_date: e.target.value })} /></Field>
        </div>
        {isBill && (
          <div className="grid g4">
            <Field label="Vendor's bill number"><input className="input" value={d.vendor_ref || ''} onChange={(e) => setD({ ...d, vendor_ref: e.target.value })} /></Field>
            <Field label="Expense category"><select className="input" value={d.category_id || ''} onChange={(e) => setD({ ...d, category_id: e.target.value })}>
              <option value="">—</option>{boot.categories.filter((c) => c.kind === 'out' && c.in_pnl !== false).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="GST input credit"><select className="input" value={d.itc_eligible ? '1' : '0'} onChange={(e) => setD({ ...d, itc_eligible: e.target.value === '1' })}>
              <option value="1">Claimable (GST bill to our GSTIN)</option><option value="0">Not claimable — GST is part of the cost</option></select></Field>
            <Field label="Shared across brands?"><label className="toggle" style={{ paddingTop: 8 }}><input type="checkbox" checked={d.shared} onChange={(e) => setD({ ...d, shared: e.target.checked })} />Split this bill</label></Field>
          </div>
        )}
        {isBill && d.shared && <SplitEditor rules={d.split} amount={t.total} onChange={(split) => setD({ ...d, split })} />}
        {party && <div className="muted small">Place of supply: {stateName(party.state_code)} → {intra ? 'CGST + SGST' : 'IGST'}{party.gstin ? ` · GSTIN ${party.gstin}` : isBill ? ' · vendor has no GSTIN — no input credit' : ' · No GSTIN (B2C)'}</div>}
        <div className="table-wrap">
          <table className="t items-table">
            <thead><tr><th style={{ width: '42%' }}>Item / service</th><th>HSN/SAC</th><th>Qty</th><th>Rate ₹</th><th>GST %</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {d.items.map((it, i) => (
                <tr key={i}>
                  <td><input className="input" value={it.description} onChange={(e) => setItem(i, 'description', e.target.value)} placeholder={isBill ? 'e.g. Printer toner' : 'e.g. Website design – 5 pages'} /></td>
                  <td><input className="input" value={it.hsn_sac || ''} onChange={(e) => setItem(i, 'hsn_sac', e.target.value)} style={{ width: 90 }} placeholder={isBill ? '' : 'needed'} /></td>
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
          <button className="btn sm" onClick={() => setD({ ...d, items: [...d.items, blankItem()] })}>+ Add line</button>
          <div className="totals">
            <div><span className="muted">Taxable value</span><span className="num">{inr2(t.sub)}</span></div>
            {intra ? <><div><span className="muted">CGST</span><span className="num">{inr2(t.cgst)}</span></div><div><span className="muted">SGST</span><span className="num">{inr2(t.sgst)}</span></div></>
              : <div><span className="muted">IGST</span><span className="num">{inr2(t.igst)}</span></div>}
            <div className="grand"><span>Total</span><span className="num">{inr2(t.total)}</span></div>
          </div>
        </div>
        {!isBill && <div className="grid g2">
          <Field label="Notes to customer"><textarea className="input" value={d.notes || ''} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
          <Field label="Terms"><textarea className="input" value={d.terms || ''} onChange={(e) => setD({ ...d, terms: e.target.value })} /></Field>
        </div>}
        {isBill && <Field label="Note"><input className="input" value={d.notes || ''} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>}
      </Modal>
      {newParty && <PartyForm kind={isBill ? 'vendor' : 'customer'} onClose={() => setNewParty(false)} onSaved={(c) => { setParties([...parties, c]); setD({ ...d, customer_id: c.id }); setNewParty(false); }} />}
    </>
  );
}

export function DocSheet({ doc }) {
  const { boot } = useApp();
  const co = boot.company;
  const c = doc.customer || {};
  const intra = doc.place_of_supply === (co.state_code || '34');
  const isBill = doc.doc_type === 'bill';
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
          <div className="doc-title">{TITLE[doc.doc_type]}</div>
          <div style={{ fontSize: 13, textAlign: 'right', marginTop: 6, lineHeight: 1.6 }}>
            <strong>{doc.number}</strong>{doc.vendor_ref && <><br />Vendor bill: {doc.vendor_ref}</>}<br />Date: {fmtDate(doc.doc_date)}
            {doc.due_date && <><br />{doc.doc_type === 'quote' ? 'Valid till' : 'Due'}: {fmtDate(doc.due_date)}</>}
            {doc.against_number && <><br />Against invoice: {doc.against_number}</>}
          </div>
        </div>
      </div>
      <div className="meta">
        <div><div className="lbl">{isBill ? 'Vendor' : 'Bill to'}</div><strong>{c.name}</strong><br />{c.address && <>{c.address}<br /></>}{c.phone}{c.gstin && <><br />GSTIN {c.gstin}</>}</div>
        <div><div className="lbl">Place of supply</div>{stateName(doc.place_of_supply)} ({doc.place_of_supply})
          {doc.doc_type === 'credit_note' && doc.notes && <><div className="lbl" style={{ marginTop: 10 }}>Reason</div>{doc.notes}</>}</div>
      </div>
      <div className="doc-table"><table>
        <thead><tr><th>#</th><th>Description</th><th>HSN/SAC</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>GST</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
        <tbody>
          {doc.items.map((it, i) => (
            <tr key={it.id || i}><td>{i + 1}</td><td>{it.description}</td><td>{it.hsn_sac || '—'}</td>
              <td className="num">{it.qty}</td><td className="num">{inr2(it.rate)}</td><td className="num">{it.gst_rate}%</td><td className="num">{inr2(it.amount)}</td></tr>
          ))}
        </tbody>
      </table></div>
      <div className="doc-end">
      <div style={{ display: 'flex', marginTop: 16, gap: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, fontSize: 12, minWidth: 220 }}>
          <div className="lbl">Amount in words</div>{amountInWords(doc.total)}
          {doc.notes && doc.doc_type !== 'credit_note' && <><div className="lbl" style={{ marginTop: 12 }}>Notes</div>{doc.notes}</>}
          {co.bank_details && ['invoice', 'quote'].includes(doc.doc_type) && <><div className="lbl" style={{ marginTop: 12 }}>Bank details</div><div style={{ whiteSpace: 'pre-line' }}>{co.bank_details}</div></>}
          {doc.terms && <><div className="lbl" style={{ marginTop: 12 }}>Terms</div><div style={{ whiteSpace: 'pre-line' }}>{doc.terms}</div></>}
        </div>
        <div className="totals" style={{ fontSize: 13 }}>
          <div><span>Taxable value</span><span className="num">{inr2(doc.subtotal)}</span></div>
          {intra ? <><div><span>CGST</span><span className="num">{inr2(doc.cgst)}</span></div><div><span>SGST</span><span className="num">{inr2(doc.sgst)}</span></div></>
            : <div><span>IGST</span><span className="num">{inr2(doc.igst)}</span></div>}
          <div className="grand"><span>Total</span><span className="num">{inr2(doc.total)}</span></div>
          {['invoice', 'bill'].includes(doc.doc_type) && (doc.amount_paid > 0 || doc.amount_credited > 0) && <>
            {doc.amount_credited > 0 && <div><span>Credit notes</span><span className="num">−{inr2(doc.amount_credited)}</span></div>}
            {doc.amount_paid > 0 && <div><span>Paid{doc.tds_total > 0 ? ` (incl. TDS ${inr2(doc.tds_total)})` : ''}</span><span className="num">{inr2(doc.amount_paid)}</span></div>}
            <div style={{ fontWeight: 700 }}><span>Balance</span><span className="num">{inr2(doc.balance)}</span></div>
          </>}
        </div>
      </div>
      {!isBill && <div style={{ marginTop: 40, textAlign: 'right', fontSize: 12 }}>For {co.legal_name}<br /><br /><br />Authorised Signatory</div>}
      </div>
      <div style={{ marginTop: 20, fontSize: 11, color: '#6b7280', textAlign: 'center' }}>{co.cin && `CIN ${co.cin} · `}{co.website}</div>
    </div>
  );
}

// Split an invoice into instalments (e.g. a 3-month course fee paid in 3 parts). One invoice; each part is a due date.
function InstalmentForm({ doc, onClose, onSaved }) {
  const nextMonth = (() => { const d = new Date(); d.setMonth(d.getMonth() + 1, 1); return d.toISOString().slice(0, 10); })();
  const [p, setP] = useState({ count: 3, first_due: nextMonth, every_months: 1, name: '' });
  const [error, setError] = useState('');
  const each = Math.floor((Number(doc.total) / Math.max(1, Number(p.count))) * 100) / 100;
  const save = async () => {
    try { onSaved(await api(`/plans/from-invoice/${doc.id}`, { method: 'POST', body: { ...p, count: Number(p.count), every_months: Number(p.every_months), name: p.name || null } })); }
    catch (e) { setError(e.message); }
  };
  return (
    <Modal title={`Instalments for ${doc.number}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn green" onClick={save} disabled={!(Number(p.count) >= 2) || !p.first_due}>Create instalments</button></>}>
      <Err error={error} />
      <div className="note-box">Total {inr2(doc.total)} is split into {p.count || '—'} parts of about {inr2(each)} each. The invoice stays as one; each part is recorded as it comes in.</div>
      <div className="grid g2">
        <Field label="Number of parts"><select className="input" value={p.count} onChange={(e) => setP({ ...p, count: e.target.value })}>{[2, 3, 4, 5, 6, 9, 12].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
        <Field label="Every"><select className="input" value={p.every_months} onChange={(e) => setP({ ...p, every_months: e.target.value })}><option value="1">month</option><option value="2">2 months</option><option value="3">3 months</option></select></Field>
        <Field label="First part due"><input className="input" type="date" value={p.first_due} onChange={(e) => setP({ ...p, first_due: e.target.value })} /></Field>
        <Field label="Name (optional)"><input className="input" placeholder="e.g. 3-month course fee" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function PaymentForm({ doc, onClose, onSaved }) {
  const { boot } = useApp();
  const isBill = doc.doc_type === 'bill';
  const isRefund = doc.doc_type === 'credit_note';
  const tdsRate = !isBill && !isRefund ? Number(doc.customer?.tds_rate || 0) : 0;
  // Customer deducting TDS: they pay balance − TDS on the taxable part
  const share = Number(doc.total) ? doc.balance / Number(doc.total) : 0;
  const tdsGuess = tdsRate ? r2((Number(doc.subtotal) * share * tdsRate) / 100) : 0;
  const [p, setP] = useState({ amount: r2(doc.balance - tdsGuess), tds_amount: tdsGuess || '', paid_on: today(), account_id: '', ref: '' });
  const [error, setError] = useState('');
  const settle = r2(Number(p.amount || 0) + Number(p.tds_amount || 0));
  const save = async () => {
    try {
      const path = isRefund ? 'refund' : 'payments';
      const body = { amount: Number(p.amount), paid_on: p.paid_on, account_id: p.account_id || null, ref: p.ref || null, ...(isBill || isRefund ? {} : { tds_amount: Number(p.tds_amount) || 0 }) };
      onSaved(await api(`/deals/documents/${doc.id}/${path}`, { method: 'POST', body }));
    } catch (e) { setError(e.message); }
  };
  const title = isRefund ? `Refund on ${doc.number}` : `${isBill ? 'Pay' : 'Payment for'} ${doc.number}`;
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn green" onClick={save} disabled={!Number(p.amount)}>{isRefund ? 'Record refund' : isBill ? 'Record payment' : 'Record payment'}</button></>}>
      <Err error={error} />
      <div className="note-box">Balance {inr2(doc.balance)}. This also adds a "{isBill || isRefund ? 'Money out' : 'Money in'}" entry to the Book, with the GST part kept aside.</div>
      <div className="grid g2">
        <Field label={isBill || isRefund ? 'Amount paid ₹' : 'Amount received ₹'}><input className="input" type="number" value={p.amount} onChange={(e) => setP({ ...p, amount: e.target.value })} /></Field>
        {!isBill && !isRefund && <Field label={`TDS deducted by customer ₹${tdsRate ? ` (${tdsRate}% usual)` : ''}`}><input className="input" type="number" value={p.tds_amount} onChange={(e) => setP({ ...p, tds_amount: e.target.value })} placeholder="0" /></Field>}
        <Field label={isBill || isRefund ? 'Paid on' : 'Received on'}><input className="input" type="date" value={p.paid_on} onChange={(e) => setP({ ...p, paid_on: e.target.value })} /></Field>
        <Field label={isBill || isRefund ? 'Paid from' : 'Received in'}><select className="input" value={p.account_id} onChange={(e) => setP({ ...p, account_id: e.target.value })}>
          <option value="">—</option>{boot.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="UTR / reference"><input className="input" value={p.ref} onChange={(e) => setP({ ...p, ref: e.target.value })} /></Field>
      </div>
      {!isBill && !isRefund && Number(p.tds_amount) > 0 && <div className="money-hint">Settles {inr2(settle)} of the invoice. TDS {inr2(p.tds_amount)} shows in Reports → TDS so your CA can claim it.</div>}
    </Modal>
  );
}

function CreditNoteForm({ inv, onClose, onSaved }) {
  const { boot } = useApp();
  const [c, setC] = useState({ doc_date: today(), reason: '', items: inv.items.map((i) => ({ description: i.description, hsn_sac: i.hsn_sac, qty: i.qty, rate: i.rate, gst_rate: i.gst_rate })) });
  const [error, setError] = useState('');
  const t = previewTotals(c.items, inv.place_of_supply === (boot.company.state_code || '34'));
  const setItem = (i, k, v) => setC({ ...c, items: c.items.map((it, j) => (j === i ? { ...it, [k]: v } : it)) });
  const save = async () => {
    try {
      onSaved(await api(`/deals/documents/${inv.id}/credit-note`, { method: 'POST', body: { ...c,
        items: c.items.filter((i) => Number(i.rate) > 0).map((i) => ({ ...i, qty: Number(i.qty), rate: Number(i.rate), gst_rate: Number(i.gst_rate) })) } }));
    } catch (e) { setError(e.message); }
  };
  const left = r2(Number(inv.total) - Number(inv.amount_credited));
  return (
    <Modal wide title={`Credit note against ${inv.number}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={save} disabled={!c.reason || !t.total || t.total > left + 0.01}>Issue credit note</button></>}>
      <Err error={error} />
      <div className="note-box">For a discount, a cancelled part, or a wrong invoice. It first reduces what {inv.customer.name} owes ({inr2(inv.balance)}). Anything above that becomes a refund we owe them.</div>
      <div className="grid g2">
        <Field label="Date"><input className="input" type="date" value={c.doc_date} onChange={(e) => setC({ ...c, doc_date: e.target.value })} /></Field>
        <Field label="Reason (prints on the credit note)"><input className="input" value={c.reason} onChange={(e) => setC({ ...c, reason: e.target.value })} placeholder="e.g. 10% discount agreed" /></Field>
      </div>
      <table className="t items-table">
        <thead><tr><th>Item</th><th>Qty</th><th>Rate to credit ₹</th><th>GST %</th><th className="num">Amount</th></tr></thead>
        <tbody>{c.items.map((it, i) => (
          <tr key={i}><td>{it.description}</td>
            <td><input className="input" type="number" value={it.qty} onChange={(e) => setItem(i, 'qty', e.target.value)} style={{ width: 70 }} /></td>
            <td><input className="input" type="number" value={it.rate} onChange={(e) => setItem(i, 'rate', e.target.value)} style={{ width: 110 }} /></td>
            <td>{it.gst_rate}%</td><td className="num">{inr2((Number(it.qty) || 0) * (Number(it.rate) || 0))}</td></tr>))}</tbody>
      </table>
      <div className="row"><span className="muted small">Up to {inr2(left)} can be credited on this invoice.</span><span className="spacer" />
        <strong className={t.total > left + 0.01 ? 'out' : ''}>Credit note total {inr2(t.total)}</strong></div>
    </Modal>
  );
}

function DocView({ id, onClose, onChanged }) {
  const { user, notify, boot } = useApp();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState(null);
  const load = (i = id) => api(`/deals/documents/${i}`).then(setDoc).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (path, body, msg) => {
    try { const r = await api(`/deals/documents/${doc.id}/${path}`, { method: 'POST', body }); setDoc(r); onChanged(); notify(msg); return r; }
    catch (e) { setError(e.message); }
  };
  if (!doc) return <Modal title="Loading…" onClose={onClose}><Err error={error} /></Modal>;
  const canMoney = user.role !== 'sales';
  const type = doc.doc_type;
  const isQuote = type === 'quote';
  const waText = encodeURIComponent(`Hello ${doc.customer.name}, here is your ${LABEL[type]} ${doc.number} from ${doc.brand_name} (${boot.company.short_name}) for ${inr2(doc.total)}${type === 'invoice' && doc.balance < doc.total ? `, balance ${inr2(doc.balance)}` : ''}. Thank you!`);
  const wa = doc.customer.phone && type !== 'bill' ? `https://wa.me/${doc.customer.phone.replace(/\D/g, '').replace(/^(\d{10})$/, '91$1')}?text=${waText}` : null;
  const untouched = Number(doc.amount_paid) === 0 && Number(doc.amount_credited) === 0;
  const printDoc = () => {
    // "Save as PDF" uses the page title as the file name
    const old = document.title;
    document.title = `${doc.number.replace(/[/\\]/g, '-')} ${doc.customer.name}`.trim();
    const back = () => { document.title = old; window.removeEventListener('afterprint', back); };
    window.addEventListener('afterprint', back);
    window.print();
  };

  return (
    <>
      <Modal wide title={<span className="row">{doc.number} <span className={`pill ${doc.status}`}>{doc.status}</span></span>} onClose={onClose} footer={<>
        {user.role === 'admin' && !['cancelled', 'converted'].includes(doc.status) && untouched && !doc.credit_notes?.length &&
          <button className="btn danger" onClick={() => window.confirm(`Cancel this ${LABEL[type]}?`) && act('cancel', {}, 'Cancelled')}>Cancel</button>}
        <span className="spacer" />
        {wa && <a className="btn" href={wa} target="_blank" rel="noreferrer">WhatsApp</a>}
        <button className="btn" onClick={printDoc}>Print / PDF</button>
        {type !== 'credit_note' && !['converted', 'cancelled', 'paid'].includes(doc.status) && untouched && (isQuote || canMoney) &&
          <button className="btn" onClick={() => setMode('edit')}>Edit</button>}
        {isQuote && doc.status === 'draft' && <button className="btn" onClick={() => act('status', { status: 'sent' }, 'Marked sent')}>Mark sent</button>}
        {isQuote && ['draft', 'sent'].includes(doc.status) && <button className="btn" onClick={() => act('status', { status: 'accepted' }, 'Marked accepted')}>Accepted</button>}
        {isQuote && canMoney && !['converted', 'rejected', 'cancelled'].includes(doc.status) &&
          <button className="btn primary" onClick={async () => { const r = await act('convert', {}, 'Invoice created'); if (r) setDoc(r); }}>Convert to invoice</button>}
        {type === 'invoice' && canMoney && doc.status !== 'cancelled' && Number(doc.total) - Number(doc.amount_credited) > 0.01 &&
          <button className="btn" onClick={() => setMode('credit')}>Credit note</button>}
        {type === 'invoice' && canMoney && doc.status === 'unpaid' && !doc.has_plan && !(doc.payments?.length) && <button className="btn" onClick={() => setMode('plan')}>Split into instalments</button>}
        {['invoice', 'bill'].includes(type) && canMoney && ['unpaid', 'partial'].includes(doc.status) && !doc.has_plan && <button className="btn green" onClick={() => setMode('pay')}>{type === 'bill' ? 'Pay bill' : 'Record payment'}</button>}
        {type === 'credit_note' && canMoney && doc.balance > 0.009 && doc.status !== 'cancelled' && <button className="btn green" onClick={() => setMode('pay')}>Refund {inr2(doc.balance)}</button>}
      </>}>
        <Err error={error} />
        {doc.payments?.length > 0 && <div className="note-box">{type === 'credit_note' ? 'Refunds' : 'Payments'}: {doc.payments.map((p) => `${inr2(p.amount)}${Number(p.tds_amount) ? ` + TDS ${inr2(p.tds_amount)}` : ''} on ${fmtDate(p.entry_date)}${p.ref ? ` (${p.ref})` : ''}`).join(' · ')}</div>}
        {doc.credit_notes?.length > 0 && <div className="note-box">Credit notes: {doc.credit_notes.map((c) => `${c.number} ${inr2(c.total)}`).join(' · ')}</div>}
        {type === 'credit_note' && doc.balance > 0.009 && <div className="banner">We owe {doc.customer.name} a refund of {inr2(doc.balance)} — it's listed under Dues → To pay.</div>}
        <DocSheet doc={doc} />
        {/* Print copy: lives directly under <body>, so the pop-up's scrolling/fixed layout can't cut it off */}
        {createPortal(<div className="print-root"><DocSheet doc={doc} /></div>, document.body)}
        {canMoney && <Attachments entity="document" id={doc.id} />}
      </Modal>
      {mode === 'pay' && <PaymentForm doc={doc} onClose={() => setMode(null)} onSaved={(r) => { setDoc(r); setMode(null); onChanged(); notify(type === 'credit_note' ? 'Refund recorded' : 'Payment recorded'); }} />}
      {mode === 'plan' && <InstalmentForm doc={doc} onClose={() => setMode(null)} onSaved={() => { setMode(null); onChanged(); notify('Instalments set — see Dashboard → Payment plans'); }} />}
      {mode === 'credit' && <CreditNoteForm inv={doc} onClose={() => setMode(null)} onSaved={(r) => { setMode(null); onChanged(); notify(`${r.number} issued`); load(r.id); }} />}
      {mode === 'edit' && <DocEditor docType={type} initial={{ ...doc, customer_id: doc.customer_id, due_date: doc.due_date || '' }}
        onClose={() => setMode(null)} onSaved={(r) => { setDoc(r); setMode(null); onChanged(); notify('Saved'); }} />}
    </>
  );
}

const TABS = [['quote', 'Quotations'], ['invoice', 'Invoices'], ['credit_note', 'Credit notes'], ['bill', 'Purchase bills']];
const STATUSES = { quote: ['draft', 'sent', 'accepted', 'rejected', 'converted'], invoice: ['unpaid', 'partial', 'paid', 'overdue', 'cancelled'],
  credit_note: ['issued', 'unpaid', 'refunded', 'cancelled'], bill: ['unpaid', 'partial', 'paid', 'overdue', 'cancelled'] };

export default function Deals() {
  const { user, notify } = useApp();
  const [tab, setTab] = useState('quote');
  const [f, setF] = useState({ brand_id: '', status: '', q: '' });
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState(null);
  const { data, error, reload } = useAsync(() => api(`/deals/documents${qs({ doc_type: tab, ...f })}`), [tab, JSON.stringify(f)]);
  const canMoney = user.role !== 'sales';
  const tabs = canMoney ? TABS : TABS.filter(([k]) => k !== 'bill');
  const money = ['invoice', 'bill', 'credit_note'].includes(tab);

  return (
    <>
      <div className="page-head">
        <div><h1>Deals</h1><p>Quotation → invoice → payment, credit notes, and vendor bills — GST worked out for you.</p></div>
        <span className="spacer" />
        {(tab === 'quote' || (canMoney && tab !== 'credit_note')) && <button className="btn primary" onClick={() => setCreating(true)}>+ New {LABEL[tab]}</button>}
      </div>
      <div className="tabs">
        {tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setF({ ...f, status: '' }); }}>{l}</button>)}
      </div>
      <div className="filters">
        <div style={{ minWidth: 180 }}><BrandSelect all includeInactive value={f.brand_id} onChange={(v) => setF({ ...f, brand_id: v })} /></div>
        <select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">Any status</option>{STATUSES[tab].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input className="input" placeholder={`Search number or ${tab === 'bill' ? 'vendor' : 'customer'}`} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      </div>
      {tab === 'credit_note' && <div className="banner info">Credit notes are made from an invoice: open the invoice → Credit note.</div>}
      <Err error={error} />
      {!data && !error && <Loader />}
      {data && (
        <div className="card table-wrap">
          {data.length === 0 ? <Empty>No {LABEL[tab]}s yet.</Empty> : (
            <table className="t">
              <thead><tr><th>Number</th><th>{tab === 'bill' ? 'Vendor' : 'Customer'}</th><th>Brand</th><th className="hide-sm">Date</th><th>Status</th><th className="num">Total</th>{money && <th className="num hide-sm">{tab === 'credit_note' ? 'Refund due' : 'Balance'}</th>}</tr></thead>
              <tbody>
                {data.map((d) => {
                  const overdue = ['invoice', 'bill'].includes(tab) && ['unpaid', 'partial'].includes(d.status) && d.due_date && d.due_date < today();
                  return (
                    <tr key={d.id} className="click" onClick={() => setViewing(d.id)}>
                      <td style={{ fontWeight: 600 }}>{d.number}{d.vendor_ref && <div className="muted small">{d.vendor_ref}</div>}</td><td>{d.customer_name}</td>
                      <td><BrandTag code={d.brand_code} color={d.brand_color} /></td>
                      <td className="hide-sm">{fmtDate(d.doc_date)}</td>
                      <td><span className={`pill ${overdue ? 'overdue' : d.status}`}>{overdue ? 'overdue' : d.status}</span></td>
                      <td className="num">{inr(d.total)}</td>
                      {money && <td className="num hide-sm">{inr(Math.max(0, Number(d.balance)))}</td>}
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

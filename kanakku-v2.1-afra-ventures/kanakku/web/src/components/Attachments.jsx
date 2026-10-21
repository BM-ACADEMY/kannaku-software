import React, { useRef, useState } from 'react';
import { api, apiBlobUrl, fileToUpload } from '../lib/api.js';
import { Err, useApp, useAsync } from './ui.jsx';

// Bill photos / receipts on a Book entry or a document. entity: 'entry' | 'document'
export default function Attachments({ entity, id, compact }) {
  const { user, notify } = useApp();
  const { data, reload } = useAsync(() => (id ? api(`/attachments/${entity}/${id}`) : Promise.resolve([])), [entity, id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef(null);
  if (!id) return null;

  const upload = async (files) => {
    setBusy(true); setError('');
    try {
      for (const f of files) {
        if (f.size > 15 * 1024 * 1024) throw new Error(`${f.name} is too big (max 8 MB after shrinking)`);
        await api(`/attachments/${entity}/${id}`, { method: 'POST', body: await fileToUpload(f) });
      }
      reload(); notify('Attached');
    } catch (e) { setError(e.message); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const open = async (a) => { try { window.open(await apiBlobUrl(`/attachments/file/${a.id}`), '_blank'); } catch (e) { setError(e.message); } };
  const remove = async (a) => { if (!window.confirm(`Remove ${a.filename}?`)) return; await api(`/attachments/file/${a.id}`, { method: 'DELETE' }); reload(); };

  return (
    <div className={`attach${compact ? ' compact' : ''}`}>
      <div className="row" style={{ gap: 8 }}>
        <span className="small" style={{ fontWeight: 600 }}>Bill / receipt</span>
        {(data || []).map((a) => (
          <span key={a.id} className="attach-chip">
            <button type="button" className="linkish" onClick={() => open(a)} title={`${Math.round(a.size / 1024)} KB · ${a.uploaded_by || ''}`}>
              {a.mime === 'application/pdf' ? '📄' : '🖼'} {a.filename.length > 22 ? `${a.filename.slice(0, 20)}…` : a.filename}
            </button>
            {user.role === 'admin' && <button type="button" className="x-mini" onClick={() => remove(a)} aria-label="Remove">×</button>}
          </span>
        ))}
        <button type="button" className="btn sm" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : '+ Add photo / PDF'}</button>
        <input ref={input} type="file" accept="image/*,application/pdf" capture="environment" multiple hidden onChange={(e) => upload([...e.target.files])} />
      </div>
      <Err error={error} />
    </div>
  );
}

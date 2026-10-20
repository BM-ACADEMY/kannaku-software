import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Err, Field, Modal, useApp } from './ui.jsx';

// Turn 2-step login on (scan QR → type code) or off (password)
export default function TwoStep({ enabled, required, onClose, onChanged }) {
  const { notify } = useApp();
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) api('/auth/2fa/setup', { method: 'POST' }).then(setSetup).catch((e) => setError(e.message));
  }, [enabled]);
  const turnOn = async () => {
    try { await api('/auth/2fa/enable', { method: 'POST', body: { code } }); notify('2-step login is on'); onChanged(true); } catch (e) { setError(e.message); }
  };
  const turnOff = async () => {
    try { await api('/auth/2fa/disable', { method: 'POST', body: { password: pw } }); notify('2-step login is off'); onChanged(false); } catch (e) { setError(e.message); }
  };
  return (
    <Modal title="2-step login" onClose={required ? () => {} : onClose} footer={enabled
      ? <><button className="btn" onClick={onClose}>Close</button><button className="btn danger" onClick={turnOff} disabled={!pw}>Turn off</button></>
      : <>{!required && <button className="btn" onClick={onClose}>Not now</button>}<button className="btn primary" onClick={turnOn} disabled={code.length !== 6}>Turn on</button></>}>
      <Err error={error} />
      {required && !enabled && <div className="banner">Admins must use 2-step login (Settings → Books & security). Set it up to continue.</div>}
      {enabled ? <>
        <div className="note-box">2-step login is on. After your password, Kanakku asks for the 6-digit code from your authenticator app.</div>
        <Field label="Your password, to turn it off"><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
      </> : setup && <>
        <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>Install <strong>Google Authenticator</strong> or <strong>Microsoft Authenticator</strong> on your phone.</li>
          <li>Tap <strong>+</strong> → <strong>Scan a QR code</strong> and scan this. (Or "Enter a setup key" and type the key below.)</li>
          <li>Type the 6-digit code it shows.</li>
        </ol>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          {setup.qr && <img className="qr" src={setup.qr} alt="QR code for your authenticator app" />}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div className="small muted">Setup key</div>
            <div className="code-box">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</div>
            <Field label="6-digit code"><input className="input otp-input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus /></Field>
          </div>
        </div>
      </>}
    </Modal>
  );
}

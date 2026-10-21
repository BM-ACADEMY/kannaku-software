import React, { useState } from 'react';
import { api, setToken } from '../lib/api.js';
import { Err, Field, Icon } from '../components/ui.jsx';

function Shell({ children }) {
  return (
    <div className="login">
      <div className="login-wrap">
        <div className="login-brand"><span className="logo-tile">A</span>Afra Ventures</div>
        {children}
        <div className="login-foot">Afra Ventures Private Limited · Puducherry</div>
      </div>
    </div>
  );
}

// /reset?token=… — set a new password from the emailed link
export function ResetPassword() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [p, setP] = useState({ a: '', b: '' });
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api('/auth/reset', { method: 'POST', body: { token, password: p.a } }); setDone(true); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <Shell>
      <form className="login-card" onSubmit={submit}>
        <div className="login-title"><h1>Set a new password</h1><p>{done ? 'Done. Use it to sign in.' : 'At least 8 characters.'}</p></div>
        <Err error={error} />
        {done ? <a className="btn primary block" href="/">Go to sign in</a> : <>
          <Field label="New password"><input className="input" type="password" autoComplete="new-password" value={p.a} onChange={(e) => setP({ ...p, a: e.target.value })} autoFocus /></Field>
          <Field label="Same again"><input className="input" type="password" autoComplete="new-password" value={p.b} onChange={(e) => setP({ ...p, b: e.target.value })} /></Field>
          {p.b && p.a !== p.b && <div className="small out">The two don't match.</div>}
          <button className="btn primary block" disabled={busy || p.a.length < 8 || p.a !== p.b || !token}>{busy ? 'Saving…' : 'Save password'}</button>
          {!token && <div className="small out">This link is incomplete — open the link from the email again.</div>}
        </>}
      </form>
    </Shell>
  );
}

export default function Login({ onLogin }) {
  const [step, setStep] = useState('password'); // password | otp | forgot
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);

  const finish = (r) => { setToken(r.token); onLogin(r.user, r.must_setup_2fa); };
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(''); setInfo('');
    try {
      if (step === 'password') {
        const r = await api('/auth/login', { method: 'POST', body: { email, password } });
        if (r.need_otp) { setPending(r.pending); setStep('otp'); } else finish(r);
      } else if (step === 'otp') {
        finish(await api('/auth/login/otp', { method: 'POST', body: { pending, code } }));
      } else {
        const r = await api('/auth/forgot', { method: 'POST', body: { email } });
        if (r.ok) setInfo(r.message); else setError(r.message);
      }
    } catch (err) { setError(err.message); if (step === 'otp' && /log in again|too long/i.test(err.message)) setStep('password'); } finally { setBusy(false); }
  };

  return (
    <Shell>
      <form className="login-card" onSubmit={submit}>
        {step === 'password' && <>
          <div className="login-title"><h1>Sign in to Kanakku</h1><p>Enter your email and password to open the books.</p></div>
          <Err error={error} />
          <Field label="Email"><input className="input" type="email" placeholder="you@afraventures.in" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required /></Field>
          <Field label="Password">
            <div className="pw">
              <input className="input" type={showPw ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" className={`pw-eye${showPw ? ' on' : ''}`} aria-label={showPw ? 'Hide password' : 'Show password'} onClick={() => setShowPw(!showPw)}>{showPw ? Icon.eyeOff : Icon.eye}</button>
            </div>
          </Field>
          <button className="btn primary block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <button type="button" className="linkish" style={{ alignSelf: 'center' }} onClick={() => { setStep('forgot'); setError(''); }}>Forgot password?</button>
        </>}
        {step === 'otp' && <>
          <div className="login-title"><h1>Enter your code</h1><p>Open your authenticator app and type the 6-digit code for Kanakku.</p></div>
          <Err error={error} />
          <input className="input otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
          <button className="btn primary block" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Continue'}</button>
          <button type="button" className="linkish" style={{ alignSelf: 'center' }} onClick={() => { setStep('password'); setCode(''); }}>Back</button>
          <div className="muted small" style={{ textAlign: 'center' }}>Lost your phone? Ask another admin to turn off your 2-step login in Settings → Team.</div>
        </>}
        {step === 'forgot' && <>
          <div className="login-title"><h1>Reset your password</h1><p>We'll email you a link to set a new one.</p></div>
          <Err error={error} />
          {info ? <div className="note-box">{info}</div> : <>
            <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required /></Field>
            <button className="btn primary block" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
          </>}
          <button type="button" className="linkish" style={{ alignSelf: 'center' }} onClick={() => { setStep('password'); setInfo(''); setError(''); }}>Back to sign in</button>
        </>}
      </form>
    </Shell>
  );
}

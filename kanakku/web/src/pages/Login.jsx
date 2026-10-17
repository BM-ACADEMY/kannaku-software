import React, { useState } from 'react';
import { api, setToken } from '../lib/api.js';
import { Err, Field, Icon } from '../components/ui.jsx';

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email, password } });
      setToken(r.token);
      onLogin(r.user);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <div className="login">
      <div className="login-wrap">
        <div className="login-brand"><span className="logo-tile">A</span>Afra Ventures</div>
        <form className="login-card" onSubmit={submit}>
          <div className="login-title">
            <h1>Sign in to Kanakku</h1>
            <p>Enter your email and password to open the books.</p>
          </div>
          <Err error={error} />
          <Field label="Email"><input className="input" type="email" placeholder="you@afraventures.in" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required /></Field>
          <Field label="Password">
            <div className="pw">
              <input className="input" type={showPw ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" className={`pw-eye${showPw ? ' on' : ''}`} aria-label={showPw ? 'Hide password' : 'Show password'} title={showPw ? 'Hide password' : 'Show password'} onClick={() => setShowPw(!showPw)}>{showPw ? Icon.eyeOff : Icon.eye}</button>
            </div>
          </Field>
          <button className="btn primary block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <div className="login-foot">Afra Ventures Private Limited · Puducherry</div>
      </div>
    </div>
  );
}

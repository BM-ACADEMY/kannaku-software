import React, { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken } from './lib/api.js';
import { AppCtx, Avatar, Err, Field, Icon, Loader, Modal, TopProgress } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Book from './pages/Book.jsx';
import Deals from './pages/Deals.jsx';
import Dues from './pages/Dues.jsx';
import Investors from './pages/Investors.jsx';
import Reports from './pages/Reports.jsx';
import Settings from './pages/Settings.jsx';

const PAGES = [
  { key: 'home', label: 'Home', icon: Icon.home, el: Dashboard, roles: ['admin', 'accounts', 'sales'], group: 'Daily' },
  { key: 'book', label: 'Book', icon: Icon.book, el: Book, roles: ['admin', 'accounts'], group: 'Daily' },
  { key: 'deals', label: 'Deals', icon: Icon.deals, el: Deals, roles: ['admin', 'accounts', 'sales'], group: 'Daily' },
  { key: 'dues', label: 'Dues', icon: Icon.dues, el: Dues, roles: ['admin', 'accounts', 'sales'], group: 'Daily' },
  { key: 'investors', label: 'Investors', icon: Icon.investors, el: Investors, roles: ['admin', 'accounts'], group: 'Finance' },
  { key: 'reports', label: 'P&L', icon: Icon.reports, el: Reports, roles: ['admin', 'accounts'], group: 'Finance' },
  { key: 'settings', label: 'Settings', icon: Icon.settings, el: Settings, roles: ['admin'], group: 'Admin' },
];

function ChangePassword({ onClose, onDone }) {
  const [p, setP] = useState({ current: '', next: '', again: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setP({ ...p, [k]: e.target.value });
  const mismatch = p.again && p.next !== p.again;
  const ok = p.current && p.next.length >= 8 && p.next === p.again;
  const save = async () => {
    setSaving(true); setError('');
    try { await api('/auth/change-password', { method: 'POST', body: { current: p.current, next: p.next } }); onDone(); } catch (e) { setError(e.message); setSaving(false); }
  };
  return (
    <Modal title="Change password" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!ok || saving} onClick={save}>{saving ? 'Saving…' : 'Change password'}</button></>}>
      <Err error={error} />
      <Field label="Current password"><input className="input" type="password" autoFocus autoComplete="current-password" value={p.current} onChange={set('current')} /></Field>
      <Field label="New password (min 8)"><input className="input" type="password" autoComplete="new-password" value={p.next} onChange={set('next')} /></Field>
      <Field label="New password again"><input className="input" type="password" autoComplete="new-password" value={p.again} onChange={set('again')} onKeyDown={(e) => e.key === 'Enter' && ok && save()} /></Field>
      {mismatch && <div className="small out">The two new passwords don't match.</div>}
    </Modal>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [boot, setBoot] = useState(null);
  // Clean URLs (/book, /settings). Old #book links still open the right page.
  const [page, setPageState] = useState(() => window.location.hash.slice(1) || window.location.pathname.slice(1) || 'home');
  const setPage = useCallback((p) => {
    setPageState(p);
    if (window.location.pathname !== `/${p}`) window.history.pushState(null, '', `/${p}`);
  }, []);
  const [toast, setToast] = useState('');
  const [pwOpen, setPwOpen] = useState(false);
  const [menu, setMenu] = useState(null); // which account menu is open: 'side' | 'top' | null
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('side-collapsed') === '1'; } catch { return false; } });
  const toggleCollapsed = () => setCollapsed((c) => { try { localStorage.setItem('side-collapsed', c ? '0' : '1'); } catch { /* ignore */ } return !c; });
  const [checking, setChecking] = useState(!!getToken());

  const loadBoot = useCallback(() => api('/bootstrap').then(setBoot), []);

  useEffect(() => {
    if (!getToken()) return;
    api('/auth/me').then((r) => { setUser(r.user); return loadBoot(); }).catch(() => setToken(null)).finally(() => setChecking(false));
  }, [loadBoot]);

  useEffect(() => {
    const onPop = () => setPageState(window.location.pathname.slice(1) || 'home');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    if (!menu) return undefined;
    const k = (e) => e.key === 'Escape' && setMenu(null);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [menu]);
  useEffect(() => setMenu(null), [page]);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(''), 2600); return () => clearTimeout(t); } }, [toast]);

  const allowed = user ? PAGES.filter((p) => p.roles.includes(user.role)) : [];
  const current = allowed.find((p) => p.key === page) || allowed[0];

  // Keep the address bar in step with the page actually shown (drops #hash, fixes unknown or not-allowed paths)
  useEffect(() => {
    if (current && (window.location.pathname !== `/${current.key}` || window.location.hash)) window.history.replaceState(null, '', `/${current.key}`);
  }, [current]);

  if (checking) return <Loader full label="Opening Kanakku…" />;
  if (!user) return <Login onLogin={(u) => { setUser(u); loadBoot(); }} />;
  if (!boot) return <Loader full label="Loading your books…" />;

  const Page = current.el;
  const brandName = boot.company?.short_name || 'Afra Ventures';
  const userMenu = (
    <>
      <div className="menu-backdrop" onClick={() => setMenu(null)} />
      <div className={`user-menu at-${menu}`} role="menu">
        <div className="user-menu-head">
          <Avatar name={user.name} square />
          <div className="side-user"><span className="side-name">{user.name}</span><span className="side-email">{user.email}</span></div>
        </div>
        <div className="menu-sep" />
        <div className="menu-label">Signed in as <span className={`role-badge ${user.role}`}>{user.role}</span></div>
        <div className="menu-sep" />
        <button role="menuitem" onClick={() => { setMenu(null); setPwOpen(true); }}>{Icon.key}Change password</button>
        <div className="menu-sep" />
        <button role="menuitem" className="danger" onClick={() => { setToken(null); window.location.replace('/'); }}>{Icon.logout}Log out</button>
      </div>
    </>
  );

  return (
    <AppCtx.Provider value={{ user, boot, reloadBoot: loadBoot, notify: setToast, go: setPage }}>
      <TopProgress />
      <div className={`shell${collapsed ? ' collapsed' : ''}`}>
        <aside className="side">
          <div className="side-brand">
            <span className="logo-tile">{brandName[0]}</span>
            <div className="brand-text"><div className="brand-name">{brandName}</div><div className="brand-sub">Kanakku finance</div></div>
          </div>
          <nav className="side-nav">
            {[...new Set(allowed.map((p) => p.group))].map((g) => (
              <div key={g} className="nav-section">
                <div className="nav-group">{g}</div>
                {allowed.filter((p) => p.group === g).map((p) => (
                  <button key={p.key} className={`nav${p.key === current.key ? ' active' : ''}`} onClick={() => setPage(p.key)}
                    title={collapsed ? p.label : undefined} aria-current={p.key === current.key ? 'page' : undefined}>
                    {p.icon}<span>{p.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="side-foot">
            <button className={`user-btn${menu === 'side' ? ' open' : ''}`} onClick={() => setMenu(menu === 'side' ? null : 'side')} title={collapsed ? user.name : undefined}>
              <Avatar name={user.name} square />
              <span className="side-user"><span className="side-name">{user.name}</span><span className="side-email">{user.email}</span></span>
              <span className="user-caret">{Icon.dots}</span>
            </button>
            {menu === 'side' && userMenu}
          </div>
        </aside>
        <div className="inset">
          <header className="site-header">
            <button className="icon-btn trigger" onClick={toggleCollapsed} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label="Toggle sidebar">{Icon.panel}</button>
            <span className="logo-tile mobile-only">{brandName[0]}</span>
            <span className="v-sep" />
            <nav className="crumb" aria-label="Breadcrumb"><span className="crumb-dim">{current.group}</span><span className="crumb-sep">/</span><span>{current.label}</span></nav>
            <span className="spacer" />
            <span className="mobile-only header-user">
              <button className="user-btn bare" onClick={() => setMenu(menu === 'top' ? null : 'top')} aria-label="Account menu"><Avatar name={user.name} size={32} /></button>
              {menu === 'top' && userMenu}
            </span>
          </header>
          <main className="main"><Page /></main>
        </div>
      </div>
      {pwOpen && <ChangePassword onClose={() => setPwOpen(false)} onDone={() => { setPwOpen(false); setToast('Password changed'); }} />}
      {toast && <div className="toast">{toast}</div>}
    </AppCtx.Provider>
  );
}

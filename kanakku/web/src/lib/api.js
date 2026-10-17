const TOKEN_KEY = 'kanakku_token';
// Empty = same domain (dev proxy or one-domain deploy). Set VITE_API_URL=https://kanakku-api.afraventures.in when the API has its own subdomain.
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

// Count of requests in flight, so the top progress bar can show while anything is loading
let inflight = 0;
const busyListeners = new Set();
const setBusy = (d) => { inflight += d; busyListeners.forEach((fn) => fn(inflight > 0)); };
export const onBusy = (fn) => { busyListeners.add(fn); return () => busyListeners.delete(fn); };

export async function api(path, { method = 'GET', body } = {}) {
  setBusy(1);
  let res, data;
  try {
    res = await fetch(`${API_BASE}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    data = await res.json().catch(() => ({}));
  } finally { setBusy(-1); }
  if (res.status === 401 && path !== '/auth/login') {
    setToken(null);
    window.location.reload();
  }
  if (!res.ok) {
    const fieldErrs = data.details?.fieldErrors ? Object.entries(data.details.fieldErrors).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') : '';
    throw new Error([data.error || 'Something went wrong', fieldErrs].filter(Boolean).join(' — '));
  }
  return data;
}

export const qs = (o) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? `?${new URLSearchParams(p).toString()}` : '';
};

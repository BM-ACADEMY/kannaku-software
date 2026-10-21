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
  // Login/forgot/reset answer 401 for a wrong password or code — that's an error to show, not a logout
  if (res.status === 401 && !path.startsWith('/auth/')) {
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

// Download something that needs the login token (bill photos): returns a temporary object URL
export async function apiBlobUrl(path) {
  const res = await fetch(`${API_BASE}/api${path}`, { headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {} });
  if (!res.ok) throw new Error('Could not open the file');
  return URL.createObjectURL(await res.blob());
}

// Read a picked file as base64 (for uploads) — shrinks big phone photos first so uploads stay quick
export async function fileToUpload(file, maxSide = 1800) {
  if (file.type.startsWith('image/') && file.type !== 'image/heic' && file.size > 600 * 1024) {
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const data = c.toDataURL('image/jpeg', 0.82);
      return { filename: file.name.replace(/\.\w+$/, '') + '.jpg', mime: 'image/jpeg', data };
    } catch { /* fall back to the original file */ }
  }
  const data = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(file); });
  return { filename: file.name, mime: file.type || 'application/octet-stream', data };
}

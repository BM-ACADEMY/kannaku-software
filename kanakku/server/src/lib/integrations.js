// Integration keys (AI, Razorpay, WhatsApp) editable from Settings → Integrations.
// Stored in settings('integrations'); secrets are AES-256-GCM encrypted with a key derived from JWT_SECRET.
// A field left empty in the panel falls back to the matching .env variable, so existing installs keep working.
const crypto = require('crypto');
const { query } = require('./db');

const FIELDS = {
  ai: {
    api_key: { env: 'XAI_API_KEY', secret: true },
    model: { env: 'XAI_MODEL', fallback: 'grok-3-mini' },
    base_url: { env: 'XAI_BASE_URL', fallback: 'https://api.x.ai/v1' },
  },
  razorpay: {
    key_id: { env: 'RAZORPAY_KEY_ID' },
    key_secret: { env: 'RAZORPAY_KEY_SECRET', secret: true },
    webhook_secret: { env: 'RAZORPAY_WEBHOOK_SECRET', secret: true },
    default_brand: { env: 'RAZORPAY_DEFAULT_BRAND', fallback: 'HO' },
  },
  whatsapp: {
    phone_number_id: { env: 'WA_PHONE_NUMBER_ID' },
    token: { env: 'WA_TOKEN', secret: true },
  },
};

const KEY = () => crypto.createHash('sha256').update(`${process.env.JWT_SECRET}|kanakku-integrations`).digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
function decrypt(blob) {
  try {
    const [, iv, tag, enc] = String(blob).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
  } catch {
    return ''; // JWT_SECRET changed or value damaged — treat as not set
  }
}

let cache = null;
let cachedAt = 0;
async function loadStored() {
  if (cache && Date.now() - cachedAt < 15000) return cache;
  const { rows } = await query("SELECT value FROM settings WHERE key='integrations'");
  cache = rows[0]?.value || {};
  cachedAt = Date.now();
  return cache;
}

// Effective config: { ai: { api_key, model, base_url }, ... } with plain values
async function getConfig() {
  const stored = await loadStored();
  const out = {};
  for (const [group, fields] of Object.entries(FIELDS)) {
    out[group] = {};
    for (const [name, f] of Object.entries(fields)) {
      const raw = stored[group]?.[name];
      const panel = raw ? (f.secret ? decrypt(raw) : raw) : '';
      out[group][name] = panel || process.env[f.env] || f.fallback || '';
    }
  }
  return out;
}

// What the admin panel sees: secrets never leave the server (not even the last digits), only whether one is set
async function publicView() {
  const stored = await loadStored();
  const cfg = await getConfig();
  const out = {};
  for (const [group, fields] of Object.entries(FIELDS)) {
    out[group] = {};
    for (const [name, f] of Object.entries(fields)) {
      const fromPanel = !!stored[group]?.[name];
      const fromEnv = !fromPanel && !!process.env[f.env];
      const v = cfg[group][name];
      out[group][name] = {
        value: f.secret ? '' : v,
        secret: !!f.secret,
        set: !!v && (fromPanel || fromEnv || !f.fallback),
        source: fromPanel ? 'panel' : fromEnv ? 'env' : v ? 'default' : '',
      };
    }
  }
  return out;
}

// patch: { field: 'new value' | '' (clear the panel value → back to .env/default) }. Missing fields are left alone.
async function saveGroup(group, patch) {
  const fields = FIELDS[group];
  if (!fields) throw Object.assign(new Error('Unknown integration'), { status: 404 });
  const stored = { ...(await loadStored()) };
  const next = { ...(stored[group] || {}) };
  const changed = [];
  for (const [name, f] of Object.entries(fields)) {
    if (!(name in patch)) continue;
    const v = String(patch[name] ?? '').trim();
    if (v) next[name] = f.secret ? encrypt(v) : v; else delete next[name];
    changed.push(name);
  }
  stored[group] = next;
  await query(`INSERT INTO settings (key,value) VALUES ('integrations',$1)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(stored)]);
  cache = null;
  return changed;
}

module.exports = { FIELDS, getConfig, publicView, saveGroup };

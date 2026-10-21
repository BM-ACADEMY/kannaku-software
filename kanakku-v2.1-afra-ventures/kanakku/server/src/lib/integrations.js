// Integration keys (AI, Razorpay, WhatsApp) editable from Settings → Integrations.
// Stored in settings('integrations'); secrets are AES-256-GCM encrypted with INTEGRATIONS_KEY (see lib/secrets.js).
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
    template_lang: { env: 'WA_TEMPLATE_LANG', fallback: 'en' },
  },
  // Email — for forgot-password links, backup alerts and statements (any SMTP: Hostinger mail, Gmail app password, Zoho…)
  email: {
    host: { env: 'SMTP_HOST' },
    port: { env: 'SMTP_PORT', fallback: '465' },
    user: { env: 'SMTP_USER' },
    pass: { env: 'SMTP_PASS', secret: true },
    from: { env: 'SMTP_FROM' },
  },
};

const { encrypt, decrypt, needsRewrap } = require('./secrets');

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

// Old installs: secrets were encrypted with a key from JWT_SECRET. Once INTEGRATIONS_KEY is set,
// re-save them with it (runs once at start-up; values that can't be read are left alone).
async function reencryptAll() {
  const stored = { ...(await loadStored()) };
  let changed = 0;
  for (const [group, fields] of Object.entries(FIELDS)) {
    for (const [name, f] of Object.entries(fields)) {
      const raw = stored[group]?.[name];
      if (f.secret && raw && needsRewrap(raw)) {
        const plain = decrypt(raw);
        if (plain) { stored[group][name] = encrypt(plain); changed++; }
      }
    }
  }
  if (changed) {
    await query("UPDATE settings SET value=$1 WHERE key='integrations'", [JSON.stringify(stored)]);
    cache = null;
  }
  return changed;
}

module.exports = { FIELDS, getConfig, publicView, saveGroup, reencryptAll };

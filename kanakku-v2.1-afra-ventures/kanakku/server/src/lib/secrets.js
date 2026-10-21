// Encryption for secrets stored in the database (integration keys, 2-step login secrets).
// Uses INTEGRATIONS_KEY — its own key, so changing JWT_SECRET (which logs everyone out) never wipes saved keys.
// Old installs encrypted with a key derived from JWT_SECRET: those values still decrypt, and are re-saved
// with the new key on start-up (see reencryptAll).
const crypto = require('crypto');

const derive = (s, label) => crypto.createHash('sha256').update(`${s}|${label}`).digest();
const primaryKey = () => (process.env.INTEGRATIONS_KEY ? derive(process.env.INTEGRATIONS_KEY, 'kanakku-secrets') : derive(process.env.JWT_SECRET, 'kanakku-integrations'));
const legacyKey = () => derive(process.env.JWT_SECRET, 'kanakku-integrations');

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', primaryKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  // v2 = INTEGRATIONS_KEY, v1 = the old JWT_SECRET-derived key (until INTEGRATIONS_KEY is set)
  return `${process.env.INTEGRATIONS_KEY ? 'v2' : 'v1'}:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function tryKey(key, iv, tag, enc) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

// Returns '' when the value cannot be read (wrong key or damaged)
function decrypt(blob) {
  const [ver, iv, tag, enc] = String(blob || '').split(':');
  if (!iv || !tag || !enc) return '';
  for (const key of ver === 'v2' ? [primaryKey(), legacyKey()] : [legacyKey(), primaryKey()]) {
    try { return tryKey(key, iv, tag, enc); } catch { /* try next */ }
  }
  return '';
}

const needsRewrap = (blob) => String(blob || '').startsWith('v1:') && !!process.env.INTEGRATIONS_KEY;

module.exports = { encrypt, decrypt, needsRewrap };

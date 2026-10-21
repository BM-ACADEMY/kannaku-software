// Time-based one-time codes (RFC 6238) — works with Google Authenticator, Microsoft Authenticator, Authy.
// No extra packages: SHA-1 HMAC, 30-second steps, 6 digits, ±1 step allowed for clock drift.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

function verify(secret, code, now = Date.now()) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6 || !secret) return false;
  const step = Math.floor(now / 30000);
  return [-1, 0, 1].some((d) => crypto.timingSafeEqual(Buffer.from(codeAt(secret, step + d)), Buffer.from(c)));
}

const otpauthUrl = (secret, email, issuer = 'Kanakku · Afra Ventures') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;

module.exports = { newSecret, verify, codeAt, otpauthUrl, base32Encode, base32Decode };

// Sending messages: email (SMTP) and WhatsApp (Meta Cloud API templates).
// Keys come from Settings → Integrations. Every function returns { ok, error } and never throws,
// so one failed message never stops autopilot.
const { getConfig } = require('./integrations');
const { query } = require('./db');

function normalisePhone(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 12 && d.startsWith('91')) return d;
  return d.length >= 11 ? d : null;
}

let transporter = null; let transporterKey = '';
async function mailer() {
  const e = (await getConfig()).email;
  if (!e.host || !e.user || !e.pass) return null;
  const key = `${e.host}|${e.port}|${e.user}|${e.pass}`;
  if (!transporter || key !== transporterKey) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({ host: e.host, port: Number(e.port || 465), secure: Number(e.port || 465) === 465, auth: { user: e.user, pass: e.pass } });
    transporterKey = key;
  }
  return { t: transporter, from: e.from || e.user };
}

async function sendEmail(to, subject, text, html) {
  if (!to) return { ok: false, error: 'no email address' };
  try {
    const m = await mailer();
    if (!m) return { ok: false, error: 'Email is not set up in Settings → Integrations' };
    await m.t.sendMail({ from: m.from, to, subject, text, html: html || undefined });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// WhatsApp template message. params: array of strings for {{1}}, {{2}}…  (no new lines allowed by Meta)
async function sendWhatsApp(phone, template, params = []) {
  const to = normalisePhone(phone);
  if (!to) return { ok: false, error: 'no valid phone number' };
  try {
    const wa = (await getConfig()).whatsapp;
    if (!wa.phone_number_id || !wa.token) return { ok: false, error: 'WhatsApp is not set up in Settings → Integrations' };
    const body = { messaging_product: 'whatsapp', to, type: 'template',
      template: { name: template, language: { code: wa.template_lang || 'en' },
        components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p ?? '').replace(/\s*\n\s*/g, ' | ').replace(/ {4,}/g, '   ').slice(0, 1000) })) }] } };
    const r = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(wa.phone_number_id)}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${wa.token}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j.error?.message || `WhatsApp returned ${r.status}` };
    return { ok: true, id: j.messages?.[0]?.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Message every active admin by whatever they have (WhatsApp first, email too)
async function notifyAdmins(subject, text, waTemplate = 'afv_weekly_brief') {
  const admins = (await query("SELECT name, email, phone FROM users WHERE role='admin' AND active")).rows;
  const results = [];
  for (const a of admins) {
    const w = a.phone ? await sendWhatsApp(a.phone, waTemplate, [a.name.split(' ')[0], `${subject}: ${text}`]) : { ok: false, error: 'no phone' };
    const m = await sendEmail(a.email, `Kanakku — ${subject}`, text);
    results.push({ to: a.name, whatsapp: w.ok, email: m.ok, error: !w.ok && !m.ok ? `${w.error}; ${m.error}` : undefined });
  }
  return results;
}

module.exports = { sendEmail, sendWhatsApp, notifyAdmins, normalisePhone };

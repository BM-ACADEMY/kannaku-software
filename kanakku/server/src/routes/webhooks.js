// Razorpay webhook → auto "money in" entry.
// In Razorpay Dashboard → Webhooks, point to https://kanakku.afraventures.in/api/webhooks/razorpay
// Events: payment.captured. Put the invoice number in payment notes as `invoice` (e.g. AFV/TX/INV/2627/0001)
// or a brand code as `brand` (e.g. TX) so the payment lands on the right brand.
// Optional when Key ID + Secret are saved — the 5-minute sync picks payments up anyway; the webhook just makes it instant.
const router = require('express').Router();
const express = require('express');
const crypto = require('crypto');
const { getConfig } = require('../lib/integrations');
const { recordRazorpayPayment } = require('../lib/razorpay');

router.post('/razorpay', express.raw({ type: '*/*' }), async (req, res) => {
  let rzp; // Settings → Integrations, falls back to .env
  try { rzp = (await getConfig()).razorpay; } catch (err) { console.error('[razorpay] config', err); return res.status(500).json({ error: 'Failed' }); }
  const secret = rzp.webhook_secret;
  if (!secret) return res.status(503).json({ error: 'Webhook not configured' });
  const sig = req.headers['x-razorpay-signature'] || '';
  const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    return res.status(400).json({ error: 'Bad signature' });

  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Bad JSON' }); }
  if (event.event !== 'payment.captured') return res.json({ ignored: event.event });

  const pay = event.payload?.payment?.entity;
  if (!pay?.id) return res.status(400).json({ error: 'No payment' });
  try {
    res.json(await recordRazorpayPayment(pay, rzp));
  } catch (err) {
    console.error('[razorpay]', err);
    res.status(500).json({ error: 'Failed' }); // Razorpay will retry
  }
});

module.exports = router;

'use strict';
const crypto = require('node:crypto');
const { E } = require('../errors');

/**
 * nowpayments.js — thin client for the NOWPayments processor.
 *
 * Two responsibilities:
 *   1. createInvoice(): ask NOWPayments to create a hosted payment for a USD
 *      price, tagged with our internal order id.
 *   2. verifyWebhookSignature(): validate the IPN callback so balance changes
 *      only ever happen on payloads genuinely signed by NOWPayments.
 *
 * The HTTP call is injectable (`httpFetch`) so it can be exercised in tests
 * without network access. Real calls use the global fetch (Node 18+).
 *
 * Config (env):
 *   NOWPAYMENTS_API_KEY     — REST API key (x-api-key header)
 *   NOWPAYMENTS_IPN_SECRET  — IPN secret used to verify webhook HMACs
 *   NOWPAYMENTS_API_BASE    — defaults to https://api.nowpayments.io/v1
 */
const API_BASE = process.env.NOWPAYMENTS_API_BASE || 'https://api.nowpayments.io/v1';

/**
 * NOWPayments signs IPN callbacks with HMAC-SHA512 over the JSON body with its
 * keys sorted (recursively), so we reproduce that exact string and compare in
 * constant time. We verify against the PARSED body (re-sorted), which avoids
 * any dependence on raw-byte whitespace.
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => {
      acc[k] = sortKeysDeep(value[k]);
      return acc;
    }, {});
  }
  return value;
}

function verifyWebhookSignature(parsedBody, signature, { secret = process.env.NOWPAYMENTS_IPN_SECRET } = {}) {
  if (!secret) throw E.Validation('NOWPAYMENTS_IPN_SECRET is not configured');
  if (!signature || typeof signature !== 'string') return false;
  const sorted = JSON.stringify(sortKeysDeep(parsedBody));
  const expected = crypto.createHmac('sha512', secret).update(sorted).digest('hex');
  // constant-time compare; guard against length-mismatch throwing
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function createInvoice({
  priceAmountUsd, payCurrency, orderId, orderDescription, ipnCallbackUrl,
  successUrl, cancelUrl, httpFetch = globalThis.fetch, apiKey = process.env.NOWPAYMENTS_API_KEY,
}) {
  if (!apiKey) throw E.Validation('NOWPAYMENTS_API_KEY is not configured');
  const body = {
    price_amount: priceAmountUsd,
    price_currency: 'usd',
    pay_currency: payCurrency,
    order_id: String(orderId),
    order_description: orderDescription || `QNTM credits top-up ${orderId}`,
    ipn_callback_url: ipnCallbackUrl,
    ...(successUrl ? { success_url: successUrl } : {}),
    ...(cancelUrl ? { cancel_url: cancelUrl } : {}),
  };
  let res;
  try {
    res = await httpFetch(`${API_BASE}/invoice`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw E.Validation(`NOWPayments request failed: ${err.message}`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    throw E.Validation(`NOWPayments invoice creation failed (${res.status}): ${data.message || text}`);
  }
  return {
    paymentId: String(data.id || data.payment_id || ''),
    paymentUrl: data.invoice_url || data.pay_url || data.payment_url || null,
    request: body,
    response: data,
  };
}

module.exports = { createInvoice, verifyWebhookSignature, sortKeysDeep, API_BASE };

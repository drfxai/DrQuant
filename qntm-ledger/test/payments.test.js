'use strict';
process.env.NOWPAYMENTS_IPN_SECRET = 'test_ipn_secret';
process.env.NOWPAYMENTS_API_KEY = 'test_api_key';
process.env.QNTM_PURCHASE_MAX_USD = process.env.QNTM_PURCHASE_MAX_USD || '100000000'; // lift bound for tests

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const decimal = require('../src/decimal');
const { pool } = require('../src/db');
const wallets = require('../src/wallets');
const treasury = require('../src/treasury');
const supply = require('../src/supply');
const pricing = require('../src/payments/pricing');
const nowpayments = require('../src/payments/nowpayments');
const orders = require('../src/payments/orders');
const { spend } = require('../src/spend');
const { tip } = require('../src/tip');

let seq = 0;
const uid = (p) => `${p}_${Date.now()}_${seq++}`;

// Fake NOWPayments HTTP endpoint: returns an invoice for any request.
function fakeFetch(invoiceId) {
  return async (_url, _opts) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ id: invoiceId, invoice_url: `https://nowpayments.test/i/${invoiceId}` }),
  });
}

// Sign a webhook body exactly the way NOWPayments does (sorted JSON, HMAC-SHA512).
function sign(body) {
  const sorted = JSON.stringify(nowpayments.sortKeysDeep(body));
  return crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET).update(sorted).digest('hex');
}

test.before(async () => {
  await wallets.ensureSystemWallets('QNTM');
  await orders.ensurePaymentWallets('QNTM');
  await treasury.mint('500', { actorId: 'admin', reason: 'payments test treasury' });
});
test.after(async () => { await pool.end(); });

// ---------- pricing ----------
test('pricing: usd -> qntm and qntm -> usd are exact (1 QNTM = 1 cent)', () => {
  assert.deepEqual(pricing.quote({ mode: 'usd', amount: '1.23' }),
    { qntm_amount: '123', usd_amount: '1.23', unit_price_usd_per_qntm: '0.01' });
  assert.deepEqual(pricing.quote({ mode: 'qntm', amount: '5000' }),
    { qntm_amount: '5000', usd_amount: '50', unit_price_usd_per_qntm: '0.01' });
  assert.equal(pricing.qntmFromUsd('100.00'), '10000');
  assert.equal(pricing.usdFromQntm('250'), '2.5');
});

test('pricing: rejects sub-cent USD and fractional QNTM', () => {
  assert.throws(() => pricing.quote({ mode: 'usd', amount: '1.234' }), /2 decimal places/);
  assert.throws(() => pricing.quote({ mode: 'qntm', amount: '10.5' }), /whole number of credits/);
  assert.throws(() => pricing.quote({ mode: 'bogus', amount: '1' }), /mode/);
});

// ---------- order creation ----------
test('createNowpaymentsOrder records order and advances to awaiting_webhook', async () => {
  const user = uid('buyer');
  const r = await orders.createNowpaymentsOrder({
    userId: user, mode: 'usd', amount: '1.00', payCurrency: 'USDTTRC20',
    ipnCallbackUrl: 'https://drfx.io/api/webhooks/nowpayments', httpFetch: fakeFetch('inv_1'),
  });
  assert.equal(r.qntm_amount, '100');
  assert.equal(r.usd_amount, '1.00');
  assert.match(r.payment_url, /nowpayments\.test/);
  const order = await orders.getOrder(r.order_id);
  assert.equal(order.status, 'awaiting_webhook');
  assert.equal(order.nowpayments_payment_id, 'inv_1');
});

test('createNowpaymentsOrder rejects unsupported currency and out-of-bounds amounts', async () => {
  await assert.rejects(orders.createNowpaymentsOrder({
    userId: uid('b'), mode: 'usd', amount: '1.00', payCurrency: 'DOGECOIN_NOPE', httpFetch: fakeFetch('x'),
  }), /unsupported pay_currency/);
  await assert.rejects(orders.createNowpaymentsOrder({
    userId: uid('b'), mode: 'usd', amount: '0.50', payCurrency: 'BTC', httpFetch: fakeFetch('x'),
  }), /minimum top-up/);
});

// ---------- webhook ----------
async function makeAwaitingOrder(user, usd, payCurrency = 'USDTTRC20', invId = uid('inv')) {
  const r = await orders.createNowpaymentsOrder({
    userId: user, mode: 'usd', amount: usd, payCurrency,
    ipnCallbackUrl: 'https://drfx.io/api/webhooks/nowpayments', httpFetch: fakeFetch(invId),
  });
  return r;
}

test('webhook with a bad signature is rejected and credits nothing', async () => {
  const user = uid('sig');
  const r = await makeAwaitingOrder(user, '1.00');
  const body = { order_id: r.order_id, payment_status: 'finished', price_amount: '1.00' };
  await assert.rejects(orders.handleWebhook({ body, signature: 'deadbeef' }), /signature/i);
  const order = await orders.getOrder(r.order_id);
  assert.equal(order.status, 'awaiting_webhook'); // unchanged
  const w = await wallets.getUserWallet(user);
  assert.equal(w, null); // no wallet/credit created
});

test('valid finished webhook credits the user once; treasury is debited; ledger linked', async () => {
  const user = uid('ok');
  const r = await makeAwaitingOrder(user, '1.00'); // 100 QNTM
  const treasuryBefore = (await wallets.getWallet(await wallets.systemWalletId('treasury', 'QNTM'))).available_balance;
  const body = { order_id: r.order_id, payment_status: 'finished', price_amount: '1.00', payment_id: 'inv' };
  const res = await orders.handleWebhook({ body, signature: sign(body) });
  assert.equal(res.status, 'completed');
  assert.equal(res.credited, '100.000000000000000000');

  const w = await wallets.getUserWallet(user);
  assert.equal(w.available_balance, '100.000000000000000000');
  const order = await orders.getOrder(r.order_id);
  assert.equal(order.status, 'completed');
  assert.ok(order.ledger_transaction_id, 'ledger transaction linked');
  const treasuryAfter = (await wallets.getWallet(await wallets.systemWalletId('treasury', 'QNTM'))).available_balance;
  assert.equal(decimal.toBaseUnits(treasuryAfter), decimal.toBaseUnits(treasuryBefore) - decimal.toBaseUnits('100'));

  // Duplicate webhook -> idempotent no-op (balance unchanged).
  const dup = await orders.handleWebhook({ body, signature: sign(body) });
  assert.equal(dup.idempotent, true);
  assert.equal((await wallets.getUserWallet(user)).available_balance, '100.000000000000000000');
});

test('amount mismatch marks the order failed and credits nothing', async () => {
  const user = uid('mismatch');
  const r = await makeAwaitingOrder(user, '2.00'); // order is $2.00
  const body = { order_id: r.order_id, payment_status: 'finished', price_amount: '1.00' }; // underpaid
  const res = await orders.handleWebhook({ body, signature: sign(body) });
  assert.equal(res.status, 'failed');
  assert.equal(res.reason, 'amount_mismatch');
  assert.equal(await wallets.getUserWallet(user), null);
});

test('underfunded treasury -> paid_pending_credit, then admin re-credit completes it', async () => {
  const user = uid('underfunded');
  // Size the order strictly larger than the current treasury, so it cannot be
  // covered regardless of what other suites minted into the shared treasury.
  const tId = await wallets.systemWalletId('treasury', 'QNTM');
  const tWhole = decimal.toBaseUnits((await wallets.getWallet(tId)).available_balance) / (10n ** 18n);
  const orderQntm = (tWhole + 1000n).toString();
  const r = await orders.createNowpaymentsOrder({
    userId: user, mode: 'qntm', amount: orderQntm, payCurrency: 'USDTTRC20',
    ipnCallbackUrl: 'https://drfx.io/api/webhooks/nowpayments', httpFetch: fakeFetch(uid('inv')),
  });
  const body = { order_id: r.order_id, payment_status: 'finished', price_amount: r.usd_amount };
  const res = await orders.handleWebhook({ body, signature: sign(body) });
  assert.equal(res.status, 'paid_pending_credit');
  assert.equal(await wallets.getUserWallet(user), null); // not credited yet

  // Admin tops up the treasury enough to cover it, then re-credits.
  await treasury.mint(orderQntm, { actorId: 'admin', reason: 'cover pending credit' });
  const rc = await orders.manualReCredit(r.order_id, { adminId: 'adminX' });
  assert.equal(decimal.toBaseUnits(rc.credited), decimal.toBaseUnits(orderQntm));
  assert.equal(decimal.toBaseUnits((await wallets.getUserWallet(user)).available_balance), decimal.toBaseUnits(orderQntm));
  assert.equal((await orders.getOrder(r.order_id)).status, 'completed');

  // Re-credit again is idempotent.
  const rc2 = await orders.manualReCredit(r.order_id, { adminId: 'adminX' });
  assert.equal(rc2.idempotent, true);
});

// ---------- spend & tip ----------
test('spend debits user into the revenue sink; tip moves credits user-to-user', async () => {
  const u = uid('spender');
  const uw = await wallets.getOrCreateWallet('user', u, 'personal');
  await treasury.grant(uw.id, '100', { actorId: 'admin', reason: 'fund spend test' });

  await spend({ userOwnerId: u, amount: '30', reason: 'ai_analysis' });
  assert.equal((await wallets.getUserWallet(u)).available_balance, '70.000000000000000000');
  const revenue = await wallets.getWallet(await wallets.systemWalletId('revenue', 'QNTM'));
  assert.ok(BigInt(revenue.available_balance.split('.')[0]) >= 30n);

  const friend = uid('friend');
  await tip({ fromOwnerId: u, toOwnerId: friend, amount: '20', note: 'nice call' });
  assert.equal((await wallets.getUserWallet(u)).available_balance, '50.000000000000000000');
  assert.equal((await wallets.getUserWallet(friend)).available_balance, '20.000000000000000000');
  await assert.rejects(tip({ fromOwnerId: u, toOwnerId: u, amount: '5' }), /yourself/);
});

test('global ledger integrity holds after all payment, spend and tip flows', async () => {
  const integ = await supply.verifyIntegrity();
  assert.equal(integ.ok, true, `offenders: ${JSON.stringify(integ.offenders)}`);
});

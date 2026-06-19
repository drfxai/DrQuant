'use strict';
const { pool, withTransaction } = require('../db');
const walletsMod = require('../wallets');
const { postTransaction } = require('../ledger');
const { writeAudit } = require('../audit');
const { emit } = require('../events');
const { E } = require('../errors');
const decimal = require('../decimal');
const pricing = require('./pricing');
const nowpayments = require('./nowpayments');

/**
 * orders.js — NOWPayments one-way top-up orchestration.
 *
 * Direction is strictly fiat/crypto -> QNTM credits -> internal use. There is
 * no reverse path. NOWPayments custodies the money; we only adjust internal
 * balances after a signature-verified, amount-validated, idempotent webhook.
 */
const PURCHASE_MIN_USD = process.env.QNTM_PURCHASE_MIN_USD || '1';      // $1
const PURCHASE_MAX_USD = process.env.QNTM_PURCHASE_MAX_USD || '10000';  // $10k
const SUPPORTED_PAY_CURRENCIES = (process.env.QNTM_PAY_CURRENCIES
  || 'USDTTRC20,USDTERC20,BTC,ETH,LTC,USDCERC20,TRX,BNBBSC').split(',').map((s) => s.trim().toUpperCase());

/** Idempotently create the two singleton wallets the payment/spend flows need. */
async function ensurePaymentWallets(currency = 'QNTM', client = pool) {
  for (const wtype of ['control_deck', 'revenue']) {
    await client.query(
      `INSERT INTO wallets (owner_type, owner_id, wallet_type, currency)
       VALUES ('platform', NULL, $1, $2)
       ON CONFLICT (wallet_type, currency) WHERE owner_id IS NULL DO NOTHING`,
      [wtype, currency]
    );
  }
}

/** Quote without side effects. */
function quote({ mode, amount }) { return pricing.quote({ mode, amount }); }

function _withinBounds(usd) {
  if (decimal.cmp(usd, PURCHASE_MIN_USD) < 0) throw E.Validation(`minimum top-up is $${PURCHASE_MIN_USD}`);
  if (decimal.cmp(usd, PURCHASE_MAX_USD) > 0) throw E.Validation(`maximum top-up is $${PURCHASE_MAX_USD}`);
}

/**
 * Create a payment order and a NOWPayments invoice for it.
 * Returns the hosted payment URL the user is redirected to.
 */
async function createNowpaymentsOrder({
  userId, mode, amount, payCurrency, ipnCallbackUrl, successUrl, cancelUrl,
  httpFetch, // injectable for tests
}) {
  if (!userId) throw E.Validation('userId is required');
  const cur = String(payCurrency || '').toUpperCase();
  if (!SUPPORTED_PAY_CURRENCIES.includes(cur)) {
    throw E.Validation(`unsupported pay_currency '${payCurrency}'`);
  }
  const q = quote({ mode, amount });
  _withinBounds(q.usd_amount);

  // 1) record the order (pending)
  const { rows } = await pool.query(
    `INSERT INTO payment_orders (user_id, qntm_amount, fiat_amount_usd, pay_currency, unit_price_usd, status)
     VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *`,
    [String(userId), q.qntm_amount, q.usd_amount, cur, pricing.UNIT_PRICE_USD_PER_QNTM]
  );
  const order = rows[0];

  // 2) ask NOWPayments for an invoice
  let invoice;
  try {
    invoice = await nowpayments.createInvoice({
      priceAmountUsd: q.usd_amount, payCurrency: cur, orderId: order.id,
      orderDescription: `QNTM credits (${q.qntm_amount}) for user ${userId}`,
      ipnCallbackUrl, successUrl, cancelUrl, httpFetch,
    });
  } catch (err) {
    await pool.query(`UPDATE payment_orders SET status='failed', error=$2 WHERE id=$1`, [order.id, err.message]);
    throw err;
  }

  // 3) persist invoice details + advance status
  const { rows: upd } = await pool.query(
    `UPDATE payment_orders
       SET nowpayments_payment_id=$2, raw_request=$3, raw_response=$4, status='awaiting_webhook'
     WHERE id=$1 RETURNING *`,
    [order.id, invoice.paymentId || null, invoice.request, invoice.response]
  );
  emit('payment.order.created', { orderId: upd[0].public_id, userId: String(userId), qntm: q.qntm_amount, usd: q.usd_amount });
  return {
    order_id: upd[0].public_id,
    payment_url: invoice.paymentUrl,
    qntm_amount: q.qntm_amount,
    usd_amount: q.usd_amount,
    pay_currency: cur,
  };
}

/**
 * The `purchase` ledger op: move pre-minted QNTM from treasury to the user.
 * Idempotent per order, so webhook retries and manual re-credits never double
 * up. Throws E.InsufficientFunds if the treasury is underfunded.
 */
async function _creditPurchase(cx, { order }) {
  const treasuryId = await walletsMod.systemWalletId('treasury', 'QNTM', cx);
  const user = await walletsMod.getOrCreateWallet('user', order.user_id, 'personal', 'QNTM', cx);
  return postTransaction({
    type: 'purchase',
    amount: order.qntm_amount,
    movements: [
      { walletId: treasuryId, direction: 'debit', amount: order.qntm_amount, description: `top-up ${order.public_id}` },
      { walletId: user.id, direction: 'credit', amount: order.qntm_amount, description: `top-up ${order.public_id}` },
    ],
    currency: 'QNTM',
    initiatorUserId: order.user_id,
    reference: { type: 'payment_order', id: order.public_id },
    idempotencyKey: `purchase:po:${order.public_id}`,
    metadata: { payment_order_id: order.public_id, pay_currency: order.pay_currency },
  }, cx);
}

// NOWPayments payment_status values that mean "paid in full".
const PAID_STATUSES = new Set(['finished', 'confirmed']);
const DEAD_STATUSES = new Set(['failed', 'expired', 'refunded']);

/**
 * Handle a NOWPayments IPN. Verifies signature, then idempotently credits QNTM
 * once the payment is finished and the amount matches the order.
 *
 * @returns {object} a small status object (also drives the HTTP response code)
 */
async function handleWebhook({ body, signature }) {
  if (!nowpayments.verifyWebhookSignature(body, signature)) {
    throw E.Forbidden('invalid NOWPayments signature');
  }
  const orderRef = body.order_id;
  const paymentStatus = body.payment_status;
  const priceAmount = body.price_amount != null ? String(body.price_amount) : null;
  if (!orderRef) throw E.Validation('webhook missing order_id');

  return withTransaction(async (cx) => {
    // Lock the order row so concurrent IPNs serialize.
    const { rows } = await cx.query(
      `SELECT * FROM payment_orders WHERE id::text = $1 OR public_id = $1 FOR UPDATE`,
      [String(orderRef)]
    );
    if (!rows.length) throw E.Validation(`unknown order_id ${orderRef}`);
    const order = rows[0];

    // Idempotency: already credited -> no-op.
    if (order.status === 'completed') {
      return { ok: true, idempotent: true, orderId: order.public_id, status: 'completed' };
    }

    // Terminal failure states.
    if (DEAD_STATUSES.has(paymentStatus)) {
      await cx.query(`UPDATE payment_orders SET status='failed', raw_webhook=$2, error=$3 WHERE id=$1`,
        [order.id, body, `payment ${paymentStatus}`]);
      emit('payment.order.failed', { orderId: order.public_id, reason: paymentStatus });
      return { ok: true, orderId: order.public_id, status: 'failed', reason: paymentStatus };
    }

    // Not yet paid -> acknowledge, stay awaiting.
    if (!PAID_STATUSES.has(paymentStatus)) {
      await cx.query(`UPDATE payment_orders SET raw_webhook=$2 WHERE id=$1`, [order.id, body]);
      return { ok: true, orderId: order.public_id, status: 'awaiting_webhook', payment_status: paymentStatus };
    }

    // Amount validation: NOWPayments price_amount must match the order's USD.
    if (priceAmount == null || decimal.cmp(priceAmount, order.fiat_amount_usd) !== 0) {
      await cx.query(`UPDATE payment_orders SET status='failed', raw_webhook=$2, error=$3 WHERE id=$1`,
        [order.id, body, `amount mismatch: webhook ${priceAmount} != order ${order.fiat_amount_usd}`]);
      emit('payment.order.failed', { orderId: order.public_id, reason: 'amount_mismatch' });
      return { ok: true, orderId: order.public_id, status: 'failed', reason: 'amount_mismatch' };
    }

    // Credit QNTM. Use a SAVEPOINT so an underfunded treasury degrades to
    // "paid_pending_credit" (admin re-credits after minting) instead of failing.
    await cx.query('SAVEPOINT credit');
    try {
      const txn = await _creditPurchase(cx, { order });
      await cx.query('RELEASE SAVEPOINT credit');
      await cx.query(
        `UPDATE payment_orders SET status='completed', raw_webhook=$2, ledger_transaction_id=$3, error=NULL WHERE id=$1`,
        [order.id, body, txn.id]
      );
      emit('payment.order.completed', { orderId: order.public_id, userId: order.user_id, qntm: order.qntm_amount, transactionId: txn.public_id });
      return { ok: true, orderId: order.public_id, status: 'completed', credited: order.qntm_amount };
    } catch (err) {
      if (err.code !== 'insufficient_funds') throw err;
      await cx.query('ROLLBACK TO SAVEPOINT credit');
      await cx.query(
        `UPDATE payment_orders SET status='paid_pending_credit', raw_webhook=$2, error='treasury_underfunded' WHERE id=$1`,
        [order.id, body]
      );
      emit('payment.order.paid_pending_credit', { orderId: order.public_id, userId: order.user_id, qntm: order.qntm_amount });
      return { ok: true, orderId: order.public_id, status: 'paid_pending_credit', reason: 'treasury_underfunded' };
    }
  });
}

/**
 * Admin action (QNTM Control Deck): credit a paid-but-uncredited order after
 * the treasury has been topped up. Idempotent; fully audited.
 */
async function manualReCredit(orderPublicId, { adminId }) {
  return withTransaction(async (cx) => {
    const { rows } = await cx.query(`SELECT * FROM payment_orders WHERE public_id=$1 FOR UPDATE`, [orderPublicId]);
    if (!rows.length) throw E.Validation('payment order not found');
    const order = rows[0];
    if (order.status === 'completed') {
      return { ok: true, idempotent: true, orderId: order.public_id };
    }
    if (!['paid_pending_credit', 'awaiting_webhook'].includes(order.status)) {
      throw E.Conflict(`order ${orderPublicId} is ${order.status}; manual credit not allowed`);
    }
    const txn = await _creditPurchase(cx, { order });
    await cx.query(
      `UPDATE payment_orders SET status='completed', ledger_transaction_id=$2, error=NULL WHERE id=$1`,
      [order.id, txn.id]
    );
    await writeAudit({ actorId: String(adminId), action: 'payment.manual_recredit', transactionId: txn.id,
      reason: `re-credit ${order.public_id}`, metadata: { orderId: order.public_id, qntm: order.qntm_amount } }, cx);
    return { ok: true, orderId: order.public_id, credited: order.qntm_amount, transactionId: txn.public_id };
  });
}

/** Admin override: mark a stuck order failed (no balance change). */
async function markFailed(orderPublicId, { adminId, reason }) {
  const { rows } = await pool.query(
    `UPDATE payment_orders SET status='failed', error=$2
     WHERE public_id=$1 AND status NOT IN ('completed') RETURNING *`, [orderPublicId, reason || 'manual override']);
  if (!rows.length) throw E.Conflict('order not found or already completed');
  await writeAudit({ actorId: String(adminId), action: 'payment.mark_failed', reason, metadata: { orderId: orderPublicId } });
  return rows[0];
}

async function getOrder(orderPublicId) {
  const { rows } = await pool.query(`SELECT * FROM payment_orders WHERE public_id=$1`, [orderPublicId]);
  return rows[0] || null;
}

async function listOrders({ status, userId, limit = 100, before = null } = {}) {
  const clauses = []; const params = [];
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  if (userId) { params.push(String(userId)); clauses.push(`user_id = $${params.length}`); }
  if (before) { params.push(before); clauses.push(`id < $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.min(limit, 500));
  const { rows } = await pool.query(
    `SELECT * FROM payment_orders ${where} ORDER BY id DESC LIMIT $${params.length}`, params);
  return rows;
}

module.exports = {
  ensurePaymentWallets, quote, createNowpaymentsOrder, handleWebhook,
  manualReCredit, markFailed, getOrder, listOrders,
  PURCHASE_MIN_USD, PURCHASE_MAX_USD, SUPPORTED_PAY_CURRENCIES,
};

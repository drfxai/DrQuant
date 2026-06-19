'use strict';
const { pool, withTransaction } = require('../db');
const wallets = require('../wallets');
const { postTransaction } = require('../ledger');
const { writeAudit } = require('../audit');
const decimal = require('../decimal');
const cfg = require('./token.config');
const { ensureEconomyWallets } = require('./schema');

/**
 * bootstrap.js -- the one-time issuance of the entire fixed QNTM supply.
 *
 * Atomic: either the full supply is minted and the five Dubai-Edition buckets
 * are funded, or nothing happens. Guarded three independent ways:
 *   1. a transaction-scoped advisory lock serializes concurrent attempts,
 *   2. an explicit isBootstrapped() check (flag OR full supply already issued),
 *   3. per-event idempotency keys on the ledger transactions.
 * After it runs, QNTM_MAX_SUPPLY blocks any further mint, so issuance is closed.
 */

/** Read the bootstrap status row (or null). */
async function status(client = pool) {
  const { rows } = await client.query(
    'SELECT value FROM qntm_system_status WHERE key = $1', [cfg.BOOTSTRAP_FLAG]);
  return rows.length ? rows[0].value : null;
}

/** True if the flag is set OR the full supply has already been issued. */
async function isBootstrapped(client = pool) {
  const s = await status(client);
  if (s && s.completed) return true;
  const { rows } = await client.query(
    "SELECT available_balance FROM wallets WHERE wallet_type = 'genesis' AND owner_id IS NULL AND currency = 'QNTM'");
  if (rows.length) {
    const issued = decimal.neg(rows[0].available_balance);
    if (decimal.cmp(issued, cfg.TOTAL_SUPPLY) >= 0) return true;
  }
  return false;
}

async function bootstrap({ actorId } = {}) {
  return withTransaction(async (cx) => {
    await cx.query('SELECT pg_advisory_xact_lock($1)', [911001]);
    if (await isBootstrapped(cx)) {
      const e = new Error('QNTM is already bootstrapped (BOOTSTRAP_COMPLETED_V1)');
      e.code = 'already_bootstrapped'; e.status = 409; throw e;
    }
    await ensureEconomyWallets(cx);

    const genesis = await wallets.systemWalletId('genesis', 'QNTM', cx);
    const treasury = await wallets.systemWalletId(cfg.MINT_SOURCE_WALLET_TYPE, 'QNTM', cx);

    // 1) initial mint: genesis -> treasury, full fixed supply.
    await postTransaction({
      type: 'mint',
      amount: cfg.TOTAL_SUPPLY,
      movements: [
        { walletId: genesis,  direction: 'debit',  amount: cfg.TOTAL_SUPPLY, description: 'QNTM initial mint (genesis contra)' },
        { walletId: treasury, direction: 'credit', amount: cfg.TOTAL_SUPPLY, description: 'QNTM initial mint to treasury' },
      ],
      initiatorUserId: actorId,
      reference: { type: 'qntm_bootstrap', id: 'initial_mint_v1' },
      idempotencyKey: 'qntm-bootstrap-initial_mint_v1',
      metadata: { event: 'initial_mint_v1', phase: 'bootstrap_v1' },
      allowFrozen: true,
    }, cx);

    // 2..n) allocate the non-treasury buckets out of treasury.
    for (const a of cfg.ALLOCATIONS) {
      if (a.walletType === cfg.MINT_SOURCE_WALLET_TYPE) continue; // treasury keeps its residual
      const to = await wallets.systemWalletId(a.walletType, 'QNTM', cx);
      await postTransaction({
        type: 'transfer',
        amount: a.amount,
        movements: [
          { walletId: treasury, direction: 'debit',  amount: a.amount, description: 'allocate ' + a.code },
          { walletId: to,       direction: 'credit', amount: a.amount, description: 'allocate ' + a.code },
        ],
        initiatorUserId: actorId,
        reference: { type: 'qntm_bootstrap', id: a.event },
        idempotencyKey: 'qntm-bootstrap-' + a.event,
        metadata: { event: a.event, code: a.code, phase: 'bootstrap_v1' },
        allowFrozen: true,
      }, cx);
    }

    // The treasury residual IS the QNTM_TREASURY allocation -- recorded in audit.
    const t = cfg.ALLOCATIONS.find((a) => a.walletType === cfg.MINT_SOURCE_WALLET_TYPE);
    await writeAudit({
      actorId, action: 'qntm.bootstrap.' + t.event,
      metadata: { code: t.code, amount: t.amount, note: 'treasury residual after allocations' },
    }, cx);

    // Set the completion flag.
    await cx.query(
      `INSERT INTO qntm_system_status (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [cfg.BOOTSTRAP_FLAG, JSON.stringify({
        completed: true, at: new Date().toISOString(),
        totalSupply: cfg.TOTAL_SUPPLY, by: actorId || null,
        allocations: cfg.ALLOCATIONS.map((a) => ({ code: a.code, amount: a.amount })),
      })]
    );
    await writeAudit({
      actorId, action: 'qntm.bootstrap.bootstrap_completed_v1',
      metadata: { totalSupply: cfg.TOTAL_SUPPLY },
    }, cx);

    return {
      completed: true,
      totalSupply: cfg.TOTAL_SUPPLY,
      allocations: cfg.ALLOCATIONS.map((a) => ({ code: a.code, walletType: a.walletType, amount: a.amount })),
    };
  });
}

module.exports = { status, isBootstrapped, bootstrap };

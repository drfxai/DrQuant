'use strict';
const { pool, withTransaction } = require('./db');
const wallets = require('./wallets');
const { postTransaction } = require('./ledger');
const { writeAudit } = require('./audit');
const { E } = require('./errors');
const decimal = require('./decimal');

/**
 * treasury.js — the ONLY origin of QNTM.
 *
 * Supply model (fixed, fully auditable, conservation-provable):
 *   - A singleton `genesis` contra-wallet holds the NEGATIVE of all tokens
 *     ever issued. It starts at 0 and is the one wallet permitted to go
 *     negative.
 *   - `mint(amount)` issues supply by posting a balanced transaction:
 *         debit  genesis   (genesis goes more negative)
 *         credit treasury  (circulating supply increases)
 *     so total issued == -(genesis.available_balance), always.
 *   - `grant(walletId, amount)` moves already-issued tokens from treasury to a
 *     user/creator wallet (rewards drops, airdrops, manual top-ups, etc.).
 *
 * There is NO fiat purchase path and NO redemption/cashout path. QNTM is an
 * internal, non-redeemable credit. Issuance is an administrative act, recorded
 * in the audit log — not a sale of a financial instrument. (See COMPLIANCE.md.)
 *
 * An optional hard cap (QNTM_MAX_SUPPLY) prevents minting beyond a fixed total.
 */

const MAX_SUPPLY = process.env.QNTM_MAX_SUPPLY || null; // decimal string or null = uncapped

async function _genesisId(client) { return wallets.systemWalletId('genesis', 'QNTM', client); }
async function _treasuryId(client) { return wallets.systemWalletId('treasury', 'QNTM', client); }

/** Total tokens issued so far = -(genesis available balance). */
async function totalIssued(client = pool) {
  const id = await _genesisId(client);
  const { rows } = await client.query(`SELECT available_balance FROM wallets WHERE id = $1`, [id]);
  return decimal.neg(rows[0].available_balance); // negate the negative contra balance
}

/**
 * Issue `amount` new QNTM into the treasury. Admin-only; the caller's RBAC
 * check happens at the route layer. Idempotent if you pass idempotencyKey.
 */
async function mint(amount, { actorId, reason, idempotencyKey } = {}) {
  if (!decimal.isPositive(amount)) throw E.InvalidAmount();
  return withTransaction(async (cx) => {
    if (MAX_SUPPLY) {
      const issued = await totalIssued(cx);
      if (decimal.cmp(decimal.add(issued, amount), MAX_SUPPLY) > 0) {
        throw E.Validation(
          `mint would exceed max supply: issued=${issued}, +${amount}, cap=${MAX_SUPPLY}`
        );
      }
    }
    const genesis = await _genesisId(cx);
    const treasuryId = await _treasuryId(cx);
    const txn = await postTransaction(
      {
        type: 'mint',
        amount,
        movements: [
          { walletId: genesis, direction: 'debit', amount, description: 'issue supply' },
          { walletId: treasuryId, direction: 'credit', amount, description: 'supply to treasury' },
        ],
        initiatorUserId: actorId,
        reference: { type: 'mint', id: idempotencyKey || null },
        idempotencyKey,
        metadata: { reason: reason || null },
        allowFrozen: true,
      },
      cx
    );
    await writeAudit({
      actorId, action: 'treasury.mint', transactionId: txn.id, reason,
      metadata: { amount },
    }, cx);
    return txn;
  });
}

/** Move issued tokens from treasury into a destination wallet. */
async function grant(toWalletId, amount, { actorId, reason, idempotencyKey } = {}) {
  if (!decimal.isPositive(amount)) throw E.InvalidAmount();
  return withTransaction(async (cx) => {
    const treasuryId = await _treasuryId(cx);
    const txn = await postTransaction(
      {
        type: 'reward', // a grant is economically a platform-funded credit
        amount,
        movements: [
          { walletId: treasuryId, direction: 'debit', amount, description: 'treasury grant' },
          { walletId: toWalletId, direction: 'credit', amount, description: reason || 'grant' },
        ],
        initiatorUserId: actorId,
        reference: { type: 'grant', id: idempotencyKey || null },
        idempotencyKey,
        metadata: { reason: reason || null, kind: 'grant' },
        allowFrozen: true,
      },
      cx
    );
    await writeAudit({
      actorId, action: 'treasury.grant', walletId: toWalletId, transactionId: txn.id, reason,
      metadata: { amount },
    }, cx);
    return txn;
  });
}

/**
 * Supply accounting snapshot. Returns the figures the spec's §27/§28 reporting
 * needs, computed straight from wallet balances so they can never disagree with
 * the ledger.
 */
async function supplySummary(client = pool) {
  const { rows } = await client.query(`
    SELECT
      COALESCE(SUM(CASE WHEN wallet_type = 'genesis' THEN available_balance END), 0)        AS genesis_avail,
      COALESCE(SUM(CASE WHEN wallet_type <> 'genesis' THEN available_balance END), 0)       AS non_genesis_avail,
      COALESCE(SUM(CASE WHEN wallet_type <> 'genesis' THEN pending_balance END), 0)         AS pending_total,
      COALESCE(SUM(CASE WHEN wallet_type <> 'genesis' THEN locked_balance END), 0)          AS locked_total,
      COALESCE(SUM(CASE WHEN wallet_type = 'treasury' THEN available_balance END), 0)       AS treasury,
      COALESCE(SUM(CASE WHEN wallet_type = 'burn' THEN available_balance END), 0)           AS burned,
      COALESCE(SUM(CASE WHEN wallet_type = 'reward_pool' THEN available_balance END), 0)    AS reward_pool,
      COALESCE(SUM(CASE WHEN wallet_type = 'escrow' THEN available_balance END), 0)         AS escrow_held
    FROM wallets WHERE currency = 'QNTM'
  `);
  const r = rows[0];
  const sumNonGenesis = decimal.add(decimal.add(r.non_genesis_avail, r.pending_total), r.locked_total);
  const totalIssuedVal = decimal.neg(r.genesis_avail);
  // circulating = total issued, minus locked, minus burned (per §28)
  const circulating = decimal.sub(decimal.sub(totalIssuedVal, r.locked_total), r.burned);
  return {
    totalIssued: totalIssuedVal,
    negGenesis: decimal.neg(r.genesis_avail),
    sumNonGenesis,
    circulating,
    treasury: r.treasury,
    burned: r.burned,
    rewardPool: r.reward_pool,
    escrowHeld: r.escrow_held,
    pendingTotal: r.pending_total,
    lockedTotal: r.locked_total,
  };
}

module.exports = { mint, grant, totalIssued, supplySummary, MAX_SUPPLY };

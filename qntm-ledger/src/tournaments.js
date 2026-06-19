'use strict';
const { pool, withTransaction } = require('./db');
const wallets = require('./wallets');
const { postTransaction } = require('./ledger');
const { splitAmount } = require('./fees');
const { emit } = require('./events');
const { E } = require('./errors');
const decimal = require('./decimal');

/**
 * tournaments.js — paid tournaments / competitions (spec §18). Entry fees flow
 * into the singleton tournament_pool wallet, tagged with the tournament id.
 * Settlement distributes the collected pool to winners, with an optional rake
 * to treasury/burn. Payouts are validated to never exceed what was collected
 * for that tournament (computed from the ledger), so a tournament can never pay
 * out money it didn't take in.
 */
async function join({ tournamentId, ownerId, ownerType = 'user', entryFee, currency = 'QNTM', idempotencyKey }) {
  if (!decimal.isPositive(entryFee)) throw E.InvalidAmount();
  const user = await wallets.getOrCreateWallet(ownerType, ownerId, 'personal', currency);
  const poolId = await wallets.systemWalletId('tournament_pool', currency);
  const txn = await postTransaction({
    type: 'tournament_entry', amount: entryFee,
    movements: [
      { walletId: user.id, direction: 'debit', amount: entryFee, description: `tournament ${tournamentId} entry` },
      { walletId: poolId, direction: 'credit', amount: entryFee, description: `tournament ${tournamentId} pool` },
    ],
    currency, initiatorUserId: String(ownerId),
    reference: { type: 'tournament', id: String(tournamentId) },
    idempotencyKey: idempotencyKey || `tjoin:${tournamentId}:${ownerId}`,
  });
  emit('tournament.joined', { tournamentId: String(tournamentId), userId: String(ownerId), entryFee });
  return txn;
}

/** Total entry fees collected for a tournament (from completed entry txns). */
async function collectedPool(tournamentId, currency = 'QNTM', client = pool) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
     WHERE type='tournament_entry' AND status='completed'
       AND reference_type='tournament' AND reference_id=$1 AND currency=$2`,
    [String(tournamentId), currency]
  );
  return rows[0].total;
}

/**
 * Distribute prizes. `winners` = [{ ownerId, ownerType?, amount }]. Optional
 * `rake = { treasury: bps, burn: bps }` takes a cut first; the remaining pool
 * is paid to winners. Sum(prizes)+rake must equal the collected pool exactly.
 */
async function settle({ tournamentId, winners, rakeBps = { treasury: 0, burn: 0 }, currency = 'QNTM' }) {
  return withTransaction(async (cx) => {
    const pool_ = await collectedPool(tournamentId, currency, cx);
    if (decimal.isZero(pool_)) throw E.Validation('tournament has an empty pool');

    const totalPrizes = winners.reduce((a, w) => decimal.add(a, w.amount), '0');
    const rakeTotalBps = (rakeBps.treasury || 0) + (rakeBps.burn || 0);
    let rake = { treasury: '0', burn: '0' };
    if (rakeTotalBps > 0) {
      const r = splitAmount(pool_, { treasury: rakeBps.treasury || 0, burn: rakeBps.burn || 0, prizes: 10000 - rakeTotalBps }, 'prizes');
      rake = { treasury: r.treasury, burn: r.burn };
    }
    const required = decimal.add(totalPrizes, decimal.add(rake.treasury, rake.burn));
    if (decimal.cmp(required, pool_) !== 0) {
      throw E.Validation(`prize+rake total ${required} must equal collected pool ${pool_}`);
    }

    const poolId = await wallets.systemWalletId('tournament_pool', currency, cx);
    const treasuryId = await wallets.systemWalletId('treasury', currency, cx);
    const burnId = await wallets.systemWalletId('burn', currency, cx);

    const movements = [
      { walletId: poolId, direction: 'debit', amount: pool_, description: `tournament ${tournamentId} settle` },
    ];
    for (const w of winners) {
      const ww = await wallets.getOrCreateWallet(w.ownerType || 'user', w.ownerId, 'personal', currency);
      movements.push({ walletId: ww.id, direction: 'credit', amount: w.amount, description: `tournament ${tournamentId} prize` });
    }
    if (decimal.isPositive(rake.treasury)) movements.push({ walletId: treasuryId, direction: 'credit', amount: rake.treasury, description: 'tournament rake' });
    if (decimal.isPositive(rake.burn)) movements.push({ walletId: burnId, direction: 'credit', amount: rake.burn, description: 'tournament burn' });

    const txn = await postTransaction({
      type: 'tournament_prize', amount: pool_, movements,
      currency, reference: { type: 'tournament', id: String(tournamentId) },
      idempotencyKey: `tsettle:${tournamentId}`,
    }, cx);
    emit('tournament.settled', { tournamentId: String(tournamentId), pool: pool_, winners: winners.length });
    return { transaction: txn, pool: pool_, rake };
  });
}
module.exports = { join, settle, collectedPool };

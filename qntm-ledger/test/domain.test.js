'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db');
const wallets = require('../src/wallets');
const treasury = require('../src/treasury');
const marketplace = require('../src/marketplace');
const subscriptions = require('../src/subscriptions');
const staking = require('../src/staking');
const tournaments = require('../src/tournaments');
const rewards = require('../src/rewards');
const referrals = require('../src/referrals');
const adjustments = require('../src/adjustments');
const supply = require('../src/supply');

let seq = 0;
const uid = (p) => `${p}_${Date.now()}_${seq++}`;

test.before(async () => {
  await wallets.ensureSystemWallets('QNTM');
  await treasury.mint('5000000', { actorId: 'admin', reason: 'smoke genesis' });
  await rewards.fundRewardPool('100000', { actorId: 'admin', reason: 'smoke reward pool' });
});
test.after(async () => { await pool.end(); });

async function fund(ownerId, amount, type = 'user', wtype = 'personal') {
  const w = await wallets.getOrCreateWallet(type, ownerId, wtype);
  await treasury.grant(w.id, amount, { actorId: 'admin', reason: 'smoke fund' });
  return w;
}

test('marketplace: purchase -> settle -> creator release, fees split exactly', async () => {
  const buyerId = uid('buyer');
  const creatorId = uid('creator');
  await fund(buyerId, '1000');
  const creatorW = await wallets.getOrCreateWallet('creator', creatorId, 'creator');

  // Buy a 100 QNTM product (0s refund window so we can settle immediately).
  const { escrow: esc } = await marketplace.purchase({
    buyerOwnerId: buyerId, creatorOwnerId: creatorId, amount: '100',
    productRef: 'course_42', refundWindowSeconds: 0,
  });
  // escrow holds the 100
  assert.equal((await wallets.getWallet(esc.escrow_wallet_id)).available_balance, '100.000000000000000000');

  // Settle: 85 creator(pending) / 10 treasury / 5 burn
  const { shares } = await marketplace.settle(esc.id);
  assert.deepEqual(shares, { creator: '85', treasury: '10', burn: '5' });
  const creatorAfter = await wallets.getWallet(creatorW.id);
  assert.equal(creatorAfter.pending_balance, '85.000000000000000000');
  assert.equal(creatorAfter.available_balance, '0.000000000000000000');

  // Release creator pending -> available after dispute window
  await marketplace.releaseToCreator(creatorW.id, '85');
  const released = await wallets.getWallet(creatorW.id);
  assert.equal(released.pending_balance, '0.000000000000000000');
  assert.equal(released.available_balance, '85.000000000000000000');
});

test('subscription: charges and splits; insufficient funds -> past_due', async () => {
  const subId = uid('sub');
  const creatorId = uid('subcreator');
  await fund(subId, '60'); // enough for exactly one 50-token cycle

  const first = await subscriptions.createSubscription({
    subscriberUserId: subId, planId: 'pro', creatorOwnerId: creatorId, amount: '50', intervalDays: 30,
  });
  assert.equal(first.subscription.status, 'active');
  assert.ok(first.transaction);

  // Second charge should fail (only 10 left) -> past_due, no money moved
  const { rows } = await pool.query(`SELECT id FROM subscriptions WHERE subscriber_user_id=$1`, [subId]);
  const second = await subscriptions.charge(rows[0].id);
  assert.equal(second.failed, true);
  assert.equal(second.subscription.status, 'past_due');
  const subWallet = await wallets.getUserWallet(subId);
  assert.equal(subWallet.available_balance, '10.000000000000000000');
});

test('staking: lock reclassifies available->locked, unlock returns it', async () => {
  const sid = uid('staker');
  await fund(sid, '3000');
  const { stake, tier } = await staking.stake({ ownerId: sid, amount: '2000' });
  assert.equal(tier, 'Silver');
  let w = await wallets.getUserWallet(sid);
  assert.equal(w.available_balance, '1000.000000000000000000');
  assert.equal(w.locked_balance, '2000.000000000000000000');
  assert.equal(w.total_balance, '3000.000000000000000000'); // total unchanged

  await staking.requestUnstake(stake.id);
  // cooldown is in the future, completing now must fail
  await assert.rejects(staking.completeUnstake(stake.id), /cooldown/i);

  // fast-forward by clearing cooldown_until for the test
  await pool.query(`UPDATE stakes SET cooldown_until = now() - interval '1 day' WHERE id=$1`, [stake.id]);
  await staking.completeUnstake(stake.id);
  w = await wallets.getUserWallet(sid);
  assert.equal(w.available_balance, '3000.000000000000000000');
  assert.equal(w.locked_balance, '0.000000000000000000');
});

test('tournament: entries pool, settlement cannot overpay the pool', async () => {
  const tId = uid('tourney');
  const p1 = uid('p1'); const p2 = uid('p2'); const p3 = uid('p3');
  for (const p of [p1, p2, p3]) await fund(p, '100');
  await tournaments.join({ tournamentId: tId, ownerId: p1, entryFee: '50' });
  await tournaments.join({ tournamentId: tId, ownerId: p2, entryFee: '50' });
  await tournaments.join({ tournamentId: tId, ownerId: p3, entryFee: '50' });
  assert.equal(await tournaments.collectedPool(tId), '150.000000000000000000');

  // Overpay attempt must be rejected
  await assert.rejects(
    tournaments.settle({ tournamentId: tId, winners: [{ ownerId: p1, amount: '200' }] }),
    /equal collected pool/
  );

  // Valid: 120 to winner, 30 rake (20 treasury / 10 burn) = 150 exactly
  const res = await tournaments.settle({
    tournamentId: tId,
    winners: [{ ownerId: p1, amount: '120' }],
    rakeBps: { treasury: 1334, burn: 666 }, // ~20% of 150 = 30
  });
  assert.equal(res.pool, '150.000000000000000000');
  const winnerW = await wallets.getUserWallet(p1);
  // p1 started 100, paid 50 -> 50, won 120 -> 170
  assert.equal(winnerW.available_balance, '170.000000000000000000');
});

test('referral: self-referral blocked, duplicate is a no-op', async () => {
  const referrer = uid('referrer');
  const referee = uid('referee');
  await wallets.getOrCreateWallet('user', referrer, 'personal');
  await assert.rejects(
    referrals.rewardReferral({ referrerOwnerId: referrer, refereeUserId: referrer, amount: '10' }),
    /self-referral/
  );
  const t1 = await referrals.rewardReferral({ referrerOwnerId: referrer, refereeUserId: referee, amount: '10', action: 'signup' });
  const t2 = await referrals.rewardReferral({ referrerOwnerId: referrer, refereeUserId: referee, amount: '10', action: 'signup' });
  assert.equal(t1.id, t2.id); // idempotent — paid once
  const w = await wallets.getUserWallet(referrer);
  assert.equal(w.available_balance, '10.000000000000000000');
});

test('admin adjustment: two-person rule enforced; same approver rejected', async () => {
  const target = uid('adjtarget');
  const w = await fund(target, '100');
  const req = await adjustments.requestAdjustment({
    walletId: w.id, direction: 'credit', amount: '25', reason: 'goodwill credit', requestedBy: 'adminA',
  });
  // same person cannot approve their own request
  await assert.rejects(
    adjustments.approveAndExecute(req.id, { approverId: 'adminA' }),
    /two-person/i
  );
  // a different admin can
  const { transaction } = await adjustments.approveAndExecute(req.id, { approverId: 'adminB' });
  assert.ok(transaction);
  assert.equal((await wallets.getWallet(w.id)).available_balance, '125.000000000000000000');
});

test('global ledger integrity holds after all domain flows', async () => {
  const integ = await supply.verifyIntegrity();
  assert.equal(integ.ok, true, `offenders: ${JSON.stringify(integ.offenders)}`);
  const snap = await supply.snapshot();
  // conservation: every non-genesis token traces back to issuance
  assert.equal(snap.sumNonGenesis, snap.totalIssued);
});

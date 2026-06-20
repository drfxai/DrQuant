'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const decimal = require('../src/decimal');
const { pool } = require('../src/db');
const wallets = require('../src/wallets');
const bootstrap = require('../src/economy/bootstrap');
const { ensureQntmSchema, ensureEconomyWallets } = require('../src/economy/schema');
const phase1 = require('../src/economy/phase1');

const base = (s) => decimal.toBaseUnits(s);
const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function sysBal(type) {
  const id = await wallets.systemWalletId(type, 'QNTM');
  return base((await wallets.getWallet(id)).available_balance);
}
async function userBal(userId) {
  const w = await wallets.getUserWallet(userId, 'user', 'QNTM');
  return w ? base(w.available_balance) : 0n;
}

test.before(async () => {
  await ensureQntmSchema();
  await wallets.ensureSystemWallets('QNTM');
  await ensureEconomyWallets();
  // Idempotent across runs: if the test DB is already bootstrapped, carry on.
  try { await bootstrap.bootstrap({ actorId: 'phase1-test' }); }
  catch (e) { if (e.code !== 'already_bootstrapped') throw e; }
});
test.after(async () => { await pool.end(); });

test('admin grant debits the pool and credits the user', async () => {
  const user = 'u_grant_' + uniq();
  const amount = '1000';
  const poolBefore = await sysBal('reward_pool');
  const userBefore = await userBal(user);

  await phase1.grantFromPool({
    pool: 'reward_pool', toUserId: user, amount,
    actorId: 'admin-1', idempotencyKey: 'grant-' + uniq(),
  });

  assert.equal(await sysBal('reward_pool'), poolBefore - base(amount), 'pool debited by amount');
  assert.equal(await userBal(user), userBefore + base(amount), 'user credited by amount');
});

test('a grant never mints -- genesis (= -total issued) is unchanged', async () => {
  const gid = await wallets.systemWalletId('genesis', 'QNTM');
  const before = base((await wallets.getWallet(gid)).available_balance);
  await phase1.grantFromPool({
    pool: 'treasury', toUserId: 'u_' + uniq(), amount: '5',
    actorId: 'admin-1', idempotencyKey: 'grant-' + uniq(),
  });
  const after = base((await wallets.getWallet(gid)).available_balance);
  assert.equal(after, before, 'no new supply was issued');
});

test('grant from a non-grantable pool is rejected', async () => {
  await assert.rejects(
    () => phase1.grantFromPool({ pool: 'burn', toUserId: 'u_' + uniq(), amount: '1', actorId: 'a' }),
    /pool must be one of/i);
});

test('grant cannot overdraw a pool', async () => {
  await assert.rejects(
    () => phase1.grantFromPool({
      pool: 'community_reserve', toUserId: 'u_' + uniq(), amount: '999999999999',
      actorId: 'a', idempotencyKey: 'grant-' + uniq(),
    }),
    /insufficient|negative|check/i);
});

test('marketplace payment splits 70/20/10 atomically and conserves', async () => {
  const buyer = 'u_buyer_' + uniq();
  const creator = 'u_creator_' + uniq();
  await phase1.grantFromPool({
    pool: 'reward_pool', toUserId: buyer, amount: '1000',
    actorId: 'admin-1', idempotencyKey: 'grant-' + uniq(),
  });

  const buyerBefore = await userBal(buyer);
  const creatorBefore = await userBal(creator);
  const treasBefore = await sysBal('treasury');
  const rewardBefore = await sysBal('reward_pool');

  const { split } = await phase1.marketplacePay({
    buyerUserId: buyer, creatorUserId: creator, amount: '100',
    productRef: 'prod_1', idempotencyKey: 'mkt-' + uniq(),
  });

  assert.equal(split.creator, '70');
  assert.equal(split.platform, '20');
  assert.equal(split.reward, '10');
  assert.equal(await userBal(buyer), buyerBefore - base('100'), 'buyer debited full amount');
  assert.equal(await userBal(creator), creatorBefore + base('70'), 'creator +70%');
  assert.equal(await sysBal('treasury'), treasBefore + base('20'), 'platform +20%');
  assert.equal(await sysBal('reward_pool'), rewardBefore + base('10'), 'reward +10%');
});

test('marketplace split is lossless on an indivisible amount', async () => {
  const buyer = 'u_buyer_' + uniq();
  const creator = 'u_creator_' + uniq();
  await phase1.grantFromPool({
    pool: 'reward_pool', toUserId: buyer, amount: '1',
    actorId: 'admin-1', idempotencyKey: 'grant-' + uniq(),
  });
  // 7 base units: platform 20% -> 1, reward 10% -> 0, creator remainder -> 6.
  const amount = '0.000000000000000007';
  const { split } = await phase1.marketplacePay({
    buyerUserId: buyer, creatorUserId: creator, amount, idempotencyKey: 'mkt-' + uniq(),
  });
  assert.equal(
    base(split.creator) + base(split.platform) + base(split.reward),
    base(amount), 'split sums exactly to the amount (no base unit lost)');
});

test('cannot pay yourself in the marketplace', async () => {
  await assert.rejects(
    () => phase1.marketplacePay({
      buyerUserId: 'u_self', creatorUserId: 'u_self', amount: '1', idempotencyKey: 'mkt-' + uniq(),
    }),
    /yourself/i);
});

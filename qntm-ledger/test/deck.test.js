'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const decimal = require('../src/decimal');
const { pool } = require('../src/db');
const wallets = require('../src/wallets');
const treasury = require('../src/treasury');
const { spend } = require('../src/spend');
const { tip } = require('../src/tip');
const orders = require('../src/payments/orders');
const deck = require('../src/deck');

const base = (s) => decimal.toBaseUnits(s);
let seq = 0;
const uid = (p) => `${p}_${Date.now()}_${seq++}`;

const userA = uid('A');
const userB = uid('B');
const adminId = uid('admin');

test.before(async () => {
  await wallets.ensureSystemWallets('QNTM');
  await orders.ensurePaymentWallets('QNTM');
  await treasury.mint('1000', { actorId: 'boot', reason: 'deck test mint' });
  const wa = await wallets.getOrCreateWallet('user', userA, 'personal');
  await wallets.getOrCreateWallet('user', userB, 'personal');
  await treasury.grant(wa.id, '100', { actorId: 'boot', reason: 'fund A' });
  await spend({ userOwnerId: userA, amount: '30', reason: 'feature' });
  await tip({ fromOwnerId: userA, toOwnerId: userB, amount: '20', note: 'gg' });
  const aw = await deck.getOrCreateAdminWallet(adminId);
  await treasury.grant(aw.id, '40', { actorId: adminId, reason: 'fund admin wallet' });
});
test.after(async () => { await pool.end(); });

test('dashboard reports issued/treasury/user totals and passes integrity', async () => {
  const d = await deck.dashboard({ recent: 20 });
  assert.equal(base(d.totalIssued), base('1000'));          // genesis = -(issued)
  assert.equal(base(d.treasuryBalance), base('860'));       // 1000 - 100 - 40
  assert.equal(base(d.userBalanceTotal), base('70'));       // A:50 + B:20 (admin excluded)
  assert.equal(base(d.revenueBalance), base('30'));
  assert.equal(d.integrity.ok, true);
  assert.ok(d.recentTransactions.length >= 5);              // mint, grant, spend, tip, admin-grant
  assert.deepEqual(d.recentPaymentOrders, []);              // none created in this suite
});

test('ledger explorer filters by type and by wallet, and can attach entries', async () => {
  const tips = await deck.ledgerExplorer({ type: 'tip', withEntries: true });
  assert.equal(tips.length, 1);
  assert.equal(tips[0].entries.length, 2);                  // debit sender, credit receiver

  const wa = await wallets.getUserWallet(userA);
  const involvingA = await deck.ledgerExplorer({ walletId: wa.id });
  const types = involvingA.map((t) => t.type).sort();
  assert.deepEqual(types, ['reward', 'spend', 'tip']);      // grant posts as 'reward'; all three touch A's wallet
});

test('transaction detail returns balanced double-entry lines', async () => {
  const tips = await deck.ledgerExplorer({ type: 'tip' });
  const detail = await deck.transactionDetail(tips[0].public_id);
  assert.equal(detail.entries.length, 2);
  const net = detail.entries.reduce((acc, e) =>
    acc + (e.direction === 'credit' ? base(e.amount) : -base(e.amount)), 0n);
  assert.equal(net, 0n);
});

test('user inspector returns the wallet, its transactions and a breakdown', async () => {
  const insp = await deck.userInspector({ userId: userA });
  assert.equal(base(insp.wallet.available_balance), base('50'));   // 100 - 30 - 20
  assert.equal(insp.transactions.length, 3);
  assert.ok(insp.breakdown.length >= 1);

  const missing = await deck.userInspector({ userId: uid('nobody') });
  assert.equal(missing.wallet, null);
  assert.deepEqual(missing.transactions, []);
});

test('admin personal wallet exists, is funded, and shows its history', async () => {
  const hist = await deck.adminWalletHistory(adminId);
  assert.equal(hist.wallet.owner_type, 'admin');
  assert.equal(base(hist.wallet.available_balance), base('40'));
  assert.equal(hist.transactions.length, 1);
  assert.equal(hist.transactions[0].direction, 'credit');
});

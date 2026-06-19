'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const decimal = require('../src/decimal');
const { pool } = require('../src/db');
const wallets = require('../src/wallets');
const { postTransaction } = require('../src/ledger');
const cfg = require('../src/economy/token.config');
const { ensureQntmSchema, ensureEconomyWallets } = require('../src/economy/schema');
const bootstrap = require('../src/economy/bootstrap');

const base = (s) => decimal.toBaseUnits(s);

test.before(async () => {
  await ensureQntmSchema();          // applies 001/002 if absent, then 003
  await wallets.ensureSystemWallets('QNTM');
  await ensureEconomyWallets();
});
test.after(async () => { await pool.end(); });

test('the five allocations sum to exactly the fixed supply', () => {
  const sum = cfg.ALLOCATIONS.reduce((acc, a) => acc + BigInt(a.amount), 0n);
  assert.equal(sum, BigInt(cfg.TOTAL_SUPPLY));
  assert.equal(cfg.TOTAL_SUPPLY, '1000000000');
});

test('6-decimal facade maps to integer base units without floats', () => {
  assert.equal(cfg.toBase6('250000000'), '250000000000000');   // 250M QNTM * 1e6
  assert.equal(cfg.toBase6('1.5'), '1500000');
  assert.equal(cfg.fromBase6('250000000000000'), '250000000.000000');
  assert.equal(cfg.toQntm6('200000000.000000000000000000'), '200000000.000000');
});

test('bootstrap allocates the exact buckets and conserves supply', async () => {
  await bootstrap.bootstrap({ actorId: 'test' });

  for (const a of cfg.ALLOCATIONS) {
    const id = await wallets.systemWalletId(a.walletType, 'QNTM');
    const w = await wallets.getWallet(id);
    assert.equal(base(w.available_balance), base(a.amount), a.code + ' balance');
  }

  const gid = await wallets.systemWalletId('genesis', 'QNTM');
  const g = await wallets.getWallet(gid);
  assert.equal(base(g.available_balance), -base(cfg.TOTAL_SUPPLY));   // genesis holds -(supply)

  let sum = 0n;
  for (const a of cfg.ALLOCATIONS) {
    const id = await wallets.systemWalletId(a.walletType, 'QNTM');
    const w = await wallets.getWallet(id);
    sum += base(w.available_balance);
  }
  assert.equal(sum, base(cfg.TOTAL_SUPPLY));
});

test('bootstrap cannot run twice', async () => {
  assert.equal(await bootstrap.isBootstrapped(), true);
  await assert.rejects(() => bootstrap.bootstrap({ actorId: 'test' }), /already bootstrapped/i);

  const tid = await wallets.systemWalletId('treasury', 'QNTM');
  const t = await wallets.getWallet(tid);
  assert.equal(base(t.available_balance), base('250000000'));        // unchanged
});

test('every bootstrap mutation created a balanced ledger transaction', async () => {
  const { rows } = await pool.query(
    "SELECT id FROM transactions WHERE reference_type = 'qntm_bootstrap' ORDER BY id");
  assert.equal(rows.length, 5);   // 1 mint + 4 allocation transfers
  for (const r of rows) {
    const { rows: entries } = await pool.query(
      'SELECT signed_amount FROM ledger_entries WHERE transaction_id = $1', [r.id]);
    assert.ok(entries.length >= 2);
    const net = entries.reduce((acc, e) => acc + base(e.signed_amount), 0n);
    assert.equal(net, 0n);
  }
});

test('transfers cannot push a bucket negative', async () => {
  const from = await wallets.systemWalletId('community_reserve', 'QNTM'); // holds 50M
  const to = await wallets.systemWalletId('treasury', 'QNTM');
  await assert.rejects(
    () => wallets.withTransaction((cx) => postTransaction({
      type: 'transfer',
      amount: '60000000', // more than the 50M it holds
      movements: [
        { walletId: from, direction: 'debit',  amount: '60000000', description: 'overdraw attempt' },
        { walletId: to,   direction: 'credit', amount: '60000000', description: 'overdraw attempt' },
      ],
      reference: { type: 'test', id: null },
      metadata: {},
    }, cx)),
    /insufficient|negative|check/i);
});

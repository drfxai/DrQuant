'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db');
const wallets = require('../src/wallets');
const { postTransaction, reverseTransaction } = require('../src/ledger');
const treasury = require('../src/treasury');

let uidSeq = 0;
const uid = (p) => `${p}_${Date.now()}_${uidSeq++}`;

test.before(async () => {
  await wallets.ensureSystemWallets('QNTM');
  // Issue a known supply into treasury so funded flows have a source.
  await treasury.mint('1000000', { actorId: 'test-admin', reason: 'test genesis' });
});

test.after(async () => { await pool.end(); });

async function fundUser(ownerId, amount) {
  const w = await wallets.getOrCreateWallet('user', ownerId, 'personal');
  await treasury.grant(w.id, amount, { actorId: 'test-admin', reason: 'fund test user' });
  return w;
}

test('a simple transfer moves value and balances stay exact', async () => {
  const a = await fundUser(uid('a'), '500');
  const b = await wallets.getOrCreateWallet('user', uid('b'), 'personal');
  await postTransaction({
    type: 'transfer',
    movements: [
      { walletId: a.id, direction: 'debit', amount: '100' },
      { walletId: b.id, direction: 'credit', amount: '100' },
    ],
  });
  const aAfter = await wallets.getWallet(a.id);
  const bAfter = await wallets.getWallet(b.id);
  assert.equal(aAfter.available_balance, '400.000000000000000000');
  assert.equal(bAfter.available_balance, '100.000000000000000000');
});

test('overdraft is rejected and the whole transaction rolls back', async () => {
  const a = await fundUser(uid('od'), '50');
  const b = await wallets.getOrCreateWallet('user', uid('od2'), 'personal');
  await assert.rejects(
    postTransaction({
      type: 'transfer',
      movements: [
        { walletId: a.id, direction: 'debit', amount: '1000' },
        { walletId: b.id, direction: 'credit', amount: '1000' },
      ],
    }),
    (e) => e.code === 'insufficient_funds'
  );
  // sender untouched, receiver never credited — atomic rollback
  assert.equal((await wallets.getWallet(a.id)).available_balance, '50.000000000000000000');
  assert.equal((await wallets.getWallet(b.id)).available_balance, '0.000000000000000000');
});

test('the database rejects an unbalanced transaction even if app checks were bypassed', async () => {
  // Hand-craft entries that do NOT net to zero, bypassing validateMovements,
  // to prove the DEFERRED constraint trigger is a true backstop.
  const a = await fundUser(uid('ub'), '500');
  const b = await wallets.getOrCreateWallet('user', uid('ub2'), 'personal');
  const client = await pool.connect();
  let threw = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO transactions (type, status, amount) VALUES ('transfer','completed','100') RETURNING id`
    );
    const txnId = rows[0].id;
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_kind)
       VALUES ($1,$2,'debit','100','available')`, [txnId, a.id]);
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_kind)
       VALUES ($1,$2,'credit','90','available')`, [txnId, b.id]); // <-- 10 short
    await client.query('COMMIT'); // deferred constraint fires here
  } catch (err) {
    threw = err;
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  assert.ok(threw, 'commit should have failed');
  assert.match(threw.message, /unbalanced|nets to/i);
});

test('idempotency key makes a retried transfer a no-op', async () => {
  const a = await fundUser(uid('idem'), '500');
  const b = await wallets.getOrCreateWallet('user', uid('idem2'), 'personal');
  const key = uid('key');
  const mv = () => ([
    { walletId: a.id, direction: 'debit', amount: '70' },
    { walletId: b.id, direction: 'credit', amount: '70' },
  ]);
  const t1 = await postTransaction({ type: 'transfer', movements: mv(), idempotencyKey: key });
  const t2 = await postTransaction({ type: 'transfer', movements: mv(), idempotencyKey: key });
  assert.equal(t1.id, t2.id, 'same transaction returned');
  // balance moved exactly once
  assert.equal((await wallets.getWallet(a.id)).available_balance, '430.000000000000000000');
  assert.equal((await wallets.getWallet(b.id)).available_balance, '70.000000000000000000');
});

test('ledger entries are append-only (UPDATE and DELETE rejected)', async () => {
  const a = await fundUser(uid('ap'), '100');
  const b = await wallets.getOrCreateWallet('user', uid('ap2'), 'personal');
  await postTransaction({
    type: 'transfer',
    movements: [
      { walletId: a.id, direction: 'debit', amount: '10' },
      { walletId: b.id, direction: 'credit', amount: '10' },
    ],
  });
  await assert.rejects(
    pool.query(`UPDATE ledger_entries SET amount = '999' WHERE wallet_id = $1`, [a.id]),
    /append-only/
  );
  await assert.rejects(
    pool.query(`DELETE FROM ledger_entries WHERE wallet_id = $1`, [a.id]),
    /append-only/
  );
});

test('reversal restores balances and marks the original reversed', async () => {
  const a = await fundUser(uid('rev'), '300');
  const b = await wallets.getOrCreateWallet('user', uid('rev2'), 'personal');
  const t = await postTransaction({
    type: 'transfer',
    movements: [
      { walletId: a.id, direction: 'debit', amount: '120' },
      { walletId: b.id, direction: 'credit', amount: '120' },
    ],
  });
  await reverseTransaction(t.id, { reason: 'test', actorId: 'admin' });
  assert.equal((await wallets.getWallet(a.id)).available_balance, '300.000000000000000000');
  assert.equal((await wallets.getWallet(b.id)).available_balance, '0.000000000000000000');
  const { rows } = await pool.query(`SELECT status FROM transactions WHERE id = $1`, [t.id]);
  assert.equal(rows[0].status, 'reversed');
});

test('concurrent debits of the same wallet cannot overspend (row lock holds)', async () => {
  const a = await fundUser(uid('cc'), '100');
  const sink1 = await wallets.getOrCreateWallet('user', uid('s1'), 'personal');
  const sink2 = await wallets.getOrCreateWallet('user', uid('s2'), 'personal');
  // Two parallel 60-token debits from a 100-token wallet: exactly one must win.
  const results = await Promise.allSettled([
    postTransaction({ type: 'transfer', movements: [
      { walletId: a.id, direction: 'debit', amount: '60' },
      { walletId: sink1.id, direction: 'credit', amount: '60' }]}),
    postTransaction({ type: 'transfer', movements: [
      { walletId: a.id, direction: 'debit', amount: '60' },
      { walletId: sink2.id, direction: 'credit', amount: '60' }]}),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;
  assert.equal(ok, 1, 'exactly one debit should succeed');
  assert.equal(failed, 1, 'the other must be rejected for insufficient funds');
  assert.equal((await wallets.getWallet(a.id)).available_balance, '40.000000000000000000');
});

test('total issued supply equals -(genesis balance) and conservation holds', async () => {
  const stats = await treasury.supplySummary();
  // Everything that exists was issued from genesis; the contra balance mirrors it.
  assert.equal(stats.totalIssued, stats.negGenesis);
  // Sum of all non-genesis balances must equal total issued (nothing leaks).
  assert.equal(stats.sumNonGenesis, stats.totalIssued);
});

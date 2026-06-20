'use strict';
/**
 * Initial QNTM airdrop — one-time distribution funded from the reward_pool bucket.
 *
 *   node scripts/airdrop-initial-qntm.js            # DRY RUN (default) — reports only
 *   node scripts/airdrop-initial-qntm.js --execute  # actually grants
 *
 * Requires DATABASE_URL (same convention as the app). Every grant DEBITS the
 * reward_pool system wallet and CREDITS the user — it never mints, so the fixed
 * 1,000,000,000 QNTM supply is conserved. Safe to re-run: each account has a
 * stable idempotency key `initial-airdrop:<userId>`, so an interrupted run
 * resumes and never double-grants.
 *
 * TIERS — highest applicable wins, exactly ONE grant per account (which is why a
 * single per-user idempotency key is correct):
 *     creator  (users.is_creator = TRUE) .................. 1000 QNTM
 *     pro      (active, unexpired subscription) ...........  500 QNTM
 *     early    (every other existing non-bot account) .....  100 QNTM
 *
 * "early" means everyone who already exists when the airdrop runs. To instead
 * restrict the base grant to accounts created before a date, set
 * AIRDROP_EARLY_BEFORE to an ISO timestamp (pro/creator still qualify regardless
 * of that date). Tier amounts are configurable in AMOUNT below.
 *
 * Transaction type: initial_qntm_airdrop (added to the txn_type enum here,
 * idempotently, before any grant is posted).
 */
require('dotenv').config();

const EXECUTE = process.argv.includes('--execute');
const AIRDROP_VERSION = '1';
const FUNDING_POOL = 'reward_pool';
const TXN_TYPE = 'initial_qntm_airdrop';
const KEY_PREFIX = 'initial-airdrop:';

// Tier amounts as exact decimal STRINGS (never JS numbers — the ledger refuses
// floats). Retune the distribution here.
const AMOUNT = { creator: '1000', pro: '500', early: '100' };

// Optional: restrict the base 'early' grant to accounts created before this ISO
// timestamp. Unset => every existing non-bot account qualifies for 'early'.
const EARLY_BEFORE = process.env.AIRDROP_EARLY_BEFORE || null;

// Pretty-print a decimal string with thousands separators, up to 6 dp.
function fmt(s) {
  s = String(s == null ? '0' : s);
  const neg = s[0] === '-';
  if (neg) s = s.slice(1);
  const parts = s.split('.');
  const int = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (parts[1] || '').replace(/0+$/, '').slice(0, 6);
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(2);
  }

  let setupQntmSchema, pool, postTransaction, wallets, decimal;
  try {
    ({ setupQntmSchema } = require('../qntm-ledger/integrate'));
    ({ pool } = require('../qntm-ledger/src/db'));
    ({ postTransaction } = require('../qntm-ledger/src/ledger'));
    wallets = require('../qntm-ledger/src/wallets');
    decimal = require('../qntm-ledger/src/decimal');
  } catch (e) {
    console.error('Failed to load QNTM modules:', e.message);
    process.exit(1);
  }

  const line = (n = 64) => console.log('-'.repeat(n));

  try {
    console.log('QNTM initial airdrop — ' + (EXECUTE ? 'EXECUTE' : 'DRY RUN') + '\n');

    // 1) Ensure ledger schema + system/allocation wallets exist (idempotent).
    await setupQntmSchema();

    // 2) Ensure the airdrop transaction type exists. ALTER TYPE ... ADD VALUE
    //    commits on its own and cannot share a transaction with later use of the
    //    value, so it must run up front. IF NOT EXISTS makes re-runs safe.
    await pool.query("ALTER TYPE txn_type ADD VALUE IF NOT EXISTS '" + TXN_TYPE + "'");

    // 3) Probe optional columns so the script is robust to migration state.
    const columnExists = async (table, column) =>
      (await pool.query(
        'SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2',
        [table, column]
      )).rowCount > 0;

    if (!(await columnExists('users', 'is_creator'))) {
      console.error('users.is_creator is missing — apply migration 003 (Market) first.');
      process.exit(1);
    }
    const hasDeletedAt = await columnExists('users', 'deleted_at');
    const notDeleted = hasDeletedAt ? 'AND u.deleted_at IS NULL' : '';

    // 4) Classify every eligible account into exactly one tier (highest wins).
    //    All fragments below are built from constants; the only runtime value
    //    (EARLY_BEFORE) is passed as a bound parameter.
    const proPred =
      "u.subscription_status='active' AND (u.subscription_expiry IS NULL OR u.subscription_expiry > now())";
    const earlyPred = EARLY_BEFORE ? 'u.created_at < $1' : 'TRUE';
    const params = EARLY_BEFORE ? [EARLY_BEFORE] : [];
    const catExpr =
      "CASE WHEN u.is_creator THEN 'creator' " +
      'WHEN ' + proPred + " THEN 'pro' " +
      'WHEN ' + earlyPred + " THEN 'early' " +
      "ELSE 'none' END";

    const { rows: eligible } = await pool.query(
      'SELECT s.id, s.username, s.email, s.category FROM (' +
      '  SELECT u.id, u.username, u.email, ' + catExpr + ' AS category' +
      "  FROM users u WHERE u.role <> 'bot' " + notDeleted +
      ") s WHERE s.category <> 'none' ORDER BY s.id",
      params
    );

    // 5) Which accounts were already airdropped (resume-safe accounting).
    const { rows: doneRows } = await pool.query(
      'SELECT idempotency_key FROM transactions WHERE idempotency_key LIKE $1',
      [KEY_PREFIX + '%']
    );
    const done = new Set(doneRows.map((r) => r.idempotency_key.slice(KEY_PREFIX.length)));

    // 6) Tally full totals and the remaining (not-yet-granted) work.
    const totalBy = { creator: 0, pro: 0, early: 0 };
    const pendingBy = { creator: 0, pro: 0, early: 0 };
    let totalReq = '0';
    let pendingReq = '0';
    const pending = [];
    for (const u of eligible) {
      totalBy[u.category] += 1;
      totalReq = decimal.add(totalReq, AMOUNT[u.category]);
      if (done.has(String(u.id))) continue;
      pendingBy[u.category] += 1;
      pendingReq = decimal.add(pendingReq, AMOUNT[u.category]);
      pending.push(u);
    }

    // 7) reward_pool balance + projection.
    const poolId = await wallets.systemWalletId(FUNDING_POOL, 'QNTM');
    const poolBalance = (await wallets.getWallet(poolId)).available_balance;
    const projected = decimal.sub(poolBalance, pendingReq);

    // 8) Report.
    line();
    console.log('Eligible accounts (one grant each, highest tier wins)');
    console.log('  creator x ' + fmt(AMOUNT.creator) + ' : ' + totalBy.creator + ' (pending ' + pendingBy.creator + ')');
    console.log('  pro     x ' + fmt(AMOUNT.pro) + '  : ' + totalBy.pro + ' (pending ' + pendingBy.pro + ')');
    console.log('  early   x ' + fmt(AMOUNT.early) + '  : ' + totalBy.early + ' (pending ' + pendingBy.early + ')');
    console.log('  ------');
    console.log('  total eligible accounts : ' + eligible.length);
    console.log('  already airdropped      : ' + (eligible.length - pending.length));
    console.log('  to grant this run       : ' + pending.length);
    line();
    console.log('QNTM required');
    console.log('  full distribution       : ' + fmt(totalReq) + ' QNTM');
    console.log('  remaining this run      : ' + fmt(pendingReq) + ' QNTM');
    line();
    console.log('reward_pool funding');
    console.log('  balance before          : ' + fmt(poolBalance) + ' QNTM');
    console.log('  balance after (projected): ' + fmt(projected) + ' QNTM');
    line();

    const sample = pending.slice(0, 10);
    if (sample.length) {
      console.log('Sample recipients (first ' + sample.length + ' of ' + pending.length + '):');
      for (const u of sample) {
        const who = u.username ? '@' + u.username : (u.email || ('user#' + u.id));
        console.log('  #' + u.id + '  ' + String(u.category).padEnd(7) + '  ' + fmt(AMOUNT[u.category]) + ' QNTM  ' + who);
      }
    } else {
      console.log('Nothing pending — every eligible account is already airdropped.');
    }
    line();

    // 9) Abort if the remaining work exceeds available reward_pool balance.
    if (decimal.cmp(pendingReq, poolBalance) > 0) {
      console.error(
        'ABORT: reward_pool has ' + fmt(poolBalance) + ' QNTM but ' +
        fmt(pendingReq) + ' QNTM is required. Top up reward_pool or lower the tier amounts.'
      );
      process.exit(1);
    }

    if (pending.length === 0) {
      console.log('Nothing to do.');
      process.exit(0);
    }

    if (!EXECUTE) {
      console.log('DRY RUN complete — no changes written. Re-run with --execute to grant.');
      process.exit(0);
    }

    // 10) Execute: one atomic, idempotent grant per account.
    console.log('Granting ' + pending.length + ' airdrops from ' + FUNDING_POOL + '...');
    let granted = 0;
    let skipped = 0;
    let failed = 0;
    for (const u of pending) {
      const key = KEY_PREFIX + u.id;
      const amount = AMOUNT[u.category];
      try {
        await wallets.withTransaction(async (cx) => {
          // Defensive re-check inside the transaction. postTransaction is also
          // idempotent on the key, so this is belt-and-suspenders.
          const seen = await cx.query('SELECT 1 FROM transactions WHERE idempotency_key=$1', [key]);
          if (seen.rowCount) { skipped += 1; return; }
          const fromId = await wallets.systemWalletId(FUNDING_POOL, 'QNTM', cx);
          const to = await wallets.getOrCreateWallet('user', u.id, 'personal', 'QNTM', cx);
          await postTransaction({
            type: TXN_TYPE,
            amount,
            movements: [
              { walletId: fromId, direction: 'debit', amount, description: 'initial airdrop (' + u.category + ')' },
              { walletId: to.id, direction: 'credit', amount, description: 'initial QNTM airdrop' },
            ],
            initiatorUserId: 'cli:initial-airdrop',
            reference: { type: 'airdrop', id: u.id },
            idempotencyKey: key,
            metadata: {
              source: 'initial_airdrop',
              fundingPool: FUNDING_POOL,
              airdropVersion: AIRDROP_VERSION,
              category: u.category,
              amount,
              idempotencyKey: key,
            },
          }, cx);
          granted += 1;
        });
      } catch (e) {
        failed += 1;
        console.error('  FAILED user #' + u.id + ' (' + u.category + '): ' + e.message);
      }
      const processed = granted + skipped + failed;
      if (processed % 100 === 0) console.log('  ...' + processed + '/' + pending.length);
    }

    line();
    console.log('Airdrop finished: granted=' + granted + ' skipped=' + skipped + ' failed=' + failed);

    // 11) Verification.
    const { rows: vr } = await pool.query(
      "SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::text AS total FROM transactions WHERE type=$1",
      [TXN_TYPE]
    );
    const { rows: dup } = await pool.query(
      'SELECT idempotency_key, COUNT(*) AS c FROM transactions ' +
      'WHERE idempotency_key LIKE $1 GROUP BY idempotency_key HAVING COUNT(*) > 1',
      [KEY_PREFIX + '%']
    );
    const poolAfter = (await wallets.getWallet(poolId)).available_balance;
    console.log('Verification');
    console.log('  airdrop transactions  : ' + vr[0].n + ' totalling ' + fmt(vr[0].total) + ' QNTM');
    console.log('  duplicate grants      : ' + dup.length + ' (must be 0)');
    console.log('  reward_pool balance   : ' + fmt(poolAfter) + ' QNTM');
    line();

    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error('Airdrop failed:', e.message);
    process.exit(1);
  }
})();

# QNTM Ledger Engine

An off-chain, double-entry token ledger for the DrFX Quant platform. It tracks
balances and moves an **internal, non-redeemable** credit (`QNTM`) between users,
creators, and platform accounts with bank-grade integrity guarantees.

> **Read `COMPLIANCE.md` first.** QNTM is issued, never sold, and cannot be
> cashed out. The on/off-ramp is intentionally disabled.

## Why it's safe to build on

Every unit of value moves through one function — `ledger.postTransaction` — and
the database itself enforces the invariants, so a bug in a feature module cannot
corrupt balances:

- **No floating point.** Amounts are decimal strings; arithmetic happens in SQL
  `NUMERIC(36,18)` or via a BigInt fixed-point helper (`decimal.js`). The
  classic `0.1 + 0.2` error is impossible.
- **Double-entry, DB-enforced.** Every transaction's entries must net to zero
  per currency — checked in app code *and* by a deferred constraint trigger at
  COMMIT.
- **No negative balances.** A trigger rejects any debit that would overdraw
  (the lone exception is the `genesis` contra-account).
- **Atomic + isolated.** Each transaction runs in one DB transaction with the
  affected wallet rows `SELECT … FOR UPDATE` locked, so concurrent spends can't
  double-spend.
- **Append-only ledger + audit.** `ledger_entries` and `audit_log` reject
  UPDATE/DELETE. Corrections happen via reversals and two-person adjustments,
  never edits.
- **Idempotent.** Pass an `idempotency_key` (or an `Idempotency-Key` header) and
  retries are no-ops.

## Layout

```
qntm-ledger/
  sql/001_init.sql        schema: wallets, transactions, ledger_entries + triggers
  src/
    decimal.js            BigInt fixed-point money math (dependency-free)
    db.js                 pg pool + withTransaction()
    ledger.js             postTransaction() / reverseTransaction()  ← the core
    wallets.js            wallet provisioning, system wallets, row locking
    treasury.js           mint / grant / supply accounting (only origin of QNTM)
    transfers.js  burn.js  escrow.js  marketplace.js  creators.js
    rewards.js  referrals.js  subscriptions.js  ai.js  tournaments.js  staking.js
    fees.js               exact basis-point split
    adjustments.js        two-person admin corrections
    risk.js  ratelimit.js  audit.js  supply.js  events.js  errors.js
    routes/               Express routers (+ disabled bridge stubs)
  test/                   decimal, ledger (invariants), domain (end-to-end)
```

## Integrate into the DrFX Quant server

1. **Migrate** (uses the same Postgres as the rest of the app):
   ```bash
   psql "$DATABASE_URL" -f qntm-ledger/sql/001_init.sql
   ```

2. **Bootstrap system wallets at boot** (idempotent):
   ```js
   const { ensureSystemWallets } = require('./qntm-ledger/src/wallets');
   await ensureSystemWallets('QNTM');
   ```

3. **Mount the API** after your JWT/RBAC middleware has populated
   `req.user = { id, role }`:
   ```js
   const { mountQntm } = require('./qntm-ledger/src/routes');
   mountQntm(app, { basePath: '/api/qntm' });
   ```
   Replace the auth shims in `src/routes/_helpers.js` with the platform's real
   `requireAuth` / `requireRole` (the DB-backed RBAC you already have).

4. **Bridge events into Socket.io / notifications** (optional but recommended):
   ```js
   const { events } = require('./qntm-ledger/src/events');
   events.on('marketplace.purchase.completed', (e) => io.to(e.buyerId).emit('qntm', e));
   events.on('subscription.payment_failed', (e) => notify(e));
   // ...any 'ledger.*', 'creator.*', 'staking.*', 'tournament.*', 'risk.*'
   ```

5. **Schedule the settlement/renewal workers** (cron or a simple interval):
   ```js
   // settle escrows past their refund window
   for (const esc of await require('./qntm-ledger/src/escrow').dueForSettlement())
     await require('./qntm-ledger/src/marketplace').settle(esc.id);
   // charge subscriptions whose period ended
   for (const sub of await require('./qntm-ledger/src/subscriptions').dueForRenewal())
     await require('./qntm-ledger/src/subscriptions').charge(sub.id);
   ```

## Issuing supply

There is no purchase flow. To bring QNTM into existence, an admin mints it (this
is where the supply numbers you decide on are applied):

```
POST /api/qntm/admin/mint   { "amount": "100000000", "reason": "initial supply" }
POST /api/qntm/admin/grant  { "userId": "...", "amount": "500", "reason": "airdrop" }
POST /api/qntm/admin/reward-pool/fund { "amount": "1000000" }
```

Set `QNTM_MAX_SUPPLY` to enforce a hard cap.

## Environment

| Var | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection | — (required) |
| `QNTM_MAX_SUPPLY` | hard mint cap (decimal string) | uncapped |
| `QNTM_SUB_MAX_ATTEMPTS` | failed charges before a sub is cancelled | 3 |
| `QNTM_STAKE_COOLDOWN_DAYS` | unstake cooldown | 7 |
| `QNTM_DB_POOL_MAX` | pg pool size | 10 |

## Tests

```bash
DATABASE_URL="postgresql://user@host/db" node --test test/
```

- `decimal.test.js` — money math is exact (incl. the `0.1 + 0.2` trap).
- `ledger.test.js` — invariants against real Postgres: overdraft rollback,
  DB-level rejection of an unbalanced transaction, idempotency, append-only,
  reversal, concurrent-spend safety, supply conservation.
- `domain.test.js` — end-to-end: marketplace, subscriptions+dunning, staking,
  tournaments, referrals, two-person adjustments, global integrity.

## Operational notes

- The in-process rate limiter (`ratelimit.js`) is per-node; back it with Redis
  for the multi-node PM2 deployment so limits are shared.
- `risk.js` is a policy hook, not a full fraud engine — plug real scoring in
  there.
- Money never leaves the system: there is no withdrawal. See `COMPLIANCE.md`.

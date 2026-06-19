# QNTM Economic Layer -- Phase 1

Internal-ledger foundation for QNTM: fixed supply, five allocation buckets, a
one-time bootstrap, and read-only admin endpoints. Built on the existing
qntm-ledger engine (double-entry, conservation-enforced). See COMPLIANCE.md for
what QNTM is and is not.

## Token

- Symbol QNTM, name "Quantum Network Token".
- Fixed supply 1,000,000,000 QNTM (enforced by `QNTM_MAX_SUPPLY`).
- 6-decimal facade over the 18-decimal ledger: 1 QNTM = 1,000,000 base units.
  Config + helpers in `src/economy/token.config.js` (`toQntm6`, `toBase6`,
  `fromBase6`). API responses carry both a 6-dp QNTM string and the integer
  base-unit string.

## Allocation (Dubai Edition)

| Account code | wallet_type | QNTM |
|---|---|---|
| QNTM_TREASURY | treasury | 250,000,000 |
| QNTM_REWARD_GROWTH_POOL | reward_pool | 350,000,000 |
| QNTM_ECOSYSTEM_STRATEGIC | ecosystem | 150,000,000 |
| QNTM_TEAM_FOUNDERS_VESTING | team_vesting | 200,000,000 |
| QNTM_COMMUNITY_RESERVE | community_reserve | 50,000,000 |

`treasury` and `reward_pool` already exist in the engine; the other three
wallet_type values are added by migration 003.

## Bootstrap

One atomic transaction (`src/economy/bootstrap.js`):

1. advisory lock + `isBootstrapped()` guard + per-event idempotency keys,
2. mint the full supply genesis -> treasury (`initial_mint_v1`),
3. transfer the four non-treasury buckets out of treasury
   (`allocate_reward_growth_v1`, `allocate_ecosystem_strategic_v1`,
   `allocate_team_vesting_v1`, `allocate_community_reserve_v1`); treasury keeps
   its 250M residual (`allocate_treasury_v1`, recorded in the audit log),
4. set `BOOTSTRAP_COMPLETED_V1` and write `bootstrap_completed_v1`.

After bootstrap: genesis = -1,000,000,000; the five buckets sum to
1,000,000,000; `QNTM_MAX_SUPPLY` blocks any further mint.

Run it once:

- API: `POST /api/qntm/admin/bootstrap` (admin only).
- CLI: `node scripts/bootstrap-qntm.js --confirm-bootstrap-qntm` (needs
  `DATABASE_URL`). Safe to re-run -- exits cleanly if already bootstrapped.

## Admin endpoints (under /api/qntm/admin)

- `GET  /overview` -- token, bootstrap status, supply figures, per-bucket balances.
- `GET  /wallets` -- the singleton system + allocation wallets with balances.
- `GET  /transactions` -- recent QNTM ledger transactions (filter by `type`, paginate by `before`).
- `POST /bootstrap` -- run the one-time bootstrap (201) or report already done (409).

## Wiring

`qntm-ledger/integrate.js` exposes:

- `setupQntmSchema()` -- applies the ledger schema (001/002 if absent, then 003)
  and ensures the system + allocation wallets. Call from the host boot sequence.
- `mountQntmEconomy(app, { authMiddleware, adminMiddleware })` -- mounts the
  admin routes under `/api/qntm/admin`, guarded by the host's auth.

The engine connects to the same database as the host via `DATABASE_URL`.

## Not in Phase 1

- Vesting engine (policy documented; bucket funded).
- Emissions / mining / reputation / staking / fee economy (later phases).
- Any sale, redemption, bridge, or on-chain form.

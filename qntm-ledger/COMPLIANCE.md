# QNTM Compliance Posture

**Status: internal ledger only. QNTM is not a public, on-chain, or investment
product in this phase.**

This document is the canonical statement of what QNTM is and is not at the
current stage of the DrFX Quant platform. It supersedes any earlier framing that
described QNTM as a purchasable credit priced in fiat.

## What QNTM is

- An **internal ledger token** used to account for platform activity, rewards,
  and utility inside DrFX Quant.
- A **fixed-supply** unit: exactly 1,000,000,000 QNTM, minted once at bootstrap
  and never expanded (enforced by `QNTM_MAX_SUPPLY` and a one-time guard).
- A **6-decimal** product/API token (1 QNTM = 1,000,000 base units) layered over
  an 18-decimal double-entry ledger. All balances are stored as exact
  integer / fixed-point values -- never floating point.

## What QNTM is NOT (this phase)

- **Not sold as an investment.** There is no endpoint that sells QNTM to users
  for money. The previous direct "buy QNTM" NOWPayments flow is paused/disabled
  and is not mounted.
- **No redemption or cash-out.** QNTM cannot be exchanged back to fiat or crypto.
- **No tradability or bridge for end users.** There is no on-chain transfer,
  withdrawal, or bridge. The `deposit`/`withdrawal` ledger types remain reserved
  and unimplemented; contract files remain `.placeholder` only.
- **No APY, yield, or guaranteed return.** Staking (a later phase) grants utility
  benefits only, never passive income.
- **No DAO / on-chain governance.**

## Future on-chain / tradable form

A future wrapped or on-chain form of QNTM is a **documented possibility, strictly
gated on legal sign-off**. It is not promised, scheduled, or implied to users or
investors. Candidate chains and migration notes, when written, live in
`docs/qntm-onchain-migration.md` and describe a possibility, not a commitment.

## Allocation (Dubai Edition, 5 buckets)

| Bucket | Account code | QNTM | % |
|---|---|---|---|
| Protocol & Platform Treasury | QNTM_TREASURY | 250,000,000 | 25% |
| Dynamic Reward & Growth Pool | QNTM_REWARD_GROWTH_POOL | 350,000,000 | 35% |
| Ecosystem & Strategic | QNTM_ECOSYSTEM_STRATEGIC | 150,000,000 | 15% |
| Team, Founders, Core (vesting) | QNTM_TEAM_FOUNDERS_VESTING | 200,000,000 | 20% |
| Community Reserve & Governance | QNTM_COMMUNITY_RESERVE | 50,000,000 | 5% |
| **Total** | | **1,000,000,000** | **100%** |

Team/Founders is documented as an 18-month cliff from `bootstrap_completed_v1`
then linear vesting over 48 months. The vesting **engine** is not implemented in
Phase 1; the bucket is funded and the policy is recorded for a later phase.

## Engineering guarantees

- Every balance change is an immutable, append-only ledger transaction.
- Total issued supply can never exceed 1,000,000,000 QNTM.
- Bootstrap runs exactly once (flag + supply check + advisory lock + idempotency).
- All admin operations require the platform admin role (the highest role today);
  the bootstrap entrypoint is structured so a future super-admin/root tier can be
  substituted without touching the financial core.

## League Unlock Ritual (non-yield qualification stake)

The League Unlock Ritual is a **gamified, non-yield** mechanic for ascending
between leagues. It is **not** an investment, savings, or interest product:

- To unlock a higher league, a user locks that league's fixed `stake_for_unlock`
  QNTM for a **7-day** period (`available` -> `locked` on the ledger).
- At the end of the 7 days the league becomes **permanently unlocked** and the
  **entire staked amount is returned** to the user (`locked` -> `available`). The
  user receives back **exactly** what they committed — no bonus, no yield, no
  interest, no additional tokens.
- The unlock is a **one-time qualification ritual**: the league stays unlocked
  after the tokens are returned. It is **not** tied to an ongoing locked balance,
  so the user is never required to keep funds staked to retain league access.
- Token movement runs through the authoritative ledger as ordinary `staking_lock`
  / `staking_unlock` transactions (tagged `reference.type='league_unlock'`); the
  fixed-supply and non-negative guarantees apply unchanged. No supply is created
  or destroyed.

A separate, **independent profit-bearing staking module** (where staking QNTM
could earn token rewards) is a **possible future phase**. It is **not** part of
the League Unlock Ritual, is **not** implemented, and — like any move toward
yield — would require qualified legal sign-off before being built.

_This posture is an engineering description, not legal advice. Any move toward a
tradable or on-chain QNTM must be reviewed and signed off by qualified counsel
first._

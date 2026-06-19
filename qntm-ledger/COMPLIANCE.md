# QNTM Ledger — Compliance Boundary

This document states, in writing, the regulatory posture the code is built to.
It is deliberately conservative. Read it before changing anything in
`treasury.js`, `bridge.routes.js`, or the supply model.

## What QNTM is

QNTM is an **internal, non-redeemable platform credit** used inside DrFX Quant
for engagement, tipping, marketplace purchases of digital goods, subscriptions,
pay-per-use AI features, tournaments, and staking-for-perks.

It is **not** money, **not** an investment, and **not** a claim on the company.

## The two rules that keep this internal

1. **Tokens are issued, never sold.** The only way QNTM comes into existence is
   an administrative `mint` into the treasury (`treasury.mint`), followed by
   `grant`/`reward` distribution. There is **no fiat or crypto purchase path**.
   Users do not buy QNTM with money.

2. **Tokens are non-redeemable.** There is **no cash-out, withdrawal, or
   on-chain bridge**. QNTM cannot be converted back into fiat, crypto, or
   anything of monetary value. It is spent inside the platform or it sits in a
   wallet.

As long as both rules hold, QNTM behaves like loyalty points / arcade credits,
which is a well-understood, low-risk category — not custody, not money
transmission, not a security.

## What is intentionally NOT built (gated pending counsel)

The original specification included an on/off-ramp and later "hybrid on-chain"
and "public listing / liquidity / governance" phases. Those are exactly the
features that would cross into regulated territory, so they are **scaffolded but
disabled**:

| Spec area | Status in this codebase |
|---|---|
| §20 deposit (fiat/crypto in) | `bridge.routes.js` returns **501**. No code path credits a wallet from an external payment. |
| §20 withdrawal / redemption | `bridge.routes.js` returns **501**. No code path pays value out of the system. |
| Phase 3 on-chain mirroring | Not implemented. `deposit`/`withdrawal` exist only as reserved enum values for forward-compatibility. |
| Phase 4 listing / AMM / liquidity | Not implemented. |
| Phase 4 governance token / voting | Not implemented. |

The reserved enum values (`txn_type.deposit`, `txn_type.withdrawal`) cost
nothing and document intent; **no function emits them**.

## What must happen BEFORE any ramp is enabled

Turning on a deposit or withdrawal path is a business/legal decision, not a code
change. At minimum it requires, with qualified counsel in the relevant
jurisdictions:

- a determination of whether the activity is money transmission / e-money /
  custody / securities, and licensing accordingly (e.g. MTLs / MSB registration
  / VASP registration);
- a KYC/AML program: identity verification, sanctions (OFAC and equivalents)
  screening, transaction monitoring, SAR/STR filing, and Travel-Rule handling
  for any on-chain leg;
- consumer-protection, safeguarding-of-funds, and tax-reporting analysis;
- terms of service and disclosures reviewed by counsel.

Until that work is signed off, the ramp stays disabled. The 501 stubs make the
boundary explicit so it cannot be crossed by accident.

## Note on supply

`treasury.mint` applies the supply figures the operator provides. If you want a
hard cap, set `QNTM_MAX_SUPPLY` (a decimal string); mints that would exceed it
are rejected. The `genesis` contra-wallet holds `-(total issued)` at all times,
so total issuance is always auditable and conservation is provable
(`supply.verifyIntegrity`).

> This document is an engineering description of how the system is built. It is
> not legal advice. Obtain qualified legal counsel before changing the posture
> above.

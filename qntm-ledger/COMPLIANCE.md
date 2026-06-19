# QNTM Ledger — Compliance Boundary

This document states, in writing, the regulatory posture the code is built to.
Read it before changing anything in `treasury.js`, `payments/`, `bridge.routes.js`,
or the supply model.

## What QNTM is

QNTM is an **internal, non-redeemable platform credit** used inside DrFX Quant
for engagement, tipping, marketplace purchases of digital goods, subscriptions,
pay-per-use AI features, tournaments, and staking-for-perks.

It is **not** money, **not** e-money or a stablecoin, **not** an investment or
security, and **not** a claim on the company's assets or profits.

Users may **buy** QNTM with fiat or crypto through a third-party payment
processor. This makes QNTM a *purchased, non-redeemable access credit* — the
same category as game gems, arcade tokens, or prepaid API/SaaS credits — **not**
a withdrawable balance, stored-value instrument, or tradable token.

## The rule that keeps this in-bounds: one way in, no way out

1. **One-way purchase only.** Money flows in exactly one direction:
   fiat/crypto → (NOWPayments) → QNTM credits → spent inside the platform.
   - **DrFX never custodies fiat or crypto.** NOWPayments collects and holds
     the funds and runs its own KYC/AML. DrFX only adjusts an internal credit
     balance, and only *after* a webhook that is **signature-verified
     (HMAC-SHA512), amount-validated, and idempotent** (see
     `payments/nowpayments.js`, `payments/orders.js`).
   - Crediting debits the pre-minted treasury (`type = 'purchase'`); it does not
     create money or move funds.

2. **Non-redeemable — no value out.** There is **no cash-out, withdrawal,
   redemption, on-chain bridge, external trading, or liquidity/exchange
   listing**. QNTM cannot be converted back into fiat, crypto, or anything of
   monetary value. It is spent inside the platform or it sits in a wallet. The
   recipient of a tip holds equally non-redeemable credits, so user-to-user
   tipping is a gift of internal credits, not a money transfer.

As long as value can only flow **in** and never **out**, QNTM stays in the
prepaid-access-credit category and does not become custody, money transmission,
or a security on the redemption side.

## Enabled vs. intentionally NOT built

| Capability | Status in this codebase |
|---|---|
| **Buy QNTM via NOWPayments** (fiat/crypto in) | **ENABLED.** `/api/exchange/qntm/quote`, `/api/exchange/qntm/buy/nowpayments`, `/api/webhooks/nowpayments`. Credit only on a verified, amount-matched, idempotent `finished` webhook. |
| Withdrawal / redemption / cash-out | **None.** No code path pays value out of the system. |
| On-chain bridge (deposit or withdrawal) | `bridge.routes.js` returns **501**. The NOWPayments top-up is *not* an on-chain bridge; mirroring QNTM to a blockchain is not implemented. |
| External trading / AMM / liquidity / listing | Not implemented. |
| Governance token / voting | Not implemented. |
| Yield / APY / interest-bearing balances | Not implemented, and out of scope. |

`bridge.routes.js` staying at 501 is intentional: the *only* sanctioned way
value enters is the audited NOWPayments purchase flow, never an ad-hoc deposit.

## What is the operator's responsibility (not the code's)

Selling a non-redeemable access credit is lighter-touch than running an exchange,
but it is still a **sale to consumers** and still carries obligations that live
outside this repository and require qualified counsel in the relevant
jurisdictions:

- **Consumer protection & refunds:** a clear refund/chargeback policy and terms
  of service for the credit sale.
- **Tax:** sales-tax / VAT / GST treatment of selling the credits, and any
  reporting that follows.
- **Reliance on the processor:** NOWPayments performs the regulated money/crypto
  handling and KYC/AML/sanctions screening. Confirm their coverage fits the
  jurisdictions you sell into; DrFX is relying on it.
- **Positioning:** all naming, UX, and marketing copy must present QNTM as
  *credits*, never as an investment, and must never imply ROI, profit, yield, or
  resale value. (The code emits no such language; the surrounding product must
  not either.)
- **If you ever add a redemption/withdrawal/bridge path,** that is a different
  regulatory posture entirely (money transmission / e-money / VASP / securities
  analysis, full AML program, safeguarding of funds). It is a business/legal
  decision, not a code change, and the boundary above must not be crossed by
  accident.

## Note on supply

`treasury.mint` applies the supply figures the operator provides. If you want a
hard cap, set `QNTM_MAX_SUPPLY` (a decimal string); mints that would exceed it
are rejected. The `genesis` contra-wallet holds `-(total issued)` at all times,
so total issuance is always auditable and conservation is provable
(`supply.verifyIntegrity`). Purchases draw down the treasury, so the treasury
must be minted/funded ahead of demand; if it is underfunded when a payment
confirms, the order is parked as `paid_pending_credit` and credited by an admin
re-credit after minting (never silently dropped).

> This document is an engineering description of how the system is built. It is
> not legal advice. Obtain qualified legal counsel before changing the posture
> above.

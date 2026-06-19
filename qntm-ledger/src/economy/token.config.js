'use strict';
/**
 * QNTM token economic configuration -- Phase 1 (Dubai Edition, 5 buckets).
 *
 * QNTM is an INTERNAL ledger token. It is not a public/on-chain token, is not
 * sold to users as an investment, has no redemption/cash-out, and no bridge in
 * this phase. See qntm-ledger/COMPLIANCE.md.
 *
 * Precision model (the 6-decimal facade over the 18-decimal ledger):
 *   - The core ledger stores every balance as NUMERIC(36,18) -- unchanged.
 *   - QNTM is a 6-decimal product/API token: 1 QNTM = 1,000,000 base units.
 *   - Allocations are whole QNTM, so they sit exactly in both representations.
 *   - API responses expose BOTH a 6-decimal QNTM string and the integer
 *     base-unit string (toQntm6 / toBase6), never a float.
 */

const SYMBOL = 'QNTM';
const NAME = 'Quantum Network Token';
const DECIMALS = 6;
const BASE_UNITS_PER_QNTM = 1000000n; // 10^6
const TOTAL_SUPPLY = '1000000000';    // 1,000,000,000 QNTM -- fixed cap

// Each bucket maps a logical account code to the singleton system wallet_type
// that physically holds it in the ledger. 'treasury' and 'reward_pool' already
// exist in the engine; the other three are added by migration 003.
const ALLOCATIONS = [
  { code: 'QNTM_TREASURY',              walletType: 'treasury',          amount: '250000000', percent: 25, event: 'allocate_treasury_v1',           policy: 'Protocol & platform treasury; strategic reserve, admin controlled.' },
  { code: 'QNTM_REWARD_GROWTH_POOL',    walletType: 'reward_pool',       amount: '350000000', percent: 35, event: 'allocate_reward_growth_v1',       policy: 'Dynamic reward & growth pool; source of contribution-mining emissions in later phases.' },
  { code: 'QNTM_ECOSYSTEM_STRATEGIC',   walletType: 'ecosystem',         amount: '150000000', percent: 15, event: 'allocate_ecosystem_strategic_v1', policy: 'Ecosystem & strategic partnerships and incentives.' },
  { code: 'QNTM_TEAM_FOUNDERS_VESTING', walletType: 'team_vesting',      amount: '200000000', percent: 20, event: 'allocate_team_vesting_v1',        policy: 'Team/founders/core. 18-month cliff from bootstrap_completed_v1, then linear over 48 months (~4,166,666.67 QNTM/month). Vesting ENGINE is NOT implemented in Phase 1 -- account + allocation only.' },
  { code: 'QNTM_COMMUNITY_RESERVE',     walletType: 'community_reserve', amount: '50000000',  percent: 5,  event: 'allocate_community_reserve_v1',   policy: 'Community reserve & governance. Governance is NOT implemented in Phase 1.' },
];

// New wallet_type enum values introduced for the economy buckets (migration 003).
const NEW_WALLET_TYPES = ['ecosystem', 'team_vesting', 'community_reserve'];

// Bootstrap mints the full supply into 'treasury' (where the engine's mint
// lands), then transfers the four non-treasury buckets OUT of treasury; the
// treasury keeps its 250M residual. So treasury is the mint source AND its own
// allocation bucket.
const MINT_SOURCE_WALLET_TYPE = 'treasury';
const BOOTSTRAP_FLAG = 'BOOTSTRAP_COMPLETED_V1';

// Public sale is OFF in this phase. QNTM is never sold to users for money here.
const PUBLIC_SALE_ENABLED = false;

// ---- 6-decimal facade helpers (pure string math; no floats) ----
function _split(s) {
  s = String(s).trim();
  let neg = false;
  if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
  if (s.charAt(0) === '+') s = s.slice(1);
  const parts = s.split('.');
  const int = (parts[0] || '0').replace(/[^0-9]/g, '') || '0';
  const frac = (parts[1] || '').replace(/[^0-9]/g, '');
  return { neg, int, frac };
}
function _stripLeading(d) { const r = d.replace(/^0+(?=[0-9])/, ''); return r === '' ? '0' : r; }
function _isZero(s) { return /^0+$/.test(s); }

/** decimal/ledger string -> integer 6-decimal base units (truncates beyond 6). */
function toBase6(s) {
  const x = _split(s);
  const f6 = (x.frac + '000000').slice(0, 6);
  const digits = _stripLeading(x.int + f6);
  return (x.neg && digits !== '0' ? '-' : '') + digits;
}
/** decimal/ledger string -> QNTM string with exactly 6 decimals. */
function toQntm6(s) {
  const x = _split(s);
  const f6 = (x.frac + '000000').slice(0, 6);
  const int = _stripLeading(x.int);
  const sign = (x.neg && !(int === '0' && _isZero(f6))) ? '-' : '';
  return sign + int + '.' + f6;
}
/** integer 6-decimal base units -> QNTM string with 6 decimals. */
function fromBase6(units) {
  let s = String(units).trim();
  let neg = false;
  if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
  s = (s.replace(/[^0-9]/g, '') || '0').padStart(7, '0');
  const int = _stripLeading(s.slice(0, -6));
  const frac = s.slice(-6);
  const sign = (neg && !(int === '0' && _isZero(frac))) ? '-' : '';
  return sign + int + '.' + frac;
}

// Fail fast at load time: the five buckets MUST sum to exactly the fixed supply.
const _sum = ALLOCATIONS.reduce((acc, a) => acc + BigInt(a.amount), 0n);
if (_sum !== BigInt(TOTAL_SUPPLY)) {
  throw new Error('QNTM allocation misconfigured: buckets sum to ' + _sum.toString() + ', expected ' + TOTAL_SUPPLY);
}

module.exports = {
  SYMBOL, NAME, DECIMALS, BASE_UNITS_PER_QNTM, TOTAL_SUPPLY,
  ALLOCATIONS, NEW_WALLET_TYPES, MINT_SOURCE_WALLET_TYPE, BOOTSTRAP_FLAG,
  PUBLIC_SALE_ENABLED, toBase6, toQntm6, fromBase6,
};

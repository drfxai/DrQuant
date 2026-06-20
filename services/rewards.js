// services/rewards.js
// ----------------------------------------------------------------------------
// Event-driven QNTM rewards.
//
// A user receives QNTM at the MOMENT a milestone happens — not on deploy:
//   • registers .............. signup_reward   (default  100 QNTM)
//   • upgrades to Pro ........ pro_reward      (default  500 QNTM)
//   • becomes a creator ...... creator_reward  (default 1000 QNTM)
//
// Each milestone is its OWN reward, so a user who hits all three receives all
// three (additive). Each is idempotent per (kind, user) via the key
// `reward:<kind>:<userId>`, so a user is paid each reward AT MOST ONCE, ever —
// repeated hook calls (webhook retries, /auth/me re-syncs, repeated store edits)
// never double-grant.
//
// Every grant DEBITS the reward_pool system wallet and CREDITS the user's
// personal wallet. It NEVER mints: the ledger's non-negative trigger rejects an
// overdraw, so the fixed 1,000,000,000 QNTM supply is conserved. Until the token
// is bootstrapped (reward_pool funded), grants no-op safely (insufficient_funds
// is caught below) — registration/Pro/creator flows are never blocked.
//
// NON-BLOCKING BY CONTRACT: a reward failure must never break the calling
// request. Every path catches, logs, and returns a result object; it never
// throws to the caller.
//
// Tagged type='reward' + metadata.kind in {signup_reward, pro_reward,
// creator_reward} so the admin Economy Console emissions panel attributes each.
// ----------------------------------------------------------------------------

const wallets = require("../qntm-ledger/src/wallets");
const { postTransaction } = require("../qntm-ledger/src/ledger");
const decimal = require("../qntm-ledger/src/decimal");

const POOL = "reward_pool";
const CURRENCY = "QNTM";

// Reward amounts as exact decimal STRINGS (the ledger refuses JS floats).
// Mirrors the original initial-airdrop tiers; override per-deploy via env.
const AMOUNT = {
  signup_reward: String(process.env.REWARD_SIGNUP_QNTM || "100"),
  pro_reward: String(process.env.REWARD_PRO_QNTM || "500"),
  creator_reward: String(process.env.REWARD_CREATOR_QNTM || "1000"),
};

// Master switch (default ON). Set REWARDS_ON_EVENTS=off in .env to disable all.
const ENABLED = !/^(off|0|false|no|n)$/i.test(String(process.env.REWARDS_ON_EVENTS || "on").trim());

const LABEL = { signup_reward: "signup", pro_reward: "pro upgrade", creator_reward: "creator" };

/**
 * Grant a one-time milestone reward to a user. Idempotent + non-throwing.
 * @param {string} kind   one of: signup_reward | pro_reward | creator_reward
 * @param {string|number} userId
 * @returns {Promise<object>} a small result object (never rejects)
 */
async function grant(kind, userId) {
  if (!ENABLED) return { ok: false, skipped: "disabled" };
  const amount = AMOUNT[kind];
  if (!userId || !amount || !decimal.isPositive(amount)) return { ok: false, skipped: "noop" };
  const key = "reward:" + kind + ":" + userId;
  try {
    return await wallets.withTransaction(async (cx) => {
      // Idempotency: at most one of each reward per user, ever.
      const seen = await cx.query("SELECT 1 FROM transactions WHERE idempotency_key=$1", [key]);
      if (seen.rowCount) return { ok: true, idempotent: true, kind, userId: String(userId) };

      const fromId = await wallets.systemWalletId(POOL, CURRENCY, cx);
      const to = await wallets.getOrCreateWallet("user", userId, "personal", CURRENCY, cx);
      const desc = (LABEL[kind] || kind) + " reward";
      const txn = await postTransaction({
        type: "reward", // platform-funded credit; economically a reward emission
        amount,
        movements: [
          { walletId: fromId, direction: "debit", amount, description: desc },
          { walletId: to.id, direction: "credit", amount, description: desc },
        ],
        initiatorUserId: "system:reward",
        reference: { type: "reward", id: kind + ":" + userId },
        idempotencyKey: key,
        metadata: { kind, source: "event_reward", reason: desc, amount, userId: String(userId) },
      }, cx);
      return { ok: true, granted: true, kind, userId: String(userId), amount, transactionId: txn.public_id };
    });
  } catch (e) {
    // Non-blocking: log + swallow. An underfunded reward_pool surfaces here as
    // insufficient_funds and is intentionally ignored so the flow continues.
    console.error("[rewards] " + kind + " grant failed for user " + userId + ": " + (e && e.message));
    return { ok: false, error: (e && e.code) || (e && e.message) || "error" };
  }
}

// Wrapper guaranteeing the returned promise never rejects, so call sites may
// `await` it (to land the balance before responding) or leave it floating —
// either way it can never break the request.
function fire(kind, userId) {
  return grant(kind, userId).catch((e) => {
    console.error("[rewards] " + kind + " unexpected:", e && e.message);
    return { ok: false, error: "unexpected" };
  });
}

module.exports = {
  grant,
  grantSignupReward: (userId) => fire("signup_reward", userId),
  grantProReward: (userId) => fire("pro_reward", userId),
  grantCreatorReward: (userId) => fire("creator_reward", userId),
  AMOUNT,
  ENABLED,
};

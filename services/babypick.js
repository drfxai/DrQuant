// services/babypick.js
// ============================================================================
// Baby Pick — the games half of the Easy Trade section.
//
// Baby Pick is a GAMES hub (casino-style). Unlike Baby Trader — whose outcomes
// come from real TradingView signals — Baby Pick games are GAMES OF CHANCE with
// PROVABLY-FAIR outcomes. Money still moves only through the authoritative
// qntm-ledger (postTransaction), exactly like Baby Trader: a stake/payout is a
// real double-entry transaction and the balance shown IS the user's main wallet.
//
// This module ships the first game: QUICK SIGNAL — predict UP or DOWN on a
// market, settled in 60 seconds, pays 2× on a correct call.
//
//   Provably fair (commit → reveal):
//     • at placement we generate a random server_seed and COMMIT its SHA-256
//       hash to the player (server_seed itself stays hidden);
//     • the result is HMAC-SHA256(server_seed, client_seed:nonce) → a number in
//       [0,1); the player wins iff that number < WIN_CHANCE;
//     • when the round settles we REVEAL server_seed so the player can recompute
//       the hash and the roll and verify the result was fixed in advance.
//   The price ticker shown during the round is illustrative; the verdict is the
//   provably-fair roll above (see /quick/:id/fairness).
//
// Solvency: stakes and wins flow through the SHARED Easy Trade Reward Pool wallet
// (the same pool Baby Trader uses — there is only one). The ledger's non-negative
// trigger is the ultimate backstop; on top of it placeQuick() enforces the same
// exposure invariant Baby Trader uses (pool ≥ 2·openStakes + newStake) so any
// winnable round can always be paid. The pool is kept topped up to a floor from
// treasury by the Easy Trade keeper (EASYTRADE_POOL_FLOOR).
// ============================================================================
"use strict";

const crypto = require("crypto");
const { pool, withTransaction } = require("../qntm-ledger/src/db");
const { postTransaction } = require("../qntm-ledger/src/ledger");
const wallets = require("../qntm-ledger/src/wallets");
const decimal = require("../qntm-ledger/src/decimal");

const MIN_STAKE = 10;
const MAX_STAKE = 1000000;
const PAYOUT_MULT = 2;
const ROUND_SECONDS = 60;
// SHARED pool: Baby Pick and Baby Trader (Easy Trade) escrow stakes and pay wins
// from ONE wallet. Pointing this at easytrade's triple means there is a single
// Reward Pool across the whole Easy Trade section, kept funded by the existing
// EASYTRADE_POOL_FLOOR keeper. (Exposure is still checked per game against the
// shared balance; the ledger's non-negative trigger is the ultimate backstop.)
const POOL_OWNER = ["platform", "easytrade", "reward_pool"]; // shared with Easy Trade

// House edge knob: probability a prediction wins. 0.50 = no edge (fair coin at
// 2×); 0.49 leaves a small sustainable margin for the pool. Clamped to a sane band.
const WIN_CHANCE = (() => {
  const v = Number(process.env.BABYPICK_WIN_CHANCE);
  if (!Number.isFinite(v)) return 0.49;
  return Math.max(0.05, Math.min(0.95, v));
})();
// Pool funding is owned by the SHARED Easy Trade keeper (EASYTRADE_POOL_FLOOR).
// Baby Pick does not top up independently by default, so the two halves never
// fight over the same wallet. Set BABYPICK_POOL_FLOOR only if you deliberately
// want Baby Pick to also raise the shared floor.
const POOL_FLOOR = Math.floor(Number(process.env.BABYPICK_POOL_FLOOR) || 0);

// Themed markets for the Quick Signal ticker (base prices are illustrative).
const SYMBOLS = [
  { sym: "BTCUSDT", name: "Bitcoin", base: 68000, accent: "#f7931a" },
  { sym: "ETHUSDT", name: "Ethereum", base: 3600, accent: "#627eea" },
  { sym: "SOLUSDT", name: "Solana", base: 172, accent: "#14f195" },
  { sym: "BNBUSDT", name: "BNB", base: 595, accent: "#f3ba2f" },
  { sym: "XAUUSD", name: "Gold", base: 2390, accent: "#f5b54a" },
  { sym: "XRPUSDT", name: "XRP", base: 0.62, accent: "#26a17b" },
];
function symbolMeta(sym) { for (const s of SYMBOLS) if (s.sym === sym) return s; return null; }

let _ready = null;
let _poolWalletId = null;

async function init() {
  if (_ready) return _ready;
  _ready = (async () => {
    await ensureSchema();
    const w = await wallets.getOrCreateWallet(POOL_OWNER[0], POOL_OWNER[1], POOL_OWNER[2], "QNTM");
    _poolWalletId = w.id;
    await ensurePoolFloor().catch((e) => console.error("[babypick] pool floor:", e.message));
  })().catch((e) => { _ready = null; throw e; });
  return _ready;
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS babypick_rounds (
      id               BIGSERIAL PRIMARY KEY,
      user_id          TEXT NOT NULL,
      game             TEXT NOT NULL DEFAULT 'quick',
      symbol           TEXT NOT NULL,
      stake            NUMERIC NOT NULL,
      pick             TEXT NOT NULL,                 -- UP | DOWN
      status           TEXT NOT NULL DEFAULT 'pending', -- pending | won | lost
      payout           NUMERIC NOT NULL DEFAULT 0,
      outcome          TEXT,                          -- UP | DOWN (what "happened")
      entry_price      NUMERIC,
      result_price     NUMERIC,
      server_seed      TEXT NOT NULL,                 -- revealed only after settle
      server_seed_hash TEXT NOT NULL,                 -- committed at placement
      client_seed      TEXT NOT NULL,
      nonce            BIGINT NOT NULL DEFAULT 0,
      stake_txn        TEXT,
      payout_txn       TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      settle_at        TIMESTAMPTZ NOT NULL,
      settled_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS bp_rounds_user ON babypick_rounds(user_id, status, id DESC);
    CREATE INDEX IF NOT EXISTS bp_rounds_pending ON babypick_rounds(status, settle_at) WHERE status = 'pending';
  `);
}

// ── helpers ────────────────────────────────────────────────────────────────
async function poolBalance(client = pool) {
  const w = await wallets.getWallet(_poolWalletId, client);
  return w.available_balance;
}
async function userWalletId(userId, client = pool) {
  const w = await wallets.getOrCreateWallet("user", userId, "personal", "QNTM", client);
  return w.id;
}
function opposite(pick) { return pick === "UP" ? "DOWN" : "UP"; }

// provably-fair roll: HMAC-SHA256(server_seed, "client_seed:nonce") -> [0,1)
function fairRoll(serverSeed, clientSeed, nonce) {
  const mac = crypto.createHmac("sha256", serverSeed).update(String(clientSeed) + ":" + String(nonce)).digest("hex");
  const r = parseInt(mac.slice(0, 8), 16) / 0x100000000;       // win determinant
  const mag = parseInt(mac.slice(8, 16), 16) / 0x100000000;    // move magnitude
  return { r, mag, mac };
}

// keep the pool at POOL_FLOOR by pulling the shortfall from treasury (graceful)
async function ensurePoolFloor() {
  if (POOL_FLOOR <= 0) return { topped: false };
  const have = await poolBalance();
  if (decimal.cmp(have, String(POOL_FLOOR)) >= 0) return { topped: false, pool: have };
  const shortfall = decimal.sub(String(POOL_FLOOR), have);
  const treasuryId = await wallets.systemWalletId("treasury", "QNTM");
  const treasuryBal = (await wallets.getWallet(treasuryId)).available_balance;
  if (decimal.cmp(treasuryBal, shortfall) < 0) return { topped: false, reason: "treasury_short", pool: have };
  try {
    const txn = await postTransaction({
      type: "transfer", amount: shortfall,
      movements: [
        { walletId: treasuryId, direction: "debit", amount: shortfall, description: "Baby Pick pool top-up" },
        { walletId: _poolWalletId, direction: "credit", amount: shortfall, description: "Baby Pick pool top-up" },
      ],
      initiatorUserId: null, allowFrozen: true,
      reference: { type: "babypick_pool_topup" },
    });
    return { topped: true, added: shortfall, txn: txn.public_id };
  } catch (e) {
    if (/insufficient/i.test(e.message) || e.code === "insufficient_funds") return { topped: false, reason: "treasury_short" };
    throw e;
  }
}

// exposure invariant: pool must cover 2× every open stake plus the new one
async function exposureOk(client, addStake) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(stake),0) AS s FROM babypick_rounds WHERE status='pending'`);
  const S = rows[0].s;
  const need = decimal.add(decimal.add(S, S), addStake);
  const have = await poolBalance(client);
  return decimal.cmp(have, need) >= 0;
}

// ── snapshot for the Baby Pick header ───────────────────────────────────────
async function me(userId) {
  await init();
  await sweepQuickFor(userId).catch(() => {});       // settle any matured rounds first
  await ensurePoolFloor().catch(() => {});
  const w = await wallets.getOrCreateWallet("user", userId, "personal", "QNTM");
  const balance = w.available_balance;
  const poolBal = await poolBalance();
  const { rows: open } = await pool.query(
    `SELECT id FROM babypick_rounds WHERE user_id=$1 AND status='pending' ORDER BY id DESC LIMIT 1`, [String(userId)]);
  return {
    balance, pool: poolBal, min: MIN_STAKE, max: MAX_STAKE, payoutMult: PAYOUT_MULT,
    roundSeconds: ROUND_SECONDS, symbols: SYMBOLS, openRoundId: open[0] ? open[0].id : null,
  };
}
function config() {
  return {
    min: MIN_STAKE, max: MAX_STAKE, payoutMult: PAYOUT_MULT, roundSeconds: ROUND_SECONDS,
    symbols: SYMBOLS, winChance: WIN_CHANCE,
    fairness: "Provably fair: result = HMAC_SHA256(server_seed, client_seed:nonce) < win chance. The server_seed hash is shown before you play and the seed is revealed after.",
  };
}

// ── shaping ─────────────────────────────────────────────────────────────────
function roundView(r, reveal) {
  const settled = r.status === "won" || r.status === "lost";
  const secsLeft = Math.max(0, Math.round((new Date(r.settle_at).getTime() - Date.now()) / 1000));
  const v = {
    id: Number(r.id), game: r.game, symbol: r.symbol, stake: r.stake, pick: r.pick,
    status: r.status, payoutMult: PAYOUT_MULT,
    entryPrice: r.entry_price != null ? Number(r.entry_price) : null,
    createdAt: r.created_at, settleAt: r.settle_at, secondsRemaining: settled ? 0 : secsLeft,
    fair: { hash: r.server_seed_hash, clientSeed: r.client_seed, nonce: Number(r.nonce) },
  };
  if (settled) {
    v.outcome = r.outcome;
    v.resultPrice = r.result_price != null ? Number(r.result_price) : null;
    v.payout = r.payout != null ? Number(r.payout) : 0;
    v.won = r.status === "won";
    v.settledAt = r.settled_at;
    if (reveal) v.fair.serverSeed = r.server_seed;   // revealed post-settlement
  }
  return v;
}

// ── place a Quick Signal bet ────────────────────────────────────────────────
async function placeQuick(userId, opts) {
  await init();
  opts = opts || {};
  const symbol = String(opts.symbol || "");
  if (!symbolMeta(symbol)) { const e = new Error("unknown market"); e.code = "bad_symbol"; throw e; }
  const pick = String(opts.pick || "").toUpperCase();
  if (pick !== "UP" && pick !== "DOWN") { const e = new Error("pick must be UP or DOWN"); e.code = "bad_pick"; throw e; }
  const stakeNum = Math.floor(Number(opts.stake));
  if (!Number.isFinite(stakeNum) || stakeNum < MIN_STAKE) { const e = new Error("stake below minimum"); e.code = "bad_stake"; throw e; }
  if (stakeNum > MAX_STAKE) { const e = new Error("stake above maximum"); e.code = "bad_stake"; throw e; }
  const stake = String(stakeNum);

  // one live round at a time keeps it simple and the exposure math tight
  const { rows: openRows } = await pool.query(
    `SELECT id FROM babypick_rounds WHERE user_id=$1 AND status='pending' LIMIT 1`, [String(userId)]);
  if (openRows.length) { const e = new Error("you already have a live round"); e.code = "has_open"; throw e; }

  // provably-fair commit
  const serverSeed = crypto.randomBytes(24).toString("hex");
  const serverSeedHash = crypto.createHash("sha256").update(serverSeed).digest("hex");
  const clientSeed = (opts.clientSeed ? String(opts.clientSeed) : crypto.randomBytes(8).toString("hex")).slice(0, 64);
  const nonce = Date.now();
  const meta = symbolMeta(symbol);
  const entryPrice = +(meta.base * (1 + (Math.random() - 0.5) * 0.004)).toFixed(meta.base < 10 ? 4 : 2);

  return withTransaction(async (cx) => {
    if (!(await exposureOk(cx, stake))) { const e = new Error("Baby Pick is at capacity — try a smaller stake"); e.code = "capacity"; throw e; }
    const uwId = await userWalletId(userId, cx);
    const { rows: rr } = await cx.query(
      `INSERT INTO babypick_rounds (user_id, game, symbol, stake, pick, entry_price, server_seed, server_seed_hash, client_seed, nonce, settle_at)
       VALUES ($1,'quick',$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10 * INTERVAL '1 second')) RETURNING *`,
      [String(userId), symbol, stake, pick, entryPrice, serverSeed, serverSeedHash, clientSeed, nonce, ROUND_SECONDS]);
    const round = rr[0];
    const txn = await postTransaction({
      type: "tournament_entry", amount: stake,    // Baby Pick stake (user -> pool)
      movements: [
        { walletId: uwId, direction: "debit", amount: stake, description: "Baby Pick stake" },
        { walletId: _poolWalletId, direction: "credit", amount: stake, description: "Baby Pick stake" },
      ],
      initiatorUserId: String(userId),
      reference: { type: "babypick_round", id: round.id },
      idempotencyKey: "bp:stake:" + round.id,
      metadata: { app: "babypick", kind: "stake", game: "quick", symbol, pick },
    }, cx);
    await cx.query(`UPDATE babypick_rounds SET stake_txn=$2 WHERE id=$1`, [round.id, txn.public_id]);
    return roundView({ ...round, stake_txn: txn.public_id }, false);
  }).catch((err) => {
    if (/insufficient/i.test(err.message) || err.code === "insufficient_funds") {
      const e = new Error("Not enough QNTM in your wallet"); e.code = "insufficient"; throw e;
    }
    throw err;
  });
}

// ── settle one matured round (idempotent, row-locked) ───────────────────────
async function settleQuickRound(roundId) {
  return withTransaction(async (cx) => {
    const { rows } = await cx.query(`SELECT * FROM babypick_rounds WHERE id=$1 FOR UPDATE`, [roundId]);
    if (!rows.length) return { ok: false, reason: "no_round" };
    const r = rows[0];
    if (r.status !== "pending") return { ok: true, already: true, round: roundView(r, true) };
    if (new Date(r.settle_at).getTime() > Date.now()) return { ok: false, reason: "not_due", round: roundView(r, false) };

    const { r: roll, mag } = fairRoll(r.server_seed, r.client_seed, r.nonce);
    const won = roll < WIN_CHANCE;
    const outcome = won ? r.pick : opposite(r.pick);
    const meta = symbolMeta(r.symbol) || { base: Number(r.entry_price) || 100 };
    const entry = Number(r.entry_price) || meta.base;
    const movePct = 0.001 + mag * 0.007;                 // 0.1% .. 0.8%
    const resultPrice = +(outcome === "UP" ? entry * (1 + movePct) : entry * (1 - movePct)).toFixed(entry < 10 ? 4 : 2);

    if (won) {
      const payout = String(Number(r.stake) * PAYOUT_MULT);
      await postTransaction({
        type: "tournament_prize", amount: payout,    // Baby Pick win (pool -> user, 2×)
        movements: [
          { walletId: _poolWalletId, direction: "debit", amount: payout, description: "Baby Pick win" },
          { walletId: await userWalletId(r.user_id, cx), direction: "credit", amount: payout, description: "Baby Pick win" },
        ],
        initiatorUserId: r.user_id,
        reference: { type: "babypick_round", id: r.id },
        idempotencyKey: "bp:payout:" + r.id,
        metadata: { app: "babypick", kind: "payout", game: "quick", outcome },
      }, cx);
      await cx.query(
        `UPDATE babypick_rounds SET status='won', payout=$2, outcome=$3, result_price=$4,
           payout_txn=(SELECT public_id FROM transactions WHERE idempotency_key=$5), settled_at=now() WHERE id=$1`,
        [r.id, payout, outcome, resultPrice, "bp:payout:" + r.id]);
    } else {
      await cx.query(
        `UPDATE babypick_rounds SET status='lost', outcome=$2, result_price=$3, settled_at=now() WHERE id=$1`,
        [r.id, outcome, resultPrice]);
    }
    const { rows: after } = await cx.query(`SELECT * FROM babypick_rounds WHERE id=$1`, [r.id]);
    return { ok: true, round: roundView(after[0], true) };
  });
}

// ── poll a round; settles lazily once its 60s elapses ───────────────────────
async function getQuick(userId, roundId) {
  await init();
  const { rows } = await pool.query(`SELECT * FROM babypick_rounds WHERE id=$1 AND user_id=$2`, [roundId, String(userId)]);
  if (!rows.length) return null;
  let r = rows[0];
  if (r.status === "pending" && new Date(r.settle_at).getTime() <= Date.now()) {
    const s = await settleQuickRound(roundId).catch(() => null);
    if (s && s.round) return s.round;
    const { rows: re } = await pool.query(`SELECT * FROM babypick_rounds WHERE id=$1`, [roundId]);
    r = re[0] || r;
  }
  return roundView(r, true);
}

// settle all of one user's matured rounds (called from me())
async function sweepQuickFor(userId) {
  const { rows } = await pool.query(
    `SELECT id FROM babypick_rounds WHERE user_id=$1 AND status='pending' AND settle_at <= now() LIMIT 20`, [String(userId)]);
  for (const row of rows) await settleQuickRound(row.id).catch(() => {});
  return { settled: rows.length };
}
// global keeper hook (optional; not wired by default) — settles any matured round
async function sweepQuick(limit) {
  await init();
  const { rows } = await pool.query(
    `SELECT id FROM babypick_rounds WHERE status='pending' AND settle_at <= now() ORDER BY settle_at LIMIT $1`,
    [Math.min(200, Math.max(1, Math.floor(Number(limit) || 100)))]);
  for (const row of rows) await settleQuickRound(row.id).catch(() => {});
  return { settled: rows.length };
}

// ── a player's Quick Signal history + summary ───────────────────────────────
async function historyQuick(userId, limitInput, offsetInput) {
  await init();
  await sweepQuickFor(userId).catch(() => {});
  const limit = Math.min(100, Math.max(1, Math.floor(Number(limitInput) || 30)));
  const offset = Math.max(0, Math.floor(Number(offsetInput) || 0));
  const { rows } = await pool.query(
    `SELECT * FROM babypick_rounds WHERE user_id=$1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
    [String(userId), limit, offset]);
  const { rows: agg } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('won','lost'))   AS settled,
            COUNT(*) FILTER (WHERE status='won')               AS won,
            COUNT(*) FILTER (WHERE status='pending')           AS open,
            COALESCE(SUM(stake)  FILTER (WHERE status IN ('won','lost')),0) AS staked,
            COALESCE(SUM(payout) FILTER (WHERE status='won'),0)            AS paid
       FROM babypick_rounds WHERE user_id=$1`, [String(userId)]);
  const a = agg[0] || {};
  const settled = Number(a.settled || 0), won = Number(a.won || 0);
  return {
    items: rows.map((r) => roundView(r, true)),
    summary: {
      settled, won, open: Number(a.open || 0),
      winRate: settled ? Math.round((won / settled) * 100) : null,
      staked: a.staked || "0", paid: a.paid || "0",
      net: decimal.sub(a.paid || "0", a.staked || "0"),
    },
    limit, offset, count: rows.length,
  };
}

// ── fairness: commit + (post-settle) reveal so a player can verify ──────────
async function fairness(userId, roundId) {
  await init();
  const { rows } = await pool.query(`SELECT * FROM babypick_rounds WHERE id=$1 AND user_id=$2`, [roundId, String(userId)]);
  if (!rows.length) { const e = new Error("round not found"); e.code = "not_found"; throw e; }
  const r = rows[0];
  const settled = r.status === "won" || r.status === "lost";
  const out = {
    id: Number(r.id), status: r.status, winChance: WIN_CHANCE,
    serverSeedHash: r.server_seed_hash, clientSeed: r.client_seed, nonce: Number(r.nonce),
    formula: "roll = parseInt(HMAC_SHA256(server_seed, client_seed + ':' + nonce)[0..8], 16) / 2^32 ; win = roll < winChance",
  };
  if (settled) {
    out.serverSeed = r.server_seed;
    const { r: roll } = fairRoll(r.server_seed, r.client_seed, r.nonce);
    out.roll = roll; out.won = r.status === "won"; out.outcome = r.outcome;
  }
  return out;
}

// ── admin: fund the Baby Pick pool from treasury ────────────────────────────
async function fundPool(amount, actorId) {
  await init();
  if (!decimal.isPositive(String(amount))) { const e = new Error("amount must be positive"); e.code = "bad_amount"; throw e; }
  const treasuryId = await wallets.systemWalletId("treasury", "QNTM");
  const txn = await postTransaction({
    type: "transfer", amount: String(amount),
    movements: [
      { walletId: treasuryId, direction: "debit", amount: String(amount), description: "fund Baby Pick pool" },
      { walletId: _poolWalletId, direction: "credit", amount: String(amount), description: "Baby Pick pool top-up" },
    ],
    initiatorUserId: actorId ? String(actorId) : null, allowFrozen: true,
    reference: { type: "babypick_pool" },
  });
  return { funded: String(amount), pool: await poolBalance(), txn: txn.public_id };
}
async function poolStats() {
  await init();
  const poolBal = await poolBalance();
  const { rows } = await pool.query(`SELECT COALESCE(SUM(stake),0) AS s, COUNT(*)::int AS n FROM babypick_rounds WHERE status='pending'`);
  const exposure = rows[0].s, openRounds = rows[0].n;
  const headroom = decimal.sub(poolBal, decimal.add(exposure, exposure));
  const { rows: won } = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(payout),0) AS paid FROM babypick_rounds WHERE status='won'`);
  return { pool: poolBal, exposure, openRounds, headroom, wins: won[0].n, totalPaid: won[0].paid,
    payoutMult: PAYOUT_MULT, winChance: WIN_CHANCE, min: MIN_STAKE, max: MAX_STAKE, floor: POOL_FLOOR };
}

module.exports = {
  init, me, config, placeQuick, getQuick, settleQuickRound, sweepQuick, historyQuick, fairness,
  fundPool, poolStats, ensurePoolFloor,
  MIN_STAKE, MAX_STAKE, PAYOUT_MULT, ROUND_SECONDS, SYMBOLS, WIN_CHANCE,
};

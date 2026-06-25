// services/easytrade.js
// ============================================================================
// Easy Trade (Baby Trader) — the real, wallet-connected engine.
//
// Money moves ONLY through the authoritative qntm-ledger (postTransaction), so
// an Easy Trade stake/payout is the same kind of double-entry transaction as a
// transfer or a marketplace purchase. The user's balance shown in Easy Trade IS
// their main wallet balance — there is no separate or shadow balance.
//
// Flow
//   bet      debit user → credit easytrade pool         (stake escrowed in pool)
//   win      debit pool → credit user  (2× stake)        (profit paid from pool)
//   loss     (nothing — the stake already sits in the pool)
//   refund   debit pool → credit user  (stake back)      (round never materialised)
//
// Rounds are driven by a DEDICATED Easy Trade webhook that a TradingView
// indicator posts to (see routes/easytrade.js). A round opens on the indicator's
// ENTRY event and settles on its terminal event (TP3 / SL / close), carrying the
// indicator's own win/loss verdict — exactly the contract the scoreboard uses.
//
// Durability: rounds + tickets live in Postgres (escrowed stakes are real money,
// so they must survive a restart). Schema is ensured idempotently at first use.
//
// Solvency: the pool is a normal wallet; the ledger's non-negative trigger makes
// it impossible to overdraw. On top of that, placeBet() enforces a buffer
// invariant so a winning round can always be paid without relying on that
// backstop. See EXPOSURE GUARD below.
// ============================================================================
"use strict";

const { pool, withTransaction } = require("../qntm-ledger/src/db");
const { postTransaction } = require("../qntm-ledger/src/ledger");
const wallets = require("../qntm-ledger/src/wallets");
const decimal = require("../qntm-ledger/src/decimal");

const MIN_STAKE = 10;
const MAX_STAKE = 1000000;
const PAYOUT_MULT = 2;                 // fixed-2× house mode (see COMPLIANCE notes)
const UNBOUND_TTL_MIN = 120;           // refund a still-unbound ticket after this
const POOL_OWNER = ["platform", "easytrade", "pool"]; // owner_type, owner_id, wallet_type

// ── seed houses (signal providers). A house's signals arrive on the dedicated
//    webhook at /api/webhooks/easytrade/<house id>. Edit/extend freely; rows are
//    upserted idempotently so adding one here surfaces it without a migration.
const SEED_HOUSES = [
  { id: "godmode", name: "DrFX GOD MODE", tag: "Quad-consensus", accent: "#1c84ff", products: ["XAUUSD", "BTCUSDT", "EURUSD"] },
  { id: "aurora",  name: "Aurora Capital", tag: "Index momentum", accent: "#8b5cf6", products: ["NAS100", "US30", "SPX500"] },
  { id: "apex",    name: "Apex Signals",   tag: "Crypto breakout", accent: "#16e29a", products: ["ETHUSDT", "SOLUSDT", "BNBUSDT"] },
  { id: "titan",   name: "Titan FX",       tag: "Major pairs",     accent: "#f5b54a", products: ["GBPUSD", "USDJPY", "AUDUSD"] },
];

let _ready = null;
let _poolWalletId = null;

async function init() {
  if (_ready) return _ready;
  _ready = (async () => {
    await ensureSchema();
    const w = await wallets.getOrCreateWallet(POOL_OWNER[0], POOL_OWNER[1], POOL_OWNER[2], "QNTM");
    _poolWalletId = w.id;
    await seedHouses();
  })().catch((e) => { _ready = null; throw e; }); // a failed init can be retried, not cached forever
  return _ready;
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS easytrade_houses (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      tag        TEXT,
      accent     TEXT,
      products   TEXT[] NOT NULL DEFAULT '{}',
      enabled    BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS easytrade_rounds (
      id          BIGSERIAL PRIMARY KEY,
      house_id    TEXT NOT NULL,
      ext_id      TEXT,
      symbol      TEXT,
      direction   TEXT,
      status      TEXT NOT NULL DEFAULT 'entered',   -- entered | settled | void
      outcome     TEXT,                              -- TP | SL
      max_tp      INT  NOT NULL DEFAULT 0,
      entry_price NUMERIC, sl_price NUMERIC, tp1_price NUMERIC, tp2_price NUMERIC, tp3_price NUMERIC,
      last_price  NUMERIC,
      timeframe   TEXT,
      entered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      settled_at  TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS et_rounds_extid ON easytrade_rounds(house_id, ext_id) WHERE ext_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS et_rounds_open ON easytrade_rounds(house_id, status);
    CREATE TABLE IF NOT EXISTS easytrade_ticks (
      id        BIGSERIAL PRIMARY KEY,
      round_id  BIGINT NOT NULL REFERENCES easytrade_rounds(id) ON DELETE CASCADE,
      kind      TEXT NOT NULL,            -- entry | tp1 | tp2 | tp3 | sl | close | price
      price     NUMERIC,
      at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS et_ticks_round ON easytrade_ticks(round_id, id);
    CREATE TABLE IF NOT EXISTS easytrade_tickets (
      id          BIGSERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      house_id    TEXT NOT NULL,
      round_id    BIGINT REFERENCES easytrade_rounds(id),
      stake       NUMERIC NOT NULL,
      pick        TEXT NOT NULL,          -- TP | SL
      status      TEXT NOT NULL DEFAULT 'pending', -- pending | won | lost | refunded
      payout      NUMERIC NOT NULL DEFAULT 0,
      stake_txn   TEXT,
      payout_txn  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      bound_at    TIMESTAMPTZ,
      settled_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS et_tickets_user ON easytrade_tickets(user_id, status, id DESC);
    CREATE INDEX IF NOT EXISTS et_tickets_round ON easytrade_tickets(round_id) WHERE round_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS et_tickets_pending ON easytrade_tickets(house_id, status) WHERE status = 'pending';
  `);
}

async function seedHouses() {
  for (const h of SEED_HOUSES) {
    await pool.query(
      `INSERT INTO easytrade_houses (id, name, tag, accent, products)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, tag=EXCLUDED.tag, accent=EXCLUDED.accent, products=EXCLUDED.products`,
      [h.id, h.name, h.tag, h.accent, h.products]
    );
  }
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
function x2(stake) { return decimal.add(stake, stake); } // 2× without a mul dependency

// ── houses + stats ──────────────────────────────────────────────────────────
async function listHouses() {
  await init();
  const { rows } = await pool.query(`SELECT id, name, tag, accent, products FROM easytrade_houses WHERE enabled = true ORDER BY created_at`);
  // best-effort live stats per house (last 200 settled rounds)
  const { rows: stats } = await pool.query(`
    SELECT house_id,
           COUNT(*) FILTER (WHERE status='settled') AS settled,
           COUNT(*) FILTER (WHERE status='settled' AND outcome='TP') AS tp,
           COUNT(*) FILTER (WHERE status='entered') AS live
      FROM easytrade_rounds GROUP BY house_id`);
  const byId = {}; stats.forEach(s => { byId[s.house_id] = s; });
  return rows.map(h => {
    const s = byId[h.id] || {};
    const settled = Number(s.settled || 0), tp = Number(s.tp || 0);
    return { id: h.id, name: h.name, tag: h.tag, accent: h.accent, products: h.products,
      live: Number(s.live || 0), win: settled ? Math.round((tp / settled) * 100) : null };
  });
}

// ── snapshot for the section header: wallet + pool + the user's open ticket ──
async function me(userId) {
  await init();
  const w = await wallets.getOrCreateWallet("user", userId, "personal", "QNTM"); // same wallet as /api/qntm/wallets/me
  const balance = w.available_balance;
  const poolBal = await poolBalance();
  const { rows: open } = await pool.query(
    `SELECT id FROM easytrade_tickets WHERE user_id=$1 AND status='pending' ORDER BY id DESC LIMIT 1`, [String(userId)]);
  return { balance, pool: poolBal, min: MIN_STAKE, max: MAX_STAKE, payoutMult: PAYOUT_MULT,
    openTicketId: open[0] ? open[0].id : null };
}

// ── EXPOSURE GUARD ──────────────────────────────────────────────────────────
// Invariant: the pool's standing buffer must cover every open ticket's PROFIT,
// because a winning ticket pays 2× while only 1× was deposited. With S = sum of
// open stakes and a new stake s, the pool (which already holds the S deposits)
// can pay all wins iff  poolBalance ≥ 2·S + s. Enforced here; the ledger's
// non-negative trigger is the ultimate backstop.
async function exposureOk(client, addStake) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(stake),0) AS s FROM easytrade_tickets WHERE status='pending'`);
  const S = rows[0].s;
  const need = decimal.add(decimal.add(S, S), addStake); // 2S + s
  const have = await poolBalance(client);
  return decimal.cmp(have, need) >= 0;
}

// ── place a bet: validate → atomic (insert ticket + debit stake → pool) ──────
async function placeBet(userId, houseId, stakeInput, pick) {
  await init();
  pick = String(pick || "").toUpperCase();
  if (pick !== "TP" && pick !== "SL") { const e = new Error("pick must be TP or SL"); e.code = "bad_pick"; throw e; }
  const stakeNum = Math.floor(Number(stakeInput));
  if (!Number.isFinite(stakeNum) || stakeNum < MIN_STAKE) { const e = new Error("stake below minimum"); e.code = "bad_stake"; throw e; }
  if (stakeNum > MAX_STAKE) { const e = new Error("stake above maximum"); e.code = "bad_stake"; throw e; }
  const stake = String(stakeNum);

  const { rows: hrows } = await pool.query(`SELECT id FROM easytrade_houses WHERE id=$1 AND enabled=true`, [houseId]);
  if (!hrows.length) { const e = new Error("unknown house"); e.code = "no_house"; throw e; }

  // one open ticket per user keeps the UX (and settlement) simple
  const { rows: openRows } = await pool.query(
    `SELECT id FROM easytrade_tickets WHERE user_id=$1 AND status='pending' LIMIT 1`, [String(userId)]);
  if (openRows.length) { const e = new Error("you already have an open prediction"); e.code = "has_open"; throw e; }

  return withTransaction(async (cx) => {
    if (!(await exposureOk(cx, stake))) { const e = new Error("Easy Trade is at capacity — try a smaller stake"); e.code = "capacity"; throw e; }
    const uwId = await userWalletId(userId, cx);
    const { rows: tk } = await cx.query(
      `INSERT INTO easytrade_tickets (user_id, house_id, stake, pick) VALUES ($1,$2,$3,$4) RETURNING *`,
      [String(userId), houseId, stake, pick]);
    const ticket = tk[0];
    // debit the user, credit the pool — overdraw throws InsufficientFunds and
    // rolls the whole bet back (ticket insert included).
    const txn = await postTransaction({
      type: "easytrade_stake", amount: stake,
      movements: [
        { walletId: uwId, direction: "debit", amount: stake, description: "Easy Trade stake" },
        { walletId: _poolWalletId, direction: "credit", amount: stake, description: "Easy Trade stake" },
      ],
      initiatorUserId: String(userId),
      reference: { type: "easytrade_ticket", id: ticket.id },
      idempotencyKey: "et:stake:" + ticket.id,
      metadata: { houseId, pick },
    }, cx);
    await cx.query(`UPDATE easytrade_tickets SET stake_txn=$2 WHERE id=$1`, [ticket.id, txn.public_id]);
    return ticketView({ ...ticket, stake_txn: txn.public_id }, null);
  }).catch((err) => {
    if (/insufficient/i.test(err.message) || err.code === "insufficient_funds") {
      const e = new Error("Not enough QNTM in your wallet"); e.code = "insufficient"; throw e;
    }
    throw err;
  });
}

// ── poll a ticket (and its round, for the chart) ────────────────────────────
async function getTicket(userId, ticketId) {
  await init();
  const { rows } = await pool.query(`SELECT * FROM easytrade_tickets WHERE id=$1 AND user_id=$2`, [ticketId, String(userId)]);
  if (!rows.length) return null;
  const t = rows[0];
  let round = null, ticks = [];
  if (t.round_id) {
    const r = await pool.query(`SELECT * FROM easytrade_rounds WHERE id=$1`, [t.round_id]);
    round = r.rows[0] || null;
    const tk = await pool.query(`SELECT kind, price, at FROM easytrade_ticks WHERE round_id=$1 ORDER BY id`, [t.round_id]);
    ticks = tk.rows;
  }
  return ticketView(t, round, ticks);
}

// ── cancel an unbound, still-pending ticket → full refund ───────────────────
async function cancelTicket(userId, ticketId) {
  await init();
  return withTransaction(async (cx) => {
    const { rows } = await cx.query(
      `SELECT * FROM easytrade_tickets WHERE id=$1 AND user_id=$2 FOR UPDATE`, [ticketId, String(userId)]);
    if (!rows.length) { const e = new Error("ticket not found"); e.code = "not_found"; throw e; }
    const t = rows[0];
    if (t.status !== "pending" || t.round_id) { const e = new Error("ticket can no longer be cancelled"); e.code = "locked"; throw e; }
    await refundTicket(cx, t);
    return { refunded: true };
  });
}

// ── the dedicated webhook ingests indicator events here ─────────────────────
// payload: { signal_id, event, symbol, direction, entry, sl, tp1, tp2, tp3, price, result, tf }
async function ingestEvent(houseId, payload) {
  await init();
  const ev = normEvent(payload.event);
  if (!ev) return { ok: false, reason: "unknown_event" };
  const extId = payload.signal_id != null ? String(payload.signal_id) : null;

  if (ev === "entry") return openRound(houseId, extId, payload);

  // find the live round this event belongs to (by ext_id, else newest open)
  const round = await findRound(houseId, extId);
  if (!round) return { ok: false, reason: "no_open_round" };
  await pool.query(`INSERT INTO easytrade_ticks (round_id, kind, price) VALUES ($1,$2,$3)`,
    [round.id, ev, num(payload.price)]);
  if (num(payload.price) != null) await pool.query(`UPDATE easytrade_rounds SET last_price=$2 WHERE id=$1`, [round.id, num(payload.price)]);

  if (ev === "tp1" || ev === "tp2" || ev === "tp3") {
    const n = Number(ev.slice(2));
    await pool.query(`UPDATE easytrade_rounds SET max_tp=GREATEST(max_tp,$2) WHERE id=$1`, [round.id, n]);
  }
  const terminal = ev === "sl" || ev === "close" || ev === "tp3";
  if (!terminal) return { ok: true, round: round.id, event: ev };

  // verdict: trust the indicator's declared result (same rule the scoreboard uses)
  const result = payload.result ? String(payload.result).toLowerCase() : null;
  let outcome;
  if (result === "win") outcome = "TP";
  else if (result === "loss") outcome = "SL";
  else if (ev === "tp3") outcome = "TP";
  else outcome = round.max_tp >= 1 ? "TP" : "SL"; // heuristic fallback
  return settleRound(round.id, outcome, num(payload.price));
}

async function openRound(houseId, extId, p) {
  return withTransaction(async (cx) => {
    // idempotent on (house, ext_id): a resent ENTRY is a no-op
    if (extId) {
      const dup = await cx.query(`SELECT id FROM easytrade_rounds WHERE house_id=$1 AND ext_id=$2`, [houseId, extId]);
      if (dup.rows.length) return { ok: true, round: dup.rows[0].id, duplicate: true };
    }
    // Supersede any still-open round for this house (the indicator started a new
    // trade without a clean terminal): refund its bound pending tickets and void
    // it, so a ticket is never stranded waiting on a round that will never settle.
    const { rows: stale } = await cx.query(`SELECT id FROM easytrade_rounds WHERE house_id=$1 AND status='entered' FOR UPDATE`, [houseId]);
    for (const sr of stale) {
      const { rows: bt } = await cx.query(`SELECT * FROM easytrade_tickets WHERE round_id=$1 AND status='pending' FOR UPDATE`, [sr.id]);
      for (const tt of bt) await refundTicket(cx, tt);
      await cx.query(`UPDATE easytrade_rounds SET status='void', settled_at=now() WHERE id=$1`, [sr.id]);
    }
    const { rows } = await cx.query(
      `INSERT INTO easytrade_rounds (house_id, ext_id, symbol, direction, status, entry_price, sl_price, tp1_price, tp2_price, tp3_price, last_price, timeframe)
       VALUES ($1,$2,$3,$4,'entered',$5,$6,$7,$8,$9,$5,$10) RETURNING *`,
      [houseId, extId, p.symbol || null, dir(p.direction), num(p.entry), num(p.sl), num(p.tp1), num(p.tp2), num(p.tp3), p.tf || null]);
    const round = rows[0];
    await cx.query(`INSERT INTO easytrade_ticks (round_id, kind, price) VALUES ($1,'entry',$2)`, [round.id, num(p.entry)]);
    // BIND every still-unbound pending ticket for this house created before now.
    // Tickets placed after this entry stay unbound and catch the NEXT round —
    // so nobody can bet after seeing a trade already move.
    await cx.query(
      `UPDATE easytrade_tickets SET round_id=$1, bound_at=now()
       WHERE house_id=$2 AND status='pending' AND round_id IS NULL AND created_at <= $3`,
      [round.id, houseId, round.entered_at]);
    return { ok: true, round: round.id, bound: true };
  });
}

async function settleRound(roundId, outcome, lastPrice) {
  return withTransaction(async (cx) => {
    const { rows } = await cx.query(`SELECT * FROM easytrade_rounds WHERE id=$1 FOR UPDATE`, [roundId]);
    if (!rows.length) return { ok: false, reason: "no_round" };
    const round = rows[0];
    if (round.status === "settled") return { ok: true, already: true };
    await cx.query(`UPDATE easytrade_rounds SET status='settled', outcome=$2, settled_at=now(), last_price=COALESCE($3,last_price) WHERE id=$1`,
      [roundId, outcome, lastPrice]);

    const { rows: tks } = await cx.query(
      `SELECT * FROM easytrade_tickets WHERE round_id=$1 AND status='pending' FOR UPDATE`, [roundId]);
    let won = 0, lost = 0;
    for (const t of tks) {
      if (t.pick === outcome) {
        const payout = x2(t.stake);
        await postTransaction({
          type: "easytrade_payout", amount: payout,
          movements: [
            { walletId: _poolWalletId, direction: "debit", amount: payout, description: "Easy Trade win" },
            { walletId: await userWalletId(t.user_id, cx), direction: "credit", amount: payout, description: "Easy Trade win" },
          ],
          initiatorUserId: t.user_id,
          reference: { type: "easytrade_ticket", id: t.id },
          idempotencyKey: "et:payout:" + t.id,
          metadata: { roundId, outcome },
        }, cx);
        await cx.query(`UPDATE easytrade_tickets SET status='won', payout=$2, payout_txn=(SELECT public_id FROM transactions WHERE idempotency_key=$3), settled_at=now() WHERE id=$1`,
          [t.id, payout, "et:payout:" + t.id]);
        won++;
      } else {
        await cx.query(`UPDATE easytrade_tickets SET status='lost', settled_at=now() WHERE id=$1`, [t.id]);
        lost++;
      }
    }
    return { ok: true, round: roundId, outcome, won, lost };
  });
}

// ── refund (used by cancel + the stale sweeper) ─────────────────────────────
async function refundTicket(cx, t) {
  await postTransaction({
    type: "easytrade_refund", amount: t.stake,
    movements: [
      { walletId: _poolWalletId, direction: "debit", amount: t.stake, description: "Easy Trade refund" },
      { walletId: await userWalletId(t.user_id, cx), direction: "credit", amount: t.stake, description: "Easy Trade refund" },
    ],
    initiatorUserId: t.user_id,
    reference: { type: "easytrade_ticket", id: t.id },
    idempotencyKey: "et:refund:" + t.id,
    metadata: { reason: "refund" },
  }, cx);
  await cx.query(`UPDATE easytrade_tickets SET status='refunded', settled_at=now() WHERE id=$1`, [t.id]);
}

// refund unbound tickets that have waited too long for a signal
async function sweepStale() {
  await init();
  const { rows } = await pool.query(
    `SELECT id FROM easytrade_tickets WHERE status='pending' AND round_id IS NULL
       AND created_at < now() - ($1 * INTERVAL '1 minute') LIMIT 100`, [UNBOUND_TTL_MIN]);
  for (const r of rows) {
    await withTransaction(async (cx) => {
      const lk = await cx.query(`SELECT * FROM easytrade_tickets WHERE id=$1 AND status='pending' AND round_id IS NULL FOR UPDATE`, [r.id]);
      if (lk.rows.length) await refundTicket(cx, lk.rows[0]);
    }).catch(() => {});
  }
  return { swept: rows.length };
}

// ── admin: fund the pool from treasury ──────────────────────────────────────
async function fundPool(amount, actorId) {
  await init();
  if (!decimal.isPositive(String(amount))) { const e = new Error("amount must be positive"); e.code = "bad_amount"; throw e; }
  const treasuryId = await wallets.systemWalletId("treasury", "QNTM");
  const txn = await postTransaction({
    type: "easytrade_pool_fund", amount: String(amount),
    movements: [
      { walletId: treasuryId, direction: "debit", amount: String(amount), description: "fund Easy Trade pool" },
      { walletId: _poolWalletId, direction: "credit", amount: String(amount), description: "Easy Trade pool top-up" },
    ],
    initiatorUserId: actorId ? String(actorId) : null, allowFrozen: true,
    reference: { type: "easytrade_pool" },
  });
  return { funded: String(amount), pool: await poolBalance(), txn: txn.public_id };
}

// ── shaping ─────────────────────────────────────────────────────────────────
function ticketView(t, round, ticks) {
  return {
    id: t.id, houseId: t.house_id, stake: t.stake, pick: t.pick, status: t.status,
    payout: t.payout, createdAt: t.created_at, settledAt: t.settled_at,
    round: round ? {
      id: round.id, symbol: round.symbol, direction: round.direction, status: round.status,
      outcome: round.outcome, maxTp: round.max_tp,
      entry: round.entry_price, sl: round.sl_price, tp1: round.tp1_price, tp2: round.tp2_price, tp3: round.tp3_price,
      lastPrice: round.last_price, timeframe: round.timeframe, enteredAt: round.entered_at,
    } : null,
    ticks: ticks || [],
  };
}

// ── tiny coercers ───────────────────────────────────────────────────────────
function num(v) { if (v == null || v === "" || v === "null") return null; const n = Number(v); return Number.isFinite(n) ? String(n) : null; }
function dir(v) { v = String(v || "").toLowerCase(); return v === "long" || v === "buy" ? "long" : v === "short" || v === "sell" ? "short" : null; }
function normEvent(e) {
  e = String(e || "").toLowerCase().trim();
  if (e === "entry" || e === "open" || e === "filled") return "entry";
  if (/^tp\s*1$|^t1$|^target1$/.test(e)) return "tp1";
  if (/^tp\s*2$|^t2$|^target2$/.test(e)) return "tp2";
  if (/^tp\s*3$|^t3$|^target3$|^target$/.test(e)) return "tp3";
  if (/^sl$|^stop$|^stoploss$|^stop_loss$/.test(e)) return "sl";
  if (/^close$|^exit$|^cancel$|^invalidate$|^invalidated$/.test(e)) return "close";
  if (/^price$|^tick$/.test(e)) return "price";
  return null;
}
async function findRound(houseId, extId) {
  if (extId) {
    const r = await pool.query(`SELECT * FROM easytrade_rounds WHERE house_id=$1 AND ext_id=$2`, [houseId, extId]);
    if (r.rows.length) return r.rows[0];
  }
  const r2 = await pool.query(`SELECT * FROM easytrade_rounds WHERE house_id=$1 AND status='entered' ORDER BY id DESC LIMIT 1`, [houseId]);
  return r2.rows[0] || null;
}

module.exports = {
  init, listHouses, me, placeBet, getTicket, cancelTicket, ingestEvent, fundPool, sweepStale,
  MIN_STAKE, MAX_STAKE, PAYOUT_MULT,
};

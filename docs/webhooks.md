# TradingView Webhook

`POST /api/webhooks/tradingview` — implemented in `routes/webhooks.js`, mounted in
`server.js` before `express.json()`.

Pipeline: **raw body → auth → schema → replay check → anti-spam → normalize →
persist → log → broadcast**.

## Auth (two modes)

TradingView's alert sender can't compute an HMAC header, so the realistic path is
a **shared secret in the JSON body**:

```json
{ "secret": "<TRADINGVIEW_WEBHOOK_SECRET>", "symbol": "EURUSD", "side": "buy",
  "price": 1.0825, "stop_loss": 1.0790, "take_profit": 1.0900,
  "timeframe": "15m", "strategy": "London breakout" }
```

If you front the webhook with a proxy that *can* sign requests, send
`X-Signature: sha256=<hex>` instead; the route prefers HMAC when present. Both
comparisons are constant-time. With no secret configured, every request is
rejected (`401`).

## Validation

`symbol` (≤32 chars) and `side` (`buy|sell|long|short|close|alert`) are required;
numeric fields are coerced and rejected if non-numeric. Body capped at 32 KB.
Malformed → logged `rejected_schema`, returns `400`.

## Replay prevention

`dedupe_key = sha256(rawBody + 60s-bucket)` is claimed via
`INSERT ... ON CONFLICT (dedupe_key) DO NOTHING`. Identical alerts within the same
minute collapse to one accepted signal; duplicates return `202 duplicate_ignored`.
Enforced at the DB layer, so it holds across multiple app instances.

## Anti-spam

Beyond per-IP rate limiting, accepted signals are capped at **10 per symbol per
minute**; floods return `429` and log `rate_limited`.

## Broadcast

A published signal is inserted into `signals` and emitted over Socket.io to the
`signals` room (every connected socket joins it) and, if a channel whose
`@username` matches `SIGNAL_CHANNEL_USERNAME` exists, to that channel's room.
Clients render it in the Signal Channel UI in real time. Listen client-side:

```js
socket.on("signal", (sig) => renderSignal(sig));
```

## Moderation (optional)

To require human approval, insert signals with `status='pending'` and broadcast
only on an admin approve action; the `status` enum and `created_by` column
already support this.

## Observability

Every attempt — accepted or rejected — lands in `webhook_logs` with `ip`,
`signature_ok`, `status`, `reason`, and the raw payload. Recommended alert: a
spike in `rejected_signature` means someone is probing the endpoint.

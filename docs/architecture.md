# Architecture

## Current shape (audited, v5.2)

Single Node process: Express + Socket.io on one HTTP server, PostgreSQL via a
`pg` Pool, a single-file Vanilla-JS SPA served statically, Multer disk uploads,
Nginx + PM2 + Certbot for deploy. Presence is an in-memory `Map`; **live trading
already exists** as server-relayed frames (`live_frame` events) with an in-memory
`liveStream` object.

```
Browser SPA ──HTTP──► Express routes ──► PostgreSQL
     │                     │
     └────WebSocket───► Socket.io  (in-memory onlineUsers Map + liveStream)
```

The in-memory presence/live state is the key scaling constraint: it breaks the
moment you run more than one worker.

## Target ecosystem (layered)

```
                  ┌──────────── Nginx (TLS, LB, static, /uploads) ────────────┐
   SPA / mobile ──┤  /api/*           Express (PM2 cluster, N workers)         │
                  │  /socket.io  ◄──► Socket.io ── Redis adapter ──┐           │
                  │  /api/webhooks/tradingview                     │           │
                  └─────────────────────────────────────────────────┼─────────┘
                                                                    │
       PostgreSQL (primary + read replica)     Redis (cache, rate-limit, socket
       ▲                                               pub/sub, presence, AI counters)
       │                                        Object store (S3-style) + CDN ─ media/HLS
  Background workers: ForexFactory poller · FFmpeg transcode queue · AI vision jobs
       │
  TURN/STUN (coturn) for WebRTC calls & live
```

## Phased roadmap

**Phase 1 — Security + RBAC + Webhook (this delivery).** Migration `001`,
`middleware/{security,rbac,audit}.js`, `services/tokens.js`, `routes/webhooks.js`,
`public/js/longpress.js`. Webhook + trust-proxy + signals room wired into
`server.js`. See `INTEGRATION.md` for the opt-in hardening/auth steps.

**Phase 2 — Messaging upgrade + files + voice.** Use the new `messages` columns
(`parent_message_id`, `type`, `deleted_at`, file/voice fields) and
`message_reads`. Add a storage abstraction + signed URLs, MediaRecorder voice
capture, and Socket.io delivery/read ACK events. WebRTC 1:1 voice calls: a thin
signaling namespace over the existing Socket.io server; coturn for NAT traversal.
SFU (mediasoup/Janus) is a later swap behind the same signaling contract.

**Phase 3 — Live + Explore.** Promote the existing in-memory live trading to
`live_sessions` (viewer counter via a Redis set, archive → `media`).
`media/posts/comments/likes` power the Explore feed with keyset pagination. Video
→ FFmpeg transcode worker → HLS; `media.status` tracks processing/ready/failed.

**Phase 4 — AI chart analysis + economic calendar + optimization.** Chart image →
temp storage → OpenRouter vision model, with per-user daily caps and cost logging
in `ai_usage_logs`. ForexFactory poller writes `economic_events` on a schedule
with a stale-cache fallback. Finalize read-replica routing, CDN, CSP tightening.

## Scaling plan

- **App tier**: stateless workers under PM2 cluster mode; move all per-process
  state (presence, live, rate limits) to Redis first — today's in-memory `Map`
  and `liveStream` prevent clustering.
- **Socket.io**: `@socket.io/redis-adapter` so events fan out across workers.
- **Postgres**: indexes are in migration 001; route heavy reads (feed, history)
  to a read replica; fix the N+1 in the chat-list query (one windowed query
  instead of a per-chat loop).
- **Media**: object store + CDN; never serve video from the app node; HLS for
  adaptive delivery.
- **Background work**: a job queue (BullMQ on Redis) for transcode, AI, and the
  ForexFactory poll so the request path stays fast.

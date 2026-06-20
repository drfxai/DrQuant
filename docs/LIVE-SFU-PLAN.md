# Live Trading — SFU + TURN Plan (720p / up to 60 fps, internet-wide audience)

> Status: **plan**. The SFU signaling layer already exists (`realtime/sfu.js`); this
> document is the build sheet to take it live. Code that can be written safely
> ahead of the infrastructure is called out as such. Anything touching media
> (mediasoup workers, coturn) must be installed and load-tested on the server —
> it cannot be validated from a dev machine.

## 0. Decision recap

- **Why not the current method:** live trading today is MJPEG over WebSocket —
  the admin screenshots a `<canvas>` to JPEG and the Node server relays every
  full frame to every viewer. No inter-frame compression, base64 bloat,
  synchronous encoding on the admin's tab, and the single-threaded server in the
  media path. It physically cannot do 720p60 to multiple viewers.
- **Chosen path:** an **SFU** (mediasoup — already scaffolded) with a **TURN**
  server (coturn) for NAT traversal, because the audience is internet-wide
  (diverse networks) and potentially larger than a P2P mesh can serve.
- **Trade-off to keep in mind:** SFU+TURN is the heaviest option. If real
  concurrent viewership stays tiny (≤5–8), P2P would be far cheaper and need no
  server upgrade. We're choosing SFU+TURN for headroom/growth.

---

## 1. What already exists (do NOT rebuild)

| Piece | Where | State |
|------|-------|-------|
| SFU signaling + room/peer bookkeeping (mediasoup) | `realtime/sfu.js` | Complete, reviewed, **inert** until `LIVE_SFU=on` + mediasoup installed. Full `live:*` produce/consume contract. |
| `live_sessions` table (`host_id`, `status`, `viewer_peak`, `started_at`, `ended_at`, `archive_media_id`) | migration `001_ecosystem_schema.sql` §7 | Created, compatible with the SFU code. |
| Socket.io auth + connection (JWT, blocked-check) | `server.js` | Reused as the signaling channel — no new transport needed. |
| SFU wired into boot | `server.js`: `require("./realtime/sfu").setupSfu(io, pool)` | Already called; returns disabled until env+deps present. |
| Existing frame-relay live path | `server.js` (`live_start/stop/join/leave/frame`) + `public/index.html` | Stays as the **fallback** during rollout. |

---

## 2. What's missing (the actual work)

### Infrastructure (you / server)
- **A. Server upgrade.** 1 vCPU / 1 GB **cannot** run an SFU + coturn. See sizing (§3).
- **B. Build toolchain + mediasoup.** mediasoup compiles a native C++ worker;
  needs `build-essential` + `python3`. (It's intentionally NOT in
  `package.json` so `npm install --production` doesn't break on toolchain-less
  hosts.)
- **C. coturn** (TURN/STUN) installed and configured.
- **D. Firewall/ports** for RTC media UDP + TURN.
- **E. Env vars**: `LIVE_SFU=on`, `SFU_ANNOUNCED_IP`, RTC port range, TURN secret.
- **F. DNS**: media/TURN endpoint must be **Cloudflare DNS-only (grey cloud)** —
  Cloudflare's proxy can't carry WebRTC UDP.

### Application code (I can write)
- **G. Session lifecycle.** Nothing currently inserts a `live_sessions` row, but
  `live:produce` authorizes the broadcaster by checking `live_sessions.host_id`.
  Add start/stop endpoints that create/end the row and return a `sessionId`.
- **H. ICE-credential endpoint.** Return STUN + TURN URLs with **short-lived**
  TURN credentials (coturn `use-auth-secret` HMAC scheme) so we never store
  per-user TURN passwords.
- **I. Client rewrite** with `mediasoup-client`: admin = producer
  (`getDisplayMedia` 720p60 → send transport → `produce`), viewer = consumer
  (`consume` → `<video>`). Replaces the canvas→`toDataURL` loop and the `<img>`
  viewer. Keep the existing Live panel shell/UI.
- **J. Capability flag + fallback.** Server advertises `liveMode: 'sfu' | 'relay'`;
  client uses SFU when on, else the current relay. Both coexist during rollout.
- **K. Polish (optional):** `viewer_peak` update, archive to `media`, reconnect
  UX, simulcast layers.

---

## 3. Sizing — the honest hardware answer

**1 CPU / 1 GB RAM is not enough.** An SFU forwards (it does **not** transcode in
mediasoup), so CPU is moderate, but:

- **RAM/CPU:** start with **2–4 vCPU / 4–8 GB**. mediasoup runs one worker per
  core; coturn relay adds CPU. (Even modest because there's no transcoding.)
- **Bandwidth is the real bill.** SFU egress = `bitrate × viewers`:
  - 720p60 ≈ **3–5 Mbps** per stream (a chart at 30 fps + higher bitrate often
    looks the same for less — worth A/B testing).
  - 20 viewers × 4 Mbps ≈ **80 Mbps** sustained egress; 100 viewers ≈ **400 Mbps**.
  - **Check the VPS monthly egress cap and overage price — this dominates cost.**
- **TURN relay bandwidth:** only viewers who can't get a direct UDP path are
  relayed *through* coturn, adding ~equal egress on the TURN box for those
  viewers. Plan ~10–30% of viewers behind strict NAT as a rough number.
- **Topology:** put coturn on the **same box** to start (simplest). If relay
  traffic competes with the SFU, move coturn to its own host.

---

## 4. Architecture / data flow

```
Admin browser                         SFU (mediasoup, on server)            Viewer browser
─────────────                         ──────────────────────────            ──────────────
getDisplayMedia 720p60                 router per live_session               <video>
  → encode (HW, in browser)            recv each producer                      ↑ recv transport
  → mediasoup-client send transport ── RTP/UDP ─▶ forward (no transcode) ── RTP/UDP ─▶ consume
                                       │
Signaling (SDP/ICE/produce/consume) over the EXISTING Socket.io connection (`live:*`)
NAT traversal: STUN (discover) + TURN relay fallback ← coturn
```

- **Media is UDP direct to the server's public IP** — NOT through nginx, NOT
  through Cloudflare's proxy. nginx keeps serving HTTPS/WSS (app + signaling) only.
- TCP/TLS fallback for media is handled by coturn (TURN over TCP/443) for viewers
  on networks that block UDP.

---

## 5. Step-by-step

### Phase A — Provision (server)
1. **Resize** to 2–4 vCPU / 4–8 GB. Record the **public IPv4** (= `SFU_ANNOUNCED_IP`).
2. **mediasoup deps + install** (in the app dir):
   ```bash
   sudo apt-get install -y build-essential python3 python3-pip
   cd /var/www/drfx-quant && npm install mediasoup
   ```
3. **coturn**:
   ```bash
   sudo apt-get install -y coturn
   ```
   `/etc/turnserver.conf` (starting point):
   ```
   listening-port=3478
   tls-listening-port=5349
   fingerprint
   use-auth-secret
   static-auth-secret=<LONG_RANDOM_SECRET>     # also goes in app .env as TURN_SECRET
   realm=drfx.io
   # relay port range — must be opened in the firewall
   min-port=49160
   max-port=49200
   # if the box is behind NAT (public != private), map it:
   # external-ip=<PUBLIC_IP>/<PRIVATE_IP>
   # TLS (reuse certbot certs or issue a dedicated one):
   cert=/etc/letsencrypt/live/drfx.io/fullchain.pem
   pkey=/etc/letsencrypt/live/drfx.io/privkey.pem
   no-cli
   ```
   Enable + start: set `TURNSERVER_ENABLED=1` in `/etc/default/coturn`, then
   `sudo systemctl enable --now coturn`.
4. **Firewall** (ufw + any cloud security group) — open:
   - **UDP** mediasoup RTC range (`SFU_RTC_MIN_PORT`–`SFU_RTC_MAX_PORT`, e.g.
     `40000–40100`). *Tip: mediasoup ≥3.11 supports a single multiplexed
     `WebRtcServer` port — we can switch to that to open just one UDP port
     instead of a range.*
   - **UDP+TCP 3478**, **TCP 5349** (TURN), and **UDP `49160–49200`** (TURN relay).
5. **DNS / Cloudflare:** point ICE candidates at the **bare public IP** via
   `SFU_ANNOUNCED_IP`, or use a **grey-cloud (DNS-only)** record like
   `media.drfx.io`. The app domain (`drfx.io`) can stay proxied for HTTPS/WSS.

### Phase B — Application code (feature-flagged; safe before Phase A finishes)
6. **DB:** confirm migration 001 applied — `live_sessions` exists. ✓ (it does).
7. **New `routes/live.js`** (mounted at `/api/live`, admin-guarded where noted):
   - `POST /start` (admin) → `INSERT INTO live_sessions (host_id, title, status) VALUES (…, 'live')` → `{ sessionId }`.
   - `POST /stop` (host/admin) → `UPDATE live_sessions SET status='ended', ended_at=NOW() WHERE id=$1`.
   - `GET /active` → current live session (`id`, host name, title, viewer count, `liveMode`).
   - `GET /ice` → `{ iceServers: [ {urls:'stun:media.drfx.io:3478'}, {urls:['turn:media.drfx.io:3478?transport=udp','turns:media.drfx.io:5349?transport=tcp'], username, credential} ] }` where `username = <expiry-unix>:live` and `credential = base64(HMAC-SHA1(TURN_SECRET, username))`, TTL ~ a few hours.
8. **Client (`public/index.html`)** with `mediasoup-client`:
   - Admin "Go Live": `POST /api/live/start` → `live:get-rtp-capabilities` →
     `Device.load` → `live:create-transport {direction:'send'}` →
     `getDisplayMedia({video:{width:1280,height:720,frameRate:60}})` →
     `sendTransport.produce(track, { contentHint:'motion', codecOptions, /* optional simulcast */ })`.
   - Viewer: `live:get-rtp-capabilities` → `Device.load` →
     `live:create-transport {direction:'recv'}` → `live:consume` →
     attach consumer track to a `<video autoplay playsinline>`; `live:resume`.
   - Remove the canvas/`toDataURL` capture loop and the `<img>` viewer for the
     SFU path. Reuse the existing Live panel layout, viewer count, and controls.
9. **Capability flag:** `GET /api/live/active` (or a `live_caps` socket event)
   returns `liveMode`. Client uses SFU when `'sfu'`, else the existing relay.

### Phase C — Test & cut over
10. 2-device test (admin + 1 viewer, same network), then **cross-network**
    (admin on wifi, viewer on mobile data) to force a TURN relay path.
11. Verify in `chrome://webrtc-internals` that media flows and that relayed
    viewers show candidate type **`relay`** (proves coturn works).
12. Load-test viewers; watch **CPU, RAM, egress, mediasoup worker load**, coturn
    sessions.
13. Tune: bitrate cap (~2.5–4 Mbps), frame rate (try 30 vs 60), keyframe
    interval; consider **simulcast** so weak viewers auto-drop to a lower layer.
14. Set `LIVE_SFU=on` and the env block; restart. Keep the relay path as an
    **instant rollback** (flip the flag off).

---

## 6. Env block (app `.env`, once infra is up)

```
LIVE_SFU=on
SFU_ANNOUNCED_IP=<PUBLIC_IPV4>
SFU_RTC_MIN_PORT=40000
SFU_RTC_MAX_PORT=40100
TURN_SECRET=<same LONG_RANDOM_SECRET as coturn static-auth-secret>
TURN_HOST=media.drfx.io        # or the public IP
```
(`update.sh` preserves `.env`, so these persist across deploys. mediasoup must be
installed on the server for `LIVE_SFU=on` to actually activate; otherwise
`sfu.js` logs a warning and the relay stays active — safe.)

---

## 7. Risks & caveats (so nothing surprises us)

- **mediasoup native build:** if it's ever installed on a host without the
  toolchain, the build fails. Install `build-essential`/`python3` first. Keep it
  out of `package.json` (as it is) so routine deploys don't try to build it.
- **coturn is its own service** to secure and monitor: rotate `static-auth-secret`,
  keep TLS certs current, watch relay bandwidth.
- **Cloudflare proxy + WebRTC UDP don't mix** → DNS-only for media/TURN.
- **Bandwidth = the real cost.** Confirm the VPS egress allowance before scaling
  viewers.
- **60 fps is often overkill for a chart** (charts repaint a few times/sec);
  30 fps at a higher bitrate usually looks better for the same bandwidth. The SFU
  supports 60 if you want it — just worth measuring.
- **Single multiplexed port option:** prefer mediasoup `WebRtcServer` (one UDP
  port) over a wide range to keep the firewall tight.

---

## 8. Division of labor

- **I can build:** `routes/live.js` (session start/stop/active + ICE-credential
  HMAC), the `mediasoup-client` admin+viewer integration, the capability flag,
  and the fallback wiring. These are safe to land **before** the server is
  upgraded — they stay dormant until `LIVE_SFU=on`.
- **You / server side:** resize the box, `npm install mediasoup`, install and
  configure coturn, open the firewall ports, set the `.env` block, point DNS.
  We iterate via `pm2 logs` + `chrome://webrtc-internals`, same as we debugged
  the boot crash.

### Suggested first code step
Land `routes/live.js` (session endpoints + `/api/live/ice`). It's harmless while
`LIVE_SFU` is off, unblocks the client work, and lets us verify the
session-authorization path end-to-end before any media flows.

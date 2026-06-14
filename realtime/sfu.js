// realtime/sfu.js
// ----------------------------------------------------------------------------
// SFU (Selective Forwarding Unit) signaling for low-latency live trading,
// per docs/PLATFORM-ARCHITECTURE.md §3. Implemented with mediasoup.
//
// IMPORTANT — SCOPE AND HONESTY:
//   This file is the SIGNALING + room/peer bookkeeping layer, which is real
//   application code. The MEDIA PLANE it drives — mediasoup's native workers
//   and a coturn TURN/STUN server — is infrastructure that must be installed
//   and load-tested separately. Accordingly this module is INERT by default:
//     * it does nothing unless  process.env.LIVE_SFU === "on", AND
//     * `mediasoup` is installed (it is intentionally NOT in package.json
//       dependencies because it pulls a C++/Python native build that would
//       break `npm install --production` on hosts without a toolchain).
//   When disabled, the existing base64 frame-relay path in server.js remains
//   the live-streaming mechanism. This code has NOT been run in this
//   environment; treat it as a reviewed starting point, not a tested service.
//
// Enable:
//   1) npm i mediasoup
//   2) install + run coturn; share its secret with the CLIENT ice config
//   3) set env: LIVE_SFU=on  SFU_ANNOUNCED_IP=<public IPv4>
//      optional: SFU_RTC_MIN_PORT, SFU_RTC_MAX_PORT
//   4) it is wired in server.js as: require("./realtime/sfu").setupSfu(io, pool)
//
// Signaling events (all carry { sessionId }), matching the doc:
//   live:get-rtp-capabilities  -> router.rtpCapabilities
//   live:create-transport      -> { direction: 'send'|'recv' } -> transport params
//   live:connect-transport     -> { transportId, dtlsParameters }
//   live:produce               -> { transportId, kind, rtpParameters } -> { id }
//   live:consume               -> { producerId, transportId, rtpCapabilities } -> consumer params
//   live:resume                -> { consumerId }
// Server emits: live:new-producer, live:viewers { count }, live:ended
// ----------------------------------------------------------------------------

// Standard codec set. H264 included for hardware-friendly decode on most
// devices; VP8 as a widely-supported fallback; opus for optional audio.
const MEDIA_CODECS = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  { kind: "video", mimeType: "video/VP8", clockRate: 90000, parameters: { "x-google-start-bitrate": 1000 } },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
      "x-google-start-bitrate": 1000,
    },
  },
];

function setupSfu(io, pool) {
  if (process.env.LIVE_SFU !== "on") {
    return { enabled: false, reason: "LIVE_SFU not 'on' (frame-relay fallback active)" };
  }

  let mediasoup;
  try {
    mediasoup = require("mediasoup");
  } catch (e) {
    console.warn("[sfu] LIVE_SFU=on but mediasoup is not installed — run `npm i mediasoup`. Falling back to frame relay.");
    return { enabled: false, reason: "mediasoup not installed" };
  }

  const ANNOUNCED_IP = process.env.SFU_ANNOUNCED_IP || "127.0.0.1";
  const RTC_MIN_PORT = parseInt(process.env.SFU_RTC_MIN_PORT) || 40000;
  const RTC_MAX_PORT = parseInt(process.env.SFU_RTC_MAX_PORT) || 49999;

  const workers = [];
  let nextWorker = 0;
  // sessionId -> { router, broadcasterSocketId, peers: Map<socketId, Peer> }
  // Peer = { transports: Map, producers: Map, consumers: Map, isBroadcaster }
  const rooms = new Map();

  // --- worker pool: one per CPU core ---------------------------------------
  (async () => {
    const os = require("os");
    const n = Math.max(1, os.cpus().length);
    for (let i = 0; i < n; i++) {
      const worker = await mediasoup.createWorker({
        rtcMinPort: RTC_MIN_PORT,
        rtcMaxPort: RTC_MAX_PORT,
      });
      worker.on("died", () => {
        console.error("[sfu] worker died, exiting in 2s");
        setTimeout(() => process.exit(1), 2000);
      });
      workers.push(worker);
    }
    console.log(`[sfu] enabled: ${workers.length} worker(s), announcedIp=${ANNOUNCED_IP}`);
  })().catch((e) => console.error("[sfu] worker init failed:", e.message));

  const pickWorker = () => {
    const w = workers[nextWorker];
    nextWorker = (nextWorker + 1) % workers.length;
    return w;
  };

  async function getOrCreateRoom(sessionId) {
    let room = rooms.get(sessionId);
    if (room) return room;
    const worker = pickWorker();
    if (!worker) throw new Error("no SFU workers ready");
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    room = { router, broadcasterSocketId: null, peers: new Map() };
    rooms.set(sessionId, room);
    return room;
  }

  function getPeer(room, socketId) {
    let p = room.peers.get(socketId);
    if (!p) {
      p = { transports: new Map(), producers: new Map(), consumers: new Map(), isBroadcaster: false };
      room.peers.set(socketId, p);
    }
    return p;
  }

  function viewerCount(room) {
    // viewers = peers that are not the broadcaster
    let c = 0;
    for (const [sid] of room.peers) if (sid !== room.broadcasterSocketId) c++;
    return c;
  }

  function emitViewers(sessionId, room) {
    io.to(`live_${sessionId}`).emit("live:viewers", { count: viewerCount(room) });
  }

  async function createWebRtcTransport(room) {
    const transport = await room.router.createWebRtcTransport({
      listenIps: [{ ip: "0.0.0.0", announcedIp: ANNOUNCED_IP }],
      enableUdp: true,
      enableTcp: true,    // TCP fallback when UDP is blocked
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1_000_000,
    });
    return transport;
  }

  function closePeer(room, socketId) {
    const peer = room.peers.get(socketId);
    if (!peer) return;
    for (const t of peer.transports.values()) { try { t.close(); } catch (_) {} }
    room.peers.delete(socketId);
  }

  async function closeRoom(sessionId) {
    const room = rooms.get(sessionId);
    if (!room) return;
    for (const sid of [...room.peers.keys()]) closePeer(room, sid);
    try { room.router.close(); } catch (_) {}
    rooms.delete(sessionId);
    io.to(`live_${sessionId}`).emit("live:ended");
    // best-effort DB cleanup
    try {
      await pool.query("UPDATE live_sessions SET status='ended', ended_at=NOW() WHERE id=$1 AND status='live'", [sessionId]);
    } catch (e) { console.error("[sfu] live_sessions cleanup:", e.message); }
  }

  // --- signaling ------------------------------------------------------------
  io.on("connection", (socket) => {
    if (!socket.user) return;
    const ack = (cb, payload) => { if (typeof cb === "function") { try { cb(payload); } catch (_) {} } };

    socket.on("live:get-rtp-capabilities", async ({ sessionId } = {}, cb) => {
      try {
        if (!sessionId) return ack(cb, { error: "sessionId required" });
        const room = await getOrCreateRoom(sessionId);
        socket.join(`live_${sessionId}`);
        ack(cb, { rtpCapabilities: room.router.rtpCapabilities });
        emitViewers(sessionId, room);
      } catch (e) { console.error("[sfu] caps:", e.message); ack(cb, { error: "server error" }); }
    });

    socket.on("live:create-transport", async ({ sessionId, direction } = {}, cb) => {
      try {
        const room = rooms.get(sessionId);
        if (!room) return ack(cb, { error: "no such session" });
        const peer = getPeer(room, socket.id);
        const transport = await createWebRtcTransport(room);
        transport.appData = { direction };
        peer.transports.set(transport.id, transport);
        ack(cb, {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (e) { console.error("[sfu] create-transport:", e.message); ack(cb, { error: "server error" }); }
    });

    socket.on("live:connect-transport", async ({ sessionId, transportId, dtlsParameters } = {}, cb) => {
      try {
        const room = rooms.get(sessionId);
        const peer = room && room.peers.get(socket.id);
        const transport = peer && peer.transports.get(transportId);
        if (!transport) return ack(cb, { error: "no such transport" });
        await transport.connect({ dtlsParameters });
        ack(cb, { ok: true });
      } catch (e) { console.error("[sfu] connect-transport:", e.message); ack(cb, { error: "server error" }); }
    });

    socket.on("live:produce", async ({ sessionId, transportId, kind, rtpParameters } = {}, cb) => {
      try {
        // Only the live host may produce. live_sessions.host_id is the owner.
        const { rows: [s] } = await pool.query("SELECT host_id FROM live_sessions WHERE id=$1", [sessionId]);
        if (!s || s.host_id !== socket.user.id) return ack(cb, { error: "not the broadcaster" });

        const room = rooms.get(sessionId);
        const peer = room && room.peers.get(socket.id);
        const transport = peer && peer.transports.get(transportId);
        if (!transport) return ack(cb, { error: "no such transport" });

        const producer = await transport.produce({ kind, rtpParameters });
        peer.producers.set(producer.id, producer);
        peer.isBroadcaster = true;
        room.broadcasterSocketId = socket.id;

        producer.on("transportclose", () => { try { producer.close(); } catch (_) {} });
        // tell viewers a new track is available
        socket.to(`live_${sessionId}`).emit("live:new-producer", { producerId: producer.id, kind });
        ack(cb, { id: producer.id });
      } catch (e) { console.error("[sfu] produce:", e.message); ack(cb, { error: "server error" }); }
    });

    socket.on("live:consume", async ({ sessionId, producerId, rtpCapabilities, transportId } = {}, cb) => {
      try {
        const room = rooms.get(sessionId);
        if (!room) return ack(cb, { error: "no such session" });
        if (!room.router.canConsume({ producerId, rtpCapabilities })) {
          return ack(cb, { error: "cannot consume" });
        }
        const peer = getPeer(room, socket.id);
        const transport = peer.transports.get(transportId);
        if (!transport) return ack(cb, { error: "no such transport" });

        // start paused, resume after the client is ready (avoids initial loss)
        const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
        peer.consumers.set(consumer.id, consumer);
        consumer.on("transportclose", () => { try { consumer.close(); } catch (_) {} });
        consumer.on("producerclose", () => {
          try { consumer.close(); } catch (_) {}
          socket.emit("live:producer-closed", { consumerId: consumer.id });
        });

        ack(cb, {
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
        emitViewers(sessionId, room);
      } catch (e) { console.error("[sfu] consume:", e.message); ack(cb, { error: "server error" }); }
    });

    socket.on("live:resume", async ({ sessionId, consumerId } = {}, cb) => {
      try {
        const room = rooms.get(sessionId);
        const peer = room && room.peers.get(socket.id);
        const consumer = peer && peer.consumers.get(consumerId);
        if (!consumer) return ack(cb, { error: "no such consumer" });
        await consumer.resume();
        ack(cb, { ok: true });
      } catch (e) { console.error("[sfu] resume:", e.message); ack(cb, { error: "server error" }); }
    });

    socket.on("live:leave", ({ sessionId } = {}) => {
      const room = rooms.get(sessionId);
      if (!room) return;
      socket.leave(`live_${sessionId}`);
      closePeer(room, socket.id);
      emitViewers(sessionId, room);
    });

    socket.on("disconnect", () => {
      // If the broadcaster drops, tear the room down; else just remove the viewer.
      for (const [sessionId, room] of rooms) {
        if (!room.peers.has(socket.id)) continue;
        if (room.broadcasterSocketId === socket.id) {
          closeRoom(sessionId);
        } else {
          closePeer(room, socket.id);
          emitViewers(sessionId, room);
        }
      }
    });
  });

  return { enabled: true, rooms };
}

module.exports = { setupSfu, MEDIA_CODECS };

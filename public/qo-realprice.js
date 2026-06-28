/* ===========================================================================
 * qo-realprice.js — real market-data provider for Quant Option (crypto)
 * ---------------------------------------------------------------------------
 * Isolated, dependency-free data layer used by the Quant Option SIGNAL chart to
 * show REAL prices. Crypto symbols (BTC/ETH/SOL/BNB-USDT) come from Binance's
 * free public endpoints (REST history + WebSocket live candles, no API key).
 * Non-crypto symbols (XAU/EUR/GBP) have no reliable free real-time browser feed,
 * so isReal() returns false and callers fall back to the signal-derived /
 * simulated curve — exactly the agreed design.
 *
 * This file deliberately renders NOTHING and modifies no existing code: it only
 * fetches and normalizes data, returning null / no-op on any failure so the
 * caller can gracefully fall back. Wiring it into the chart is done separately.
 *
 * Candle shape returned (matches TradingView Lightweight Charts):
 *   { time: <unix seconds>, open, high, low, close }
 * Live updates also include { closed: <bool> } (true when the candle finalizes).
 *
 * Exposes: window.dqQORealPrice = { isReal, mapSymbol, klines, subscribe, stopAll }
 * =========================================================================== */
(function () {
  "use strict";
  if (window.dqQORealPrice) return;

  // QO symbol → Binance symbol. Only these have a real free feed; everything
  // else is intentionally absent so isReal() is false for it.
  var CRYPTO = {
    BTCUSDT: "BTCUSDT",
    ETHUSDT: "ETHUSDT",
    SOLUSDT: "SOLUSDT",
    BNBUSDT: "BNBUSDT",
  };

  // Primary Binance hosts. If a viewer's region blocks Binance, the fetch/WS
  // simply fails and the caller falls back to the simulated curve.
  var REST_BASE = "https://api.binance.com";
  var WS_BASE = "wss://stream.binance.com:9443/ws";
  var DEFAULT_INTERVAL = "1m";
  var DEFAULT_LIMIT = 200;

  var _sockets = []; // active WebSockets, for stopAll()

  function isReal(symbol) { return !!CRYPTO[String(symbol || "").toUpperCase()]; }
  function mapSymbol(symbol) { return CRYPTO[String(symbol || "").toUpperCase()] || null; }

  // ── REST history: returns Promise<Array<candle>> or null on failure ───────
  function klines(symbol, opts) {
    opts = opts || {};
    var bsym = mapSymbol(symbol);
    if (!bsym) return Promise.resolve(null);
    var interval = opts.interval || DEFAULT_INTERVAL;
    var limit = Math.max(10, Math.min(1000, opts.limit || DEFAULT_LIMIT));
    var url = REST_BASE + "/api/v3/klines?symbol=" + encodeURIComponent(bsym) +
      "&interval=" + encodeURIComponent(interval) + "&limit=" + limit;

    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var to = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 9000) : null;

    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) { if (!r.ok) throw new Error("binance " + r.status); return r.json(); })
      .then(function (arr) {
        if (to) clearTimeout(to);
        if (!Array.isArray(arr)) return null;
        var out = [];
        for (var i = 0; i < arr.length; i++) {
          var k = arr[i];
          // [ openTime, open, high, low, close, volume, closeTime, ... ]
          var t = Math.floor(Number(k[0]) / 1000);
          var o = Number(k[1]), h = Number(k[2]), l = Number(k[3]), c = Number(k[4]);
          if (!isFinite(t) || !isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
          out.push({ time: t, open: o, high: h, low: l, close: c });
        }
        return out.length ? out : null;
      })
      .catch(function (e) {
        if (to) clearTimeout(to);
        return null; // caller falls back to simulated/signal-derived
      });
  }

  // ── live WebSocket candles. Returns a stop() function, or null if not real ──
  // onCandle({ time, open, high, low, close, closed }) is called on each update.
  function subscribe(symbol, intervalOrCb, maybeCb) {
    var interval = (typeof intervalOrCb === "string") ? intervalOrCb : DEFAULT_INTERVAL;
    var onCandle = (typeof intervalOrCb === "function") ? intervalOrCb : maybeCb;
    if (typeof onCandle !== "function") return null;
    var bsym = mapSymbol(symbol);
    if (!bsym || typeof WebSocket === "undefined") return null;

    var stream = bsym.toLowerCase() + "@kline_" + interval;
    var url = WS_BASE + "/" + stream;
    var ws = null, stopped = false, retried = false;

    function open() {
      try { ws = new WebSocket(url); } catch (e) { return; }
      _sockets.push(ws);
      ws.onmessage = function (ev) {
        if (stopped) return;
        var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        var k = msg && msg.k; if (!k) return;
        var t = Math.floor(Number(k.t) / 1000);
        var o = Number(k.o), h = Number(k.h), l = Number(k.l), c = Number(k.c);
        if (!isFinite(t) || !isFinite(c)) return;
        try { onCandle({ time: t, open: o, high: h, low: l, close: c, closed: !!k.x }); } catch (e) {}
      };
      ws.onclose = function () {
        removeSock(ws);
        if (stopped || retried) return;
        retried = true; // one reconnect attempt, then give up (caller still has REST history)
        setTimeout(function () { if (!stopped) open(); }, 1500);
      };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    }
    open();

    return function stop() {
      stopped = true;
      try { if (ws) ws.close(); } catch (e) {}
      removeSock(ws);
    };
  }

  function removeSock(ws) {
    var i = _sockets.indexOf(ws);
    if (i >= 0) _sockets.splice(i, 1);
  }
  function stopAll() {
    for (var i = _sockets.length - 1; i >= 0; i--) {
      try { _sockets[i].close(); } catch (e) {}
    }
    _sockets.length = 0;
  }

  window.dqQORealPrice = {
    isReal: isReal,
    mapSymbol: mapSymbol,
    klines: klines,
    subscribe: subscribe,
    stopAll: stopAll,
  };
})();

/* ===========================================================================
 * qo-chart.js — TradingView Lightweight Charts wrapper for Quant Option
 * ---------------------------------------------------------------------------
 * Isolated, dependency-free wrapper around TradingView's FREE (Apache-2.0)
 * Lightweight Charts library — the same look as TradingView (crosshair, real
 * price/time axes, candlesticks) WITHOUT any license or the Pine engine. The
 * library is loaded lazily from a CDN, pinned to v4 so the API can't drift onto
 * v5's breaking series API. If the CDN is blocked, ensureLib() rejects and the
 * caller falls back to the built-in canvas renderer — nothing breaks.
 *
 * This file renders nothing on its own and modifies no existing code. It only
 * exposes a small controller used by the signal chart:
 *
 *   await window.dqQOChart.ensureLib();              // load lib (cached)
 *   const ch = window.dqQOChart.create(el, opts);    // null if lib unavailable
 *   ch.setMode('candle'|'line');
 *   ch.setData([{time,open,high,low,close}]);         // seconds-based time
 *   ch.update({time,open,high,low,close});            // live tick
 *   ch.setLevels({entry,target,stop});                // entry/TP/SL price lines
 *   ch.fit(); ch.resize(w,h); ch.destroy();
 *
 * Exposes: window.dqQOChart = { ensureLib, available, create }
 * =========================================================================== */
(function () {
  "use strict";
  if (window.dqQOChart) return;

  // Pinned to the v4 major (not v5) so addCandlestickSeries()/addLineSeries()
  // stay valid; unpkg resolves to the latest 4.x so an exact patch can't 404.
  var CDN = "https://unpkg.com/lightweight-charts@4/dist/lightweight-charts.standalone.production.js";
  var _libPromise = null;

  function available() { return typeof window.LightweightCharts !== "undefined"; }

  // Inject the library <script> once; resolve when window.LightweightCharts is
  // present. Rejects on load error or timeout so callers can fall back.
  function ensureLib() {
    if (available()) return Promise.resolve(true);
    if (_libPromise) return _libPromise;
    _libPromise = new Promise(function (resolve, reject) {
      var existing = document.getElementById("qo-lwc-lib");
      if (existing) {
        existing.addEventListener("load", function () { resolve(true); });
        existing.addEventListener("error", function () { reject(new Error("lib load failed")); });
        if (available()) resolve(true);
        return;
      }
      var s = document.createElement("script");
      s.id = "qo-lwc-lib";
      s.src = CDN;
      s.async = true;
      var to = setTimeout(function () { reject(new Error("lib load timeout")); }, 12000);
      s.onload = function () { clearTimeout(to); available() ? resolve(true) : reject(new Error("lib missing after load")); };
      s.onerror = function () { clearTimeout(to); reject(new Error("lib load error")); };
      document.head.appendChild(s);
    }).catch(function (e) { _libPromise = null; throw e; });
    return _libPromise;
  }

  // Infer a pip size from a symbol so TP/SL labels can show "+N pips".
  function pipSizeFor(symbol) {
    var s = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!s) return null;
    if (/JPY/.test(s)) return 0.01;                              // JPY pairs: 1 pip = 0.01
    if (/^XAU|^GOLD/.test(s)) return 0.1;                        // gold
    if (/^XAG|^SILVER/.test(s)) return 0.01;                     // silver
    if (/(USDT|BUSD|USDC)$/.test(s) && s.length > 6) return null; // crypto: pips not meaningful
    if (/^[A-Z]{6}$/.test(s)) return 0.0001;                     // 6-letter FX major
    return null;
  }
  function fmtPips(delta, pip) {
    if (pip == null || !isFinite(delta)) return null;
    return (delta >= 0 ? "+" : "-") + Math.round(Math.abs(delta) / pip) + "p";
  }

  // opts: { colors:{bg,text,grid,up,down,entry,target,stop}, mode:'candle'|'line' }
  function create(container, opts) {
    if (!available() || !container) return null;
    opts = opts || {};
    var c = opts.colors || {};
    var LWC = window.LightweightCharts;
    var DASH = (LWC.LineStyle && LWC.LineStyle.Dashed != null) ? LWC.LineStyle.Dashed : 2;

    var chart, candleSeries = null, lineSeries = null;
    var mode = opts.mode === "line" ? "line" : "candle";
    var lastData = [];           // retained so a mode switch can re-feed
    var levels = null;           // {entry,target,stop}
    var priceLines = [];
    var markers = [];

    try {
      chart = LWC.createChart(container, {
        width: container.clientWidth || 320,
        height: container.clientHeight || 240,
        layout: { background: { color: "transparent" }, textColor: c.text || "#9fb0cc", fontFamily: "Outfit, system-ui, sans-serif", attributionLogo: false },
        grid: { vertLines: { color: c.grid || "rgba(120,150,200,.07)" }, horzLines: { color: c.grid || "rgba(120,150,200,.07)" } },
        rightPriceScale: { borderColor: c.grid || "rgba(120,150,200,.12)" },
        timeScale: { borderColor: c.grid || "rgba(120,150,200,.12)", timeVisible: true, secondsVisible: false },
        crosshair: { mode: (LWC.CrosshairMode && LWC.CrosshairMode.Normal != null) ? LWC.CrosshairMode.Normal : 0 },
        handleScroll: true, handleScale: true,
      });
    } catch (e) { return null; }

    // Keep the chart sized to its container. On mobile (and any late-layout
    // case) clientWidth can be 0 at creation, leaving the chart blank/collapsed;
    // the observer resizes it the moment the container has real dimensions.
    var ro = null;
    function syncSize() { try { chart.resize(container.clientWidth || 320, container.clientHeight || 240); } catch (e) {} }
    if (typeof ResizeObserver !== "undefined") {
      try { ro = new ResizeObserver(function () { syncSize(); }); ro.observe(container); } catch (e) { ro = null; }
    } else {
      try { setTimeout(syncSize, 60); } catch (e) {}
    }

    function makeSeries() {
      if (mode === "candle") {
        candleSeries = chart.addCandlestickSeries({
          upColor: c.up || "#22c55e", downColor: c.down || "#f43f5e",
          borderUpColor: c.up || "#22c55e", borderDownColor: c.down || "#f43f5e",
          wickUpColor: c.up || "#22c55e", wickDownColor: c.down || "#f43f5e",
        });
      } else {
        lineSeries = chart.addLineSeries({ color: c.up || "#3b82f6", lineWidth: 2 });
      }
    }
    function activeSeries() { return mode === "candle" ? candleSeries : lineSeries; }
    function toLine(candles) { return candles.map(function (k) { return { time: k.time, value: k.close }; }); }

    function applyData() {
      var s = activeSeries(); if (!s) return;
      try { s.setData(mode === "candle" ? lastData : toLine(lastData)); } catch (e) {}
      applyLevels();
      applyMarkers();
    }
    function applyMarkers() {
      var s = activeSeries(); if (!s) return;
      try { s.setMarkers(markers || []); } catch (e) {}
    }
    function clearLevels() {
      var s = activeSeries(); if (!s) { priceLines = []; return; }
      for (var i = 0; i < priceLines.length; i++) { try { s.removePriceLine(priceLines[i]); } catch (e) {} }
      priceLines = [];
    }
    function applyLevels() {
      clearLevels();
      var s = activeSeries(); if (!s || !levels) return;
      var lv = levels;
      var pip = (lv.pip != null) ? Number(lv.pip) : pipSizeFor(lv.symbol);
      var entry = Number(lv.entry);
      var risk = (isFinite(entry) && lv.stop != null && isFinite(Number(lv.stop))) ? Math.abs(entry - Number(lv.stop)) : null;
      function tpTitle(name, price) {
        var bits = [name];
        if (isFinite(entry) && isFinite(price)) {
          var pp = fmtPips(price - entry, pip); if (pp) bits.push(pp);
          if (risk && risk > 0) bits.push("R " + (Math.round((Math.abs(price - entry) / risk) * 10) / 10));
        }
        return bits.join(" ");
      }
      function slTitle(price) {
        var bits = ["STOP"];
        if (isFinite(entry) && isFinite(price)) { var pp = fmtPips(price - entry, pip); if (pp) bits.push(pp); }
        return bits.join(" ");
      }
      var tp1 = (lv.tp1 != null) ? lv.tp1 : lv.target;
      var defs = [
        { price: lv.entry, color: c.entry || "#ffcf5a", title: "ENTRY", w: 2 },
        { price: tp1,      color: "#22c55e", title: tpTitle("TP1", Number(tp1)), w: 1 },
        { price: lv.tp2,   color: "#15c07a", title: tpTitle("TP2", Number(lv.tp2)), w: 1 },
        { price: lv.tp3,   color: "#0fb872", title: tpTitle("TP3", Number(lv.tp3)), w: 1 },
        { price: lv.stop,  color: c.stop || "#f43f5e", title: slTitle(Number(lv.stop)), w: 1 },
      ];
      for (var i = 0; i < defs.length; i++) {
        var d = defs[i]; if (d.price == null || !isFinite(Number(d.price))) continue;
        try {
          priceLines.push(s.createPriceLine({
            price: Number(d.price), color: d.color, lineWidth: d.w, lineStyle: DASH,
            axisLabelVisible: true, title: d.title,
          }));
        } catch (e) {}
      }
    }

    makeSeries();

    return {
      setMode: function (m) {
        var next = m === "line" ? "line" : "candle";
        if (next === mode) return;
        clearLevels();
        try { if (candleSeries) { chart.removeSeries(candleSeries); candleSeries = null; } } catch (e) {}
        try { if (lineSeries) { chart.removeSeries(lineSeries); lineSeries = null; } } catch (e) {}
        mode = next; makeSeries(); applyData();
      },
      setData: function (candles) { lastData = Array.isArray(candles) ? candles.slice() : []; applyData(); },
      update: function (candle) {
        if (!candle) return;
        // keep lastData coherent so a later mode switch still has history
        if (lastData.length && lastData[lastData.length - 1].time === candle.time) lastData[lastData.length - 1] = candle;
        else lastData.push(candle);
        var s = activeSeries(); if (!s) return;
        try { s.update(mode === "candle" ? candle : { time: candle.time, value: candle.close }); } catch (e) {}
      },
      setLevels: function (lv) { levels = lv || null; applyLevels(); },
      clearLevels: function () { levels = null; clearLevels(); },
      setMarkers: function (arr) { markers = Array.isArray(arr) ? arr.slice() : []; applyMarkers(); },
      clearMarkers: function () { markers = []; applyMarkers(); },
      fit: function () { try { chart.timeScale().fitContent(); } catch (e) {} },
      resize: function (w, h) {
        try { chart.resize(w || container.clientWidth, h || container.clientHeight); } catch (e) {}
      },
      destroy: function () { if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; } try { chart.remove(); } catch (e) {} chart = candleSeries = lineSeries = null; priceLines = []; markers = []; },
    };
  }

  window.dqQOChart = { ensureLib: ensureLib, available: available, create: create };
})();

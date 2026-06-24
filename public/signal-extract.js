/* ============================================================================
   DrFX Quant — Deterministic Signal Extraction  (window.DQSignal / require)
   ----------------------------------------------------------------------------
   A dependency-free, rules-based extractor that turns informal trade talk into
   a structured (advisory) signal. NO machine learning, NO network, NO build
   step. One file, loaded two ways:

     • Browser:  <script src="/signal-extract.js">  →  window.DQSignal
     • Node:     const DQSignal = require("../public/signal-extract.js")

   Loading it in BOTH places on purpose: the in-chat "Auto-detected" card and
   the server-derived /signals feed run the EXACT same logic, so what a user
   sees under a message is exactly what the feed would derive.

   Public API:
     DQSignal.extract(text) -> null | {
       detected   : true,                 // cleared the minimum bar
       level      : "detected"|"possible",
       label      : "Detected signal"|"Possible signal",
       confidence : 0..1,
       symbol     : "XAUUSD",             // canonical
       direction  : "long"|"short",
       entry      : Number|null,
       sl         : Number|null,
       tp         : Number|null,
       matched    : { symbol, direction, entry, sl, tp }  // booleans
     }

   Design rules (intentionally conservative — see the project brief):
     • Minimum to report ANYTHING = a symbol AND a direction. A bare price or a
       lone "buy" is NOT a signal (avoids aggressive false positives).
     • entry present pushes it to "Detected"; missing entry stays "Possible".
     • This is ADVISORY only — it never rewrites the message; the caller shows
       the original text primary and this as an expandable chip underneath.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;     // Node
  if (typeof window !== "undefined") window.DQSignal = api;                    // Browser
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERSION = "1.0.0";
  var MAX_LEN = 280; // signals are short; don't scan walls of prose

  // ── Symbol dictionary: informal/multilingual alias -> canonical symbol ────
  // Latin aliases are lower-cased; non-Latin (fa/ar/ru/hi) kept verbatim.
  // Extend freely — it's just data.
  var SYMBOL_GROUPS = {
    BTCUSDT: ["btc", "btcusd", "btcusdt", "xbt", "bitcoin", "بیت", "بیتکوین", "بیت‌کوین", "بتکوین", "بیتکوین", "بِتکوین", "биткоин", "битка", "битк", "бит", "биток", "बिटकॉइन", "बीटीसी"],
    ETHUSDT: ["eth", "ethusd", "ethusdt", "ether", "ethereum", "اتریوم", "اتر", "اِتریوم", "эфир", "эфириум", "эфирка", "इथेरियम", "ईथीरियम", "ईटीएच"],
    SOLUSDT: ["sol", "solusd", "solusdt", "solana", "سولانا", "سول", "солана", "सोलाना"],
    XRPUSDT: ["xrp", "xrpusd", "xrpusdt", "ripple", "ریپل", "рипл", "रिपल"],
    BNBUSDT: ["bnb", "bnbusd", "bnbusdt", "binancecoin", "بایننس", "бнб", "बीएनबी"],
    DOGEUSDT: ["doge", "dogeusd", "dogeusdt", "dogecoin", "دوج", "догикоин", "дож", "डॉज"],
    XAUUSD: ["xau", "xauusd", "gold", "gld", "طلا", "طلای", "طلا‌", "زر", "золото", "голд", "सोना", "गोल्ड"],
    XAGUSD: ["xag", "xagusd", "silver", "نقره", "سیلور", "серебро", "चांदी", "सिल्वर"],
    EURUSD: ["eurusd", "eur", "euro", "eur/usd", "یورو", "евро", "евра", "यूरो"],
    GBPUSD: ["gbpusd", "gbp", "cable", "pound", "پوند", "گبپ", "фунт", "кабель", "पाउंड"],
    USDJPY: ["usdjpy", "jpy", "yen", "ین", "ин", "йена", "иена", "येन"],
    AUDUSD: ["audusd", "aud", "aussie", "دلار استرالیا", "оззи", "австралиец"],
    USDCAD: ["usdcad", "cad", "loonie", "دلار کانادا", "канадец"],
    USDCHF: ["usdchf", "chf", "swissy", "فرانک", "франк"],
    NZDUSD: ["nzdusd", "nzd", "kiwi", "دلار نیوزیلند", "киви"],
    GBPJPY: ["gbpjpy", "guppy", "پوند ین"],
    EURJPY: ["eurjpy", "یورو ین"],
    NAS100: ["nas100", "nasdaq", "nas", "ndx", "us100", "ustec", "ناسداک", "نزدک", "насдак", "наздак", "нэсдак", "नैस्डैक", "नैसडैक"],
    SPX500: ["spx500", "spx", "sp500", "us500", "spx/usd", "اس‌پی", "اس پی 500", "эсэндпи", "сипи", "एसपी500"],
    US30: ["us30", "dji", "dow", "dowjones", "dow30", "wallstreet", "داوجونز", "داو", "доу", "доу-джонс", "डाओ"],
    GER40: ["ger40", "de40", "dax", "dax40", "germany40", "دکس", "دکس40", "дакс", "डैक्स"],
    UK100: ["uk100", "ftse", "ftse100", "فوتسی", "футси"],
    JP225: ["jp225", "nikkei", "nik225", "نیکی", "никкей"],
    USOIL: ["usoil", "oil", "wti", "crude", "cl", "نفت", "نفت خام", "нефть", "ойл", "тел", "तेल", "क्रूड"],
    UKOIL: ["ukoil", "brent", "برنت", "брент", "ब्रेंट"],
    NATGAS: ["natgas", "naturalgas", "ng", "گاز", "газ"]
  };

  // Flatten to alias -> canonical (lower-cased Latin keys; non-Latin verbatim).
  var SYMBOL_MAP = {};
  Object.keys(SYMBOL_GROUPS).forEach(function (canon) {
    SYMBOL_GROUPS[canon].forEach(function (alias) {
      SYMBOL_MAP[String(alias).toLowerCase()] = canon;
    });
    SYMBOL_MAP[canon.toLowerCase()] = canon; // canonical matches itself
  });

  // ── Direction keywords (multilingual) ────────────────────────────────────
  var LONG_WORDS = [
    "long", "buy", "buying", "bought", "bullish", "bull", "longed",
    "خرید", "بخر", "بخرید", "لانگ", "لانگ‌", "صعودی", "خریدن",
    "лонг", "купить", "покупка", "покупаю", "лонгую", "вверх", "бычий",
    "شراء", "اشتري", "اشترِ", "صاعد", "شراءه",
    "लांग", "लॉन्ग", "खरीद", "खरीदो", "खरीदें", "तेजी"
  ];
  var SHORT_WORDS = [
    "short", "sell", "selling", "sold", "bearish", "bear", "shorted",
    "فروش", "بفروش", "بفروشید", "شورت", "شورت‌", "نزولی", "فروختن",
    "шорт", "продать", "продажа", "продаю", "шорчу", "вниз", "медвежий",
    "بيع", "بِيع", "بع", "هابط", "بيعه",
    "शॉर्ट", "शोर्ट", "बेच", "बेचो", "बेचें", "मंदी"
  ];

  // ── Labeled-number keyword sets (for SL / TP / explicit entry) ────────────
  var SL_WORDS = ["sl", "s/l", "stop loss", "stop-loss", "stoploss", "stop",
    "استاپ", "استوپ", "حد ضرر", "حدضرر", "استاپ لاس",
    "стоп", "стоплосс", "стоп лосс",
    "وقف الخسارة", "وقف",
    "स्टॉप लॉस", "स्टॉपलॉस", "स्टॉप"];
  var TP_WORDS = ["tp", "t/p", "take profit", "take-profit", "takeprofit", "target", "tgt", "tp1",
    "تارگت", "تارگ", "حد سود", "حدسود", "هدف", "تی پی",
    "тейк", "тейк профит", "тп", "цель",
    "الهدف", "جني الأرباح", "هدف الربح",
    "टारगेट", "टीपी", "लक्ष्य"];
  var ENTRY_WORDS = ["entry", "enter", "entries", "entry point", "buy", "sell", "long", "short", "price", "at", "@",
    "ورود", "ورودی", "نقطه ورود", "قیمت", "ورود قیمت",
    "вход", "цена", "точка входа",
    "دخول", "سعر", "نقطة الدخول",
    "एंट्री", "प्रवेश", "कीमत"];

  // ── Confidence weights & thresholds ───────────────────────────────────────
  var W = { symbol: 0.45, direction: 0.35, entry: 0.20, sl: 0.05, tp: 0.05 };
  var DETECTED_AT = 0.85;  // >= -> "Detected signal", else "Possible signal"

  // ── helpers ───────────────────────────────────────────────────────────────
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  // Build an alternation that matches any keyword, allowing flexible internal
  // whitespace ("stop  loss" === "stop loss").
  function altSource(words) {
    return words
      .slice()
      .sort(function (a, b) { return b.length - a.length; }) // longest-first so "stop loss" beats "stop"
      .map(function (w) { return escapeRe(w).replace(/\s+/g, "\\s*"); })
      .join("|");
  }

  var NUM = "\\d{1,3}(?:[,\\u066c]\\d{3})+(?:[.\\u066b]\\d+)?|\\d+(?:[.\\u066b]\\d+)?"; // 76800 | 2,415.50 | 1.0855 (also Arabic-Indic separators)
  var NUM_RE = new RegExp(NUM, "g");
  var SL_RE = new RegExp("(?:" + altSource(SL_WORDS) + ")\\s*[:=\\-]?\\s*(" + NUM + ")", "i");
  var TP_RE = new RegExp("(?:" + altSource(TP_WORDS) + ")\\s*[:=\\-]?\\s*(" + NUM + ")", "i");
  var ENTRY_RE = new RegExp("(?:" + altSource(ENTRY_WORDS) + ")\\s*[:=@]?\\s*(" + NUM + ")", "i");

  // ── Timeframe detection ──
  // Matches "15m", "1h", "4h", "1d", "1w", MT-style "M15/H1/H4/D1/W1" (leading
  // letter = unit, M = minute), and worded "15 min", "4 hour(s)", "daily/weekly/
  // monthly". Canonical output: <n><unit>, unit in m|h|d|w|mo (e.g. "15m","4h",
  // "1d","1w","1mo"). Detected so the scoreboard can group by timeframe, and so a
  // timeframe number (the 15 in "15m") is never mistaken for an entry price.
  var TF_RE = new RegExp(
    "\\b(" +
      "\\d{1,3}\\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months)" +
      "|(?:m|h|d|w)\\s*\\d{1,3}" +
      "|daily|weekly|monthly" +
    ")\\b", "i"
  );

  function toNum(str) {
    if (str == null) return null;
    // normalize Arabic-Indic digits + separators, strip thousands commas.
    var s = String(str)
      .replace(/[\u0660-\u0669]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
      .replace(/[\u06f0-\u06f9]/g, function (d) { return String(d.charCodeAt(0) - 0x06f0); })
      .replace(/\u066b/g, ".").replace(/\u066c/g, ",")
      .replace(/,/g, "");
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  // Canonicalize a raw timeframe substring to "<n><unit>" (m|h|d|w|mo) or null.
  function canonTF(s) {
    var m = String(s).toLowerCase().replace(/\s+/g, "");
    if (m === "daily") return "1d";
    if (m === "weekly") return "1w";
    if (m === "monthly") return "1mo";
    var n = null, u = null, a = m.match(/^(\d{1,3})(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months)$/);
    if (a) { n = a[1]; u = a[2]; }
    else { var b = m.match(/^(m|h|d|w)(\d{1,3})$/); if (b) { u = b[1]; n = b[2]; } }
    if (!n || !u) return null;
    var unit = (u.charAt(0) === "m" && (u === "mo" || u.indexOf("month") === 0)) ? "mo" : u.charAt(0);
    return n + unit;
  }

  // Find the first timeframe mention; returns { tf, span:[start,end] } or null.
  function detectTimeframe(text) {
    TF_RE.lastIndex = 0;
    var m = TF_RE.exec(text);
    if (!m) return null;
    var tf = canonTF(m[1]);
    if (!tf) return null;
    return { tf: tf, span: [m.index, m.index + m[0].length] };
  }

  // Tokenize keeping byte offsets so we can blank a matched symbol before the
  // numeric pass (prevents "nas100" donating "100" as an entry).
  var TOKEN_RE = /[^\s,;:!?()[\]{}"'\/\\|]+/g;
  function tokens(text) {
    var out = [], m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text)) !== null) out.push({ t: m[0], i: m.index });
    return out;
  }

  function lookupSymbol(tok) {
    var raw = tok.toLowerCase();
    if (SYMBOL_MAP[raw]) return SYMBOL_MAP[raw];
    var stripped = raw.replace(/[^a-z0-9\u0600-\u06ff\u0900-\u097f\u0400-\u04ff]/g, "");
    if (stripped && SYMBOL_MAP[stripped]) return SYMBOL_MAP[stripped];
    return null;
  }

  function matchWord(tok, set) {
    var raw = tok.toLowerCase();
    if (set.indexOf(raw) >= 0) return raw;
    var stripped = raw.replace(/[^a-z\u0600-\u06ff\u0900-\u097f\u0400-\u04ff]/g, "");
    return stripped && set.indexOf(stripped) >= 0 ? stripped : null;
  }

  function extract(text) {
    if (text == null) return null;
    var str = String(text).trim();
    if (!str || str.length > MAX_LEN) return null;
    // Skip our own already-formatted signal messages (webhook/manual/bot output).
    if (/tradingview\s*signal/i.test(str) || /^📡/.test(str) || /god\s*mode/i.test(str)) return null; // skip our own formatted signal / GOD MODE bot posts

    var toks = tokens(str);

    // 1) symbol + direction via token scan (first hit wins)
    var symbol = null, symbolSpan = null, direction = null;
    for (var i = 0; i < toks.length; i++) {
      if (!symbol) {
        var hit = lookupSymbol(toks[i].t);
        if (hit) { symbol = hit; symbolSpan = [toks[i].i, toks[i].i + toks[i].t.length]; continue; }
      }
      if (!direction) {
        if (matchWord(toks[i].t, LONG_WORDS)) direction = "long";
        else if (matchWord(toks[i].t, SHORT_WORDS)) direction = "short";
      }
    }
    // also let direction be found even if it appeared before the symbol token
    if (!direction) {
      for (var j = 0; j < toks.length; j++) {
        if (matchWord(toks[j].t, LONG_WORDS)) { direction = "long"; break; }
        if (matchWord(toks[j].t, SHORT_WORDS)) { direction = "short"; break; }
      }
    }

    // Minimum bar: need BOTH a symbol and a direction, else it's not a signal.
    if (!symbol || !direction) return null;

    // 2) numbers — work on a copy with the symbol token blanked out.
    var numText = str;
    if (symbolSpan) {
      numText = str.slice(0, symbolSpan[0]) + " ".repeat(symbolSpan[1] - symbolSpan[0]) + str.slice(symbolSpan[1]);
    }

    // Timeframe: detect on the symbol-blanked text, capture it, and blank its
    // span too so its digits can't be picked up as an entry/SL/TP number.
    var timeframe = null;
    var tfInfo = detectTimeframe(numText);
    if (tfInfo) {
      timeframe = tfInfo.tf;
      numText = numText.slice(0, tfInfo.span[0]) + " ".repeat(tfInfo.span[1] - tfInfo.span[0]) + numText.slice(tfInfo.span[1]);
    }

    var sl = null, tp = null, entry = null;
    var slM = SL_RE.exec(numText); SL_RE.lastIndex = 0;
    var tpM = TP_RE.exec(numText); TP_RE.lastIndex = 0;
    var slSpan = slM ? [slM.index, slM.index + slM[0].length] : null;
    var tpSpan = tpM ? [tpM.index, tpM.index + tpM[0].length] : null;
    if (slM) sl = toNum(slM[1]);
    if (tpM) tp = toNum(tpM[1]);

    // entry: explicit label first…
    var enM = ENTRY_RE.exec(numText); ENTRY_RE.lastIndex = 0;
    var enSpan = enM ? [enM.index, enM.index + enM[0].length] : null;
    var inSpan = function (idx, span) { return span && idx >= span[0] && idx < span[1]; };
    if (enM && !inSpan(enM.index, slSpan) && !inSpan(enM.index, tpSpan)) {
      entry = toNum(enM[1]);
    } else {
      // …otherwise the first bare number that isn't part of the SL/TP clause.
      var nm;
      NUM_RE.lastIndex = 0;
      while ((nm = NUM_RE.exec(numText)) !== null) {
        var at = nm.index;
        if (inSpan(at, slSpan) || inSpan(at, tpSpan)) continue;
        entry = toNum(nm[0]);
        break;
      }
    }

    // 3) confidence
    var matched = { symbol: !!symbol, direction: !!direction, entry: entry != null, sl: sl != null, tp: tp != null };
    var conf = 0;
    if (matched.symbol) conf += W.symbol;
    if (matched.direction) conf += W.direction;
    if (matched.entry) conf += W.entry;
    if (matched.sl) conf += W.sl;
    if (matched.tp) conf += W.tp;
    if (conf > 1) conf = 1;
    conf = Math.round(conf * 100) / 100;

    var level = conf >= DETECTED_AT ? "detected" : "possible";

    return {
      detected: true,
      level: level,
      label: level === "detected" ? "Detected signal" : "Possible signal",
      confidence: conf,
      symbol: symbol,
      direction: direction,
      entry: entry,
      sl: sl,
      tp: tp,
      timeframe: timeframe,
      matched: matched
    };
  }

  return {
    version: VERSION,
    extract: extract,
    // exposed for debugging / extension / tests
    SYMBOL_MAP: SYMBOL_MAP,
    LONG_WORDS: LONG_WORDS,
    SHORT_WORDS: SHORT_WORDS
  };
});

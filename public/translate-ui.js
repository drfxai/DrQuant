/* ============================================================================
   DrFX Quant — Chat translation UI  (window.dqTranslate)
   ----------------------------------------------------------------------------
   Loaded in the browser as /translate-ui.js. Adds, with a tiny index.html
   footprint, an advisory translation layer to chat:

     • a globe control in the chat header (shown only when the engine is up)
     • a per-message "Translate" action (in the long-press menu)
     • an optional AUTO mode that translates incoming foreign-language messages

   Hard rules (project brief):
     • ADVISORY / display-only. The ORIGINAL message is always shown; the
       translation is appended UNDER it. Nothing overwrites the message.
     • DEGRADES QUIETLY. If /translate/status says the engine is down, the
       globe + menu action stay hidden and chat is completely unaffected.

   Persistence: language + auto toggle are saved server-side (POST /translate/
   prefs) with a localStorage MIRROR for instant load. The server is the source
   of truth; localStorage just avoids a first-paint flash.

   Page globals reused (classic scripts share one scope): t, esc, ic, api, S,
   modal, showToast, fmtMsg.
   ========================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined") return;

  var LS_KEY = "dq_tr_prefs";
  var prefs = { lang: "", auto: false };
  var _status = { available: false, languages: [], loaded: false };
  var _cache = {};   // "id|lang" -> { translated, source_lang, same } | { translated:null, reason }
  var _shown = {};   // id -> true (translation currently displayed)
  var _queue = [], _active = 0, MAX_CONC = 4;

  var LANG_NAMES = { en: "English", ru: "Русский", fa: "فارسی", ar: "العربية", hi: "हिन्दी", es: "Español", fr: "Français", de: "Deutsch", tr: "Türkçe", zh: "中文", pt: "Português", it: "Italiano", nl: "Nederlands", pl: "Polski", uk: "Українська", id: "Bahasa Indonesia", ur: "اردو" };
  var CORE = ["en", "ru", "fa", "ar", "hi"];
  var RTL = ["fa", "ar", "ur", "ps", "he"];

  function langName(code) { code = String(code || "").toLowerCase(); return LANG_NAMES[code] || code.toUpperCase(); }
  function api2(p, o) { return (typeof api === "function") ? api(p, o) : Promise.reject(new Error("no api")); }
  function findMsg(id) { try { return (S.chatMsgs || []).find(function (m) { return m.id === id; }); } catch (e) { return null; } }
  function mcEl(id) { var mc = document.getElementById("cv-msgs"); return mc ? mc.querySelector('[data-mid="' + id + '"]') : null; }
  function available() { return _status.available; }

  function defaultLang() { try { var n = (navigator.language || "en").slice(0, 2).toLowerCase(); return /^[a-z]{2}$/.test(n) ? n : "en"; } catch (e) { return "en"; } }
  function loadLocal() {
    try { var raw = localStorage.getItem(LS_KEY); if (raw) { var p = JSON.parse(raw); if (p && typeof p === "object") { prefs.lang = p.lang || ""; prefs.auto = !!p.auto; } } } catch (e) {}
    if (!prefs.lang) prefs.lang = defaultLang();
  }
  function saveLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify({ lang: prefs.lang, auto: prefs.auto })); } catch (e) {} }
  function savePrefs() { saveLocal(); api2("/translate/prefs", { method: "POST", body: JSON.stringify({ lang: prefs.lang, auto: prefs.auto }) }).catch(function () {}); }

  function fetchStatus() {
    api2("/translate/status").then(function (d) {
      _status.available = !!(d && d.available);
      _status.languages = (d && d.languages) || [];
      _status.loaded = true;
      refreshGlobe();
    }).catch(function () { _status.loaded = true; _status.available = false; refreshGlobe(); });
  }
  function fetchPrefs() {
    api2("/translate/prefs").then(function (d) {
      if (d && typeof d === "object") {
        if (d.lang) prefs.lang = d.lang;
        prefs.auto = !!d.auto;
        saveLocal();
        var mc = document.getElementById("cv-msgs"); if (mc) onChatRender(mc);
      }
    }).catch(function () {});
  }

  // ── same-script heuristic: in AUTO mode, skip messages whose dominant script
  //    already matches the target language (the common "same language" case).
  //    Cuts engine load sharply for cross-script pairs (fa/ar/ru/hi <-> en).
  //    Manual translate (menu) bypasses this and always calls. ──
  function scriptOfLang(l) { if (RTL.indexOf(l) >= 0) return "arabic"; if (l === "hi") return "deva"; if (["ru", "uk", "bg", "sr", "mk"].indexOf(l) >= 0) return "cyrillic"; if (l === "zh" || l === "ja") return "han"; return "latin"; }
  function scriptOfText(s) { if (/[\u0600-\u06ff]/.test(s)) return "arabic"; if (/[\u0900-\u097f]/.test(s)) return "deva"; if (/[\u0400-\u04ff]/.test(s)) return "cyrillic"; if (/[\u3400-\u9fff]/.test(s)) return "han"; if (/[a-z]/i.test(s)) return "latin"; return ""; }
  function likelySame(text, lang) { var ts = scriptOfText(text); return !!ts && ts === scriptOfLang(lang); }

  // ── DOM injection (the translation block lives UNDER the original text) ──
  function removeBlock(el) { if (!el) return; var b = el.querySelector(".dqtr-block"); if (b) b.remove(); }
  function injectLoading(el) {
    if (!el) return; var src = el.querySelector(".dqtr-src"); if (!src) return;
    removeBlock(el);
    var d = document.createElement("div"); d.className = "dqtr-block";
    d.style.cssText = "margin-top:5px;padding-top:5px;border-top:1px dashed " + t.bd + ";color:" + t.t4 + ";font-size:11px;display:flex;align-items:center;gap:6px";
    d.innerHTML = '<span style="width:11px;height:11px;border:2px solid ' + t.bd + ';border-top-color:' + t.pr + ';border-radius:50%;display:inline-block;animation:dqspin .8s linear infinite"></span> translating…';
    src.parentNode.insertBefore(d, src.nextSibling);
  }
  function injectBlock(el, tr) {
    if (!el || !tr || tr.translated == null) return;
    var src = el.querySelector(".dqtr-src"); if (!src) return;
    removeBlock(el);
    var rtl = RTL.indexOf(prefs.lang) >= 0;
    var bodyHtml = (typeof fmtMsg === "function") ? fmtMsg(tr.translated) : esc(tr.translated);
    var srcLbl = tr.source_lang ? langName(tr.source_lang) : "auto";
    var globe = ic('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>', 11);
    var d = document.createElement("div"); d.className = "dqtr-block";
    d.style.cssText = "margin-top:5px;padding-top:5px;border-top:1px dashed " + t.bd;
    d.innerHTML =
      '<div class="dqtr-txt" ' + (rtl ? 'dir="rtl" ' : '') + 'style="font-size:13.5px;line-height:1.5;color:' + t.t1 + ';white-space:pre-wrap;word-break:break-word">' + bodyHtml + '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;margin-top:3px;font-size:10px;color:' + t.t4 + '">' +
        '<span style="display:inline-flex;color:' + t.t4 + '">' + globe + '</span>' +
        '<span>translated from ' + esc(srcLbl) + '</span>' +
        '<span style="flex:1"></span>' +
        '<button type="button" class="dqtr-hide" style="background:none;border:none;color:' + t.ac + ';font-size:10px;cursor:pointer;font-family:inherit;padding:0">Hide</button>' +
      '</div>';
    src.parentNode.insertBefore(d, src.nextSibling);
    var hb = d.querySelector(".dqtr-hide");
    if (hb) hb.onclick = function (e) { e.stopPropagation(); hideTranslation(parseInt(el.dataset.mid, 10)); };
  }

  // ── translate one message (toggle) ──
  function hideTranslation(id) { delete _shown[id]; removeBlock(mcEl(id)); }
  function showTranslation(id, fromAuto) {
    var msg = findMsg(id); var text = msg && msg.content;
    if (!text || !available()) return Promise.resolve();
    var key = id + "|" + prefs.lang;
    var cached = _cache[key];
    if (cached) {
      if (cached.translated != null && !cached.same) { _shown[id] = true; injectBlock(mcEl(id), cached); }
      return Promise.resolve();
    }
    if (!fromAuto) injectLoading(mcEl(id));
    return api2("/translate/message/" + id + "?to=" + encodeURIComponent(prefs.lang), { method: "POST" }).then(function (d) {
      var tr = (d && d.translated != null)
        ? { translated: d.translated, source_lang: d.source_lang || null, same: !!d.same }
        : { translated: null, reason: (d && d.reason) };
      _cache[key] = tr;
      if (d && d.reason === "unavailable") { _status.available = false; refreshGlobe(); }
      var el = mcEl(id);
      if (tr.translated != null && !tr.same) { _shown[id] = true; injectBlock(el, tr); }
      else removeBlock(el);
    }).catch(function () { removeBlock(mcEl(id)); });
  }
  function translateMessage(id) { if (_shown[id]) { hideTranslation(id); return; } showTranslation(id, false); }

  // ── concurrency-limited queue for auto-translate ──
  function enqueue(id) { if (_shown[id]) return; _queue.push(id); pump(); }
  function pump() {
    while (_active < MAX_CONC && _queue.length) {
      var id = _queue.shift();
      if (_shown[id]) continue;
      _active++;
      showTranslation(id, true).then(function () { _active--; pump(); }, function () { _active--; pump(); });
    }
  }

  // ── hooks called from index.html ──
  function onChatRender(mc) {
    refreshGlobe();
    if (!mc || !available()) return;
    // re-apply already-shown translations so they survive re-renders this session
    Object.keys(_shown).forEach(function (idStr) {
      var id = parseInt(idStr, 10); var el = mc.querySelector('[data-mid="' + id + '"]'); if (!el) return;
      var tr = _cache[id + "|" + prefs.lang]; if (tr && tr.translated != null && !tr.same) injectBlock(el, tr);
    });
    if (!prefs.auto) return;
    Array.prototype.slice.call(mc.querySelectorAll("[data-mid]")).slice(-25).forEach(function (el) {
      var id = parseInt(el.dataset.mid, 10); var msg = findMsg(id);
      if (!msg || !msg.content) return;
      if (S.user && msg.user_id === S.user.id) return; // never my own messages
      if (_shown[id] || likelySame(msg.content, prefs.lang)) return;
      enqueue(id);
    });
  }
  function onIncoming(mc, msg) {
    if (!available() || !prefs.auto || !msg || !msg.content) return;
    if (S.user && msg.user_id === S.user.id) return;
    if (likelySame(msg.content, prefs.lang)) return;
    enqueue(msg.id);
  }
  // one-shot: translate the visible foreign messages without enabling auto
  function translateConversationNow() {
    var mc = document.getElementById("cv-msgs"); if (!mc) return;
    if (!available()) { try { showToast("Translation unavailable", "The translation service isn't reachable right now."); } catch (e) {} return; }
    var n = 0;
    Array.prototype.slice.call(mc.querySelectorAll("[data-mid]")).slice(-40).forEach(function (el) {
      var id = parseInt(el.dataset.mid, 10); var msg = findMsg(id);
      if (!msg || !msg.content || _shown[id] || likelySame(msg.content, prefs.lang)) return;
      enqueue(id); n++;
    });
    if (!n) { try { showToast("Nothing to translate", "No messages in another language were found here."); } catch (e) {} }
  }

  // ── globe button in the chat header (revealed only when available) ──
  function refreshGlobe() {
    var g = document.getElementById("cv-translate"); if (!g) return;
    g.style.display = available() ? "flex" : "none";
    g.style.color = (available() && prefs.auto) ? t.pr : t.t2;
    if (!g._dqWired) { g._dqWired = true; g.onclick = openSheet; }
  }

  // ── settings sheet ──
  function openSheet() {
    if (typeof modal !== "function") return;
    modal("Translation", function (body, close) {
      var have = (_status.languages && _status.languages.length);
      var seen = {}, ordered = [];
      CORE.concat(have ? _status.languages : Object.keys(LANG_NAMES)).forEach(function (c) {
        c = String(c).toLowerCase();
        if (seen[c] || !/^[a-z]{2,5}$/.test(c)) return;
        if (have && _status.languages.indexOf(c) < 0) return;
        seen[c] = 1; ordered.push(c);
      });
      if (!ordered.length) ordered = CORE.slice();

      var langBtns = ordered.map(function (c) {
        var on = c === prefs.lang;
        return '<button type="button" class="dqtr-lang" data-l="' + c + '" style="padding:8px 12px;border-radius:10px;border:1px solid ' + (on ? t.ba : t.bd) + ';background:' + (on ? t.act : "transparent") + ';color:' + (on ? t.ac : t.t2) + ';font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">' + esc(langName(c)) + '</button>';
      }).join("");

      body.innerHTML =
        (!available() ? '<div style="margin:-4px 0 12px;padding:10px 12px;border-radius:12px;background:' + t.ta + ';border:1px solid ' + t.bd + ';color:' + t.t3 + ';font-size:12px;line-height:1.5">Translation service isn\'t reachable right now. You can still set preferences — they\'ll take effect once it\'s available.</div>' : '') +
        '<div style="color:' + t.t2 + ';font-size:12px;font-weight:700;margin-bottom:8px">Translate messages to</div>' +
        '<div id="dqtr-langs" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px">' + langBtns + '</div>' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:13px 14px;border-radius:14px;background:' + t.cd + ';border:1px solid ' + t.bd + ';margin-bottom:12px">' +
          '<div style="min-width:0"><div style="color:' + t.t1 + ';font-size:13.5px;font-weight:600">Auto-translate incoming</div><div style="color:' + t.t3 + ';font-size:11.5px;margin-top:3px;line-height:1.45">When on, messages in another language are translated automatically. The original is always kept.</div></div>' +
          '<div id="dqtr-auto" style="width:48px;height:28px;border-radius:14px;flex-shrink:0;cursor:pointer;position:relative;transition:background .2s;background:' + (prefs.auto ? t.pr : t.bl) + '"><div style="position:absolute;top:3px;left:' + (prefs.auto ? "23px" : "3px") + ';width:22px;height:22px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.35)"></div></div>' +
        '</div>' +
        '<button id="dqtr-now" class="pb" type="button" style="width:100%;margin-bottom:6px">Translate this conversation now</button>' +
        '<div style="color:' + t.t4 + ';font-size:11px;text-align:center;line-height:1.5;margin-top:8px">Translations are a convenience and may be imperfect. The original message is always shown.</div>';

      function paintLangs() { body.querySelectorAll(".dqtr-lang").forEach(function (b) { var on = b.dataset.l === prefs.lang; b.style.border = "1px solid " + (on ? t.ba : t.bd); b.style.background = on ? t.act : "transparent"; b.style.color = on ? t.ac : t.t2; }); }
      body.querySelectorAll(".dqtr-lang").forEach(function (b) {
        b.onclick = function () {
          if (prefs.lang === b.dataset.l) return;
          prefs.lang = b.dataset.l;
          _cache = {}; _shown = {};                 // cached translations were for the old language
          savePrefs(); paintLangs(); refreshGlobe();
          var mc = document.getElementById("cv-msgs");
          if (mc) { mc.querySelectorAll(".dqtr-block").forEach(function (x) { x.remove(); }); onChatRender(mc); }
        };
      });
      var tog = body.querySelector("#dqtr-auto");
      if (tog) tog.onclick = function () {
        prefs.auto = !prefs.auto; savePrefs();
        tog.style.background = prefs.auto ? t.pr : t.bl;
        var knob = tog.firstChild; if (knob) knob.style.left = prefs.auto ? "23px" : "3px";
        refreshGlobe();
        var mc = document.getElementById("cv-msgs"); if (mc) onChatRender(mc);
      };
      var nowB = body.querySelector("#dqtr-now");
      if (nowB) nowB.onclick = function () { close(); translateConversationNow(); };
    });
  }

  // ── boot ──
  loadLocal();
  fetchStatus();
  fetchPrefs();

  window.dqTranslate = {
    onChatRender: onChatRender,
    onIncoming: onIncoming,
    translateMessage: translateMessage,
    openSheet: openSheet,
    available: available,
    isShown: function (id) { return !!_shown[id]; }
  };
})();

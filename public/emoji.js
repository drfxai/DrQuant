/* ============================================================================
   DrFX Quant — Custom animated emoji set  (window.dqEmoji)
   ----------------------------------------------------------------------------
   Hand-drawn, trader-themed emojis as crisp vector SVG with looping SMIL
   animation (the same "animated vector" idea as Telegram's Lottie emojis, but
   our own original artwork — no third-party assets, no licensing concerns).

   These are referenced by short string KEYS (e.g. "rocket", "fire", "bull").
   The server stores those keys for message reactions; this file turns a key
   into an animated picture. Unknown keys fall back to a neutral dot so nothing
   ever breaks.

   Public API:
     dqEmoji.render(key, size)   -> SVG markup string (animated), sized `size`px
     dqEmoji.label(key)          -> human label (tooltip)
     dqEmoji.has(key)            -> boolean
     dqEmoji.REACTIONS           -> ordered array of keys for the reaction picker
   ========================================================================== */
(function () {
  "use strict";

  // viewBox is 0 0 36 36 for every glyph; render() scales to the requested px.
  var G = {};

  // ── 👍 like — thumbs up with a gentle tilt ──
  G.like = {
    label: "Nice",
    art:
      '<g><animateTransform attributeName="transform" type="rotate" values="0 18 22;-9 18 22;0 18 22" dur="1.4s" repeatCount="indefinite"/>' +
      '<path d="M14.5 16.5l4-8.2c.3-.7 1-1.1 1.8-1 .9.2 1.5 1 1.4 1.9l-.6 4.3h4.6c1.4 0 2.4 1.3 2 2.6l-2 6.6c-.4 1.2-1.5 2-2.8 2H14.5z" fill="#ffce4a"/>' +
      '<path d="M14.5 16.5l4-8.2c.3-.7 1-1.1 1.8-1l-1.3 5.4h6.7c.2.4.2.8.1 1.3l-2 6.6c-.4 1.2-1.5 2-2.8 2H14.5z" fill="#ffc02e"/>' +
      '<rect x="8.6" y="16" width="5" height="9.3" rx="1.6" fill="#ffb01f"/>' +
      '<rect x="8.6" y="16" width="2.2" height="9.3" rx="1.1" fill="#ffc84a"/></g>'
  };

  // ── ❤️ heart — beating ──
  G.heart = {
    label: "Love",
    art:
      '<g><animateTransform attributeName="transform" type="scale" values="1 1;1.14 1.14;0.97 0.97;1 1" dur="1.1s" repeatCount="indefinite" additive="sum"/>' +
      '<g transform="translate(-2.6 -2.6)">' +
      '<path d="M18 30S5.5 22.6 5.5 14.2C5.5 10 8.6 7 12.4 7c2.4 0 4.5 1.3 5.6 3.2C19.1 8.3 21.2 7 23.6 7c3.8 0 6.9 3 6.9 7.2C30.5 22.6 18 30 18 30z" fill="#ff4d6d"/>' +
      '<path d="M12.4 7c2.4 0 4.5 1.3 5.6 3.2C16.9 12 14.5 13.5 12 13.5c-2.2 0-3.9-1-4.9-2.6C8 8.5 10 7 12.4 7z" fill="#ff7a90" opacity=".85"/>' +
      '</g></g>'
  };

  // ── 🔥 fire — flickering flame ──
  G.fire = {
    label: "Fire",
    art:
      '<g>' +
      '<path d="M18 4c1.2 3 0 5.2-1.6 7.2-1.7 2.1-3.9 4-3.9 7.6 0 4.6 3.4 8.2 5.5 8.2s5.5-3.6 5.5-8.2c0-2.2-.8-3.7-1.6-5.1 2 1.1 3.3 3 3.3 6.3 0 5.2-4.2 9-7.2 9-3.8 0-8-3.8-8-9C12 11 16.6 8.6 18 4z" fill="#ff7a1a">' +
      '<animateTransform attributeName="transform" type="scale" values="1 1;1.06 0.92;0.96 1.06;1 1" dur="0.7s" repeatCount="indefinite" additive="sum"/></path>' +
      '<path d="M18 16c1 1.7 1.7 3 1.7 4.6 0 2.6-1.7 4.8-3.7 4.8-1.6 0-2.8-1.3-2.8-3 0-2.6 3-3.4 4.8-6.4z" fill="#ffd23b">' +
      '<animateTransform attributeName="transform" type="scale" values="1 1;0.9 1.1;1 1" dur="0.5s" repeatCount="indefinite" additive="sum"/></path></g>'
  };

  // ── 🚀 rocket — bobbing with a flickering flame ──
  G.rocket = {
    label: "To the moon",
    art:
      '<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -1.6;0 0" dur="1.7s" repeatCount="indefinite"/>' +
      '<path d="M18 30c-2.2 0-3.5-2-3.5-3.9 0-1.7 1.5-2.6 2-4 .7 1 .9 1.3 1.5 1.8.2-1.4.9-2.4 1.6-3.1.3 1.7 1.9 2.7 1.9 5.3C21.5 28 20.2 30 18 30z" fill="#ff9b21">' +
      '<animateTransform attributeName="transform" type="scale" values="1 1;1 0.72;1 1" dur="0.45s" repeatCount="indefinite" additive="sum"/></path>' +
      '<path d="M18 4.2c3.3 2.5 5.2 6.8 5.2 11.9 0 2.3-.5 4.5-1.3 6.3H14.1c-.8-1.8-1.3-4-1.3-6.3C12.8 11 14.7 6.7 18 4.2z" fill="#eef2fb"/>' +
      '<path d="M18 4.2c1.6 1.2 3 3.1 3.9 5.4H14.1c.9-2.3 2.3-4.2 3.9-5.4z" fill="#ff5a5f"/>' +
      '<circle cx="18" cy="13.4" r="2.4" fill="#39a0ff"/><circle cx="18" cy="13.4" r="2.4" fill="none" stroke="#2766c0" stroke-width="1"/>' +
      '<path d="M12.9 18.6c-2 .7-3.1 2.3-3.1 4.4 1.1-.6 2.2-.8 3.2-.8z" fill="#ff5a5f"/>' +
      '<path d="M23.1 18.6c2 .7 3.1 2.3 3.1 4.4-1.1-.6-2.2-.8-3.2-.8z" fill="#ff5a5f"/></g>'
  };

  // ── 💯 hundred — pulsing "100" with double underline ──
  G.hundred = {
    label: "100",
    art:
      '<g><animateTransform attributeName="transform" type="scale" values="1 1;1.1 1.1;1 1" dur="1.2s" repeatCount="indefinite" additive="sum"/>' +
      '<text x="18" y="19" text-anchor="middle" font-family="Outfit,Arial,sans-serif" font-size="13.5" font-weight="800" fill="#ff3b5c">100</text>' +
      '<rect x="6.5" y="23" width="23" height="2.2" rx="1.1" fill="#ff3b5c"/>' +
      '<rect x="6.5" y="26.4" width="23" height="2.2" rx="1.1" fill="#ff3b5c"/></g>'
  };

  // ── 👏 clap — two hands clapping with motion sparks ──
  G.clap = {
    label: "Clap",
    art:
      '<g>' +
      '<g><animateTransform attributeName="transform" type="translate" values="2 0;-0.5 0;2 0" dur="0.5s" repeatCount="indefinite"/>' +
      '<path d="M19 7.5l5.6 4.8c1.9 1.6 3 2.9 3.6 5l1 3.6c.4 1.6-.5 3.2-2.1 3.6-1.2.3-3 .2-4.8-1.2l-6-4.8c-1.3-1-1.6-1.8-2.4-4.6L12.4 12c-.4-1.4.9-2.4 2-1.4z" fill="#ffce4a"/></g>' +
      '<g><animateTransform attributeName="transform" type="translate" values="-2 0;0.5 0;-2 0" dur="0.5s" repeatCount="indefinite"/>' +
      '<path d="M16.6 8.8l-4.4 5.9c-1.5 2-2.3 3.4-2.5 5.6l-.3 3.7c-.1 1.7 1.2 3 2.9 2.9 1.2-.1 2.9-.7 4.2-2.5l4.5-6c1-1.3 1.1-2.2 1.2-5.1l.4-3.4c.2-1.5-1.3-2.1-2.1-.9z" fill="#ffc02e"/></g>' +
      '<g fill="#ffd23b"><circle cx="7" cy="9" r="1.1"><animate attributeName="opacity" values="0;1;0" dur="0.7s" repeatCount="indefinite"/></circle>' +
      '<circle cx="29" cy="9" r="1.1"><animate attributeName="opacity" values="1;0;1" dur="0.7s" repeatCount="indefinite"/></circle>' +
      '<circle cx="18" cy="4.5" r="1"><animate attributeName="opacity" values="0;1;0" dur="0.9s" repeatCount="indefinite"/></circle></g></g>'
  };

  // ── 📈 chartup — green line drawing upward with an arrow ──
  G.chartup = {
    label: "Bullish chart",
    art:
      '<g>' +
      '<rect x="3" y="4" width="30" height="28" rx="5" fill="#0e1c2e"/>' +
      '<rect x="3.6" y="4.6" width="28.8" height="26.8" rx="4.4" fill="none" stroke="#1f3a55" stroke-width="1"/>' +
      '<polyline points="7,25 14,18 19,21 28,10" fill="none" stroke="#34d27a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="40" stroke-dashoffset="40">' +
      '<animate attributeName="stroke-dashoffset" values="40;0;0;40" keyTimes="0;0.5;0.85;1" dur="2.4s" repeatCount="indefinite"/></polyline>' +
      '<path d="M23.5 10h4.5v4.5" fill="none" stroke="#34d27a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.45;0.55;0.85;1" dur="2.4s" repeatCount="indefinite"/></path></g>'
  };

  // ── 💰 moneybag — bouncing bag with a shine sweep ──
  G.moneybag = {
    label: "Money",
    art:
      '<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -1.5;0 0.4;0 0" dur="1.3s" repeatCount="indefinite"/>' +
      '<path d="M14 9c-.4-.5-1.5-2-1-3.2.2-.5.7-.6 1.1-.4 1 .5 2.4.8 3.9.8s2.9-.3 3.9-.8c.4-.2.9-.1 1.1.4.5 1.2-.6 2.7-1 3.2 3.3 1.6 6 5.2 6 9.7 0 5.2-3.6 8.6-10 8.6S8 24.6 8 19.4c0-4.5 2.7-8.1 6-9.4z" fill="#e8b53b"/>' +
      '<path d="M14 9c-.4-.5-1.5-2-1-3.2.2-.5.7-.6 1.1-.4 1 .5 2.4.8 3.9.8s2.9-.3 3.9-.8c.4-.2.9-.1 1.1.4.5 1.2-.6 2.7-1 3.2-1.1-.5-2.5-.8-4-.8s-2.9.3-4 .8z" fill="#caa029"/>' +
      '<text x="18" y="23.5" text-anchor="middle" font-family="Outfit,Arial,sans-serif" font-size="12" font-weight="800" fill="#7a5d10">$</text>' +
      '<path d="M11 14l9 9" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".5"><animate attributeName="opacity" values="0;.55;0" dur="1.8s" repeatCount="indefinite"/></path></g>'
  };

  // ── 💎 diamond — sparkling gem (diamond hands) ──
  G.diamond = {
    label: "Diamond hands",
    art:
      '<g>' +
      '<path d="M11 7h14l5 6-12 16L6 13z" fill="#49d6f3"/>' +
      '<path d="M11 7h14l5 6H6z" fill="#7ee6ff"/>' +
      '<path d="M6 13h24L18 29z" fill="#34b8e0"/>' +
      '<path d="M11 7l2.6 6L18 29 6 13z" fill="#9ff0ff" opacity=".6"/>' +
      '<g fill="#ffffff"><path d="M24 6.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8L21.5 9l1.8-.7z"><animate attributeName="opacity" values="0;1;0" dur="1.5s" repeatCount="indefinite"/></path>' +
      '<circle cx="9" cy="20" r="1"><animate attributeName="opacity" values="1;0;1" dur="1.5s" repeatCount="indefinite"/></circle></g></g>'
  };

  // ── ⭐ star — twinkling, slow spin ──
  G.star = {
    label: "Star",
    art:
      '<g><animateTransform attributeName="transform" type="rotate" values="0 18 18;8 18 18;0 18 18;-8 18 18;0 18 18" dur="3s" repeatCount="indefinite"/>' +
      '<path d="M18 4l3.7 8 8.8.9-6.6 5.9 1.9 8.6L18 23.9 10.2 27.4l1.9-8.6L5.5 12.9l8.8-.9z" fill="#ffce4a"/>' +
      '<path d="M18 4l3.7 8 8.8.9-6.6 5.9C22 16 20 13 18 4z" fill="#ffe07a" opacity=".7"/></g>'
  };

  // ── 🏆 trophy — gold cup with a shine ──
  G.trophy = {
    label: "Winner",
    art:
      '<g>' +
      '<path d="M11 6h14v5c0 4-3 7-7 7s-7-3-7-7z" fill="#ffce4a"/>' +
      '<path d="M11 6h14v2H11zM18 18v4" fill="none" stroke="#e0a92e" stroke-width="2"/>' +
      '<path d="M11 7H8c-1 0-1.6.8-1.4 1.8.4 2.1 1.9 3.6 4.4 3.9z" fill="#e0a92e"/>' +
      '<path d="M25 7h3c1 0 1.6.8 1.4 1.8-.4 2.1-1.9 3.6-4.4 3.9z" fill="#e0a92e"/>' +
      '<rect x="13.5" y="21.5" width="9" height="2.5" rx="1" fill="#e0a92e"/>' +
      '<rect x="11" y="24.5" width="14" height="3.5" rx="1.4" fill="#caa029"/>' +
      '<path d="M14 8l2 4" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".6"><animate attributeName="opacity" values="0;.7;0" dur="2s" repeatCount="indefinite"/></path></g>'
  };

  // ── 🐂 bull — green "bullish" badge: up-arrow + horns ──
  G.bull = {
    label: "Bullish",
    art:
      '<g>' +
      '<circle cx="18" cy="19" r="13" fill="#1f9d5a"/>' +
      '<circle cx="18" cy="19" r="13" fill="none" stroke="#34d27a" stroke-width="1.5"/>' +
      '<path d="M8 10c2.5.3 4 1.8 4.6 4.2M28 10c-2.5.3-4 1.8-4.6 4.2" fill="none" stroke="#cdebd9" stroke-width="2.2" stroke-linecap="round"/>' +
      '<path d="M18 12l6 7h-3.4v5h-5.2v-5H12z" fill="#ffffff">' +
      '<animateTransform attributeName="transform" type="translate" values="0 1;0 -1;0 1" dur="1.4s" repeatCount="indefinite"/></path></g>'
  };

  // ── 🐻 bear — red "bearish" badge: down-arrow + ears ──
  G.bear = {
    label: "Bearish",
    art:
      '<g>' +
      '<circle cx="18" cy="17" r="13" fill="#c8324a"/>' +
      '<circle cx="18" cy="17" r="13" fill="none" stroke="#ff6b81" stroke-width="1.5"/>' +
      '<circle cx="9" cy="8.5" r="3.2" fill="#c8324a" stroke="#ff6b81" stroke-width="1.2"/>' +
      '<circle cx="27" cy="8.5" r="3.2" fill="#c8324a" stroke="#ff6b81" stroke-width="1.2"/>' +
      '<path d="M18 24l-6-7h3.4v-5h5.2v5H24z" fill="#ffffff">' +
      '<animateTransform attributeName="transform" type="translate" values="0 -1;0 1;0 -1" dur="1.4s" repeatCount="indefinite"/></path></g>'
  };

  // Ordered list shown in the reaction picker (most useful first).
  var REACTIONS = ["like", "heart", "fire", "rocket", "hundred", "clap", "chartup", "moneybag", "bull", "bear", "diamond", "star", "trophy"];

  function has(key) { return Object.prototype.hasOwnProperty.call(G, key); }
  function label(key) { return has(key) ? G[key].label : key; }

  function render(key, size) {
    var s = size || 20;
    var inner = has(key)
      ? G[key].art
      : '<circle cx="18" cy="18" r="9" fill="#8aa0cc"/>'; // graceful fallback
    return '<svg viewBox="0 0 36 36" width="' + s + '" height="' + s +
      '" style="display:inline-block;vertical-align:middle;flex-shrink:0" aria-label="' +
      label(key) + '" role="img">' + inner + '</svg>';
  }

  window.dqEmoji = { render: render, label: label, has: has, REACTIONS: REACTIONS };
})();

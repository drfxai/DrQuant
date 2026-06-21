/* ============================================================================
   DrFX Quant — Market redesign  (futuristic / Instagram-class)
   ----------------------------------------------------------------------------
   This module OVERRIDES the marketplace render functions defined in index.html
   with a modern, immersive design. It changes presentation ONLY: every
   functional class (.mk-like / .mk-foll / .mk-buy / .mk-cmt / .mk-openc /
   .mk-openp / .mk-viewstore / .mk-ctab / .mk-newpost ...) and every data-*
   attribute is preserved, so the existing delegated handler (mkBodyClick) and
   all global action functions (mkToggleLike / mkBuy / mkGoCreator / mkOpenPost
   / mkCompose ...) keep working unchanged.

   It loads after the inline app script, so all globals exist by the time these
   overrides run. The render chain (mkRender -> mkExplore -> mkPostCard, etc.)
   resolves each function by-reference at call time, so reassigning them on
   `window` takes effect immediately. If this file fails to load, the original
   renderers remain — the marketplace degrades gracefully, never breaks.
   ========================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined") return;

  var GR = "linear-gradient(135deg,#1f8bff,#7c5cff)";          // brand gradient
  var GR3 = "conic-gradient(from 210deg,#1f8bff,#7c5cff,#ff4d6d,#ffb020,#1f8bff)"; // story ring

  /* ---- inject scoped styles once (structure + animations, no theme colors) ---- */
  function injectCSS() {
    if (document.getElementById("mkx-css")) return;
    var s = document.createElement("style"); s.id = "mkx-css";
    s.textContent = [
      "#mk-overlay .mkx-rail{display:flex;gap:14px;padding:14px 14px 8px;overflow-x:auto;scrollbar-width:none;-ms-overflow-style:none}",
      "#mk-overlay .mkx-rail::-webkit-scrollbar{display:none}",
      "#mk-overlay .mkx-story{flex-shrink:0;width:68px;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;background:none;border:none;padding:0;font-family:inherit;-webkit-tap-highlight-color:transparent}",
      "#mk-overlay .mkx-ring{width:64px;height:64px;border-radius:50%;padding:2.5px;box-sizing:border-box;background:" + GR3 + ";transition:transform .14s ease}",
      "#mk-overlay .mkx-story:active .mkx-ring{transform:scale(.92)}",
      "#mk-overlay .mkx-rin{width:100%;height:100%;border-radius:50%;padding:2.5px;box-sizing:border-box}",
      "#mk-overlay .mkx-av{width:100%;height:100%;border-radius:50%;overflow:hidden}",
      "#mk-overlay .mkx-slbl{font-size:10.5px;font-weight:600;max-width:66px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}",
      "#mk-overlay .mkx-chiprow{display:flex;gap:8px;padding:2px 14px 12px;overflow-x:auto;align-items:center;scrollbar-width:none}",
      "#mk-overlay .mkx-chiprow::-webkit-scrollbar{display:none}",
      "#mk-overlay .mkx-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:13px}",
      "#mk-overlay .mkx-post{animation:mkxRise .42s cubic-bezier(.22,.61,.36,1) both}",
      "@keyframes mkxRise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}",
      "#mk-overlay .mkx-media{position:relative;line-height:0;cursor:pointer;-webkit-tap-highlight-color:transparent}",
      "#mk-overlay .mkx-act{transition:transform .12s ease}",
      "#mk-overlay .mkx-act:active{transform:scale(.84)}",
      "#mk-overlay .mkx-prod{transition:transform .15s ease}",
      "#mk-overlay .mkx-prod:active{transform:scale(.98)}",
      "#mk-overlay .mkx-cc{transition:transform .15s ease}",
      "#mk-overlay .mkx-cc:active{transform:scale(.985)}",
      "#mk-overlay .mkx-burst{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:6}",
      "#mk-overlay .mkx-burst svg{width:108px;height:108px;filter:drop-shadow(0 8px 22px rgba(255,77,109,.55));animation:mkxBurst .9s ease forwards}",
      "@keyframes mkxBurst{0%{transform:scale(.2) rotate(-12deg);opacity:0}14%{transform:scale(1.18) rotate(7deg);opacity:1}30%{transform:scale(.9) rotate(-3deg)}46%{transform:scale(1.05) rotate(0)}70%{transform:scale(1);opacity:1}100%{transform:scale(1.3);opacity:0}}",
      "#mk-overlay video{border-radius:0}",
      "#mk-overlay .mkx-neon{border-radius:50%;line-height:0;box-sizing:border-box;transition:transform .14s ease;animation:mkxNeon 3.4s ease-in-out infinite}",
      "#mk-overlay .mkx-story:active .mkx-neon{transform:scale(.92)}",
      "@keyframes mkxNeon{0%,100%{box-shadow:0 0 0 2px var(--mkem),0 0 11px var(--mkeg)}50%{box-shadow:0 0 0 2px var(--mkem),0 0 22px var(--mkeg)}}"
    ].join("");
    document.head.appendChild(s);
  }
  injectCSS();

  /* small local helpers (reuse app globals; only add what's missing) */
  function ringAvatar(av, size, grad) {
    // gradient-ring wrapper around the app avatar()
    var inner = '<div class="mkx-rin" style="background:' + t.bg + '"><div class="mkx-av">' + avatar(av, size) + "</div></div>";
    return '<div class="mkx-ring"' + (grad ? ' style="background:' + grad + '"' : "") + ">" + inner + "</div>";
  }

  // neon-glow avatar (no story ring) for the explore rail
  function neonAvatar(av, em, emg) {
    return '<div class="mkx-neon" style="--mkem:' + em + ';--mkeg:' + emg + '">' + avatar(av, 58) + "</div>";
  }

  // ============================ EXPLORE FEED ============================
  window.mkExplore = async function () {
    var body = document.getElementById("mk-body"); if (!body) return;
    var chips = [["", "All"]].concat(MK_TYPES).map(function (p) {
      var v = p[0], l = p[1], on = MK.type === v;
      return '<button class="mk-chip" data-type="' + v + '" style="flex-shrink:0;padding:7px 15px;border-radius:13px;border:1px solid ' + (on ? t.ba : t.bd) + ";background:" + (on ? t.act : "transparent") + ";color:" + (on ? t.ac : t.t3) + ';font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap">' + l + "</button>";
    }).join("");
    var sorts = [["likes", "&#128293; Top"], ["new", "&#9889; New"]].map(function (p) {
      var v = p[0], l = p[1], on = MK.sort === v;
      return '<button class="mk-sortbtn" data-sort="' + v + '" style="flex-shrink:0;padding:7px 13px;border-radius:13px;border:1px solid ' + (on ? t.ba : t.bd) + ";background:" + (on ? t.act : "transparent") + ";color:" + (on ? t.ac : t.t3) + ';font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap">' + l + "</button>";
    }).join("");
    body.innerHTML =
      '<div class="mkx-rail" id="mkx-rail"></div>' +
      '<div class="mkx-chiprow">' + chips + '<div style="flex:1;min-width:6px"></div>' + sorts + "</div>" +
      '<div id="mk-feed" style="padding:0 12px 30px;max-width:640px;margin:0 auto;width:100%;box-sizing:border-box">' + mkLoader() + "</div>";
    mkxLoadRail();
    try {
      var qs = "sort=" + MK.sort + "&type=" + encodeURIComponent(MK.type) + "&q=" + encodeURIComponent(MK.q || "") + "&limit=30";
      var d = await api("/market/explore?" + qs);
      var feed = document.getElementById("mk-feed"); if (!feed) return;
      if (!d.posts || !d.posts.length) { feed.innerHTML = mkEmpty("Nothing here yet", "Be the first to share a chart, idea, or product with the community."); return; }
      feed.innerHTML = d.posts.map(mkPostCard).join("");
    } catch (e) {
      var f2 = document.getElementById("mk-feed"); if (f2) f2.innerHTML = mkEmpty("Couldn't load feed", mkErrMsg(e));
    }
  };

  // stories / creator rail at the top of the feed
  async function mkxLoadRail() {
    var rail = document.getElementById("mkx-rail"); if (!rail) return;
    var dark = !(typeof S !== "undefined" && S.theme === "light");
    var EM = dark ? "#16e29a" : "#0b9d6a";
    var EMG = dark ? "rgba(22,226,154,.55)" : "rgba(11,157,106,.42)";
    var GRAD = dark ? "linear-gradient(135deg,#0fd98a,#36e36b)" : "linear-gradient(135deg,#0bbf7e,#3fcf6a)";
    var GRADG = dark ? "rgba(34,220,120,.5)" : "rgba(20,180,110,.4)";
    var meAv = (S.user && S.user.avatar) || "\uD83E\uDDD1\u200D\uD83D\uDCBB";
    var yours =
      '<button class="mk-newpost mkx-story" type="button">' +
        '<div class="mkx-neon" style="--mkem:' + EM + ';--mkeg:' + EMG + ';position:relative">' + avatar(meAv, 58) +
          '<span style="position:absolute;bottom:-1px;right:-1px;width:21px;height:21px;border-radius:50%;background:' + GRAD + ";border:2.5px solid " + t.bg + ';display:flex;align-items:center;justify-content:center;color:#04140d;font-size:15px;line-height:1;font-weight:800;box-shadow:0 2px 8px ' + GRADG + '">+</span>' +
        "</div>" +
        '<span class="mkx-slbl" style="color:' + EM + ';text-shadow:0 0 8px ' + EMG + ';font-weight:700">Add post</span>' +
      "</button>";
    rail.innerHTML = yours + '<div style="color:' + t.t4 + ';font-size:12px;display:flex;align-items:center;padding:0 4px">Loading creators&#8230;</div>';
    try {
      var d = await api("/market/creators?sort=followers&limit=20");
      var cs = ((d && d.creators) || []).filter(function (c) { return !c.is_me; });
      var items = cs.map(function (c) {
        var em2 = c.store_kind === "company" ? "\uD83C\uDFE2" : "\uD83E\uDDD1\u200D\uD83D\uDCBB";
        return '<button class="mk-openc mkx-story" data-h="' + esc(c.username) + '" type="button">' +
          neonAvatar(c.avatar || em2, EM, EMG) +
          '<span class="mkx-slbl" style="color:' + EM + ';text-shadow:0 0 8px ' + EMG + ';font-weight:700">' + esc(c.name || c.username) + "</span></button>";
      }).join("");
      rail.innerHTML = yours + items;
    } catch (e) { rail.innerHTML = yours; }
  }

  // ============================ POST CARD ============================
  window.mkPostCard = function (p) {
    var a = p.author || {};
    var liked = !!p.liked_by_me;
    var media = "";
    if (p.media_type === "image" && p.media_url) {
      media = '<div class="mkx-media" data-pid="' + p.id + '" style="background:' + t.ch + '"><img src="' + esc(p.media_url) + '" alt="" loading="lazy" style="width:100%;display:block;max-height:520px;object-fit:cover"/></div>';
    } else if (p.media_type === "video" && p.media_url) {
      media = '<video src="' + esc(p.media_url) + '" ' + (p.thumb_url ? 'poster="' + esc(p.thumb_url) + '" ' : "") + 'controls playsinline preload="metadata" style="width:100%;display:block;max-height:520px;background:#000"></video>';
    }
    var mine = !!(S.user && a.id === S.user.id);
    var follBtn = mine
      ? '<button class="mk-editpost" data-pid="' + p.id + '" style="' + mkGhostBtn() + ';padding:6px 14px;font-size:12px;font-weight:700;flex-shrink:0">Edit</button>'
      : a.is_following
        ? '<button class="mk-foll" data-uid="' + a.id + '" data-on="1" style="' + mkFollOff() + '">Following</button>'
        : '<button class="mk-foll" data-uid="' + a.id + '" data-on="0" style="' + mkFollOn() + '">Follow</button>';
    var sub = a.headline || ("@" + (a.username || ""));
    if (a.follower_count) sub += " &#183; " + mkNum(a.follower_count) + " followers";
    return '<article class="mkx-post" style="border:1px solid ' + t.bd + ";border-radius:20px;background:" + t.cd + ';overflow:hidden;margin-bottom:16px">' +
      '<header style="display:flex;align-items:center;gap:11px;padding:13px 14px">' +
        '<div class="mk-openc" data-h="' + esc(a.username) + '" style="cursor:pointer;flex-shrink:0;border-radius:50%;padding:2px;background:' + GR + '">' + avatar(a.avatar || "\uD83E\uDDD1\u200D\uD83D\uDCBB", 40) + "</div>" +
        '<div class="mk-openc" data-h="' + esc(a.username) + '" style="flex:1;min-width:0;cursor:pointer">' +
          '<div style="display:flex;align-items:center;gap:4px;color:' + t.t1 + ';font-weight:700;font-size:14px">' + esc(a.name || a.username || "User") + (a.verified ? goldSeal(15) : "") + "</div>" +
          '<div style="color:' + t.t3 + ';font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(sub) + "</div>" +
        "</div>" + follBtn +
      "</header>" +
      (p.title ? '<div style="padding:0 15px 10px;color:' + t.t1 + ';font-weight:700;font-size:15.5px;line-height:1.3">' + esc(p.title) + "</div>" : "") +
      media +
      '<div style="display:flex;align-items:center;gap:20px;padding:13px 15px 4px">' +
        '<button class="mk-like mkx-act" data-pid="' + p.id + '" data-on="' + (liked ? 1 : 0) + '" style="display:flex;align-items:center;gap:7px;background:none;border:none;cursor:pointer;color:' + (liked ? "#ff4d6d" : t.t2) + ';font-family:inherit;font-size:14px;font-weight:700;padding:0">' + mkHeart(liked) + '<span class="mk-like-n">' + (p.like_count || 0) + "</span></button>" +
        '<button class="mk-cmt mkx-act" data-pid="' + p.id + '" style="display:flex;align-items:center;gap:7px;background:none;border:none;cursor:pointer;color:' + t.t2 + ';font-family:inherit;font-size:14px;font-weight:700;padding:0">' + ic('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>', 20) + "<span>" + (p.comment_count || 0) + "</span></button>" +
        '<div style="flex:1"></div>' +
        '<span style="color:' + t.t4 + ';font-size:11px;font-weight:500">' + fmtTime(p.created_at) + "</span>" +
      "</div>" +
      (p.caption ? '<div style="padding:4px 15px ' + (p.product ? "8" : "14") + 'px;color:' + t.t2 + ';font-size:13.5px;line-height:1.5;white-space:pre-wrap"><b class="mk-openc" data-h="' + esc(a.username) + '" style="color:' + t.t1 + ';font-weight:700;margin-right:6px;cursor:pointer">' + esc(a.username || "") + "</b>" + linkify(esc(p.caption)) + "</div>" : "") +
      (p.product ? mkProductChip(p.product) : '<div style="height:6px"></div>') +
      "</article>";
  };

  // ============================ PRODUCT CHIP (in feed) ============================
  window.mkProductChip = function (pr) {
    return '<div class="mk-openp" data-pid="' + pr.id + '" style="margin:8px 15px 14px;display:flex;align-items:center;gap:12px;padding:11px;border:1px solid ' + t.bl + ";border-radius:16px;background:linear-gradient(135deg," + t.ch + "," + t.cd + ');cursor:pointer;position:relative;overflow:hidden">' +
      '<div style="position:absolute;inset:0;background:linear-gradient(120deg,' + t.pr + '14,transparent 62%);pointer-events:none"></div>' +
      '<div style="width:56px;height:56px;border-radius:13px;overflow:hidden;flex-shrink:0;background:' + t.cd + ';display:flex;align-items:center;justify-content:center;position:relative">' + (pr.cover ? '<img src="' + esc(pr.cover) + '" alt="" style="width:100%;height:100%;object-fit:cover"/>' : mkChartGlyph(28)) + "</div>" +
      '<div style="flex:1;min-width:0;position:relative">' +
        '<div style="font-size:9.5px;font-weight:800;letter-spacing:.6px;color:' + t.pr + ';text-transform:uppercase">' + mkTypeLabel(pr.type) + "</div>" +
        '<div style="color:' + t.t1 + ';font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(pr.name) + "</div>" +
        '<div style="margin-top:3px">' + mkPriceTag(pr.price_qntm) + "</div>" +
      "</div>" +
      (pr.bought_by_me
        ? '<button disabled style="padding:9px 17px;border-radius:11px;border:1px solid ' + t.ba + ";background:transparent;color:" + t.on + ';font-weight:700;font-size:12.5px;font-family:inherit;flex-shrink:0;position:relative">Owned</button>'
        : '<button class="mk-buy" data-pid="' + pr.id + '" style="' + mkBuyBtn() + ';position:relative">Get</button>') +
      "</div>";
  };

  // ============================ PRODUCT CARD (store grid) ============================
  window.mkProductCard = function (pr, mine) {
    var cover = pr.cover
      ? '<img src="' + esc(pr.cover) + '" alt="" style="width:100%;height:100%;object-fit:cover"/>'
      : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,' + t.pr + "22," + t.ch + ')">' + mkChartGlyph(40) + "</div>";
    var badge = pr.badge ? '<span style="position:absolute;top:9px;left:9px;font-size:9px;font-weight:800;letter-spacing:.5px;color:#fff;background:' + t.pg + ";padding:3px 9px;border-radius:8px;box-shadow:0 2px 10px " + t.pgw + '">' + esc(String(pr.badge).toUpperCase()) + "</span>" : "";
    var action;
    if (mine) action = '<button class="mk-editp" data-pid="' + pr.id + '" style="' + mkBuyBtn() + '">Edit</button>';
    else if (pr.bought_by_me) action = '<button disabled style="padding:8px 14px;border-radius:10px;border:1px solid ' + t.ba + ";background:transparent;color:" + t.on + ';font-weight:700;font-size:12.5px;font-family:inherit;flex-shrink:0">Owned</button>';
    else action = '<button class="mk-buy" data-pid="' + pr.id + '" style="' + mkBuyBtn() + '">Get</button>';
    return '<div class="mkx-prod" style="border:1px solid ' + t.bd + ";border-radius:18px;overflow:hidden;background:" + t.cd + ';display:flex;flex-direction:column">' +
      '<div class="mk-openp" data-pid="' + pr.id + '" style="position:relative;aspect-ratio:16/10;cursor:pointer;background:' + t.ch + '">' + cover + badge +
        '<span style="position:absolute;top:9px;right:9px;font-size:9px;font-weight:700;letter-spacing:.5px;color:#fff;background:rgba(0,0,0,.45);padding:3px 9px;border-radius:8px;backdrop-filter:blur(6px)">' + mkTypeLabel(pr.type).toUpperCase() + "</span></div>" +
      '<div style="padding:11px 13px 13px;display:flex;flex-direction:column;flex:1">' +
        '<div class="mk-openp" data-pid="' + pr.id + '" style="color:' + t.t1 + ';font-weight:700;font-size:14.5px;cursor:pointer;line-height:1.25">' + esc(pr.name) + "</div>" +
        (pr.subtitle ? '<div style="color:' + t.t3 + ';font-size:11.5px;margin-top:3px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' + esc(pr.subtitle) + "</div>" : "") +
        '<div style="margin-top:8px">' + mkStars(pr.rating_avg, true) + '<span style="color:' + t.t4 + ';font-size:11px;margin-left:6px">' + mkNum(pr.sales_count) + " sold</span></div>" +
        '<div style="flex:1"></div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:11px;gap:8px">' + mkPriceTag(pr.price_qntm) + action + "</div>" +
      "</div></div>";
  };

  // ============================ CREATOR CARD (directory) ============================
  window.mkCreatorCard = function (c) {
    var cover = c.cover_image
      ? "background-image:url('" + cssUrl(c.cover_image) + "');background-size:cover;background-position:center"
      : "background:linear-gradient(135deg," + t.pr + ",#7c5cff)";
    var em = c.store_kind === "company" ? "\uD83C\uDFE2" : "\uD83E\uDDD1\u200D\uD83D\uDCBB";
    return '<div class="mkx-cc" style="border:1px solid ' + t.bd + ";border-radius:18px;overflow:hidden;background:" + t.cd + '">' +
      '<div style="height:76px;position:relative;' + cover + '"><div style="position:absolute;inset:0;background:linear-gradient(to top,' + t.cd + ',transparent 85%)"></div></div>' +
      '<div style="padding:0 15px 15px;margin-top:-30px;position:relative">' +
        '<div class="mk-openc" data-h="' + esc(c.username) + '" style="cursor:pointer;width:56px;border-radius:50%;padding:2.5px;background:' + GR + '">' + avatar(c.avatar || em, 50) + "</div>" +
        '<div style="display:flex;align-items:center;gap:4px;margin-top:9px;color:' + t.t1 + ';font-weight:700;font-size:15px">' + esc(c.name || c.username) + (c.verified ? goldSeal(15) : "") + (c.store_kind === "company" ? '<span style="font-size:8.5px;font-weight:800;color:' + t.ac + ";background:" + t.act + ';padding:2px 6px;border-radius:6px;letter-spacing:.4px">CO</span>' : "") + "</div>" +
        '<div style="color:' + t.t3 + ';font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(c.headline || ("@" + c.username)) + "</div>" +
        '<div style="display:flex;gap:16px;margin:11px 0;color:' + t.t2 + ';font-size:12px"><span><b style="color:' + t.t1 + '">' + mkNum(c.follower_count) + '</b> followers</span><span><b style="color:' + t.t1 + '">' + mkNum(c.product_count || 0) + "</b> items</span></div>" +
        '<div style="display:flex;gap:8px">' +
          '<button class="mk-viewstore" data-h="' + esc(c.username) + '" style="flex:1;padding:9px 0;border-radius:11px;border:none;background:' + t.pg + ";color:#fff;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;box-shadow:0 4px 14px " + t.pgw + '">View Store</button>' +
          (c.is_me ? "" : '<button class="mk-foll" data-uid="' + c.id + '" data-on="' + (c.is_following ? 1 : 0) + '" style="' + (c.is_following ? mkFollOff() : mkFollOn()) + '">' + (c.is_following ? "Following" : "Follow") + "</button>") +
        "</div>" +
      "</div></div>";
  };

  // ============================ CREATOR PROFILE ============================
  window.mkCreatorView = function (d, pushed) {
    var c = d.creator;
    var isCo = c.store_kind === "company";
    var cover = c.cover_image
      ? "background-image:url('" + cssUrl(c.cover_image) + "');background-size:cover;background-position:center"
      : "background:linear-gradient(135deg," + t.pr + ",#7c5cff," + t.ch + ")";
    var back = pushed ? '<button class="mk-back2" style="position:absolute;top:12px;left:12px;width:38px;height:38px;border-radius:12px;border:none;background:rgba(0,0,0,.42);color:#fff;cursor:pointer;backdrop-filter:blur(8px);font-size:18px;display:flex;align-items:center;justify-content:center">&#8592;</button>' : "";
    var actions = c.is_me
      ? '<button class="mk-editstore" style="' + mkGhostBtn() + ';flex:1;padding:10px 0">Edit store</button>'
      : '<button class="mk-foll" data-uid="' + c.id + '" data-on="' + (c.is_following ? 1 : 0) + '" style="' + (c.is_following ? mkFollOff() : mkFollOn()) + ';flex:1">' + (c.is_following ? "Following" : "Follow") + '</button><button class="mk-msg" data-uid="' + c.id + '" style="' + mkGhostBtn() + ';flex:1;padding:10px 0">Message</button>';
    var manage = c.is_me ? '<div style="display:flex;gap:8px;margin-top:12px"><button class="mk-newproduct" style="' + mkPrimBtn() + ';flex:1">+ Add product</button><button class="mk-newpost" style="' + mkGhostBtn() + ';flex:1">+ New post</button></div><div style="margin-top:8px"><button class="mk-purchases" style="' + mkGhostBtn() + ';width:100%">My purchases</button></div>' : "";
    var stat = function (v, l) { return '<div style="text-align:center"><div style="color:' + t.t1 + ';font-weight:800;font-size:17px">' + v + '</div><div style="color:' + t.t3 + ';font-size:11px;margin-top:1px">' + l + "</div></div>"; };
    var tabs = [["store", "Store", d.product_count], ["posts", "Posts", d.post_count]].map(function (p) {
      var v = p[0], l = p[1], n = p[2], on = MK.ctab === v;
      return '<button class="mk-ctab" data-ctab="' + v + '" style="flex:1;padding:13px 0;background:none;border:none;border-bottom:2px solid ' + (on ? t.pr : "transparent") + ";color:" + (on ? t.t1 : t.t3) + ';font-weight:700;font-size:13.5px;cursor:pointer;font-family:inherit">' + l + " &#183; " + n + "</button>";
    }).join("");
    return '<div style="max-width:780px;margin:0 auto;width:100%;box-sizing:border-box">' +
      '<div style="position:relative;height:150px;overflow:hidden;' + cover + '"><div style="position:absolute;inset:0;background:linear-gradient(to top,' + t.bg + ',transparent 58%)"></div>' + back + "</div>" +
      '<div style="padding:0 18px 14px;margin-top:-44px;position:relative">' +
        '<div style="border-radius:50%;padding:3px;background:linear-gradient(135deg,#1f8bff,#7c5cff,#ff4d6d);width:86px">' + avatar(c.avatar || (isCo ? "\uD83C\uDFE2" : "\uD83E\uDDD1\u200D\uD83D\uDCBB"), 80) + "</div>" +
        '<div style="display:flex;gap:8px;margin-top:14px">' + actions + "</div>" +
        '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:14px;color:' + t.t1 + ';font-weight:800;font-size:20px">' + esc(c.name || c.username) + (c.verified ? goldSeal(19) : "") + (isCo ? '<span style="font-size:10px;font-weight:800;color:' + t.ac + ";background:" + t.act + ';padding:3px 9px;border-radius:8px;letter-spacing:.5px">COMPANY</span>' : "") + "</div>" +
        '<div style="color:' + t.pr + ';font-size:13px;margin-top:2px">@' + esc(c.username) + (c.founded_year ? " &#183; <span style=\"color:" + t.t3 + '">Est. ' + esc(String(c.founded_year)) + "</span>" : "") + "</div>" +
        (c.headline ? '<div style="color:' + t.t2 + ';font-size:13.5px;margin-top:9px;line-height:1.5">' + esc(c.headline) + "</div>" : "") +
        (c.bio ? '<div style="color:' + t.t3 + ';font-size:13px;margin-top:6px;line-height:1.5;white-space:pre-wrap">' + esc(c.bio) + "</div>" : "") +
        '<div style="display:flex;justify-content:space-around;gap:10px;margin-top:16px;padding:13px;border:1px solid ' + t.bd + ";border-radius:16px;background:" + t.cd + '">' + stat(mkNum(c.follower_count), "Followers") + stat(mkNum(c.following_count), "Following") + stat(mkNum(c.sales_count), "Sales") + stat((Number(c.rating_avg) || 0).toFixed(1), "Rating") + "</div>" +
        manage +
      "</div>" +
      '<div style="display:flex;border-bottom:1px solid ' + t.bd + ";margin-top:8px;position:sticky;top:0;background:" + t.bg + ';z-index:2">' + tabs + "</div>" +
      '<div id="mk-cv-content" style="padding:16px 14px">' + mkCreatorContent(d) + "</div>" +
      "</div>";
  };

  // ---- creator content: keep the new grid class for products ----
  window.mkCreatorContent = function (d) {
    if (MK.ctab === "posts") {
      if (!d.posts || !d.posts.length) return mkEmpty("No posts yet", "");
      return '<div style="max-width:640px;margin:0 auto">' + d.posts.map(mkPostCard).join("") + "</div>";
    }
    if (!d.products || !d.products.length) return mkEmpty("No products yet", d.creator.is_me ? 'Tap "Add product" to list your first indicator or strategy.' : "");
    return '<div class="mkx-grid">' + d.products.map(function (pr) { return mkProductCard(pr, d.creator.is_me); }).join("") + "</div>";
  };

  // ============================ DOUBLE-TAP TO LIKE ============================
  // Added once, capture phase. Works on image media only (videos keep controls).
  var _tapT = 0, _tapEl = null;
  document.addEventListener("click", function (e) {
    var tgt = e.target; if (!tgt || !tgt.closest) return;
    var m = tgt.closest(".mkx-media");
    if (!m || !m.closest("#mk-overlay")) return;
    var now = Date.now();
    if (_tapEl === m && now - _tapT < 340) { _tapT = 0; _tapEl = null; mkxDoubleLike(m); }
    else { _tapT = now; _tapEl = m; }
  }, true);
  function mkxDoubleLike(m) {
    var b = document.createElement("div"); b.className = "mkx-burst";
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="#ff4d6d"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
    m.appendChild(b); setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 880);
    var pid = m.getAttribute("data-pid"); if (!pid) return;
    var btn = document.querySelector('#mk-overlay .mk-like[data-pid="' + pid + '"]');
    if (btn && btn.getAttribute("data-on") !== "1" && typeof window.mkToggleLike === "function") { try { window.mkToggleLike(btn); } catch (_) {} }
  }
})();

/* ============================================================================
 * crystal3d.js — DrFX Quant real-time 3D crystals (WebGL / Three.js)
 * ----------------------------------------------------------------------------
 * Self-contained SPA module. Loads as a plain <script> after index.html's main
 * script. It renders genuine 3D, lit, faceted crystals into any container and
 * is used by the Profile popup for two things:
 *
 *   - the League Progress "gem"   (a tall faceted crystal shard)
 *   - the Premium Tier "crown"    (a crystal crown of shards on a base)
 *
 * Public API (all synchronous to call; rendering boots lazily):
 *
 *     window.dq3DCrystal.mount(el, {
 *        kind:  "shard" | "crown",     // which model            (default "shard")
 *        color: "#7cc7ff",             // base crystal colour    (default blue)
 *        height: 150,                  // canvas px height       (default = el's)
 *        spin:  true                   // slow auto-rotation     (default true)
 *     })  ->  returns a handle { destroy() }  (also tracked internally)
 *
 *     window.dq3DCrystal.disposeAll()   // tear down every live instance + GL
 *
 * Design / safety notes
 *   • Three.js (r128) is lazy-loaded from cdnjs only the first time a crystal is
 *     mounted, so it costs nothing until the Profile is opened.
 *   • Phone-safe: device-pixel-ratio is capped, the renderer pauses whenever the
 *     canvas is scrolled off-screen (IntersectionObserver) and whenever the tab
 *     is hidden, and every instance fully disposes its geometry/material/GL
 *     context on destroy(). No localStorage / sessionStorage is ever touched.
 *   • Graceful fallback: if WebGL is unavailable or Three.js fails to load, a
 *     crisp static SVG crystal is injected instead, so the card never breaks.
 * ========================================================================== */
(function () {
  "use strict";
  if (window.dq3DCrystal) return; // singleton

  var THREE_URL = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
  var _loading = null;        // Promise<boolean> for the Three.js script
  var _instances = [];        // live handles, for disposeAll()

  // ── tiny colour helpers ────────────────────────────────────────────────────
  function hexToRgb(h) {
    h = String(h || "#7cc7ff").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function lighten(h, amt) {
    var c = hexToRgb(h);
    var r = Math.round(c.r + (255 - c.r) * amt),
        g = Math.round(c.g + (255 - c.g) * amt),
        b = Math.round(c.b + (255 - c.b) * amt);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  // ── WebGL capability probe ─────────────────────────────────────────────────
  function webglOK() {
    try {
      var c = document.createElement("canvas");
      return !!(window.WebGLRenderingContext &&
        (c.getContext("webgl") || c.getContext("experimental-webgl")));
    } catch (e) { return false; }
  }

  // ── lazy Three.js loader ───────────────────────────────────────────────────
  function loadThree() {
    if (window.THREE) return Promise.resolve(true);
    if (_loading) return _loading;
    _loading = new Promise(function (res) {
      var s = document.createElement("script");
      s.src = THREE_URL; s.async = true;
      s.onload = function () { res(!!window.THREE); };
      s.onerror = function () { res(false); };
      document.head.appendChild(s);
    });
    return _loading;
  }

  // ── SVG fallback (used when WebGL/Three is unavailable) ─────────────────────
  function svgFallback(el, kind, color) {
    var lite = lighten(color, 0.45), pale = lighten(color, 0.7);
    var gid = "dqc-" + Math.random().toString(36).slice(2, 8);
    var inner;
    if (kind === "crown") {
      inner =
        '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="' + pale + '"/><stop offset="1" stop-color="' + color + '"/></linearGradient></defs>' +
        '<g filter="drop-shadow(0 6px 16px ' + color + '88)">' +
        '<path d="M14 70 L14 44 L28 56 L44 30 L60 56 L74 44 L74 70 Z" fill="url(#' + gid + ')" stroke="' + lite + '" stroke-width="1.4" stroke-linejoin="round"/>' +
        '<path d="M44 30 L44 70 M28 56 L28 70 M60 56 L60 70" stroke="rgba(255,255,255,.45)" stroke-width="1"/>' +
        '<rect x="12" y="70" width="64" height="9" rx="2.5" fill="' + color + '" stroke="' + lite + '" stroke-width="1.2"/>' +
        '<circle cx="44" cy="24" r="3.4" fill="' + pale + '"/></g>';
    } else {
      inner =
        '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="' + pale + '"/><stop offset=".55" stop-color="' + color + '"/><stop offset="1" stop-color="' + lite + '"/></linearGradient></defs>' +
        '<g filter="drop-shadow(0 6px 18px ' + color + '99)">' +
        '<polygon points="44,6 60,30 52,74 36,74 28,30" fill="url(#' + gid + ')" stroke="' + lite + '" stroke-width="1.4" stroke-linejoin="round"/>' +
        '<polygon points="44,6 52,74 44,40" fill="rgba(255,255,255,.20)"/>' +
        '<polygon points="44,6 36,74 44,40" fill="rgba(0,0,0,.12)"/>' +
        '<polyline points="28,30 44,40 60,30" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1"/></g>';
    }
    el.innerHTML = '<svg viewBox="0 0 88 88" width="100%" height="100%" style="display:block;overflow:visible">' + inner + "</svg>";
  }

  // ── geometry builders ──────────────────────────────────────────────────────
  // A tall, double-terminated crystal shard (classic "gem" silhouette).
  function buildShardGeo(THREE) {
    var R = 1.0, top = 2.05, bot = -2.05, mid = 0.42, sides = 6;
    var verts = [], idx = [];
    // ring of `sides` vertices around the middle
    for (var i = 0; i < sides; i++) {
      var a = (i / sides) * Math.PI * 2;
      verts.push(Math.cos(a) * R, mid, Math.sin(a) * R);
    }
    // apex (top) and nadir (bottom)
    verts.push(0, top, 0);             // index sides
    verts.push(0, bot, 0);             // index sides+1
    var apex = sides, nadir = sides + 1;
    for (var j = 0; j < sides; j++) {
      var n = (j + 1) % sides;
      idx.push(j, n, apex);            // top faces
      idx.push(n, j, nadir);           // bottom faces
    }
    var g = new THREE.BufferGeometry();
    g.setIndex(idx);
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    g.computeVertexNormals();
    g.scale(0.92, 1, 0.92);
    return g;
  }

  // A crown: a ring base + several upward crystal spikes.
  function buildCrownGroup(THREE, mat) {
    var group = new THREE.Group();

    // base ring (slightly tapered cylinder)
    var baseGeo = new THREE.CylinderGeometry(1.18, 1.32, 0.5, 12, 1);
    var base = new THREE.Mesh(baseGeo, mat);
    base.position.y = -1.15;
    group.add(base);

    // a thin bright band on top of the base
    var bandGeo = new THREE.CylinderGeometry(1.2, 1.2, 0.12, 12, 1);
    var band = new THREE.Mesh(bandGeo, mat);
    band.position.y = -0.86;
    group.add(band);

    // spikes — a tall centre one flanked by shorter ones
    var spikeGeo = new THREE.ConeGeometry(0.34, 1.7, 4, 1);
    var heights = [0.0, 0.0, 0.0, 0.0, 0.0];
    var angles = [-0.92, -0.46, 0, 0.46, 0.92];
    var scales = [0.72, 0.9, 1.18, 0.9, 0.72];
    for (var i = 0; i < angles.length; i++) {
      var s = new THREE.Mesh(spikeGeo, mat);
      var radius = 0.92;
      s.position.x = Math.sin(angles[i]) * radius;
      s.position.z = Math.cos(angles[i]) * 0.18;
      s.scale.set(1, scales[i], 1);
      s.position.y = -0.7 + (1.7 * scales[i]) / 2;
      s.rotation.y = angles[i];
      group.add(s);
    }
    return group;
  }

  // ── one live crystal instance ──────────────────────────────────────────────
  function makeInstance(el, opts) {
    var THREE = window.THREE;
    var kind = opts.kind || "shard";
    var color = opts.color || "#7cc7ff";
    var spin = opts.spin !== false;

    var W = el.clientWidth || 120;
    var H = opts.height || el.clientHeight || 150;

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(38, W / H, 0.1, 100);
    camera.position.set(0, 0, 6.4);

    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: false });
    } catch (e) {
      svgFallback(el, kind, color);
      return { destroy: function () { } };
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 0);
    el.innerHTML = "";
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";

    // material — glassy, faceted, glowing crystal
    var base = hexToRgb(color);
    var mat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color),
      metalness: 0.0,
      roughness: 0.16,
      transmission: 0.55,          // glassiness (r128 supports basic transmission)
      transparent: true,
      opacity: 0.92,
      reflectivity: 0.7,
      clearcoat: 1.0,
      clearcoatRoughness: 0.18,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.22,
      flatShading: true,           // crisp facets
      side: THREE.DoubleSide
    });

    var obj, geo;
    if (kind === "crown") {
      obj = buildCrownGroup(THREE, mat);
      obj.scale.set(1.02, 1.02, 1.02);
    } else {
      geo = buildShardGeo(THREE);
      obj = new THREE.Mesh(geo, mat);
      obj.rotation.z = 0.06;
    }
    scene.add(obj);

    // a faint inner wireframe twin to accentuate the facets
    var wire = null;
    if (kind !== "crown") {
      var wmat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(lighten(color, 0.6)),
        wireframe: true, transparent: true, opacity: 0.16
      });
      wire = new THREE.Mesh(geo, wmat);
      wire.scale.set(1.005, 1.005, 1.005);
      scene.add(wire);
    }

    // lighting rig — cool key, warm-white rim, soft fill, glow point inside
    scene.add(new THREE.AmbientLight(0x4466aa, 0.6));
    var key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(3, 4, 5); scene.add(key);
    var rim = new THREE.DirectionalLight(new THREE.Color(lighten(color, 0.3)), 0.9);
    rim.position.set(-4, 1, -3); scene.add(rim);
    var core = new THREE.PointLight(new THREE.Color(color), 1.1, 12);
    core.position.set(0, 0, 0); scene.add(core);

    // animation + visibility gating
    var raf = 0, visible = true, alive = true, tPrev = performance.now();
    function frame(now) {
      if (!alive) return;
      raf = requestAnimationFrame(frame);
      if (!visible) return;
      var dt = Math.min(0.05, (now - tPrev) / 1000); tPrev = now;
      if (spin) {
        obj.rotation.y += dt * 0.6;
        if (wire) wire.rotation.y = obj.rotation.y;
      }
      // gentle bob + light shimmer
      var s = Math.sin(now / 900);
      obj.position.y = s * 0.05;
      core.intensity = 0.9 + (s + 1) * 0.28;
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(frame);

    // pause when scrolled out of view
    var io = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(function (es) {
        visible = es[0] && es[0].isIntersecting;
        if (visible) tPrev = performance.now();
      }, { threshold: 0.05 });
      io.observe(el);
    }
    // pause when the tab is hidden
    function onVis() { if (document.hidden) visible = false; else { visible = true; tPrev = performance.now(); } }
    document.addEventListener("visibilitychange", onVis);

    // keep crisp on container resize
    function onResize() {
      var w = el.clientWidth || W, h = opts.height || el.clientHeight || H;
      camera.aspect = w / h; camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    var ro = null;
    if ("ResizeObserver" in window) { ro = new ResizeObserver(onResize); ro.observe(el); }

    function destroy() {
      if (!alive) return;
      alive = false;
      cancelAnimationFrame(raf);
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      try { scene.remove(obj); } catch (e) { }
      try {
        if (geo) geo.dispose();
        mat.dispose();
        if (wire) wire.material.dispose();
      } catch (e) { }
      try {
        renderer.forceContextLoss();
        renderer.dispose();
        if (renderer.domElement && renderer.domElement.parentNode)
          renderer.domElement.parentNode.removeChild(renderer.domElement);
      } catch (e) { }
    }

    return { destroy: destroy };
  }

  // ── public mount ───────────────────────────────────────────────────────────
  function mount(el, opts) {
    opts = opts || {};
    if (!el) return { destroy: function () { } };

    // show a quiet placeholder gem immediately; upgrade to 3D once ready
    svgFallback(el, opts.kind || "shard", opts.color || "#7cc7ff");

    var handle = { destroy: function () { handle._d && handle._d(); } };
    _instances.push(handle);

    if (!webglOK()) return handle;   // keep the SVG fallback

    loadThree().then(function (ok) {
      if (!ok || !window.THREE) return;     // keep the SVG fallback
      // if the element was removed while loading, abort
      if (!document.body.contains(el)) return;
      try {
        var inst = makeInstance(el, opts);
        handle._d = inst.destroy;
      } catch (e) {
        svgFallback(el, opts.kind || "shard", opts.color || "#7cc7ff");
      }
    });

    return handle;
  }

  function disposeAll() {
    _instances.forEach(function (h) { try { h.destroy(); } catch (e) { } });
    _instances = [];
  }

  window.dq3DCrystal = { mount: mount, disposeAll: disposeAll };
})();

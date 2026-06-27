/* ============================================================================
 * crystal3d.js — DrFX Quant STATIC 3D crystals (WebGL / Three.js)
 * ----------------------------------------------------------------------------
 * Self-contained SPA module. Loads as a plain <script> after index.html's main
 * script. It renders genuine 3D, lit, faceted ICE-BLUE crystals into any
 * container and is used by the Profile popup for two things:
 *
 *   - the League Progress "gem"   (a tall faceted crystal shard)
 *   - the Premium Tier "crown"    (a fanned crystal tiara on a faceted pedestal)
 *
 * The look matches the approved reference art: bright ice-blue glass with
 * WHITE-HOT facet edges, deep-blue interior shadows, an emissive inner glow, a
 * procedural environment reflection (no external asset) and a soft ground-glow
 * pool beneath the model — lots of colour depth.
 *
 * STATIC by design: the scene is posed front-facing and rendered as a SINGLE
 * FRAME. There is NO animation — no spin, no bob, no pulsing. The only time it
 * re-renders is on a container resize (to stay crisp); otherwise it never moves.
 *
 * Public API (synchronous to call; rendering boots lazily):
 *
 *     window.dq3DCrystal.mount(el, {
 *        kind:  "shard" | "crown",     // which model            (default "shard")
 *        color: "#7cc7ff",             // base crystal colour    (default blue)
 *        height: 150,                  // canvas px height       (default = el's)
 *        glow:  true                   // ground-glow pool       (default true)
 *     })  ->  returns a handle { destroy() }  (also tracked internally)
 *     // NOTE: a `spin` option is accepted but IGNORED — the crystals are static.
 *
 *     window.dq3DCrystal.disposeAll()   // tear down every live instance + GL
 *
 * Safety: Three.js (r128) is lazy-loaded from cdnjs only on first mount.
 * Phone-safe: DPR capped, single frame (no RAF loop, no battery drain), fully
 * disposes geometry+material+env+GL on destroy. No localStorage/sessionStorage.
 * Graceful fallback: a crisp static SVG crystal if WebGL/Three is unavailable.
 * ========================================================================== */
(function () {
  "use strict";
  if (window.dq3DCrystal) return; // singleton

  var THREE_URL = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
  var _loading = null;
  var _instances = [];

  // ── colour helpers ──────────────────────────────────────────────────────────
  function hexToRgb(h) {
    h = String(h || "#7cc7ff").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function mix(a, b, amt) {
    return {
      r: Math.round(a.r + (b.r - a.r) * amt),
      g: Math.round(a.g + (b.g - a.g) * amt),
      b: Math.round(a.b + (b.b - a.b) * amt)
    };
  }
  function toHex(c) { return "#" + ((1 << 24) + (c.r << 16) + (c.g << 8) + c.b).toString(16).slice(1); }
  function lighten(h, amt) { return toHex(mix(hexToRgb(h), { r: 255, g: 255, b: 255 }, amt)); }
  function darken(h, amt) { return toHex(mix(hexToRgb(h), { r: 4, g: 12, b: 34 }, amt)); }

  function webglOK() {
    try {
      var c = document.createElement("canvas");
      return !!(window.WebGLRenderingContext &&
        (c.getContext("webgl") || c.getContext("experimental-webgl")));
    } catch (e) { return false; }
  }

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

  // ── SVG fallback ────────────────────────────────────────────────────────────
  function svgFallback(el, kind, color) {
    var lite = lighten(color, 0.5), pale = lighten(color, 0.78), deep = darken(color, 0.55);
    var gid = "dqc-" + Math.random().toString(36).slice(2, 8);
    var inner;
    if (kind === "crown") {
      inner =
        '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="' + pale + '"/><stop offset=".5" stop-color="' + color + '"/><stop offset="1" stop-color="' + deep + '"/></linearGradient></defs>' +
        '<g filter="drop-shadow(0 4px 20px ' + color + 'aa)">' +
        '<path d="M10 66 L10 40 L22 54 L32 26 L44 48 L56 26 L66 54 L78 40 L78 66 Z" fill="url(#' + gid + ')" stroke="' + lite + '" stroke-width="1.5" stroke-linejoin="round"/>' +
        '<path d="M32 26 L32 66 M56 26 L56 66 M22 54 L22 66 M66 54 L66 66 M44 48 L44 66" stroke="rgba(255,255,255,.55)" stroke-width="1"/>' +
        '<rect x="9" y="66" width="70" height="10" rx="3" fill="' + deep + '" stroke="' + lite + '" stroke-width="1.3"/>' +
        '<rect x="9" y="65" width="70" height="3" rx="1.5" fill="' + pale + '"/></g>';
    } else {
      inner =
        '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="' + pale + '"/><stop offset=".5" stop-color="' + color + '"/><stop offset="1" stop-color="' + deep + '"/></linearGradient></defs>' +
        '<g filter="drop-shadow(0 4px 22px ' + color + 'bb)">' +
        '<polygon points="44,5 60,30 52,76 36,76 28,30" fill="url(#' + gid + ')" stroke="' + lite + '" stroke-width="1.5" stroke-linejoin="round"/>' +
        '<polygon points="44,5 52,76 44,40" fill="rgba(255,255,255,.26)"/>' +
        '<polygon points="44,5 36,76 44,40" fill="rgba(0,10,30,.22)"/>' +
        '<polyline points="28,30 44,40 60,30" fill="none" stroke="rgba(255,255,255,.6)" stroke-width="1.1"/></g>';
    }
    el.innerHTML = '<svg viewBox="0 0 88 88" width="100%" height="100%" style="display:block;overflow:visible">' + inner + "</svg>";
  }

  // ── procedural environment map (gives glassy facet reflections, no asset) ───
  function makeEnvTexture(THREE, color) {
    var size = 128;
    var cv = document.createElement("canvas"); cv.width = size; cv.height = size;
    var ctx = cv.getContext("2d");
    // vertical sky: white-hot top, ice-blue middle, deep navy bottom
    var g = ctx.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.35, lighten(color, 0.45));
    g.addColorStop(0.62, color);
    g.addColorStop(1, "#040a1e");
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
    // a couple of bright specular blobs to catch on the facets
    function blob(x, y, r, a) {
      var rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, "rgba(255,255,255," + a + ")");
      rg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    blob(size * 0.30, size * 0.26, size * 0.26, 0.95);
    blob(size * 0.74, size * 0.42, size * 0.18, 0.7);
    blob(size * 0.52, size * 0.70, size * 0.22, 0.4);
    var tex = new THREE.Texture(cv);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    return tex;
  }

  // ── vertex-coloured glass material (blue→cyan→white depth across the body) ──
  function makeCrystalMaterial(THREE, color, env) {
    var mat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color("#ffffff"),     // let vertex colours drive the hue
      vertexColors: true,
      metalness: 0.0,
      roughness: 0.08,
      transmission: 0.5,
      transparent: true,
      opacity: 0.96,
      reflectivity: 0.92,
      clearcoat: 1.0,
      clearcoatRoughness: 0.06,
      envMap: env || null,
      envMapIntensity: 1.5,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.34,
      flatShading: true,
      side: THREE.DoubleSide
    });
    return mat;
  }

  // Paint a geometry's vertices with a vertical gradient: deep at the base,
  // saturated mid, white-hot near the tips — this is what gives "colour depth".
  function paintVerticalGradient(THREE, geo, color) {
    var pos = geo.attributes.position;
    var n = pos.count;
    var ys = [];
    var minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < n; i++) { var y = pos.getY(i); ys.push(y); if (y < minY) minY = y; if (y > maxY) maxY = y; }
    var span = (maxY - minY) || 1;
    var deep = hexToRgb(darken(color, 0.5));
    var mid = hexToRgb(color);
    var hot = hexToRgb(lighten(color, 0.7));
    var cols = new Float32Array(n * 3);
    for (var j = 0; j < n; j++) {
      var f = (ys[j] - minY) / span;           // 0 base → 1 tip
      var c;
      if (f < 0.5) c = mix(deep, mid, f / 0.5);
      else c = mix(mid, hot, (f - 0.5) / 0.5);
      cols[j * 3] = c.r / 255; cols[j * 3 + 1] = c.g / 255; cols[j * 3 + 2] = c.b / 255;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  }

  // Bright white edge lines overlaid on a geometry (the "white-hot" facet seams)
  function edgeLines(THREE, geo, opacity) {
    var eg = new THREE.EdgesGeometry(geo, 18);
    var lm = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: opacity == null ? 0.55 : opacity });
    return new THREE.LineSegments(eg, lm);
  }

  // ── geometry: a tall, double-terminated crystal shard ───────────────────────
  function buildShardGeo(THREE) {
    var R = 1.0, top = 2.1, bot = -2.1, mid = 0.4, sides = 6;
    var verts = [], idx = [];
    for (var i = 0; i < sides; i++) {
      var a = (i / sides) * Math.PI * 2;
      verts.push(Math.cos(a) * R, mid, Math.sin(a) * R);
    }
    verts.push(0, top, 0);
    verts.push(0, bot, 0);
    var apex = sides, nadir = sides + 1;
    for (var j = 0; j < sides; j++) {
      var nx = (j + 1) % sides;
      idx.push(j, nx, apex);
      idx.push(nx, j, nadir);
    }
    var g = new THREE.BufferGeometry();
    g.setIndex(idx);
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    g.computeVertexNormals();
    g.scale(0.92, 1, 0.92);
    return g;
  }

  // A single flat, blade-like crown spike (a thin 4-sided pyramid prism).
  // Built tip-up, base at y=0; w = half-width, d = half-depth, h = height.
  function buildBladeGeo(THREE, w, d, h) {
    var verts = [
      -w, 0, -d,  w, 0, -d,  w, 0, d,  -w, 0, d, // base ring 0..3
      0, h, 0                                     // tip 4
    ];
    var idx = [
      0, 1, 4,  1, 2, 4,  2, 3, 4,  3, 0, 4,      // 4 side faces
      0, 3, 2,  0, 2, 1                            // base (closes it)
    ];
    var g = new THREE.BufferGeometry();
    g.setIndex(idx);
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    g.computeVertexNormals();
    return g;
  }

  // The crown: faceted translucent base block + glowing rim + fanned blades.
  // Returns { group, extras:[geometries to dispose], edges:[lineSegments] }.
  function buildCrown(THREE, color, env) {
    var group = new THREE.Group();
    var extras = [], edges = [];
    var glassMat = makeCrystalMaterial(THREE, color, env);

    // ── faceted base block (an octagonal prism — reads as the crystal cube) ──
    var baseGeo = new THREE.CylinderGeometry(1.5, 1.62, 0.62, 8, 1);
    paintVerticalGradient(THREE, baseGeo, color);
    var base = new THREE.Mesh(baseGeo, glassMat);
    base.position.y = -1.5;
    group.add(base); extras.push(baseGeo);
    var baseEdge = edgeLines(THREE, baseGeo, 0.4); baseEdge.position.copy(base.position); group.add(baseEdge); edges.push(baseEdge);

    // dark inner pedestal that the spikes rise from (the near-black ring)
    var pedGeo = new THREE.CylinderGeometry(1.18, 1.28, 0.5, 8, 1);
    var pedMat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#0a1124"), metalness: 0.5, roughness: 0.35, flatShading: true });
    var ped = new THREE.Mesh(pedGeo, pedMat);
    ped.position.y = -0.92;
    group.add(ped); extras.push(pedGeo);

    // a lower, wider glass step under the base block (the second tier of the
    // plinth in the reference) — gives the base more presence/height.
    var stepGeo = new THREE.CylinderGeometry(1.66, 1.78, 0.34, 8, 1);
    paintVerticalGradient(THREE, stepGeo, color);
    var step = new THREE.Mesh(stepGeo, glassMat);
    step.position.y = -1.96;
    group.add(step); extras.push(stepGeo);
    var stepEdge = edgeLines(THREE, stepGeo, 0.35); stepEdge.position.copy(step.position); group.add(stepEdge); edges.push(stepEdge);

    // bright glowing rim band on top of the pedestal (primary cyan ring)
    var rimGeo = new THREE.CylinderGeometry(1.26, 1.26, 0.16, 8, 1);
    var rimMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(lighten(color, 0.62)), transparent: true, opacity: 0.98 });
    var rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.y = -0.66;
    group.add(rim); extras.push(rimGeo);

    // a second, slightly larger and softer halo band just below it — makes the
    // glowing base ring read as thick and luminous like the artwork.
    var rim2Geo = new THREE.CylinderGeometry(1.34, 1.34, 0.07, 8, 1);
    var rim2Mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(lighten(color, 0.35)), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
    var rim2 = new THREE.Mesh(rim2Geo, rim2Mat);
    rim2.position.y = -0.78;
    group.add(rim2); extras.push(rim2Geo);

    // ── fanned blade spikes (symmetric tiara) ─────────────────────────────────
    // A wide 7-point fan of sharp glass blades, tallest in the centre, stepping
    // down to short outer needles — matching the reference crown silhouette.
    // a = angle around the ring, h = blade height, w = blade half-width,
    // r = how far out along the ring the blade sits (wider at the edges).
    var blades = [
      { a: -1.30, h: 1.18, w: 0.155, r: 1.20 },
      { a: -0.86, h: 1.62, w: 0.180, r: 1.12 },
      { a: -0.43, h: 2.12, w: 0.205, r: 1.05 },
      { a:  0.00, h: 2.70, w: 0.235, r: 1.00 },
      { a:  0.43, h: 2.12, w: 0.205, r: 1.05 },
      { a:  0.86, h: 1.62, w: 0.180, r: 1.12 },
      { a:  1.30, h: 1.18, w: 0.155, r: 1.20 }
    ];
    for (var i = 0; i < blades.length; i++) {
      var b = blades[i];
      var bg = buildBladeGeo(THREE, b.w, 0.15, b.h);
      paintVerticalGradient(THREE, bg, color);
      var m = new THREE.Mesh(bg, glassMat);
      m.position.x = Math.sin(b.a) * b.r;
      m.position.z = Math.cos(b.a) * 0.12;
      m.position.y = -0.6;
      m.rotation.y = b.a;
      // fan the outer blades slightly outward so the tips splay like the artwork
      m.rotation.z = -b.a * 0.16;
      group.add(m); extras.push(bg);
      var e = edgeLines(THREE, bg, 0.7);
      e.position.copy(m.position); e.rotation.copy(m.rotation); group.add(e); edges.push(e);
    }

    group._glassMat = glassMat;
    group._pedMat = pedMat;
    group._rimMat = rimMat;
    group._rim2Mat = rim2Mat;
    return { group: group, extras: extras, edges: edges };
  }

  // ── one live (STATIC) crystal instance ──────────────────────────────────────
  function makeInstance(el, opts) {
    var THREE = window.THREE;
    var kind = opts.kind || "shard";
    var color = opts.color || "#7cc7ff";
    var wantGlow = opts.glow !== false;

    var W = el.clientWidth || 120;
    var H = opts.height || el.clientHeight || 150;

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(36, W / H, 0.1, 100);
    // Pose the camera slightly above and back so we look at the model head-on
    // with a gentle downward tilt — matching the reference art.
    camera.position.set(0, 0.55, 6.6);
    camera.lookAt(0, 0.05, 0);

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
    if (renderer.outputEncoding !== undefined && THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;
    el.innerHTML = "";
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";

    var env = makeEnvTexture(THREE, color);

    var disposables = [];   // geometries / textures / materials to free
    disposables.push(env);

    var obj, edgesList = [], singleEdge = null;

    if (kind === "crown") {
      var built = buildCrown(THREE, color, env);
      obj = built.group;
      obj.scale.set(0.92, 0.92, 0.92);
      // STATIC front-facing pose: face the camera, tilt forward a touch so the
      // tops of the blades and the base facets are visible (as in the artwork).
      obj.rotation.y = 0;
      obj.rotation.x = 0.12;
      obj.position.y = 0.18;
      edgesList = built.edges;
      built.extras.forEach(function (g) { disposables.push(g); });
      disposables.push(obj._glassMat, obj._pedMat, obj._rimMat, obj._rim2Mat);
    } else {
      var geo = buildShardGeo(THREE);
      paintVerticalGradient(THREE, geo, color);
      var glassMat = makeCrystalMaterial(THREE, color, env);
      obj = new THREE.Mesh(geo, glassMat);
      // STATIC pose: a slight lean like the league crystal in the reference.
      obj.rotation.y = 0.42;
      obj.rotation.z = 0.06;
      obj.rotation.x = 0.05;
      singleEdge = edgeLines(THREE, geo, 0.6);
      obj.add(singleEdge);
      disposables.push(geo, glassMat);
    }
    scene.add(obj);

    // ground-glow pool beneath the model (soft radial sprite) ------------------
    var glow = null;
    if (wantGlow) {
      var gs = 256;
      var gcv = document.createElement("canvas"); gcv.width = gs; gcv.height = gs;
      var gx = gcv.getContext("2d");
      var rg = gx.createRadialGradient(gs / 2, gs / 2, 0, gs / 2, gs / 2, gs / 2);
      var cr = hexToRgb(lighten(color, 0.2));
      rg.addColorStop(0, "rgba(" + cr.r + "," + cr.g + "," + cr.b + ",0.85)");
      rg.addColorStop(0.4, "rgba(" + cr.r + "," + cr.g + "," + cr.b + ",0.35)");
      rg.addColorStop(1, "rgba(" + cr.r + "," + cr.g + "," + cr.b + ",0)");
      gx.fillStyle = rg; gx.fillRect(0, 0, gs, gs);
      var gtex = new THREE.Texture(gcv); gtex.needsUpdate = true;
      var gmat = new THREE.SpriteMaterial({ map: gtex, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
      glow = new THREE.Sprite(gmat);
      glow.scale.set(5.2, 2.6, 1);
      glow.position.set(0, kind === "crown" ? -2.0 : -2.3, -0.2);
      scene.add(glow);
      disposables.push(gtex, gmat);
    }

    // lighting — bright key, cool rim, fill, and an emissive core point --------
    scene.add(new THREE.AmbientLight(0x6688cc, 0.7));
    var key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(3, 5, 5); scene.add(key);
    var rim2 = new THREE.DirectionalLight(new THREE.Color(lighten(color, 0.2)), 1.1);
    rim2.position.set(-5, 2, -2); scene.add(rim2);
    var fill = new THREE.DirectionalLight(new THREE.Color(color), 0.6);
    fill.position.set(0, -3, 4); scene.add(fill);
    var core = new THREE.PointLight(new THREE.Color(lighten(color, 0.3)), 1.5, 14);
    core.position.set(0, 0.2, 0.5); scene.add(core);

    // ── render ONE static frame (no animation loop at all) ────────────────────
    var alive = true;
    function renderOnce() { if (alive) renderer.render(scene, camera); }
    // render now, and once more on the next tick in case fonts/layout shift the
    // container size right after mount (keeps the first paint crisp). Still no
    // ongoing animation — these are one-off draws.
    renderOnce();
    requestAnimationFrame(renderOnce);

    // re-render only when the container is resized (stay crisp), never on a timer
    function onResize() {
      var w = el.clientWidth || W, h = opts.height || el.clientHeight || H;
      camera.aspect = w / h; camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      renderOnce();
    }
    var ro = null;
    if ("ResizeObserver" in window) { ro = new ResizeObserver(onResize); ro.observe(el); }

    function destroy() {
      if (!alive) return;
      alive = false;
      if (ro) ro.disconnect();
      try { scene.remove(obj); } catch (e) { }
      // dispose every edge line
      try {
        edgesList.forEach(function (e) { if (e.geometry) e.geometry.dispose(); if (e.material) e.material.dispose(); });
        if (singleEdge) { if (singleEdge.geometry) singleEdge.geometry.dispose(); if (singleEdge.material) singleEdge.material.dispose(); }
      } catch (e) { }
      // dispose tracked geometries / materials / textures
      try { disposables.forEach(function (d) { if (d && d.dispose) d.dispose(); }); } catch (e) { }
      try {
        renderer.forceContextLoss();
        renderer.dispose();
        if (renderer.domElement && renderer.domElement.parentNode)
          renderer.domElement.parentNode.removeChild(renderer.domElement);
      } catch (e) { }
    }

    return { destroy: destroy };
  }

  // ── public mount ────────────────────────────────────────────────────────────
  function mount(el, opts) {
    opts = opts || {};
    if (!el) return { destroy: function () { } };

    svgFallback(el, opts.kind || "shard", opts.color || "#7cc7ff");

    var handle = { destroy: function () { handle._d && handle._d(); } };
    _instances.push(handle);

    if (!webglOK()) return handle;

    loadThree().then(function (ok) {
      if (!ok || !window.THREE) return;
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

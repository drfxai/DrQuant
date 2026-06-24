// routes/share-post.js
// ----------------------------------------------------------------------------
// PUBLIC (no-auth) share landing for a single Market / Explore post.
//
//   GET /p/:id  →  an Open-Graph-tagged HTML page that:
//     • unfurls with a rich preview when pasted into WhatsApp / X / Telegram /…
//     • shows the post (image/video, title, caption, author) right on the web,
//       so anyone — even without the app — sees it (great for advertising)
//     • has an "Open in DrFX Quant" button that deep-links into the app
//       ( /?post=<id> ), which opens the Market overlay + the post.
//
// PRIVACY: only PUBLIC, non-deleted posts expose content. A subscribers-only or
// private post (or a deleted one) shows just a generic card + app CTA, never the
// content. This router is intentionally unauthenticated and read-only, and must
// be mounted BEFORE the SPA catch-all (app.get("*")) in server.js.
// ----------------------------------------------------------------------------

const express = require("express");
const router = express.Router();

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Resolve a stored media value to an absolute URL for OG/media tags.
// Accepts an /uploads/<file> path (prefixed with origin) or an http(s) URL.
function absMedia(origin, v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/^\/uploads\/[A-Za-z0-9._-]+$/.test(s)) return origin + s;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(s)) return s;
  return "";
}

function page({ title, body, origin }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>html,body{margin:0;height:100%;background:#070d1f;color:#e6edff;font-family:system-ui,Segoe UI,Roboto,sans-serif}
.w{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;text-align:center}
.c{max-width:380px}a.btn{display:inline-block;margin-top:18px;padding:13px 22px;border-radius:13px;background:linear-gradient(135deg,#1f8bff,#7c5cff);color:#fff;text-decoration:none;font-weight:700}</style>
</head><body><div class="w"><div class="c">
<div style="font-size:22px;font-weight:800;margin-bottom:8px">DrFX <span style="color:#7c5cff">Quant</span></div>
<div style="color:#9fb2d8;font-size:14px;line-height:1.5">${esc(body)}</div>
<a class="btn" href="${esc(origin)}/">Open DrFX Quant</a>
</div></div></body></html>`;
}

function landing({ origin, post, author }) {
  const id = post.id;
  const openUrl = `${origin}/?post=${id}`;
  const authorName = author.name || author.username || "A creator";
  const handle = author.username ? "@" + author.username : "";
  const avatar = absMedia(origin, author.avatar);
  const img = absMedia(origin, post.media_type === "image" ? post.media_url : (post.thumb_url || ""));
  const ogImg = img || avatar || (origin + "/icon.svg");
  const caption = (post.caption || "").replace(/\s+/g, " ").trim();
  const ogTitle = post.title ? post.title : `${authorName} on DrFX Quant`;
  const ogDesc = (caption || post.title || "Trading idea shared on DrFX Quant Market.").slice(0, 200);

  // Body media block
  let mediaHtml = "";
  if (post.media_type === "image" && img) {
    mediaHtml = `<img src="${esc(img)}" alt="" style="width:100%;display:block;max-height:70vh;object-fit:contain;background:#05081c"/>`;
  } else if (post.media_type === "video" && absMedia(origin, post.media_url)) {
    const v = absMedia(origin, post.media_url);
    mediaHtml = `<video src="${esc(v)}" controls playsinline preload="metadata"${post.thumb_url && absMedia(origin, post.thumb_url) ? ` poster="${esc(absMedia(origin, post.thumb_url))}"` : ""} style="width:100%;display:block;max-height:70vh;background:#000"></video>`;
  }

  const avatarBox = avatar
    ? `<img src="${esc(avatar)}" alt="" style="width:44px;height:44px;border-radius:50%;object-fit:cover;display:block"/>`
    : `<div style="width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1f8bff,#7c5cff);font-size:20px">🧑‍💻</div>`;

  const verified = author.verified
    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="#1f8bff" style="margin-left:3px;vertical-align:-2px"><path d="M12 1l2.6 1.9 3.2-.2 1 3 2.6 1.9-1 3 1 3-2.6 1.9-1 3-3.2-.2L12 23l-2.6-1.9-3.2.2-1-3L2.6 16.5l1-3-1-3 2.6-1.9 1-3 3.2.2z"/><path d="M10.5 14.6l-2.1-2.1-1.3 1.3 3.4 3.4 5.9-5.9-1.3-1.3z" fill="#fff"/></svg>`
    : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(ogTitle)} · DrFX Quant</title>
<meta property="og:type" content="article"/>
<meta property="og:site_name" content="DrFX Quant"/>
<meta property="og:title" content="${esc(ogTitle)}"/>
<meta property="og:description" content="${esc(ogDesc)}"/>
<meta property="og:image" content="${esc(ogImg)}"/>
<meta property="og:url" content="${esc(openUrl)}"/>
<meta name="twitter:card" content="${img ? "summary_large_image" : "summary"}"/>
<meta name="twitter:title" content="${esc(ogTitle)}"/>
<meta name="twitter:description" content="${esc(ogDesc)}"/>
<meta name="twitter:image" content="${esc(ogImg)}"/>
<link rel="icon" href="${esc(origin)}/icon.svg"/>
<style>html,body{margin:0;min-height:100%;background:radial-gradient(ellipse 120% 90% at 50% -10%,#101a3d,#0a1130 40%,#05081c 78%);color:#e6edff;font-family:system-ui,Segoe UI,Roboto,sans-serif}
.w{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
.card{width:100%;max-width:460px;background:rgba(12,18,42,.72);border:1px solid rgba(140,170,255,.16);border-radius:22px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.5)}
.hd{display:flex;align-items:center;gap:11px;padding:14px}
.nm{color:#eaf1ff;font-weight:700;font-size:15px}
.hl{color:#8aa0cc;font-size:12px}
.cap{padding:12px 16px 4px;color:#cdd9f5;font-size:14.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.ttl{padding:12px 16px 0;color:#fff;font-weight:700;font-size:17px;line-height:1.3}
.meta{display:flex;gap:16px;padding:12px 16px;color:#7d8fb8;font-size:13px}
a.btn{display:block;margin:6px 16px 16px;padding:14px;border-radius:13px;background:linear-gradient(135deg,#1f8bff,#7c5cff);color:#fff;text-decoration:none;font-weight:800;text-align:center;letter-spacing:.3px}
.brand{display:flex;align-items:center;justify-content:center;gap:7px;padding:14px 0 2px;color:#9fb2d8;font-size:12px}</style>
</head><body><div class="w"><div style="width:100%;max-width:460px">
<div class="brand"><span style="font-weight:800;color:#eaf1ff;font-size:15px">DrFX <span style="color:#7c5cff">Quant</span></span><span style="opacity:.6">· Market</span></div>
<div class="card">
  <div class="hd">${avatarBox}<div style="flex:1;min-width:0"><div class="nm">${esc(authorName)}${verified}</div><div class="hl">${esc(handle)}</div></div></div>
  ${post.title ? `<div class="ttl">${esc(post.title)}</div>` : ""}
  ${mediaHtml}
  ${caption ? `<div class="cap">${esc(caption)}</div>` : ""}
  <div class="meta"><span>❤️ ${Number(post.like_count) || 0}</span><span>💬 ${Number(post.comment_count) || 0}</span></div>
  <a class="btn" href="${esc(openUrl)}">Open in DrFX Quant</a>
</div>
</div></div></body></html>`;
}

router.get("/:id", async (req, res) => {
  const pool = req.app.get("pool");
  const origin = `${req.protocol}://${req.get("host")}`;
  const id = parseInt(req.params.id, 10);
  try {
    if (!id) return res.status(404).send(page({ title: "DrFX Quant", body: "Post not found.", origin }));
    const { rows: [r] } = await pool.query(
      `SELECT po.id, po.title, po.caption, po.media_url, po.media_type, po.thumb_url,
              po.visibility, po.deleted_at, po.like_count, po.comment_count,
              u.username, u.name, u.avatar, u.verified
         FROM posts po JOIN users u ON u.id = po.author_id
        WHERE po.id = $1`,
      [id]
    );
    if (!r || r.deleted_at) return res.status(404).send(page({ title: "DrFX Quant", body: "This post is no longer available.", origin }));

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=120");

    // Only PUBLIC posts expose content publicly.
    if (r.visibility !== "public") {
      const who = r.name || r.username || "A creator";
      return res.send(page({ title: "DrFX Quant", body: `${who} shared a post on DrFX Quant. Open the app to view it.`, origin }));
    }
    const post = {
      id: r.id, title: r.title || "", caption: r.caption || "", media_url: r.media_url || "",
      media_type: r.media_type || "text", thumb_url: r.thumb_url || "",
      like_count: r.like_count || 0, comment_count: r.comment_count || 0,
    };
    const author = { username: r.username || "", name: r.name || "", avatar: r.avatar || "", verified: !!r.verified };
    return res.send(landing({ origin, post, author }));
  } catch (e) {
    return res.status(500).send(page({ title: "DrFX Quant", body: "Something went wrong.", origin }));
  }
});

module.exports = router;

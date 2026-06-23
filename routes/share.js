// routes/share.js
// ----------------------------------------------------------------------------
// PUBLIC (no-auth) share landing for a single channel/group message.
//
//   GET /m/:id  →  a small Open-Graph-tagged HTML card that:
//     • unfurls nicely when pasted into WhatsApp / X / Telegram / etc.
//     • deep-links into the SPA  ( /?chat=<chatId>&m=<id> )  via an "Open" button
//
// PRIVACY (critical):
//   • DMs are NEVER shareable — always returns a generic "private" card.
//   • VIP (pro_only) and private chats expose ONLY the channel name + an
//     "open in app" CTA — never the message content. Public channels/groups
//     may show a short text preview.
//
// This router is intentionally unauthenticated and read-only. It must be mounted
// BEFORE the SPA catch-all (app.get("*")) in server.js.
// ----------------------------------------------------------------------------

const express = require("express");
const router = express.Router();

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Minimal full-page shell with a single message (errors / private notices).
function page({ title, body, origin }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>html,body{margin:0;height:100%;background:#070d1f;color:#e6edff;font-family:system-ui,Segoe UI,Roboto,sans-serif}
.w{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;text-align:center}
.c{max-width:380px}a.btn{display:inline-block;margin-top:18px;padding:13px 22px;border-radius:13px;background:linear-gradient(135deg,#7c5cff,#4a8cff 55%,#22d3ee);color:#fff;text-decoration:none;font-weight:700}</style>
</head><body><div class="w"><div class="c">
<div style="font-size:22px;font-weight:800;margin-bottom:8px">DrFX <span style="color:#7c5cff">Quant</span></div>
<div style="color:#9fb2d8;font-size:14px;line-height:1.5">${esc(body)}</div>
<a class="btn" href="${esc(origin)}/">Open DrFX Quant</a>
</div></div></body></html>`;
}

// Rich share card for a channel/group message.
function landing({ origin, title, chanName, username, avatar, preview, isRestricted, proOnly, openUrl, ogDesc }) {
  const img = avatar || (origin + "/icon.svg");
  const lockRow = isRestricted
    ? `<div style="margin-top:14px;padding:12px 14px;border-radius:14px;background:rgba(240,185,11,.08);border:1px solid rgba(240,185,11,.3);color:#FFD700;font-size:13px;font-weight:700">${proOnly ? "🔒 VIP channel — subscribe in the app to view" : "🔒 Private channel — open the app to view"}</div>`
    : "";
  const previewRow = (!isRestricted && preview)
    ? `<div style="margin-top:14px;padding:13px 15px;border-radius:14px;background:rgba(18,28,52,.7);border:1px solid rgba(120,160,255,.16);color:#cdd9f5;font-size:14px;line-height:1.5;text-align:left;white-space:pre-wrap;word-break:break-word">${esc(preview)}</div>`
    : "";
  const handle = username ? `<div style="color:#8cc4ff;font-size:13px;margin-top:3px">@${esc(username)}</div>` : "";
  const avatarBox = avatar
    ? `<img src="${esc(avatar)}" alt="" style="width:72px;height:72px;border-radius:50%;object-fit:cover;display:block;margin:0 auto"/>`
    : `<div style="width:72px;height:72px;border-radius:50%;margin:0 auto;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(124,92,255,.3),rgba(34,211,238,.18));font-size:30px">📢</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<meta property="og:type" content="website"/>
<meta property="og:site_name" content="DrFX Quant"/>
<meta property="og:title" content="${esc(chanName)}"/>
<meta property="og:description" content="${esc(ogDesc)}"/>
<meta property="og:image" content="${esc(img)}"/>
<meta property="og:url" content="${esc(openUrl)}"/>
<meta name="twitter:card" content="summary"/>
<meta name="twitter:title" content="${esc(chanName)}"/>
<meta name="twitter:description" content="${esc(ogDesc)}"/>
<meta name="twitter:image" content="${esc(img)}"/>
<link rel="icon" href="${esc(origin)}/icon.svg"/>
<style>html,body{margin:0;height:100%;background:radial-gradient(ellipse 120% 90% at 50% -10%,#101a3d,#0a1130 40%,#05081c 78%);color:#e6edff;font-family:system-ui,Segoe UI,Roboto,sans-serif}
.w{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
.c{width:100%;max-width:400px;background:rgba(12,18,42,.66);border:1px solid rgba(140,170,255,.16);border-radius:22px;padding:26px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.5)}
a.btn{display:block;margin-top:20px;padding:15px;border-radius:14px;background:linear-gradient(135deg,#7c5cff,#4a8cff 55%,#22d3ee);color:#fff;text-decoration:none;font-weight:800;letter-spacing:.3px}
.muted{color:#7d8fb8;font-size:12px;margin-top:14px}</style>
</head><body><div class="w"><div class="c">
${avatarBox}
<div style="font-size:20px;font-weight:800;margin-top:12px">${esc(chanName)}</div>
${handle}
${previewRow}
${lockRow}
<a class="btn" href="${esc(openUrl)}">Open in DrFX Quant</a>
<div class="muted">Shared from DrFX Quant · communication &amp; charting only</div>
</div></div></body></html>`;
}

router.get("/:id", async (req, res) => {
  const pool = req.app.get("pool");
  const origin = `${req.protocol}://${req.get("host")}`;
  const id = parseInt(req.params.id, 10);
  try {
    if (!id) return res.status(404).send(page({ title: "DrFX Quant", body: "Message not found.", origin }));
    const { rows: [m] } = await pool.query(
      `SELECT m.id, m.chat_id, m.content, m.image, m.created_at,
              c.type, c.name, c.username, c.avatar, c.visibility, c.pro_only
         FROM messages m JOIN chats c ON c.id = m.chat_id
        WHERE m.id = $1`,
      [id]
    );
    if (!m) return res.status(404).send(page({ title: "DrFX Quant", body: "This message is no longer available.", origin }));
    // DMs are private — never expose anything.
    if (m.type === "dm") return res.status(403).send(page({ title: "DrFX Quant", body: "This conversation is private.", origin }));

    const isRestricted = !!m.pro_only || m.visibility === "private";
    const chanName = m.name || "Channel";
    const avatar = (m.avatar && /^\/uploads\/[A-Za-z0-9._-]+$/.test(m.avatar)) ? origin + m.avatar : null;
    let preview = "";
    if (!isRestricted) preview = (m.content || (m.image ? "📷 Photo" : "")).replace(/\s+/g, " ").trim().slice(0, 220);
    const ogDesc = isRestricted
      ? (m.pro_only ? "VIP channel on DrFX Quant — open the app to view." : "Open DrFX Quant to view this channel.")
      : (preview || "Shared from DrFX Quant.");
    const openUrl = `${origin}/?chat=${m.chat_id}&m=${m.id}`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=120");
    return res.send(landing({ origin, title: `${chanName} · DrFX Quant`, chanName, username: m.username, avatar, preview, isRestricted, proOnly: !!m.pro_only, openUrl, ogDesc }));
  } catch (e) {
    return res.status(500).send(page({ title: "DrFX Quant", body: "Something went wrong.", origin }));
  }
});

module.exports = router;

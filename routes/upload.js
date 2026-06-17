const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const router = express.Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");

// The stored extension is ALWAYS derived from the validated MIME type, never the
// user-supplied filename. Otherwise an attacker could send Content-Type:image/png
// with a filename like "x.html"/"x.svg" and have it served back as an executable
// document from our own origin (stored XSS / token theft). Only safe, known types
// are listed — deliberately NO html/svg/xml/js/wasm/executable types.
const MIME_EXT = {
  // images
  "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
  // audio (voice notes + clips)
  "audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp3": ".mp3",
  "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/aac": ".aac", "audio/wav": ".wav", "audio/x-wav": ".wav",
  // video (clips)
  "video/webm": ".webm", "video/mp4": ".mp4", "video/quicktime": ".mov",
  // documents / archives — downloaded by the client, never rendered inline
  "application/pdf": ".pdf", "text/plain": ".txt", "text/csv": ".csv", "application/zip": ".zip",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

// Absolute ceiling multer enforces mid-stream (aborts the request if exceeded).
const HARD_MAX = 60 * 1024 * 1024;
// Per-category caps, enforced after the stream once the kind is known.
const CAP = {
  image: 10 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
  video: 60 * 1024 * 1024,
  file: 30 * 1024 * 1024,
};

function kindFor(mime) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

// Display name from the user's original filename: strip any directory, drop
// control/quote/angle chars, cap length. METADATA ONLY — never used for storage.
function safeName(name) {
  return String(name || "file")
    .replace(/^.*[\\/]/, "")
    .replace(/[\u0000-\u001f"'<>]/g, "")
    .slice(0, 120) || "file";
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = MIME_EXT[file.mimetype] || ".bin";
    cb(null, crypto.randomBytes(16).toString("hex") + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: HARD_MAX, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = Object.prototype.hasOwnProperty.call(MIME_EXT, file.mimetype);
    cb(ok ? null : new Error("Unsupported file type"), ok);
  },
});

// POST /api/upload  → { url, kind, mime, size, name }
router.post("/", (req, res) => {
  const auth = req.app.get("authMiddleware");
  auth(req, res, () => {
    upload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || "Upload failed" });
      if (!req.file) return res.status(400).json({ error: "No file" });
      const kind = kindFor(req.file.mimetype);
      const cap = CAP[kind] || HARD_MAX;
      if (req.file.size > cap) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: `File too large (max ${Math.round(cap / 1048576)}MB for ${kind})` });
      }
      res.json({
        url: "/uploads/" + req.file.filename,
        kind,
        mime: req.file.mimetype,
        size: req.file.size,
        name: safeName(req.file.originalname),
      });
    });
  });
});

module.exports = router;

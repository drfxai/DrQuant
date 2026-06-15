const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const router = express.Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

// Extension is derived from the VALIDATED MIME type, never the user-supplied
// filename. Otherwise an attacker could send Content-Type: image/png with a
// filename like "x.html" / "x.svg" and have the file served back as an
// executable document from our own origin (stored XSS / token theft).
const MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = MIME_EXT[file.mimetype] || ".bin";
    cb(null, crypto.randomBytes(16).toString("hex") + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = Object.prototype.hasOwnProperty.call(MIME_EXT, file.mimetype);
    cb(ok ? null : new Error("Images only (jpg, png, gif, webp)"), ok);
  },
});

// POST /api/upload
router.post("/", (req, res) => {
  const auth = req.app.get("authMiddleware");
  auth(req, res, () => {
    upload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || "Upload failed" });
      if (!req.file) return res.status(400).json({ error: "No file" });
      res.json({ url: "/uploads/" + req.file.filename });
    });
  });
});

module.exports = router;

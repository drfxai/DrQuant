// services/email.js
// ----------------------------------------------------------------------------
// Transactional email for DrFX Quant — currently the sign-up confirmation code.
//
// Sending is done over SMTP via nodemailer. Configure the SMTP_* values in .env
// (easiest via `sudo bash manage.sh` → option 6). This works with any SMTP
// provider: Resend, SendGrid, Mailgun, Gmail (app password), Supabase's SMTP, …
//
//   SMTP_HOST     smtp.resend.com  /  smtp.gmail.com  /  smtp.sendgrid.net …
//   SMTP_PORT     587 (STARTTLS, default) or 465 (SSL)
//   SMTP_SECURE   "true" for 465, "false"/unset for 587
//   SMTP_USER     SMTP username / API-key id
//   SMTP_PASS     SMTP password / API key
//   SMTP_FROM     e.g.  DrFX Quant <no-reply@yourdomain.com>
//
// If SMTP_HOST is not set, smtpConfigured() returns false and the auth routes
// fall back to instant sign-up (no email step) — so the app keeps working until
// email is configured.
// ----------------------------------------------------------------------------
const nodemailer = require("nodemailer");

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && String(process.env.SMTP_HOST).trim());
}

let _transport = null;
function transport() {
  if (_transport) return _transport;
  if (!smtpConfigured()) return null;
  const port = parseInt(process.env.SMTP_PORT, 10) || 587;
  const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;
  const hasAuth = !!(process.env.SMTP_USER || process.env.SMTP_PASS);
  _transport = nodemailer.createTransport({
    host: String(process.env.SMTP_HOST).trim(),
    port,
    secure,
    auth: hasAuth ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return _transport;
}

function fromAddress() {
  return process.env.SMTP_FROM || process.env.SMTP_USER || "DrFX Quant <no-reply@localhost>";
}

async function sendMail({ to, subject, text, html }) {
  const t = transport();
  if (!t) throw new Error("SMTP is not configured (set SMTP_HOST in .env)");
  return t.sendMail({ from: fromAddress(), to, subject, text, html });
}

function otpHtml(code) {
  const safe = String(code).replace(/[^0-9]/g, "");
  return `<!doctype html><html><body style="margin:0;background:#0a0f1f;padding:32px 16px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="440" cellpadding="0" cellspacing="0" style="max-width:440px;width:100%;background:#0f1730;border:1px solid #1d2a55;border-radius:18px;overflow:hidden">
      <tr><td style="padding:28px 32px 8px;text-align:center">
        <div style="font-size:22px;font-weight:800;color:#e0e8ff;letter-spacing:.3px">DrFX&nbsp;<span style="color:#5b8def">Quant</span></div>
      </td></tr>
      <tr><td style="padding:8px 32px 0;text-align:center">
        <div style="color:#9fb0d6;font-size:14px;line-height:1.6">Use this code to confirm your email and finish creating your account.</div>
      </td></tr>
      <tr><td style="padding:24px 32px;text-align:center">
        <div style="display:inline-block;background:#0a1330;border:1px solid #2a3a6b;border-radius:14px;padding:16px 26px;font-size:34px;font-weight:800;letter-spacing:12px;color:#ffffff">${safe}</div>
      </td></tr>
      <tr><td style="padding:0 32px 28px;text-align:center">
        <div style="color:#6b7aa3;font-size:12px;line-height:1.6">This code expires in 10 minutes. If you didn't request it, you can safely ignore this email.</div>
      </td></tr>
    </table>
    <div style="color:#42507a;font-size:11px;margin-top:16px">© DrFX Quant</div>
  </td></tr></table>
  </body></html>`;
}

async function sendOtpEmail(to, code) {
  const safe = String(code).replace(/[^0-9]/g, "");
  return sendMail({
    to,
    subject: `${safe} is your DrFX Quant confirmation code`,
    text: `Your DrFX Quant confirmation code is ${safe}. It expires in 10 minutes. If you didn't request this, ignore this email.`,
    html: otpHtml(safe),
  });
}

async function sendTestEmail(to) {
  return sendMail({
    to,
    subject: "DrFX Quant — SMTP test ✓",
    text: "If you can read this, your DrFX Quant SMTP settings work.",
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1a2240">
      <h2 style="margin:0 0 8px">SMTP is working ✓</h2>
      <p>If you can read this, your <b>DrFX Quant</b> email settings are correct. Sign-up confirmation codes will be delivered from this address.</p>
    </div>`,
  });
}

module.exports = { smtpConfigured, sendMail, sendOtpEmail, sendTestEmail };

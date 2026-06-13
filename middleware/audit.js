// middleware/audit.js
// ----------------------------------------------------------------------------
// Fire-and-forget audit logger. Call from any sensitive route AFTER the action
// succeeds. Never let an audit failure break the request — log and move on.
// Requires the audit_logs table from migrations/001_ecosystem_schema.sql.
// ----------------------------------------------------------------------------

async function audit(pool, { actor, action, targetType, targetId, ip, metadata }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, ip, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        actor?.id ?? null,
        actor?.role ?? null,
        action,
        targetType ?? null,
        targetId != null ? String(targetId) : null,
        ip ?? null,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
  } catch (err) {
    console.error("[audit] failed:", action, err.message);
  }
}

// Express helper: pulls actor + ip off req for you.
function auditFromReq(pool, req, { action, targetType, targetId, metadata }) {
  return audit(pool, {
    actor: req.user,
    action,
    targetType,
    targetId,
    ip: req.ip,
    metadata,
  });
}

module.exports = { audit, auditFromReq };

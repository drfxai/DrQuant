'use strict';
const { pool } = require('./db');
/**
 * audit.js — immutable audit trail (spec §21.6).
 * Every privileged or financial-control action is recorded. The audit_log
 * table is append-only at the DB level; this is just the writer + a search.
 */
async function writeAudit(entry, client = pool) {
  const {
    actorId = null, actorRole = null, action, walletId = null, transactionId = null,
    ip = null, deviceId = null, userAgent = null, reason = null, metadata = {},
  } = entry;
  if (!action) throw new Error('audit: action is required');
  const { rows } = await client.query(
    `INSERT INTO audit_log
       (actor_id, actor_role, action, wallet_id, transaction_id,
        ip_address, device_id, user_agent, reason, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [actorId, actorRole, action, walletId, transactionId, ip, deviceId, userAgent, reason, metadata]
  );
  return rows[0].id;
}

async function searchAudit({ actorId, action, walletId, transactionId, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  const add = (sql, val) => { params.push(val); clauses.push(sql.replace('$$', `$${params.length}`)); };
  if (actorId) add('actor_id = $$', actorId);
  if (action) add('action = $$', action);
  if (walletId) add('wallet_id = $$', walletId);
  if (transactionId) add('transaction_id = $$', transactionId);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.min(limit, 500));
  const { rows } = await pool.query(
    `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT $${params.length}`, params);
  return rows;
}
module.exports = { writeAudit, searchAudit };

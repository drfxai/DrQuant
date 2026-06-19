'use strict';
const { Pool } = require('pg');

/**
 * Single shared pool. Configure with DATABASE_URL (same convention as the
 * rest of DrFX Quant). Numeric columns are returned as strings by node-pg,
 * which is exactly what we want — they flow straight into the decimal layer
 * with zero float exposure.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.QNTM_DB_POOL_MAX || 10),
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[qntm] idle pg client error:', err);
});

/**
 * Run `fn` inside a single SERIALIZABLE-safe transaction. `fn` receives a
 * dedicated client; every query for that unit of work MUST use it so the
 * row locks (SELECT ... FOR UPDATE) and the atomic commit/rollback all apply
 * to the same connection. Any throw rolls the whole thing back — this is the
 * atomicity guarantee the spec requires.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };

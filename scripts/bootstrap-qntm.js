'use strict';
/**
 * One-time QNTM bootstrap CLI.
 *
 *   node scripts/bootstrap-qntm.js --confirm-bootstrap-qntm
 *
 * Requires DATABASE_URL (same as the app). Refuses to run without the explicit
 * confirmation flag. Safe to re-run: if already bootstrapped it exits cleanly
 * without minting or transferring anything.
 */
require('dotenv').config();

const CONFIRM = '--confirm-bootstrap-qntm';

(async () => {
  if (!process.argv.includes(CONFIRM)) {
    console.error('Refusing to bootstrap without ' + CONFIRM);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(2);
  }
  let setupQntmSchema; let bootstrap;
  try {
    ({ setupQntmSchema } = require('../qntm-ledger/integrate'));
    bootstrap = require('../qntm-ledger/src/economy/bootstrap');
  } catch (e) {
    console.error('Failed to load QNTM modules:', e.message);
    process.exit(1);
  }
  try {
    await setupQntmSchema();
    if (await bootstrap.isBootstrapped()) {
      console.log('QNTM already bootstrapped -- nothing to do.');
      process.exit(0);
    }
    const result = await bootstrap.bootstrap({ actorId: 'cli' });
    console.log('QNTM bootstrap complete:');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (e) {
    console.error('Bootstrap failed:', e.message);
    process.exit(1);
  }
})();

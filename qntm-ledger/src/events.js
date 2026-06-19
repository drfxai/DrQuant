'use strict';
const { EventEmitter } = require('node:events');
/**
 * Central event hub. The financial engine stays decoupled from delivery:
 * it emits domain events here, and adapters (Socket.io, notifications,
 * analytics, the risk engine, the admin monitor) subscribe.
 *
 * Wiring example in your Express/Socket.io app:
 *   const { events } = require('./qntm-ledger/src/events');
 *   events.on('marketplace.purchase.completed', (e) => io.to(e.buyerRoom).emit('toast', e));
 */
const events = new EventEmitter();
events.setMaxListeners(50);

function emit(name, payload) {
  // Never let a listener throw into the financial path.
  try {
    events.emit(name, { event: name, at: new Date().toISOString(), ...payload });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[qntm] event listener for ${name} threw:`, err);
  }
}
module.exports = { events, emit };

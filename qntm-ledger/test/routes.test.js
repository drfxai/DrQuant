'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { pool } = require('../src/db');
const wallets = require('../src/wallets');
const treasury = require('../src/treasury');
const { mountQntm } = require('../src/routes');

// --- build an app with a fake auth layer we can drive via a header ---
function buildApp() {
  const app = express();
  app.use(express.json());
  // test auth: read identity from headers (stand-in for real JWT/RBAC)
  app.use((req, _res, next) => {
    const id = req.get('X-Test-User');
    if (id) req.user = { id, role: req.get('X-Test-Role') || 'user' };
    next();
  });
  mountQntm(app, { basePath: '/api/qntm' });
  return app;
}

let server, base;
test.before(async () => {
  await wallets.ensureSystemWallets('QNTM');
  await treasury.mint('1000000', { actorId: 'admin', reason: 'route test' });
  server = http.createServer(buildApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

async function req(method, path, { user, role, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers['X-Test-User'] = user;
  if (role) headers['X-Test-Role'] = role;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

test('unauthenticated wallet request is 401', async () => {
  const r = await req('GET', '/api/qntm/wallets/me');
  assert.equal(r.status, 401);
});

test('admin mint+grant then user sees balance and can transfer', async () => {
  const uid = `rt_${Date.now()}`;
  const other = `${uid}_b`;
  // non-admin cannot grant
  const denied = await req('POST', '/api/qntm/admin/grant', { user: uid, role: 'user', body: { userId: uid, amount: '100' } });
  assert.equal(denied.status, 403);
  // admin grants 200 to uid
  const granted = await req('POST', '/api/qntm/admin/grant', { user: 'admin1', role: 'admin', body: { userId: uid, amount: '200', reason: 'test' } });
  assert.equal(granted.status, 201);
  // uid sees balance
  const bal = await req('GET', '/api/qntm/wallets/me', { user: uid });
  assert.equal(bal.status, 200);
  assert.equal(bal.json.wallet.available_balance, '200.000000000000000000');
  // uid transfers 50 to other
  const tx = await req('POST', '/api/qntm/wallets/transfer', { user: uid, body: { toUserId: other, amount: '50' } });
  assert.equal(tx.status, 201);
  const balB = await req('GET', '/api/qntm/wallets/me', { user: other });
  assert.equal(balB.json.wallet.available_balance, '50.000000000000000000');
});

test('overdraft via API returns a clean 409', async () => {
  const uid = `rtod_${Date.now()}`;
  await req('POST', '/api/qntm/admin/grant', { user: 'admin1', role: 'admin', body: { userId: uid, amount: '10' } });
  const tx = await req('POST', '/api/qntm/wallets/transfer', { user: uid, body: { toUserId: 'someone', amount: '999' } });
  assert.equal(tx.status, 409);
  assert.equal(tx.json.error.code, 'insufficient_funds');
});

test('the on/off-ramp bridge is disabled (501) and advertises it', async () => {
  const dep = await req('POST', '/api/qntm/bridge/deposit', { user: 'u1', body: { amount: '5' } });
  assert.equal(dep.status, 501);
  assert.equal(dep.json.error.code, 'ramp_disabled');
  const wd = await req('POST', '/api/qntm/bridge/withdraw', { user: 'u1', body: { amount: '5' } });
  assert.equal(wd.status, 501);
  const status = await req('GET', '/api/qntm/bridge/status', { user: 'u1' });
  assert.equal(status.status, 200);
  assert.equal(status.json.enabled, false);
});

test('admin supply endpoint reports integrity ok', async () => {
  const r = await req('GET', '/api/qntm/admin/supply', { user: 'admin1', role: 'admin' });
  assert.equal(r.status, 200);
  assert.equal(r.json.integrity.ok, true);
});

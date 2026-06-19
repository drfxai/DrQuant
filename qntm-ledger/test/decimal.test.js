'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../src/decimal');

test('round-trips amounts without precision loss', () => {
  for (const v of ['0', '1', '50.00', '0.000000000000000001', '123456789.123456789', '1000000000']) {
    assert.equal(d.fromBaseUnits(d.toBaseUnits(v)), v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
  }
});

test('the classic float trap is exact here', () => {
  // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754; must be exactly "0.3" for us.
  assert.equal(d.add('0.1', '0.2'), '0.3');
});

test('refuses JS numbers to prevent float contamination', () => {
  assert.throws(() => d.toBaseUnits(0.1), TypeError);
  assert.throws(() => d.toBaseUnits(50), TypeError);
});

test('rejects more than 18 fractional digits', () => {
  assert.throws(() => d.toBaseUnits('1.0000000000000000001'), RangeError);
});

test('add/sub/neg behave', () => {
  assert.equal(d.sub('400', '50'), '350');
  assert.equal(d.add('400', '50'), '450');
  assert.equal(d.neg('50.5'), '-50.5');
  assert.equal(d.sub('100', '100'), '0');
});

test('cmp and predicates', () => {
  assert.equal(d.cmp('100', '99'), 1);
  assert.equal(d.cmp('99', '100'), -1);
  assert.equal(d.cmp('100', '100'), 0);
  assert.ok(d.isPositive('0.000000000000000001'));
  assert.ok(d.isZero('0'));
  assert.ok(d.isNegative('-1'));
});

test('double-entry: a balanced movement set nets to zero', () => {
  // transfer 50 A->B, then a marketplace split
  assert.ok(d.sumIsZero(['-50', '50']));
  assert.ok(d.sumIsZero(['-100', '85', '10', '5']));
  assert.ok(!d.sumIsZero(['-100', '85', '10']));
});

test('splitByBps is exact and loses no base unit', () => {
  const out = d.splitByBps('100', [
    { key: 'creator', bps: 8500, remainder: true },
    { key: 'treasury', bps: 1000 },
    { key: 'burn', bps: 500 },
  ]);
  assert.deepEqual(out, { creator: '85', treasury: '10', burn: '5' });
  assert.ok(d.sumIsZero([d.neg('100'), out.creator, out.treasury, out.burn]));
});

test('splitByBps assigns indivisible remainder to the flagged sink', () => {
  // 1 base unit split 1/3 each — remainder of 1 unit must land on creator
  const tiny = d.fromBaseUnits(1n); // 0.000000000000000001
  const out = d.splitByBps(tiny, [
    { key: 'creator', bps: 3334, remainder: true },
    { key: 'treasury', bps: 3333 },
    { key: 'burn', bps: 3333 },
  ]);
  // treasury and burn get 0 (floor), creator gets the whole indivisible unit
  assert.equal(out.treasury, '0');
  assert.equal(out.burn, '0');
  assert.equal(out.creator, tiny);
  assert.ok(d.sumIsZero([d.neg(tiny), out.creator, out.treasury, out.burn]));
});

test('split weights must sum to 10000 bps', () => {
  assert.throws(
    () => d.splitByBps('100', [{ key: 'a', bps: 5000 }, { key: 'b', bps: 4000 }]),
    RangeError
  );
});

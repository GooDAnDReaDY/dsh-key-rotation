import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepExpired } from '../lib/pool.js';

test('sweepExpired: clears only expired entries', () => {
  const st1 = { failedUntil: new Map([['A', 1000], ['B', 5000]]), failCounts: new Map([['A',1],['B',1]]) };
  const st2 = { failedUntil: new Map([['C', 2000]]), failCounts: new Map([['C',2]]) };
  const poolState = new Map([['p1', st1], ['p2', st2]]);
  const n = sweepExpired(poolState, 3000);
  assert.equal(n, 2); // A and C expired
  assert.equal(st1.failedUntil.has('A'), false);
  assert.equal(st1.failedUntil.has('B'), true);
  assert.equal(st2.failedUntil.has('C'), false);
  assert.equal(st1.failCounts.has('A'), false);
  assert.equal(st1.failCounts.has('B'), true);
});
test('sweepExpired: returns 0 when nothing expired', () => {
  const st = { failedUntil: new Map([['A', 9000]]), failCounts: new Map([['A',1]]) };
  const poolState = new Map([['p1', st]]);
  assert.equal(sweepExpired(poolState, 1000), 0);
  assert.equal(st.failedUntil.has('A'), true);
});

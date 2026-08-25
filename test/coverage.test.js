import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedBridgeRequest, pickNext, recordFailure, recordSuccess, sweepExpired } from '../lib/pool.js';

test('isTrustedBridgeRequest: host undefined with Origin -> false', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { origin: 'http://127.0.0.1:3080' } }; // no host
  assert.equal(isTrustedBridgeRequest(req), false);
});

test('pickNext: refsCount 0 returns undefined', () => {
  const pool = { refs: [], state: { failedUntil: new Map(), pointer: 0 } };
  assert.equal(pickNext(pool, 0, 0), undefined);
  assert.equal(pickNext(pool, 0), undefined); // default refsCount 0
});

test('recordFailure: creates failCounts map if missing', () => {
  const pool = { state: { failedUntil: new Map() } }; // no failCounts
  const b = recordFailure(pool, 'A', 1000, 60000);
  assert.equal(b, 60000);
  assert.equal(pool.state.failCounts.get('A'), 1);
});

test('recordSuccess: handles missing failCounts', () => {
  const pool = { state: { failedUntil: new Map([['A', 9999]]) } }; // no failCounts
  recordSuccess(pool, 'A');
  assert.equal(pool.state.failedUntil.has('A'), false);
});

test('recordSuccess: clears existing failCounts', () => {
  const pool = { state: { failedUntil: new Map([['A', 9999]]), failCounts: new Map([['A', 2]]) } };
  recordSuccess(pool, 'A');
  assert.equal(pool.state.failCounts.has('A'), false);
});

test('pickNext: uses 0 when pointer undefined', () => {
  const pool = { refs: ['A','B'], state: { failedUntil: new Map() } };
  assert.equal(pickNext(pool, 0), 'A');
});
test('pickNext: respects pointer offset', () => {
  const pool = { refs: ['A','B','C'], state: { failedUntil: new Map(), pointer: 1 } };
  assert.equal(pickNext(pool, 0), 'B');
});

test('sweepExpired: handles missing failCounts gracefully', () => {
  const st = { failedUntil: new Map([['A', 1000]]) }; // no failCounts property
  const poolState = new Map([['p1', st]]);
  const n = sweepExpired(poolState, 2000);
  assert.equal(n, 1);
  assert.equal(st.failedUntil.has('A'), false);
});

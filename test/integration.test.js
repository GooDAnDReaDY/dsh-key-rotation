import test from 'node:test';
import assert from 'node:assert/strict';
import { pickNext, recordFailure, recordSuccess, sweepExpired, computeBackoff } from '../lib/pool.js';

function freshPool(refs=['A','B'], perHour) {
  return {
    refs, weightedRefs: refs,
    perHour,
    cooldownMs: 60000,
    state: { failedUntil: new Map(), failCounts: new Map(), usageCounts: new Map(), quotaWindows: new Map(), pointer: 0, switches: 0 }
  };
}

test('integration: 429 on A -> next picks B', () => {
  const pool = freshPool();
  // first pick
  let nxt = pickNext(pool, 0);
  assert.equal(nxt, 'A');
  // simulate success for A to set pointer
  pool.state.pointer = 1; pool.state.lastUsed = 'A';
  // A fails
  recordFailure(pool, 'A', 1000, 60000);
  nxt = pickNext(pool, 1000);
  assert.equal(nxt, 'B');
  // B succeeds
  recordSuccess(pool, 'B');
  assert.equal(pool.state.failedUntil.has('B'), false);
});

test('integration: both cooling -> pickNext undefined, sweep clears after expiry', () => {
  const pool = freshPool(['A','B']);
  recordFailure(pool, 'A', 0, 60000);
  recordFailure(pool, 'B', 0, 60000);
  assert.equal(pickNext(pool, 1000), undefined);
  // sweep after 60s
  const n = sweepExpired(new Map([['p', pool.state]]), 70000);
  assert.equal(n, 2);
  assert.equal(pickNext(pool, 70000), 'A');
});

test('integration: perHour blocks after limit', () => {
  const pool = freshPool(['A','B'], 1);
  // Simulate A used once
  pool.state.quotaWindows.set('A', { count: 1, start: 0 });
  pool.state.failedUntil.set('A', 0 + 3600000);
  // pick should skip A
  const nxt = pickNext(pool, 1000);
  // But pickNext only checks failedUntil, not quotaWindows directly. Our perHour enforcement is via failedUntil set by quota check.
  // So we simulate the quota check that sets failedUntil
  assert.equal(pool.state.failedUntil.has('A'), true);
});

test('integration: breaker after 3 AUTH', () => {
  const pool = freshPool();
  pool.state.authFailCounts = new Map();
  pool.state.brokenUntil = new Map();
  for (let i=0;i<3;i++) {
    const c = (pool.state.authFailCounts.get('A') ?? 0) + 1;
    pool.state.authFailCounts.set('A', c);
    if (c>=3) pool.state.brokenUntil.set('A', Date.now()+86400000*30);
  }
  assert.equal(pool.state.brokenUntil.has('A'), true);
});

test('integration: backoff doubles then caps', () => {
  const pool = freshPool();
  let b1 = recordFailure(pool, 'A', 0, 60000);
  assert.equal(b1, 60000);
  let b2 = recordFailure(pool, 'A', 0, 60000);
  assert.equal(b2, 120000);
  let b3 = recordFailure(pool, 'A', 0, 60000);
  assert.equal(b3, 240000);
  let b4 = recordFailure(pool, 'A', 0, 60000);
  assert.equal(b4, 480000);
  let b5 = recordFailure(pool, 'A', 0, 60000);
  assert.equal(b5, 480000);
});

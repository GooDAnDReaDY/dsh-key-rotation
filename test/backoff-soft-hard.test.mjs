import test from 'node:test';
import assert from 'node:assert/strict';
import { isSoftFailure, computeBackoff, applyJitter, recordFailure } from '../lib/pool.js';

test('isSoftFailure: identifies soft network and server drops', () => {
  assert.equal(isSoftFailure('SERVER', ''), true);
  assert.equal(isSoftFailure('TIMEOUT', ''), true);
  assert.equal(isSoftFailure('TRANSPORT', ''), true);
  assert.equal(isSoftFailure('EMPTY_RESPONSE', ''), true);
  assert.equal(isSoftFailure(null, '502 Bad Gateway'), true);
  assert.equal(isSoftFailure(null, '503 Service Unavailable'), true);
  assert.equal(isSoftFailure(null, 'socket hang up'), true);

  // Hard errors
  assert.equal(isSoftFailure('QUOTA', ''), false);
  assert.equal(isSoftFailure('RATE_LIMIT', ''), false);
  assert.equal(isSoftFailure('AUTH', ''), false);
  assert.equal(isSoftFailure(null, '429 Too Many Requests'), false);
});

test('computeBackoff: soft failures get short flat cooldown without multiplier', () => {
  const baseMs = 60000;
  assert.equal(computeBackoff(baseMs, 1, null, true), 10000);
  assert.equal(computeBackoff(baseMs, 5, null, true), 10000);

  // Hard failures escalate exponentially
  assert.equal(computeBackoff(baseMs, 1, null, false), 60000);
  assert.equal(computeBackoff(baseMs, 2, null, false), 120000);
  assert.equal(computeBackoff(baseMs, 3, null, false), 240000);
});

test('applyJitter: adds +-12.5% variation within bounds', () => {
  const base = 10000;
  for (let i = 0; i < 20; i++) {
    const j = applyJitter(base, 0.125);
    assert.ok(j >= 8750 && j <= 11250, `jitter ${j} within +-12.5% of ${base}`);
  }
});

test('recordFailure: soft failure does not increment failCounts', () => {
  const pool = {
    refs: ['k1'],
    state: { failedUntil: new Map(), failCounts: new Map() },
  };
  recordFailure(pool, 'k1', 1000, 60000, null, true, false);
  assert.equal(pool.state.failCounts.get('k1') ?? 0, 0);
  assert.equal(pool.state.failedUntil.get('k1'), 1000 + 10000);

  // Subsequent hard failure increments failCounts from 1
  recordFailure(pool, 'k1', 2000, 60000, null, false, false);
  assert.equal(pool.state.failCounts.get('k1'), 1);
  assert.equal(pool.state.failedUntil.get('k1'), 2000 + 60000);
});
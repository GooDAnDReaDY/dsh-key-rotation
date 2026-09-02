import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucketAccumulator, computeEffectiveLimit } from '../lib/bucket.js';

test('TokenBucketAccumulator: initial state has full capacity', () => {
  const b = new TokenBucketAccumulator(60, 60000, 1000);
  const info = b.info(1000);
  assert.equal(info.capacity, 60);
  assert.equal(info.remaining, 60);
  assert.equal(info.used, 0);
  assert.equal(info.resetMs, 0);
});

test('TokenBucketAccumulator: allow consumes tokens and blocks when empty', () => {
  const b = new TokenBucketAccumulator(2, 60000, 1000);
  assert.equal(b.allow(1, 1000), true);
  assert.equal(b.allow(1, 1000), true);
  assert.equal(b.allow(1, 1000), false);
  assert.ok(b.retryMs(1, 1000) > 0);
});

test('TokenBucketAccumulator: refills tokens over time at refillRate', () => {
  const b = new TokenBucketAccumulator(60, 60000, 0); // 1 token per second
  assert.equal(b.allow(60, 0), true);
  assert.equal(b.allow(1, 0), false);

  // Advance 10 seconds -> 10 tokens refilled
  assert.equal(b.allow(10, 10000), true);
  assert.equal(b.allow(1, 10000), false);
});

test('computeEffectiveLimit: respects manual limit as upper ceiling', () => {
  // Upstream says 100, manual is 50 -> returns 50
  assert.equal(computeEffectiveLimit({ limit: 100 }, 50, true), 50);

  // Upstream says 30, manual is 50 -> adapts downwards to 30
  assert.equal(computeEffectiveLimit({ limit: 30 }, 50, true), 30);

  // Adaptive disabled -> returns manual limit
  assert.equal(computeEffectiveLimit({ limit: 30 }, 50, false), 50);

  // No manual limit -> adapts to upstream 30
  assert.equal(computeEffectiveLimit({ limit: 30 }, 0, true), 30);
});
// test/concurrency.test.mjs - issue #193 concurrency limiter
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyTracker } from '../lib/concurrency.js';

test('ConcurrencyTracker: disabled when limit=0', () => {
  const t = new ConcurrencyTracker({ limit: 0 });
  assert.equal(t.isEnabled(), false);
  for (let i = 0; i < 100; i++) assert.equal(t.acquire('A'), true);
});

test('ConcurrencyTracker: limit enforced', () => {
  const t = new ConcurrencyTracker({ limit: 2 });
  assert.equal(t.acquire('A'), true);
  assert.equal(t.acquire('A'), true);
  assert.equal(t.acquire('A'), false);
  t.release('A');
  assert.equal(t.acquire('A'), true);
});

test('ConcurrencyTracker: per-key isolation', () => {
  const t = new ConcurrencyTracker({ limit: 1 });
  assert.equal(t.acquire('A'), true);
  assert.equal(t.acquire('B'), true);
});

test('ConcurrencyTracker: pickLeastLoaded picks minimum count', () => {
  const t = new ConcurrencyTracker({ limit: 5 });
  t.acquire('A'); t.acquire('A');
  t.acquire('B');
  assert.equal(t.pickLeastLoaded(['A', 'B']), 'B');
});

test('ConcurrencyTracker: pickLeastLoaded skips saturated', () => {
  const t = new ConcurrencyTracker({ limit: 1 });
  t.acquire('A');
  assert.equal(t.pickLeastLoaded(['A', 'B']), 'B');
});

test('ConcurrencyTracker: pickLeastLoaded returns null when all saturated', () => {
  const t = new ConcurrencyTracker({ limit: 1 });
  t.acquire('A');
  t.acquire('B');
  assert.equal(t.pickLeastLoaded(['A', 'B']), null);
});

test('ConcurrencyTracker: stale reset resets count', () => {
  const t = new ConcurrencyTracker({ limit: 2, staleMs: 100 });
  t.acquire('A', 0);
  t.acquire('A', 10);
  // At t=200, stale reset clears count. Fresh acquire succeeds.
  assert.equal(t.acquire('A', 200), true);
});

test('ConcurrencyTracker: snapshot and clear', () => {
  const t = new ConcurrencyTracker({ limit: 5 });
  t.acquire('A');
  t.acquire('B');
  const s = t.snapshot();
  assert.equal(s.A.count, 1);
  t.clear('A');
  assert.equal(t.snapshot().A, undefined);
  t.clear();
  assert.equal(t.size, 0);
});

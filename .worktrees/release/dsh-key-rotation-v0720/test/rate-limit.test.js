import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRateLimit, isRateLimited } from '../lib/pool.js';

test('extractRateLimit: parses headers', () => {
  const h = { 'X-RateLimit-Remaining': '5', 'X-RateLimit-Limit': '100', 'X-RateLimit-Reset': '1700000000' };
  assert.deepEqual(extractRateLimit(h), { remaining: 5, limit: 100, reset: 1700000000 });
});
test('extractRateLimit: null when no headers', () => {
  assert.equal(extractRateLimit(null), null);
  assert.equal(extractRateLimit(undefined), null);
  assert.equal(extractRateLimit({}), null);
});
test('extractRateLimit: case-insensitive', () => {
  const h = { 'x-ratelimit-remaining': '3' };
  const r = extractRateLimit(h);
  assert.equal(r.remaining, 3);
});
test('isRateLimited: remaining below 10% of limit', () => {
  assert.equal(isRateLimited({ remaining: 5, limit: 100 }, 0.1), true);
  assert.equal(isRateLimited({ remaining: 20, limit: 100 }, 0.1), false);
});
test('isRateLimited: remaining 0 when no limit', () => {
  assert.equal(isRateLimited({ remaining: 0 }, 0.1), true);
  assert.equal(isRateLimited({ remaining: 5 }, 0.1), false);
});
test('isRateLimited: null rate', () => {
  assert.equal(isRateLimited(null, 0.1), false);
});

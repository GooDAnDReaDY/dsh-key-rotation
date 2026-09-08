import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const INDEX_SRC = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

test('extractRateLimit parses headers efficiently without allocating case variants', async () => {
  const { extractRateLimit } = await import('../lib/pool.js');
  const h1 = { 'X-RateLimit-Remaining': '15', 'X-RateLimit-Limit': '100', 'X-RateLimit-Reset': '1700000000' };
  assert.deepEqual(extractRateLimit(h1), { remaining: 15, limit: 100, reset: 1700000000 });

  const h2 = { 'x-ratelimit-remaining': '7', 'x-ratelimit-limit': '50' };
  assert.deepEqual(extractRateLimit(h2), { remaining: 7, limit: 50, reset: undefined });
});

test('rotate() uses runtime0 directly instead of repetitive buildRuntime() in finish/rate checks', () => {
  assert.doesNotMatch(INDEX_SRC, /const\s*\{\s*rateLimitThreshold\s*\}\s*=\s*buildRuntime\(\)/, 'must not re-call buildRuntime for rateLimitThreshold');
  assert.match(INDEX_SRC, /const\s*\{\s*switchCodes,\s*cooldownMs,\s*maxCooldownMs,\s*switchNotify,\s*rateLimitThreshold\s*\}\s*=\s*runtime0;/, 'must destructure from runtime0 once');
});

test('status route computes totalUsage without creating intermediate array copy', () => {
  assert.doesNotMatch(INDEX_SRC, /totalUsage:\s*\[\.\.\./, 'must not spread values into temporary array');
  assert.match(INDEX_SRC, /totalUsage:\s*\(\(\)\s*=>\s*\{\s*let s = 0;/, 'must compute sum iteratively');
});

test('todayIso is memoized once per request in rotate finish branch', () => {
  assert.match(INDEX_SRC, /const todayIso = activeRef \? new Date\(\)\.toISOString\(\)\.slice\(0, 10\) : undefined;/, 'must memoize todayIso once');
  assert.match(INDEX_SRC, /cMap\.set\(todayIso,/, 'costDays must use todayIso');
  assert.match(INDEX_SRC, /dayMap\.set\(todayIso,/, 'usageDays must use todayIso');
});

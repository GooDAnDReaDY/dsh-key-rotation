import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDurationToSeconds,
  extractRateLimit,
  isRateLimited,
  isKeyPaused,
  sortAttemptList,
} from '../lib/pool.js';
import { pickCascadeFallback, CASCADE_MAX_DEPTH } from '../lib/cascade.js';
import { ConcurrencyTracker } from '../lib/concurrency.js';
import { buildPoolItem } from '../lib/pool-builder.js';

test('parseDurationToSeconds parses numeric and unit strings', () => {
  assert.equal(parseDurationToSeconds(15), 15);
  assert.equal(parseDurationToSeconds('10'), 10);
  assert.equal(parseDurationToSeconds('2.5s'), 2.5);
  assert.equal(parseDurationToSeconds('500ms'), 0.5);
  assert.equal(parseDurationToSeconds('2m'), 120);
  assert.equal(parseDurationToSeconds('1h'), 3600);
  assert.equal(parseDurationToSeconds('1d'), 86400);
  assert.equal(parseDurationToSeconds('invalid-string'), null);
  assert.equal(parseDurationToSeconds(null), null);
});

test('extractRateLimit parses duration strings in x-ratelimit-reset', () => {
  const headers = {
    'x-ratelimit-remaining': '3',
    'x-ratelimit-limit': '100',
    'x-ratelimit-reset': '1.5s',
  };
  const res = extractRateLimit(headers);
  assert.ok(res);
  assert.equal(res.remaining, 3);
  assert.equal(res.limit, 100);
  assert.equal(res.reset, 1.5);
});

test('extractRateLimit parses reset-requests and reset-tokens headers', () => {
  const headers = {
    'x-ratelimit-remaining-requests': '2',
    'x-ratelimit-limit-requests': '60',
    'x-ratelimit-reset-requests': '20s',
  };
  const res = extractRateLimit(headers);
  assert.ok(res);
  assert.equal(res.remaining, 2);
  assert.equal(res.limit, 60);
  assert.equal(res.reset, 20);
});

test('isKeyPaused correctly identifies paused keys', () => {
  const pool = {
    pausedRefs: new Set(['key-paused', 'key-2']),
  };
  assert.equal(isKeyPaused(pool, 'key-paused'), true);
  assert.equal(isKeyPaused(pool, 'key-2'), true);
  assert.equal(isKeyPaused(pool, 'key-active'), false);
  assert.equal(isKeyPaused(null, 'key-1'), false);
});

test('buildPoolItem supports paused array and builds weightsMap', () => {
  const item = buildPoolItem({
    base: 'deepseek',
    keys: ['KEY_A', 'KEY_B', 'KEY_C'],
    weights: [1, 5, 2],
    paused: [false, true, false],
    poolCooldown: 60000,
    poolMax: 300000,
    makeState: () => ({ failedUntil: new Map() }),
  });
  assert.ok(item);
  assert.deepEqual(item.refs, ['KEY_A', 'KEY_B', 'KEY_C']);
  assert.equal(item.pausedRefs.has('KEY_B'), true);
  assert.equal(item.pausedRefs.has('KEY_A'), false);
  assert.equal(item.weightsMap['KEY_B'], 5);
  assert.equal(item.weightsMap['KEY_A'], 1);
});

test('pickCascadeFallback respects modelMapping and skips paused keys', () => {
  const pools = new Map();
  pools.set('deepseek', {
    refs: ['DS_1'],
    pausedRefs: new Set(['DS_1']),
    state: { failedUntil: new Map() },
  });
  pools.set('openrouter', {
    refs: ['OR_1'],
    pausedRefs: new Set(),
    state: { failedUntil: new Map() },
  });

  const cfg = {
    cascade: [
      {
        provider: 'openrouter',
        modelMapping: {
          'deepseek-chat': 'openrouter/deepseek/deepseek-chat',
        },
      },
    ],
  };

  const fb = pickCascadeFallback('deepseek', cfg, pools, 'deepseek-chat');
  assert.ok(fb);
  assert.equal(fb.provider, 'openrouter');
  assert.equal(fb.model, 'openrouter/deepseek/deepseek-chat');
});

test('sortAttemptList least-loaded normalizes by weights', () => {
  const tracker = new ConcurrencyTracker({ limit: 10 });
  tracker.acquire('KEY_1'); // 1 in-flight
  tracker.acquire('KEY_2'); // 1 in-flight
  tracker.acquire('KEY_2'); // 2 in-flight

  // KEY_1 has weight 1 -> score = 1 / 1 = 1.0
  // KEY_2 has weight 4 -> score = 2 / 4 = 0.5 (less loaded per weight!)
  const weights = { KEY_1: 1, KEY_2: 4 };
  const sorted = sortAttemptList(['KEY_1', 'KEY_2'], 'least-loaded', {
    concurrencyTracker: tracker,
    weights,
  });

  assert.deepEqual(sorted, ['KEY_2', 'KEY_1']);
});

test('pickLeastLoaded supports candidate weights', () => {
  const tracker = new ConcurrencyTracker({ limit: 10 });
  tracker.acquire('KEY_A'); // 1 in-flight
  tracker.acquire('KEY_B'); // 2 in-flight

  const weights = { KEY_A: 1, KEY_B: 5 }; // KEY_B has 2/5 = 0.4 score vs KEY_A 1/1 = 1.0
  const chosen = tracker.pickLeastLoaded(['KEY_A', 'KEY_B'], Date.now(), weights);
  assert.equal(chosen, 'KEY_B');
});

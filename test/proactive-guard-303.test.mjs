import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRateLimit, isRateLimited } from '../lib/pool.js';
import { createRotate } from '../lib/rotate.js';

test('extractRateLimit: recognizes vendor rate-limit and retry-after headers', () => {
  const h1 = {
    'x-ratelimit-remaining-requests': '1',
    'x-ratelimit-limit-requests': '100',
    'retry-after': '12',
  };
  const res1 = extractRateLimit(h1);
  assert.equal(res1.remaining, 1);
  assert.equal(res1.limit, 100);
  assert.equal(res1.retryAfter, 12);

  const hAnthropic = {
    'anthropic-ratelimit-requests-remaining': '0',
    'anthropic-ratelimit-requests-limit': '50',
    'anthropic-ratelimit-requests-reset': '1700000050',
  };
  const resAnthropic = extractRateLimit(hAnthropic);
  assert.equal(resAnthropic.remaining, 0);
  assert.equal(resAnthropic.limit, 50);
  assert.equal(resAnthropic.reset, 1700000050);

  const hDate = {
    'retry-after': new Date(Date.now() + 30000).toUTCString(),
  };
  const resDate = extractRateLimit(hDate);
  assert.ok(resDate.retryAfter >= 28 && resDate.retryAfter <= 32);
});

test('isRateLimited: triggers proactive pause on remaining <= 1 or retryAfter', () => {
  assert.equal(isRateLimited({ remaining: 1, limit: 100 }), true, 'remaining 1 should trigger preventative pause');
  assert.equal(isRateLimited({ remaining: 0, limit: 100 }), true, 'remaining 0 should trigger preventative pause');
  assert.equal(isRateLimited({ remaining: 15, limit: 100, retryAfter: 10 }), true, 'retryAfter > 0 should trigger pause');
  assert.equal(isRateLimited({ remaining: 50, limit: 100 }, 0.1), false, 'healthy remaining should not trigger');
  assert.equal(isRateLimited({ remaining: 8, limit: 100 }, 0.1), true, 'below 10% threshold should trigger');
});

test('rotate(): proactively pauses key on low remaining without failing active stream', async () => {
  let failureRecorded = null;
  const events = [];
  const fakePool = {
    base: 'openai',
    refs: ['key-1', 'key-2'],
    cooldownMs: 60000,
    maxCooldownMs: 300000,
    routingStrategy: 'round-robin',
    proactiveRateLimitGuard: true,
    state: {
      pointer: 0,
      failedUntil: new Map(),
      events,
    },
  };

  const fakeDeps = {
    ctx: {
      get: () => ({
        stream: async function* () {
          yield { type: 'text-delta', text: 'Hello' };
          yield {
            type: 'finish',
            metadata: {
              headers: {
                'x-ratelimit-remaining-requests': '1',
                'x-ratelimit-limit-requests': '100',
              },
            },
          };
        },
      }),
    },
    dispatchStorage: {
      run: (store, fn) => {
        store.pickedRef = 'key-1';
        return fn();
      },
    },
    buildRuntime: () => ({
      switchCodes: ['RATE_LIMIT'],
      cooldownMs: 60000,
      maxCooldownMs: 300000,
      switchNotify: false,
      rateLimitThreshold: 0.1,
      routingStrategy: 'round-robin',
      proactiveRateLimitGuard: true,
    }),
    pushEvent: (p, ref, code, cool) => {
      events.push({ ref, code, cool });
    },
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    recordLatency: () => {},
    concurrencyTracker: { isEnabled: () => false },
    MARKER: '__dshKeyRotation',
    finishError: (code, msg) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message: msg } } }),
    setRotateStartMs: () => {},
    quotaStore: { set: () => {} },
    circuitBreaker: null,
    now: () => 1000000,
  };

  const rotate = createRotate(fakeDeps);
  const chunks = [];
  for await (const chunk of rotate({ provider: 'openai', model: 'gpt-4' }, fakePool)) {
    chunks.push(chunk);
  }

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, 'Hello');
  assert.ok(fakePool.state.failedUntil.has('key-1'), 'key-1 must be proactively put into cooldown');
  assert.ok(events.some((e) => e.ref === 'key-1' && e.code === 'RATE_LIMIT'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  isPreemptiveYielding,
  applyPreemptiveYield,
  DEFAULT_PREEMPTIVE_SAFETY_MARGIN_TOKENS,
  DEFAULT_PREEMPTIVE_SAFETY_MARGIN_REQUESTS,
} from '../lib/preemptive-yield.js';
import { buildPools } from '../lib/pool-builder.js';
import { createRotate } from '../lib/rotate.js';
import { createResolver } from '../lib/resolver.js';

test('isPreemptiveYielding: returns false when no detected limits recorded', () => {
  const pool = { state: { detectedLimits: new Map() } };
  const res = isPreemptiveYielding(pool, 'KEY_1');
  assert.equal(res.yielding, false);
});

test('isPreemptiveYielding: detects low remaining tokens below safety margin', () => {
  const pool = {
    preemptiveRotationEnabled: true,
    preemptiveSafetyMarginTokens: 4000,
    state: {
      detectedLimits: new Map([
        ['KEY_LOW_TOKENS', { remainingTokens: 2500, remainingRequests: 50, at: 1000, tpmResetMs: 60000 }],
        ['KEY_HEALTHY', { remainingTokens: 50000, remainingRequests: 50, at: 1000, tpmResetMs: 60000 }],
      ]),
    },
  };

  const lowRes = isPreemptiveYielding(pool, 'KEY_LOW_TOKENS', { now: 2000 });
  assert.equal(lowRes.yielding, true);
  assert.match(lowRes.reason, /LOW_REMAINING_TOKENS/);
  assert.equal(lowRes.remainingTokens, 2500);
  assert.equal(lowRes.resetInMs, 59000);

  const healthyRes = isPreemptiveYielding(pool, 'KEY_HEALTHY', { now: 2000 });
  assert.equal(healthyRes.yielding, false);
});

test('isPreemptiveYielding: detects low remaining requests below safety margin', () => {
  const pool = {
    preemptiveRotationEnabled: true,
    preemptiveSafetyMarginRequests: 2,
    state: {
      detectedLimits: new Map([
        ['KEY_LOW_REQ', { remainingTokens: 100000, remainingRequests: 1, at: 1000, rpmResetMs: 30000 }],
      ]),
    },
  };

  const res = isPreemptiveYielding(pool, 'KEY_LOW_REQ', { now: 2000 });
  assert.equal(res.yielding, true);
  assert.match(res.reason, /LOW_REMAINING_REQUESTS/);
  assert.equal(res.remainingRequests, 1);
  assert.equal(res.resetInMs, 29000);
});

test('isPreemptiveYielding: window reset restores key capacity', () => {
  const pool = {
    preemptiveRotationEnabled: true,
    preemptiveSafetyMarginTokens: 4000,
    state: {
      detectedLimits: new Map([
        ['KEY_EXPIRED_WINDOW', { remainingTokens: 500, at: 1000, tpmResetMs: 10000 }],
      ]),
    },
  };

  // Before reset (now = 5000): yielding is true
  const beforeReset = isPreemptiveYielding(pool, 'KEY_EXPIRED_WINDOW', { now: 5000 });
  assert.equal(beforeReset.yielding, true);

  // After reset (now = 12000 >= 1000 + 10000): window has refreshed upstream
  const afterReset = isPreemptiveYielding(pool, 'KEY_EXPIRED_WINDOW', { now: 12000 });
  assert.equal(afterReset.yielding, false);
});

test('isPreemptiveYielding: disabled when preemptiveRotationEnabled is false', () => {
  const pool = {
    preemptiveRotationEnabled: false,
    state: {
      detectedLimits: new Map([
        ['KEY_LOW', { remainingTokens: 10, remainingRequests: 1, at: 1000, tpmResetMs: 60000 }],
      ]),
    },
  };

  const res = isPreemptiveYielding(pool, 'KEY_LOW', { now: 2000 });
  assert.equal(res.yielding, false);
});

test('applyPreemptiveYield: partitions ample keys before yielding keys', () => {
  const pool = {
    preemptiveRotationEnabled: true,
    preemptiveSafetyMarginTokens: 4000,
    state: {
      preemptiveYields: 0,
      detectedLimits: new Map([
        ['KEY_A', { remainingTokens: 500, at: 1000, tpmResetMs: 30000 }],
        ['KEY_B', { remainingTokens: 80000, at: 1000, tpmResetMs: 30000 }],
        ['KEY_C', { remainingTokens: 1200, at: 1000, tpmResetMs: 20000 }],
        ['KEY_D', { remainingTokens: 45000, at: 1000, tpmResetMs: 30000 }],
      ]),
    },
  };

  const steps = [];
  const events = [];
  const trace = { addStep: (...args) => steps.push(args) };
  const pushEvent = (...args) => events.push(args);

  const initialList = ['KEY_A', 'KEY_B', 'KEY_C', 'KEY_D'];
  const reordered = applyPreemptiveYield(initialList, pool, {
    now: 2000,
    trace,
    pushEvent,
  });

  // KEY_B and KEY_D have ample quota (>4000) and must be first
  assert.deepEqual(reordered.slice(0, 2), ['KEY_B', 'KEY_D']);
  // KEY_C (1200 tokens) and KEY_A (500 tokens) yield to end; KEY_C has more tokens than KEY_A
  assert.deepEqual(reordered.slice(2), ['KEY_C', 'KEY_A']);

  assert.equal(pool.state.preemptiveYields, 2);
  assert.equal(steps.length, 2);
  assert.equal(events.length, 2);
});

test('applyPreemptiveYield: graceful degradation when all keys are yielding', () => {
  const pool = {
    provider: 'test-all-low',
    preemptiveRotationEnabled: true,
    preemptiveSafetyMarginTokens: 5000,
    state: {
      preemptiveYields: 0,
      detectedLimits: new Map([
        ['KEY_1', { remainingTokens: 100, at: 1000, tpmResetMs: 30000 }],
        ['KEY_2', { remainingTokens: 2500, at: 1000, tpmResetMs: 30000 }],
        ['KEY_3', { remainingTokens: 900, at: 1000, tpmResetMs: 15000 }],
      ]),
    },
  };

  const warnings = [];
  const reordered = applyPreemptiveYield(['KEY_1', 'KEY_2', 'KEY_3'], pool, {
    now: 2000,
    logWarn: (msg) => warnings.push(msg),
  });

  // All keys are low, but must not be dropped. Sorted by highest tokens first: KEY_2 (2500) > KEY_3 (900) > KEY_1 (100)
  assert.deepEqual(reordered, ['KEY_2', 'KEY_3', 'KEY_1']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /all candidate keys are yielding/);
});

test('applyPreemptiveYield: pinnedRef preserves priority when configured', () => {
  const pool = {
    pinnedRef: 'KEY_PINNED',
    preemptiveRotationEnabled: true,
    preemptiveSafetyMarginTokens: 4000,
    state: {
      detectedLimits: new Map([
        ['KEY_PINNED', { remainingTokens: 100, at: 1000, tpmResetMs: 30000 }],
        ['KEY_OTHER', { remainingTokens: 50000, at: 1000, tpmResetMs: 30000 }],
      ]),
    },
  };

  const reordered = applyPreemptiveYield(['KEY_PINNED', 'KEY_OTHER'], pool, { now: 2000 });
  assert.deepEqual(reordered, ['KEY_PINNED', 'KEY_OTHER']);
});

test('resolver e2e: resolve picks key with ample tokens over low headroom key', async () => {
  const poolState = new Map();
  const cfg = {
    providers: [
      {
        provider: 'test-prov-res',
        keys: ['KEY_STARVED', 'KEY_ABUNDANT'],
        preemptiveRotationEnabled: true,
        preemptiveSafetyMarginTokens: 4000,
      },
    ],
  };

  const built = buildPools({ cfg, poolState });
  const pool = built.providerToPool.get('test-prov-res');
  pool.state.detectedLimits.set('KEY_STARVED', { remainingTokens: 300, remainingRequests: 10, at: Date.now(), tpmResetMs: 60000 });
  pool.state.detectedLimits.set('KEY_ABUNDANT', { remainingTokens: 60000, remainingRequests: 50, at: Date.now(), tpmResetMs: 60000 });

  const resolve = createResolver({
    buildRuntime: () => ({ ...built, routingStrategy: 'round-robin' }),
    currentPool: () => pool,
    now: () => Date.now(),
  });

  const res = await resolve('KEY_STARVED', async (ref) => ({ value: 'secret-' + ref }));
  assert.equal(res.value, 'secret-KEY_ABUNDANT', 'Resolver must preemptively select abundant key');
});

test('rotate e2e: streaming rotate prioritizes ample headroom key without error failover', async () => {
  const poolState = new Map();
  const cfg = {
    providers: [
      {
        provider: 'test-prov-stream',
        keys: ['KEY_FIRST_LOW', 'KEY_SECOND_RICH'],
        preemptiveRotationEnabled: true,
        preemptiveSafetyMarginTokens: 4000,
      },
    ],
  };

  const { providerToPool, poolByRef } = buildPools({ cfg, poolState });
  const pool = providerToPool.get('test-prov-stream');
  pool.state.detectedLimits.set('KEY_FIRST_LOW', { remainingTokens: 800, at: Date.now(), tpmResetMs: 60000 });
  pool.state.detectedLimits.set('KEY_SECOND_RICH', { remainingTokens: 85000, at: Date.now(), tpmResetMs: 60000 });

  const attempts = [];
  const mockCtx = {
    get(name) {
      if (name === 'llm') {
        return {
          stream: async function* (opts) {
            attempts.push(opts._rotationKeyRef);
            yield { type: 'text-delta', text: 'Success on rich key' };
            yield { type: 'finish', usage: { total_tokens: 15 } };
          },
        };
      }
      return null;
    },
  };

  const rotate = createRotate({
    ctx: mockCtx,
    dispatchStorage: new AsyncLocalStorage(),
    buildRuntime: () => ({
      providerToPool,
      poolByRef,
      switchCodes: ['TIMEOUT', 'QUOTA', 'RATE_LIMIT'],
    }),
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    recordLatency: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    pushEvent: () => {},
    setRotateStartMs: () => {},
    circuitBreaker: null,
    MARKER: '__test_preemptive_1',
  });

  const chunks = [];
  for await (const chunk of rotate({ provider: 'test-prov-stream', model: 'test-model' }, pool)) {
    chunks.push(chunk);
  }

  // Only KEY_SECOND_RICH was attempted because KEY_FIRST_LOW preemptively yielded!
  assert.deepEqual(attempts, ['KEY_SECOND_RICH']);
  assert.equal(chunks[0].text, 'Success on rich key');
  assert.equal(pool.state.switches ?? 0, 0, 'No error switches occurred');
  assert.equal(pool.state.preemptiveYields, 1, 'Preemptive yield recorded');
});

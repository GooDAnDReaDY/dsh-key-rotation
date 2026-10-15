import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';

import { createRotate } from '../lib/rotate.js';
import { buildPools } from '../lib/pool-builder.js';
import { createResolver } from '../lib/resolver.js';
import { sortAttemptList, recordSuccess } from '../lib/pool.js';
import { autoUnbreakBrokenKeys } from '../lib/heal.js';

test('Issue #23: sortAttemptList with sticky strategy prioritizes lastUsed', () => {
  const refs = ['KEY_A', 'KEY_B', 'KEY_C'];
  assert.deepEqual(sortAttemptList(refs, 'sticky', { lastUsed: 'KEY_B' }), ['KEY_B', 'KEY_A', 'KEY_C']);
  assert.deepEqual(sortAttemptList(refs, 'sticky', { lastUsed: 'KEY_C' }), ['KEY_C', 'KEY_A', 'KEY_B']);
  assert.deepEqual(sortAttemptList(refs, 'sticky', { lastUsed: 'UNKNOWN' }), ['KEY_A', 'KEY_B', 'KEY_C']);
  assert.deepEqual(sortAttemptList(refs, 'sticky', {}), ['KEY_A', 'KEY_B', 'KEY_C']);
});

test('Issue #23: sticky routing sticks to current key across requests until failover', async () => {
  const cfg = {
    providers: [
      {
        provider: 'openai',
        keys: ['KEY_A', 'KEY_B', 'KEY_C'],
        routingStrategy: 'sticky',
      },
    ],
    routingStrategy: 'sticky',
  };
  const built = buildPools({ cfg, poolState: new Map() });
  const pool = built.providerToPool.get('openai');
  const store = new Map([
    ['KEY_A', 'secret-A'],
    ['KEY_B', 'secret-B'],
    ['KEY_C', 'secret-C'],
  ]);
  const original = async (ref) => ({ value: store.get(ref) });
  const runtime = {
    ...built,
    routingStrategy: 'sticky',
  };
  const resolver = createResolver({
    buildRuntime: () => runtime,
    currentPool: () => pool,
    now: () => Date.now(),
    dispatchStorage: new AsyncLocalStorage(),
  });

  // Request 1: should pick KEY_A (first healthy key)
  const r1 = await resolver('KEY_A', original);
  assert.equal(r1.value, 'secret-A');
  assert.equal(pool.state.lastUsed, 'KEY_A');

  // Request 2: should stick to KEY_A
  const r2 = await resolver('KEY_A', original);
  assert.equal(r2.value, 'secret-A');
  assert.equal(pool.state.lastUsed, 'KEY_A');

  // Request 3: should stick to KEY_A
  const r3 = await resolver('KEY_A', original);
  assert.equal(r3.value, 'secret-A');

  // Now simulate KEY_A failure/cooldown
  pool.state.failedUntil.set('KEY_A', Date.now() + 60_000);

  // Request 4: KEY_A is failed, should failover to KEY_B
  const r4 = await resolver('KEY_A', original);
  assert.equal(r4.value, 'secret-B');
  assert.equal(pool.state.lastUsed, 'KEY_B');

  // Request 5: should stick to KEY_B
  const r5 = await resolver('KEY_A', original);
  assert.equal(r5.value, 'secret-B');
  assert.equal(pool.state.lastUsed, 'KEY_B');
});

function makeRotateHelper(cfg, failFn) {
  const built = buildPools({ cfg, poolState: new Map() });
  const pool = built.providerToPool.get('sensenova');
  const dispatchStorage = new AsyncLocalStorage();

  let attempt = 0;
  const llm = {
    stream(options) {
      return (async function* () {
        attempt++;
        const storeState = dispatchStorage.getStore();
        if (storeState) {
          const picked = pool.refs[attempt - 1] ?? pool.refs[0];
          storeState.pickedRef = picked;
        }
        if (attempt === 1) {
          throw failFn();
        }
        yield { type: 'text', text: 'success' };
      })();
    },
  };

  const runtime = {
    ...built,
    cooldownMs: cfg.cooldownMs ?? 10_000,
    maxCooldownMs: cfg.maxCooldownMs ?? 60_000,
    quotaResetWindow: cfg.quotaResetWindow,
    switchCodes: cfg.switchCodes,
    routingStrategy: 'round-robin',
    maxDurationMs: 0,
    maxAttempts: 0,
    rateLimitThreshold: 0.1,
    concurrencyLimit: 0,
    cascade: [],
  };

  const rotate = createRotate({
    ctx: { get: (name) => (name === 'llm' ? llm : undefined) },
    dispatchStorage,
    buildRuntime: () => runtime,
    schedulePersist: () => {},
    pushEvent: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    recordLatency: () => {},
    latencyHistogram: { snapshot: () => null, record: () => {} },
    concurrencyTracker: { isEnabled: () => false, acquire: () => false, release: () => {}, getActive: () => 0, pickLeastLoaded: () => null },
    MARKER: '__dshKeyRotation',
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    setRotateStartMs: () => {},
    quotaStore: null,
    circuitBreaker: null,
    now: () => Date.now(),
    logger: { warn: () => {} },
  });

  return { rotate, pool, runtime };
}

test('Issue #24: transient 429/rpm/tpm throttling does not trigger calendar quota lock', async () => {
  const cfg = {
    providers: [{ provider: 'sensenova', keys: ['KEY_1', 'KEY_2'] }],
    quotaResetWindow: { type: 'midnight_utc', hour: 0 },
    cooldownMs: 10_000,
    maxCooldownMs: 60_000,
    switchCodes: ['429', 'QUOTA', 'RATE_LIMIT'],
  };

  const { rotate, pool } = makeRotateHelper(cfg, () => {
    const err = new Error('{ message:rpm exhausted,type:quota_exceeded_error}');
    err.status = 429;
    err.code = '429';
    return err;
  });

  const stream = rotate({ provider: 'sensenova', model: 'nova-pro', apiKeyEnv: 'KEY_1' }, pool);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, 'success');

  // Verify KEY_1 was failed with ordinary cooldown, NOT calendar locked to midnight
  assert.equal(pool.state.quotaWindows?.has('KEY_1') ?? false, false, 'KEY_1 should not be in quotaWindows');
  const fu = pool.state.failedUntil.get('KEY_1');
  assert.ok(fu > Date.now(), 'KEY_1 should have cooldown');
  assert.ok(fu <= Date.now() + 65_000, 'KEY_1 cooldown should be transient (<= 65s), not calendar midnight');
});

test('Issue #24: inference exceeds tpm/rpm limit error does not trigger calendar quota lock', async () => {
  const cfg = {
    providers: [{ provider: 'sensenova', keys: ['KEY_1', 'KEY_2'] }],
    quotaResetWindow: { type: 'midnight_utc', hour: 0 },
    cooldownMs: 5_000,
    maxCooldownMs: 30_000,
    switchCodes: ['429', 'QUOTA', 'RATE_LIMIT'],
  };

  const { rotate, pool } = makeRotateHelper(cfg, () => {
    const err = new Error('inference exceeds tpm/rpm limit');
    err.code = 'insufficient_quota';
    return err;
  });

  const stream = rotate({ provider: 'sensenova', model: 'nova-pro', apiKeyEnv: 'KEY_1' }, pool);
  for await (const _ of stream) {}

  assert.equal(pool.state.quotaWindows?.has('KEY_1') ?? false, false);
  const fu = pool.state.failedUntil.get('KEY_1');
  assert.ok(fu > Date.now());
  assert.ok(fu <= Date.now() + 35_000);
});

test('Issue #24: autoUnbreakBrokenKeys heals calendar quota locks when probe succeeds', async () => {
  const midnight = Date.now() + 12 * 3600_000;
  const pool = {
    base: 'demo',
    refs: ['KEY_LOCKED'],
    state: {
      brokenUntil: new Map(),
      failedUntil: new Map([['KEY_LOCKED', midnight]]),
      quotaWindows: new Map([['KEY_LOCKED', midnight]]),
      failCounts: new Map([['KEY_LOCKED', 1]]),
      authFailCounts: new Map(),
      events: [],
    },
  };

  let probed = false;
  const probeFn = async (ref) => {
    probed = true;
    assert.equal(ref, 'KEY_LOCKED');
    return { ok: true, status: 200 };
  };

  const results = await autoUnbreakBrokenKeys([pool], probeFn, Date.now(), { isActive: () => true });
  assert.ok(probed);
  assert.equal(results.length, 1);
  assert.equal(results[0].ref, 'KEY_LOCKED');
  assert.equal(results[0].ok, true);
  assert.equal(pool.state.quotaWindows.has('KEY_LOCKED'), false);
  assert.equal(pool.state.failedUntil.has('KEY_LOCKED'), false);
  assert.equal(pool.state.failCounts.has('KEY_LOCKED'), false);
});

test('Issue #24: recordSuccess clears quotaWindows', () => {
  const pool = {
    state: {
      failedUntil: new Map([['KEY_A', Date.now() + 100000]]),
      quotaWindows: new Map([['KEY_A', Date.now() + 100000]]),
      failCounts: new Map([['KEY_A', 3]]),
    },
  };
  recordSuccess(pool, 'KEY_A');
  assert.equal(pool.state.failedUntil.has('KEY_A'), false);
  assert.equal(pool.state.quotaWindows.has('KEY_A'), false);
  assert.equal(pool.state.failCounts.has('KEY_A'), false);
});

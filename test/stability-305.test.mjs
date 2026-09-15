// test/stability-305.test.mjs — tests for issue #305 (concurrency leak, retry, sweep pruning)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyTracker } from '../lib/concurrency.js';
import { createRotate } from '../lib/rotate.js';
import { SandboxRunner } from '../lib/sandbox.js';
import { sweepExpired } from '../lib/pool.js';

test('concurrencyTracker.getActive returns accurate active count and handles stale locks', () => {
  const tracker = new ConcurrencyTracker({ limit: 5, staleMs: 500 });
  assert.equal(tracker.getActive('KEY1'), 0);
  tracker.acquire('KEY1', 1000);
  assert.equal(tracker.getActive('KEY1', 1000), 1);
  tracker.acquire('KEY1', 1000);
  assert.equal(tracker.getActive('KEY1', 1000), 2);
  tracker.release('KEY1', 1000);
  assert.equal(tracker.getActive('KEY1', 1000), 1);
  // Past stale window
  assert.equal(tracker.getActive('KEY1', 1600), 0);
});

test('rotate: concurrencyTracker acquired count is strictly 0 after stream finish', async () => {
  const tracker = new ConcurrencyTracker({ limit: 2 });
  const pool = {
    base: 'test-prov',
    refs: ['K1', 'K2'],
    weights: [1, 1],
    weightedRefs: ['K1', 'K2'],
    state: {
      failedUntil: new Map(),
      failCounts: new Map(),
      switches: 0,
      events: [],
      lastUsed: 'K1',
    },
    cooldownMs: 50,
  };

  const dispatchStorage = {
    run(store, fn) {
      store.pickedRef = 'K1';
      return fn();
    },
  };

  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: 'hi' };
        yield { type: 'finish', reason: { kind: 'stop' }, usage: {} };
      })();
    },
  };

  const ctx = {
    get(name) {
      if (name === 'llm') return llm;
      return null;
    },
  };

  const rotate = createRotate({
    ctx,
    dispatchStorage,
    buildRuntime: () => ({
      switchCodes: [],
      cooldownMs: 50,
      concurrencyLimit: 2,
      routingStrategy: 'round-robin',
    }),
    pushEvent: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    recordLatency: () => {},
    concurrencyTracker: tracker,
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    setRotateStartMs: () => {},
  });

  assert.equal(tracker.getActive('K1'), 0);
  const stream = rotate({ provider: 'test-prov' }, pool);
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      // While streaming, counter is acquired
      assert.equal(tracker.getActive('K1'), 1);
    }
  }
  // After clean finish, counter must be 0!
  assert.equal(tracker.getActive('K1'), 0);
});

test('rotate: concurrencyTracker released on early generator abort / break', async () => {
  const tracker = new ConcurrencyTracker({ limit: 2 });
  const pool = {
    base: 'test-prov',
    refs: ['K1'],
    weights: [1],
    weightedRefs: ['K1'],
    state: {
      failedUntil: new Map(),
      failCounts: new Map(),
      switches: 0,
      events: [],
      lastUsed: 'K1',
    },
    cooldownMs: 50,
  };

  const dispatchStorage = {
    run(store, fn) {
      store.pickedRef = 'K1';
      return fn();
    },
  };

  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: 'chunk 1' };
        yield { type: 'text-delta', text: 'chunk 2' };
        yield { type: 'finish', reason: { kind: 'stop' }, usage: {} };
      })();
    },
  };

  const ctx = {
    get(name) {
      if (name === 'llm') return llm;
      return null;
    },
  };

  const rotate = createRotate({
    ctx,
    dispatchStorage,
    buildRuntime: () => ({
      switchCodes: [],
      cooldownMs: 50,
      concurrencyLimit: 2,
      routingStrategy: 'round-robin',
    }),
    pushEvent: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    recordLatency: () => {},
    concurrencyTracker: tracker,
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    setRotateStartMs: () => {},
  });

  const stream = rotate({ provider: 'test-prov' }, pool);
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      assert.equal(tracker.getActive('K1'), 1);
      break; // Abort early!
    }
  }
  // Finally block must have executed on generator .return()!
  assert.equal(tracker.getActive('K1'), 0);
});

test('SandboxRunner.probeModels: recovers on transient network socket error', async () => {
  let attempts = 0;
  const runner = new SandboxRunner({
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('ECONNRESET');
      }
      return {
        status: 200,
        json: async () => ({ data: [{ id: 'model-a' }] }),
      };
    },
    resolveBaseUrl: () => 'https://api.example.com/v1',
  });

  const res = await runner.probeModels('REF_TEST', 'sk-test');
  assert.equal(attempts, 2, 'Should have retried once on socket error');
  assert.equal(res.ok, true);
  assert.equal(res.code, 'ok');
  assert.equal(res.modelsCount, 1);
});

test('sweepExpired: prunes deleted keys when activeRefs set is provided', () => {
  const st = {
    failedUntil: new Map([['K_ACTIVE', 9999999999999], ['K_DELETED', 9999999999999]]),
    failCounts: new Map([['K_ACTIVE', 1], ['K_DELETED', 5]]),
    authFailCounts: new Map([['K_DELETED', 3]]),
    brokenUntil: new Map([['K_DELETED', 9999999999999]]),
    costPerKey: new Map([['K_ACTIVE', 0.5], ['K_DELETED', 1.2]]),
    lastUsedAt: new Map([['K_ACTIVE', 1000], ['K_DELETED', 200]]),
    usageCounts: new Map([['K_ACTIVE', 10], ['K_DELETED', 2]]),
    byModel: new Map([['K_DELETED', new Map()]]),
    usageDays: new Map([['K_DELETED', new Map()]]),
    quotaWindows: new Map([['K_DELETED', { count: 1 }]]),
    rpmWindows: new Map([['K_DELETED', [1, 2]]]),
    probedAt: new Map([['K_DELETED', 500]]),
  };
  const poolState = new Map([['prov1', st]]);

  sweepExpired(poolState, 1000, ['K_ACTIVE']);

  assert.equal(st.failedUntil.has('K_ACTIVE'), true);
  assert.equal(st.failedUntil.has('K_DELETED'), false);
  assert.equal(st.failCounts.has('K_DELETED'), false);
  assert.equal(st.authFailCounts.has('K_DELETED'), false);
  assert.equal(st.brokenUntil.has('K_DELETED'), false);
  assert.equal(st.costPerKey.has('K_DELETED'), false);
  assert.equal(st.lastUsedAt.has('K_DELETED'), false);
  assert.equal(st.usageCounts.has('K_DELETED'), false);
  assert.equal(st.byModel.has('K_DELETED'), false);
  assert.equal(st.usageDays.has('K_DELETED'), false);
  assert.equal(st.quotaWindows.has('K_DELETED'), false);
  assert.equal(st.rpmWindows.has('K_DELETED'), false);
  assert.equal(st.probedAt.has('K_DELETED'), false);
});

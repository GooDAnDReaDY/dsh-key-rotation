import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConcurrencyTracker } from '../lib/concurrency.js';
import { createResolver, getProviderCost, LOCAL_POOL_EXHAUSTED_CODE } from '../lib/resolver.js';
import { pickCascadeFallback } from '../lib/cascade.js';
import { checkBudgetAndHealthAlerts } from '../lib/budget-monitor.js';
import { buildPools } from '../lib/pool-builder.js';
import { createRotate } from '../lib/rotate.js';

// ============================================================================
// #407: Concurrency limits & least-loaded
// ============================================================================

test('audit #407: ConcurrencyTracker configure updates limit and staleMs dynamically', () => {
  const tracker = new ConcurrencyTracker({ limit: 0, staleMs: 300000 });
  assert.equal(tracker.isEnabled(), false);
  assert.equal(tracker.limit, 0);

  tracker.configure({ limit: 3, staleMs: 15000 });
  assert.equal(tracker.isEnabled(), true);
  assert.equal(tracker.limit, 3);

  // acquire respects updated limit
  assert.equal(tracker.acquire('KEY_1'), true);
  assert.equal(tracker.acquire('KEY_1'), true);
  assert.equal(tracker.acquire('KEY_1'), true);
  assert.equal(tracker.acquire('KEY_1'), false, 'must reject at limit 3');

  tracker.release('KEY_1');
  assert.equal(tracker.acquire('KEY_1'), true, 'must accept after release');
});

test('audit #407: ConcurrencyTracker tracks in-flight count even when limit is 0', () => {
  const tracker = new ConcurrencyTracker({ limit: 0 });
  assert.equal(tracker.isEnabled(), false);

  assert.equal(tracker.acquire('KEY_X'), true);
  assert.equal(tracker.getActive('KEY_X'), 1);

  assert.equal(tracker.acquire('KEY_X'), true);
  assert.equal(tracker.getActive('KEY_X'), 2);

  tracker.release('KEY_X');
  assert.equal(tracker.getActive('KEY_X'), 1);
  tracker.release('KEY_X');
  assert.equal(tracker.getActive('KEY_X'), 0);
});

test('audit #407: ConcurrencyTracker pickLeastLoaded respects per-call limit and skips saturated keys', () => {
  const tracker = new ConcurrencyTracker({ limit: 5 });
  const now = 10000;

  tracker.acquire('KEY_A', now, 1); // saturated under effective limit 1
  tracker.acquire('KEY_B', now, 2); // 1 in-flight under limit 2

  // With limit 1: KEY_A has 1 (saturated), KEY_B has 1 (saturated under limit 1) -> null
  assert.equal(tracker.pickLeastLoaded(['KEY_A', 'KEY_B'], now, {}, 1), null);

  // With limit 2: KEY_A has 1, KEY_B has 1 -> both valid, picks KEY_A
  assert.equal(tracker.pickLeastLoaded(['KEY_A', 'KEY_B'], now, {}, 2), 'KEY_A');

  tracker.release('KEY_A'); // KEY_A has 0
  assert.equal(tracker.pickLeastLoaded(['KEY_A', 'KEY_B'], now, {}, 1), 'KEY_A');
});

test('audit #407: resolver gates on concurrencyLimit and fails closed when all keys saturated', async () => {
  const tracker = new ConcurrencyTracker({ limit: 0 });
  const cfg = {
    providers: [
      {
        provider: 'concurrency-prov',
        keys: ['KEY_1', 'KEY_2'],
        concurrencyLimit: 1,
      },
    ],
  };

  const built = buildPools({ cfg });
  const pool = built.providerToPool.get('concurrency-prov');
  const now = 1000;
  const original = async (ref) => ({ value: 'secret-' + ref });

  let pickedMeta = null;
  const resolve = createResolver({
    buildRuntime: () => ({ ...built, concurrencyLimit: 1, routingStrategy: 'round-robin' }),
    currentPool: () => pool,
    concurrencyTracker: tracker,
    onPicked: (p, cand, meta) => { pickedMeta = meta; },
    now: () => now,
  });

  // 1st request -> acquires KEY_1
  const r1 = await resolve('KEY_1', original);
  assert.equal(r1.value, 'secret-KEY_1');
  assert.equal(tracker.getActive('KEY_1', now), 1);
  assert.equal(pickedMeta?.concurrencyRef, 'KEY_1');

  // 2nd request -> acquires KEY_2 (KEY_1 is saturated)
  const r2 = await resolve('KEY_2', original);
  assert.equal(r2.value, 'secret-KEY_2');
  assert.equal(tracker.getActive('KEY_2', now), 1);
  assert.equal(pickedMeta?.concurrencyRef, 'KEY_2');

  // 3rd request -> both KEY_1 and KEY_2 are saturated -> LOCAL_POOL_EXHAUSTED
  await assert.rejects(
    resolve('KEY_1', original),
    (err) => {
      assert.equal(err.code, LOCAL_POOL_EXHAUSTED_CODE);
      assert.equal(err.localExhausted, true);
      return true;
    }
  );

  // Release KEY_1 -> 4th request succeeds
  tracker.release('KEY_1');
  assert.equal(tracker.getActive('KEY_1', now), 0);
  const r4 = await resolve('KEY_1', original);
  assert.equal(r4.value, 'secret-KEY_1');
  assert.equal(tracker.getActive('KEY_1', now), 1);
});

test('audit #407: resolver rolls back concurrency permit if original() rejects', async () => {
  const tracker = new ConcurrencyTracker({ limit: 1 });
  const cfg = {
    providers: [
      {
        provider: 'rollback-prov',
        keys: ['KEY_FAIL'],
        concurrencyLimit: 1,
      },
    ],
  };

  const built = buildPools({ cfg });
  const pool = built.providerToPool.get('rollback-prov');
  const failingOriginal = async () => { throw new Error('credentials service boom'); };

  const resolve = createResolver({
    buildRuntime: () => ({ ...built, concurrencyLimit: 1 }),
    currentPool: () => pool,
    concurrencyTracker: tracker,
    now: () => 1000,
  });

  await assert.rejects(
    resolve('KEY_FAIL', failingOriginal),
    /credentials service boom/
  );

  assert.equal(tracker.getActive('KEY_FAIL', 1000), 0, 'permit must be rolled back on rejection');
});

test('audit #407: rotate stream lifecycle releases concurrency permit on finish and abort', async () => {
  const tracker = new ConcurrencyTracker({ limit: 1 });
  const pool = {
    base: 'rotate-stream-prov',
    refs: ['KEY_STREAM'],
    concurrencyLimit: 1,
    state: { failedUntil: new Map(), lastUsed: 'KEY_STREAM', pointer: 0 },
  };

  const runtime = {
    providerToPool: new Map([['rotate-stream-prov', pool]]),
    poolByRef: new Map([['KEY_STREAM', pool]]),
    concurrencyLimit: 1,
  };

  const dispatchStorage = new AsyncLocalStorage();
  let streamYielded = false;

  const rotate = createRotate({
    ctx: {
      get: () => ({
        stream: () => (async function* () {
          streamYielded = true;
          yield { delta: 'hello' };
        })(),
      }),
    },
    dispatchStorage,
    buildRuntime: () => runtime,
    concurrencyTracker: tracker,
    pushEvent: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    recordLatency: () => {},
    finishError: (code, msg) => new Error(msg),
    setRotateStartMs: () => {},
    circuitBreaker: null,
    now: () => 1000,
  });

  // Normal stream execution
  const stream = rotate({ provider: 'rotate-stream-prov' }, pool);
  for await (const chunk of stream) {
    assert.equal(chunk.delta, 'hello');
    // During stream processing, permit is acquired
    assert.equal(tracker.getActive('KEY_STREAM', 1000), 1);
  }
  // After completion, permit must be released
  assert.equal(tracker.getActive('KEY_STREAM', 1000), 0);
  assert.equal(streamYielded, true);

  // Early abort stream execution
  const abortStream = rotate({ provider: 'rotate-stream-prov' }, pool);
  const it = abortStream[Symbol.asyncIterator]();
  await it.next();
  assert.equal(tracker.getActive('KEY_STREAM', 1000), 1);
  await it.return(); // consumer aborts early
  assert.equal(tracker.getActive('KEY_STREAM', 1000), 0, 'permit must be released on stream return/abort');
});

// ============================================================================
// #414: Model-aware cascade failover
// ============================================================================

test('audit #414: pickCascadeFallback resolves model sub-pool when model mapping matches', () => {
  const cfg = {
    cascade: [
      {
        provider: 'fallback-prov',
        modelMapping: { 'gpt-4o': 'claude-3-5-sonnet' },
      },
    ],
    providers: [
      {
        provider: 'primary-prov',
        keys: ['KEY_P'],
      },
      {
        provider: 'fallback-prov',
        keys: ['KEY_FB_BASE'],
        models: {
          'claude-3-5-sonnet': {
            keys: ['KEY_FB_MODEL'],
          },
        },
      },
    ],
  };

  const { providerToPool, modelPoolByProvider } = buildPools({ cfg });
  const fb = pickCascadeFallback('primary-prov', cfg, providerToPool, 'gpt-4o', modelPoolByProvider);

  assert.ok(fb);
  assert.equal(fb.provider, 'fallback-prov');
  assert.equal(fb.model, 'claude-3-5-sonnet');
  assert.equal(fb.pool.model, 'claude-3-5-sonnet');
  assert.deepEqual(fb.pool.refs, ['KEY_FB_MODEL']);
});

test('audit #414: pickCascadeFallback skips fallback when model pool token quota is exhausted', () => {
  const cfg = {
    cascade: [
      {
        provider: 'quota-prov',
        model: 'special-model',
      },
    ],
    providers: [
      {
        provider: 'primary-prov',
        keys: ['KEY_P'],
      },
      {
        provider: 'quota-prov',
        keys: ['KEY_BASE'],
        models: {
          'special-model': {
            keys: ['KEY_M'],
            quotas: {
              KEY_M: { tokenLimit: 1000 },
            },
          },
        },
      },
    ],
  };

  const { providerToPool, modelPoolByProvider } = buildPools({ cfg });
  const modelPool = modelPoolByProvider.get('quota-prov').get('special-model');
  const now = Date.now();

  // Mark token quota exhausted on the model pool
  modelPool.state.tokenUsage = new Map([
    ['KEY_M', { used: 1000, resetAt: now + 60000 }],
  ]);

  const fb = pickCascadeFallback('primary-prov', cfg, providerToPool, 'special-model', modelPoolByProvider);
  assert.equal(fb, null, 'must skip quota-exhausted model pool in cascade');
});

test('audit #414: pickCascadeFallback supports model-only provider without base keys', () => {
  const cfg = {
    cascade: [
      {
        provider: 'model-only-prov',
        model: 'deepseek-coder',
      },
    ],
    providers: [
      {
        provider: 'primary-prov',
        keys: ['KEY_P'],
      },
      {
        provider: 'model-only-prov',
        // No top-level keys
        models: {
          'deepseek-coder': {
            keys: ['KEY_CODER'],
          },
        },
      },
    ],
  };

  const { providerToPool, modelPoolByProvider } = buildPools({ cfg });
  const fb = pickCascadeFallback('primary-prov', cfg, providerToPool, 'deepseek-coder', modelPoolByProvider);

  assert.ok(fb);
  assert.equal(fb.provider, 'model-only-prov');
  assert.equal(fb.model, 'deepseek-coder');
  assert.deepEqual(fb.pool.refs, ['KEY_CODER']);
});

// ============================================================================
// #422: Provider monetary budget
// ============================================================================

test('audit #422: getProviderCost aggregates spend across base pool and model pools without double-counting', () => {
  const today = new Date().toISOString().slice(0, 10);
  const now = Date.now();

  const baseState = {
    costDays: new Map([['KEY_BASE', new Map([[today, 6.0]])]]),
    failedUntil: new Map(),
  };

  const modelState = {
    costDays: new Map([['KEY_MODEL', new Map([[today, 4.5]])]]),
    failedUntil: new Map(),
  };

  const basePool = { provider: 'test-prov', base: 'test-prov', refs: ['KEY_BASE'], state: baseState };
  const modelPool = { provider: 'test-prov', base: 'test-prov::fast', refs: ['KEY_MODEL'], state: modelState };

  const runtime = {
    providerToPool: new Map([['test-prov', basePool]]),
    modelPoolByProvider: new Map([['test-prov', new Map([['fast', modelPool]])]]),
    poolByRef: new Map([['KEY_BASE', basePool], ['KEY_MODEL', modelPool]]),
  };

  const cost = getProviderCost('test-prov', runtime, now);
  assert.equal(cost.daily, 10.5, 'must sum base (6.0) and model (4.5) daily spend');
  assert.equal(cost.weekly, 10.5);

  // Shared state scenario: modelPool shares state with basePool -> should NOT double count
  modelPool.state = baseState;
  const deduplicatedCost = getProviderCost('test-prov', runtime, now);
  assert.equal(deduplicatedCost.daily, 6.0, 'must not double-count when state is shared');
});

test('audit #422: checkBudgetAndHealthAlerts pauses all pools belonging to provider when budget exceeded', () => {
  const today = new Date().toISOString().slice(0, 10);
  const now = 2000000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const basePool = {
    provider: 'budget-prov',
    base: 'budget-prov',
    refs: ['KEY_B1'],
    state: {
      costDays: new Map([['KEY_B1', new Map([[today, 12.0]])]]),
      failedUntil: new Map(),
    },
  };

  const modelPool = {
    provider: 'budget-prov',
    base: 'budget-prov::gpt-4',
    refs: ['KEY_M1'],
    state: {
      costDays: new Map([['KEY_M1', new Map([[today, 3.0]])]]),
      failedUntil: new Map(),
    },
  };

  const runtime = {
    providerToPool: new Map([['budget-prov', basePool]]),
    modelPoolByProvider: new Map([['budget-prov', new Map([['gpt-4', modelPool]])]]),
    poolByRef: new Map([['KEY_B1', basePool], ['KEY_M1', modelPool]]),
    providerBudgets: new Map([
      ['budget-prov', { costBudgetDaily: 10.0, costBudgetWeekly: 100.0, pauseOnBudget: true }],
    ]),
    notifyWebhook: 'http://alerts.local',
  };

  const alerts = [];
  const fakeWebhookSender = {
    send: (url, payload) => alerts.push({ url, payload }),
  };

  checkBudgetAndHealthAlerts({
    runtime,
    poolState: new Map([['budget-prov', basePool.state], ['budget-prov::gpt-4', modelPool.state]]),
    now,
    expiryNotifiedAt: new Map(),
    budgetNotifiedAt: new Map(),
    lowHealthNotifiedAt: new Map(),
    sloNotifiedAt: new Map(),
    latencyHistogram: { snapshot: () => ({}) },
    webhookSender: fakeWebhookSender,
    logger: { warn: () => {} },
  });

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].payload.provider, 'budget-prov');
  assert.equal(alerts[0].payload.kind, 'budget');
  assert.equal(alerts[0].payload.spend.daily, 15.0, 'daily spend must sum 12.0 + 3.0 = 15.0');

  // Both base pool and model pool keys must be paused
  assert.ok((basePool.state.failedUntil.get('KEY_B1') ?? 0) >= now + DAY_MS);
  assert.ok((modelPool.state.failedUntil.get('KEY_M1') ?? 0) >= now + DAY_MS);
});

test('audit #422: resolver fails closed with LOCAL_POOL_EXHAUSTED when provider budget exceeded', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const now = 1000;

  const pool = {
    provider: 'exceeded-prov',
    base: 'exceeded-prov',
    refs: ['KEY_BUDGET'],
    state: {
      costDays: new Map([['KEY_BUDGET', new Map([[today, 25.0]])]]),
      failedUntil: new Map(),
      pointer: 0,
    },
  };

  const runtime = {
    providerToPool: new Map([['exceeded-prov', pool]]),
    poolByRef: new Map([['KEY_BUDGET', pool]]),
    providerBudgets: new Map([
      ['exceeded-prov', { costBudgetDaily: 20.0, costBudgetWeekly: 100.0, pauseOnBudget: true }],
    ]),
  };

  const resolve = createResolver({
    buildRuntime: () => runtime,
    currentPool: () => pool,
    now: () => now,
  });

  await assert.rejects(
    resolve('KEY_BUDGET', async (ref) => ({ value: 'secret-' + ref })),
    (err) => {
      assert.equal(err.code, LOCAL_POOL_EXHAUSTED_CODE);
      assert.equal(err.localExhausted, true);
      assert.match(err.message, /cost budget exceeded/);
      return true;
    }
  );
});

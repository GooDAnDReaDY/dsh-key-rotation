import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';

import { createRotate } from '../lib/rotate.js';
import { buildPools } from '../lib/pool-builder.js';
import { initializePoolState } from '../lib/pool-state.js';
import { StatePersistence } from '../lib/persistence.js';
import { createResolver } from '../lib/resolver.js';
import { SandboxRunner } from '../lib/sandbox.js';
import { nowMono } from '../lib/clock.js';

const MARKER = '__dshKeyRotation';

function makeHarness({ providers, scriptFn }) {
  const cfg = {
    providers,
    cooldownMs: 60000,
    switchCodes: ['401', '403', '502', '503', '504', 'TIMEOUT', 'QUOTA', 'RATE_LIMIT'],
  };
  const built = buildPools({ cfg, poolState: new Map() });
  const refs = new Set(providers.flatMap((p) => p.keys ?? []));
  const store = new Map([...refs].map((r) => [r, `secret-for-${r}`]));
  const dispatchStorage = new AsyncLocalStorage();
  const dispatched = [];

  const credentials = {
    async resolve(ref) {
      const pool = dispatchStorage.getStore()?.pool ?? null;
      if (pool) {
        const resolve = createResolver({
          buildRuntime: () => runtime,
          currentPool: () => dispatchStorage.getStore()?.pool ?? null,
          currentModel: () => dispatchStorage.getStore()?.model ?? null,
          onPicked: (p, candidate) => {
            const s = dispatchStorage.getStore();
            if (s && s.pool === p) s.pickedRef = candidate;
          },
        });
        return resolve(ref, async (r) => (store.has(r) ? { value: store.get(r) } : undefined));
      }
      return store.has(ref) ? { value: store.get(ref) } : undefined;
    },
  };

  const llm = {
    stream(options) {
      const record = { provider: options.provider, model: options.model, pickedRef: null };
      dispatched.push(record);
      return (async function* () {
        const resolved = await credentials.resolve(options.apiKeyEnv ?? built.providerToPool.get(options.provider)?.refs?.[0]);
        record.pickedRef = resolved?.value ?? null;
        // Delegate behavior to scriptFn
        yield* scriptFn(options, record);
      })();
    },
  };

  const runtime = {
    ...built,
    switchCodes: cfg.switchCodes,
    cooldownMs: 60000,
    maxCooldownMs: undefined,
    switchNotify: false,
    rateLimitThreshold: 0.1,
    concurrencyLimit: 0,
    cascade: [],
    routingStrategy: 'round-robin',
    proactiveRateLimitGuard: false,
    circuitBreakerEnabled: false,
    notifier: null,
  };

  const events = [];
  const rotate = createRotate({
    ctx: { get: (name) => (name === 'llm' ? llm : undefined) },
    dispatchStorage,
    buildRuntime: () => runtime,
    schedulePersist: () => {},
    pushEvent: (pool, ref, code, ms) => events.push({ ref, code, ms }),
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    recordLatency: () => {},
    latencyHistogram: { snapshot: () => null, record: () => {} },
    concurrencyTracker: { isEnabled: () => false, acquire: () => false, release: () => {}, getActive: () => 0, pickLeastLoaded: () => null },
    MARKER,
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: Object.freeze({ code, message }) } }),
    setRotateStartMs: () => {},
    quotaStore: null,
    circuitBreaker: null,
    now: nowMono,
    logger: { warn: () => {} },
  });

  const drain = async (options, pool) => {
    const out = [];
    for await (const chunk of rotate(options, pool)) out.push(chunk);
    return out;
  };

  return { ...built, runtime, rotate, drain, dispatched, events, credentials, store };
}

test('Issue #501: permanent auth pause on 401 / 403 failure', async () => {
  let callCount = 0;
  const h = makeHarness({
    providers: [
      { provider: 'prov1', keys: ['key1', 'key2'] },
    ],
    scriptFn: async function* (options, record) {
      callCount++;
      if (record.pickedRef === 'secret-for-key1') {
        const err = new Error('Incorrect API key provided: key1');
        err.status = 401;
        err.code = '401';
        throw err;
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const pool = h.providerToPool.get('prov1');
  const res = await h.drain({ provider: 'prov1', model: 'deepseek-chat' }, pool);
  assert.equal(res[0]?.reason?.kind, 'stop');
  assert.equal(callCount, 2);

  // key1 must now be in pausedRefs with AUTH_FAILURE_PAUSED and failedUntil: Infinity
  assert.ok(pool.state.pausedRefs.has('key1'), 'key1 should be in pausedRefs');
  assert.equal(pool.state.pauseReasons.get('key1'), 'AUTH_FAILURE_PAUSED');
  assert.equal(pool.state.failedUntil.get('key1'), Infinity);

  // Subsequent call should skip key1 immediately
  callCount = 0;
  const res2 = await h.drain({ provider: 'prov1', model: 'deepseek-chat' }, pool);
  assert.equal(res2[0]?.reason?.kind, 'stop');
  assert.equal(callCount, 1);
  assert.equal(h.dispatched[h.dispatched.length - 1].pickedRef, 'secret-for-key2');
});

test('Issue #501: soft errors (502, 503, 504, TIMEOUT) receive short flat cooldown <= 10s', async () => {
  let callCount = 0;
  const h = makeHarness({
    providers: [
      { provider: 'prov2', keys: ['k_bad', 'k_good'] },
    ],
    scriptFn: async function* (options, record) {
      callCount++;
      if (record.pickedRef === 'secret-for-k_bad') {
        const err = new Error('502 Bad Gateway');
        err.status = 502;
        err.code = '502';
        throw err;
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const pool = h.providerToPool.get('prov2');
  const nowBefore = Date.now();
  await h.drain({ provider: 'prov2', model: 'deepseek-chat' }, pool);

  const until = pool.state.failedUntil.get('k_bad');
  assert.ok(Number.isFinite(until));
  const diff = until - nowBefore;
  assert.ok(diff <= 12000, `Expected flat cooldown <= 10s (+jitter <= 12s), got ${diff}ms`);
  assert.ok(!pool.state.pausedRefs.has('k_bad'), 'k_bad should not be auth paused');
  assert.equal(pool.state.failCounts.get('k_bad') || 0, 0, 'failCounts should not increment on soft error');
});

test('Issue #500: automatic model capabilities discovery and routing', async () => {
  const h = makeHarness({
    providers: [
      { provider: 'prov3', keys: ['key_coder', 'key_general'] },
    ],
    scriptFn: async function* (options, record) {
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });

  const pool = h.providerToPool.get('prov3');
  // Discovered capabilities
  pool.state.modelCapabilities.set('key_coder', new Set(['deepseek-coder']));
  pool.state.modelCapabilities.set('key_general', new Set(['deepseek-chat', 'deepseek-coder']));

  // Requesting deepseek-chat should filter out key_coder and choose key_general
  await h.drain({ provider: 'prov3', model: 'deepseek-chat' }, pool);
  assert.equal(h.dispatched[h.dispatched.length - 1].pickedRef, 'secret-for-key_general');
});

test('Issue #500: sandbox probeModels extracts models list', async () => {
  const fakeFetch = async (url) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        object: 'list',
        data: [
          { id: 'deepseek-chat', object: 'model' },
          { id: 'deepseek-reasoner', object: 'model' },
        ],
      }),
    };
  };

  const runner = new SandboxRunner({
    fetchImpl: fakeFetch,
    resolveBaseUrl: async () => 'https://api.deepseek.com',
  });

  const res = await runner.probeModels('deepseek_key_1', 'sk-test');

  assert.equal(res.ok, true);
  assert.deepEqual(res.models, ['deepseek-chat', 'deepseek-reasoner']);
});

test('State persistence restores pausedRefs and modelCapabilities', () => {
  const poolState = new Map();
  const st = initializePoolState();
  st.pausedRefs.add('k_auth_dead');
  st.pauseReasons.set('k_auth_dead', 'AUTH_FAILURE_PAUSED');
  st.failedUntil.set('k_auth_dead', Infinity);
  st.modelCapabilities.set('k_coder', new Set(['model-x', 'model-y']));
  poolState.set('provider1', st);

  const snapshot = StatePersistence.serialize({ poolState });
  assert.ok(snapshot.pools.provider1.pausedRefs.includes('k_auth_dead'));
  assert.equal(snapshot.pools.provider1.pauseReasons.k_auth_dead, 'AUTH_FAILURE_PAUSED');
  assert.deepEqual(snapshot.pools.provider1.modelCapabilities.k_coder, ['model-x', 'model-y']);

  const restored = new Map();
  StatePersistence.restorePools(restored, snapshot);
  const rSt = restored.get('provider1');
  assert.ok(rSt.pausedRefs.has('k_auth_dead'));
  assert.equal(rSt.pauseReasons.get('k_auth_dead'), 'AUTH_FAILURE_PAUSED');
  assert.equal(rSt.failedUntil.get('k_auth_dead'), Infinity);
  assert.ok(rSt.modelCapabilities.get('k_coder').has('model-x'));
  assert.ok(rSt.modelCapabilities.get('k_coder').has('model-y'));
});

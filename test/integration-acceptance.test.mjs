// test/integration-acceptance.test.mjs — the task's end-to-end acceptance
// configuration, exercised through the real pool builder, resolver, quota module
// and persistence, wired together the way apply() wires them.
//
// Configuration under test:
//   anthropic
//     CLAUDE_KEY_A / CLAUDE_KEY_B (base pool)
//     models.claude-sonnet  quota 1,000,000 per key
//     models.claude-opus    quota   200,000 per key
//
// Required outcome: once CLAUDE_KEY_A exhausts its Sonnet budget, Sonnet rotates
// to CLAUDE_KEY_B while Opus may still select CLAUDE_KEY_A.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';

import { buildPools } from '../lib/pool-builder.js';
import { createResolver } from '../lib/resolver.js';
import { preserveDispatchContext } from '../lib/rotate.js';
import { selectPool } from '../lib/pool.js';
import { StatePersistence } from '../lib/persistence.js';
import {
  consumeModelTokens, getModelTokenRemaining, getModelTokenUsage, getModelQuotaStatus,
} from '../lib/model-quota.js';

const WINDOW = { type: 'midnight_utc', hour: 0 };
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** The acceptance configuration exactly as documented. */
const ACCEPTANCE = {
  quotaResetWindow: WINDOW,
  providers: [{
    provider: 'anthropic',
    keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
    models: {
      'claude-sonnet': {
        keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
        quotas: {
          CLAUDE_KEY_A: { tokenLimit: 1000000 },
          CLAUDE_KEY_B: { tokenLimit: 1000000 },
        },
      },
      'claude-opus': {
        keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
        quotas: {
          CLAUDE_KEY_A: { tokenLimit: 200000 },
          CLAUDE_KEY_B: { tokenLimit: 200000 },
        },
      },
    },
  }],
};

/**
 * A full runtime stub: pool set, memoised runtime snapshot, dispatch ALS and the
 * patched-style resolver, mirroring apply()'s wiring.
 */
function install(config) {
  const poolState = new Map();
  const built = buildPools({ cfg: config, poolState });
  const store = new Map(
    ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'].map((r) => [r, `secret-for-${r}`]),
  );
  const runtime = {
    ...built,
    routingStrategy: 'round-robin',
    quotaResetWindow: config.quotaResetWindow,
    switchCodes: ['QUOTA', 'RATE_LIMIT'],
  };
  const dispatchStorage = new AsyncLocalStorage();
  const original = async (ref) => (store.has(ref) ? { value: store.get(ref), source: 'stored' } : undefined);
  const resolve = createResolver({
    buildRuntime: () => runtime,
    currentPool: () => dispatchStorage.getStore()?.pool ?? null,
    onPicked: (pool, candidate) => {
      const s = dispatchStorage.getStore();
      if (s && s.pool === pool) s.pickedRef = candidate;
    },
    now: () => NOW,
  });

  /**
   * Dispatch one request the way rotate() does: pick the pool via selectPool,
   * run the stream inside the dispatch store, resolve the credential lazily.
   */
  async function request(provider, model, { ref, usage, pin } = {}) {
    const pool = selectPool(built.modelPoolByProvider, built.providerToPool, provider, model);
    assert.ok(pool, `a pool exists for ${provider}/${model}`);
    const reqStore = { pool, pickedRef: undefined };
    if (pin) {
      const list = pool.weightedRefs ?? pool.refs;
      const i = list.indexOf(pin);
      if (i >= 0) pool.state.pointer = i;
    }
    // The upstream ref: the provider profile's apiKeyEnv by default.
    const requestedRef = ref ?? built.providerToPool.get(provider)?.refs?.[0] ?? 'CLAUDE_KEY_A';

    async function* upstream() {
      const hit = await resolve(requestedRef, original);
      reqStore.resolved = hit?.value;
      yield { type: 'finish', reason: { kind: 'stop' }, usage };
    }

    const inner = dispatchStorage.run(reqStore, () => upstream());
    for await (const _ of preserveDispatchContext(inner, dispatchStorage, reqStore)) { /* drain */ }

    // Account exactly as rotate() does on a successful finish.
    if (reqStore.pickedRef) consumeModelTokens(pool, reqStore.pickedRef, usage?.total_tokens, WINDOW, NOW);
    return { pool, store: reqStore };
  }

  return { ...built, runtime, poolState, request, resolve, original, dispatchStorage, store };
}

test('the documented acceptance configuration builds three pools', () => {
  const h = install(ACCEPTANCE);
  assert.deepEqual(h.pools.map((p) => p.base).sort(),
    ['anthropic', 'anthropic::claude-opus', 'anthropic::claude-sonnet']);
  assert.equal(h.modelPoolByProvider.get('anthropic').get('claude-sonnet').quotas.CLAUDE_KEY_A.tokenLimit, 1000000);
  assert.equal(h.modelPoolByProvider.get('anthropic').get('claude-opus').quotas.CLAUDE_KEY_A.tokenLimit, 200000);
});

test('ACCEPTANCE: Sonnet exhaustion rotates to KEY_B while Opus keeps KEY_A', async () => {
  const h = install(ACCEPTANCE);
  const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  const opus = h.modelPoolByProvider.get('anthropic').get('claude-opus');

  // 1. Two Sonnet requests pinned to CLAUDE_KEY_A, consuming 60% then 50% of its budget.
  const r1 = await h.request('anthropic', 'claude-sonnet', { usage: { total_tokens: 600000 }, pin: 'CLAUDE_KEY_A' });
  assert.equal(r1.store.pickedRef, 'CLAUDE_KEY_A');
  assert.equal(r1.store.resolved, 'secret-for-CLAUDE_KEY_A');

  const r2 = await h.request('anthropic', 'claude-sonnet', { usage: { total_tokens: 500000 }, pin: 'CLAUDE_KEY_A' });
  assert.equal(r2.store.pickedRef, 'CLAUDE_KEY_A', 'still under the 1,000,000 limit');

  // Overshot to 1,100,000: exhausted.
  assert.equal(getModelTokenUsage(sonnet, 'CLAUDE_KEY_A', NOW), 1100000);
  assert.equal(getModelTokenRemaining(sonnet, 'CLAUDE_KEY_A', NOW), 0);
  assert.equal(getModelQuotaStatus(sonnet, 'CLAUDE_KEY_A', NOW).exhausted, true);

  // 2. The next Sonnet request must skip CLAUDE_KEY_A even with the cursor on it.
  const r3 = await h.request('anthropic', 'claude-sonnet', { usage: { total_tokens: 1000 }, pin: 'CLAUDE_KEY_A' });
  assert.equal(r3.store.pickedRef, 'CLAUDE_KEY_B', 'Sonnet rotated to CLAUDE_KEY_B');
  assert.equal(r3.store.resolved, 'secret-for-CLAUDE_KEY_B');

  // 3. Opus must still be allowed to select CLAUDE_KEY_A.
  const r4 = await h.request('anthropic', 'claude-opus', { usage: { total_tokens: 20000 }, pin: 'CLAUDE_KEY_A' });
  assert.equal(r4.store.pickedRef, 'CLAUDE_KEY_A', 'Opus still selects CLAUDE_KEY_A');
  assert.equal(r4.store.resolved, 'secret-for-CLAUDE_KEY_A');

  // 4. Final asserted state.
  assert.equal(getModelTokenUsage(sonnet, 'CLAUDE_KEY_A', NOW), 1100000, 'Sonnet/KEY_A used 1,100,000');
  assert.equal(getModelTokenRemaining(sonnet, 'CLAUDE_KEY_A', NOW), 0, 'Sonnet/KEY_A exhausted');
  assert.equal(getModelTokenRemaining(sonnet, 'CLAUDE_KEY_B', NOW), 999000, 'Sonnet/KEY_B remains available');
  assert.equal(getModelTokenUsage(opus, 'CLAUDE_KEY_A', NOW), 20000, 'Opus/KEY_A used 20,000');
  assert.equal(getModelTokenRemaining(opus, 'CLAUDE_KEY_A', NOW), 180000, 'Opus/KEY_A remaining 180,000');
  assert.equal(getModelTokenRemaining(opus, 'CLAUDE_KEY_B', NOW), 200000, 'Opus/KEY_B untouched');

  // 5. The two counters are genuinely independent objects.
  assert.notEqual(sonnet.state.tokenUsage, opus.state.tokenUsage);
  assert.notEqual(sonnet.state, opus.state);
});

test('the request-scoped pool is authoritative for a shared ref', async () => {
  const h = install(ACCEPTANCE);
  const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  const opus = h.modelPoolByProvider.get('anthropic').get('claude-opus');

  // Exhaust only Sonnet for KEY_A.
  consumeModelTokens(sonnet, 'CLAUDE_KEY_A', 1000000, WINDOW, NOW);

  // Same ref, same runtime, two request scopes -> two different answers.
  const sonnetPick = await h.request('anthropic', 'claude-sonnet', { ref: 'CLAUDE_KEY_A', pin: 'CLAUDE_KEY_A' });
  const opusPick = await h.request('anthropic', 'claude-opus', { ref: 'CLAUDE_KEY_A', pin: 'CLAUDE_KEY_A' });

  assert.equal(sonnetPick.store.pickedRef, 'CLAUDE_KEY_B');
  assert.equal(opusPick.store.pickedRef, 'CLAUDE_KEY_A');
  assert.equal(opus.state.usageCounts.get('CLAUDE_KEY_A') > 0, true);
});

test('a model pool key that the base pool does not list is still usable', async () => {
  const h = install({
    quotaResetWindow: WINDOW,
    providers: [{
      provider: 'anthropic',
      keys: ['CLAUDE_KEY_A'],
      models: {
        // The model pool draws from credentials the provider base pool lacks.
        'claude-sonnet': { keys: ['CLAUDE_KEY_B'] },
      },
    }],
  });
  const hit = await h.request('anthropic', 'claude-sonnet', { ref: 'CLAUDE_KEY_A', pin: 'CLAUDE_KEY_B' });
  assert.equal(hit.store.pickedRef, 'CLAUDE_KEY_B');
  assert.equal(hit.store.resolved, 'secret-for-CLAUDE_KEY_B');
});

test('ALL EXHAUSTED: neither key is dispatched and no bypass occurs', async () => {
  const h = install({
    quotaResetWindow: WINDOW,
    providers: [{
      provider: 'anthropic',
      keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
      models: {
        'claude-sonnet': {
          keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
          quotas: { CLAUDE_KEY_A: { tokenLimit: 100 }, CLAUDE_KEY_B: { tokenLimit: 100 } },
        },
      },
    }],
  });
  const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  consumeModelTokens(sonnet, 'CLAUDE_KEY_A', 100, WINDOW, NOW);
  consumeModelTokens(sonnet, 'CLAUDE_KEY_B', 100, WINDOW, NOW);

  const pool = sonnet;
  const reqStore = { pool, pickedRef: undefined };
  const inner = h.dispatchStorage.run(reqStore, () => (async function* () {
    await h.resolve('CLAUDE_KEY_A', h.original);
    yield { type: 'finish' };
  })());
  await assert.rejects(async () => {
    for await (const _ of preserveDispatchContext(inner, h.dispatchStorage, reqStore)) { /* drain */ }
  }, (err) => err.code === 'LOCAL_MODEL_QUOTA_EXHAUSTED' && err.localQuota === true);

  assert.equal(reqStore.pickedRef, undefined, 'no credential was handed out');
  assert.equal(sonnet.state.failedUntil.size, 0, 'and no credential was penalised');
});

test('budgets survive a process restart through persistence', async () => {
  const first = install(ACCEPTANCE);
  const sonnet = first.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  await first.request('anthropic', 'claude-sonnet', { usage: { total_tokens: 820000 }, pin: 'CLAUDE_KEY_A' });
  assert.equal(getModelTokenUsage(sonnet, 'CLAUDE_KEY_A', NOW), 820000);

  // Snapshot, then rebuild from scratch as a restart would.
  const snapshot = JSON.parse(JSON.stringify(
    StatePersistence.serialize({ poolState: first.poolState, circuitSnapshot: {}, quotaSnapshot: {} }),
  ));
  const restoredState = new Map();
  StatePersistence.restorePools(restoredState, snapshot);
  const second = install(ACCEPTANCE);
  second.poolState.clear();
  for (const [k, v] of restoredState) second.poolState.set(k, v);
  const rebuilt = buildPools({ cfg: ACCEPTANCE, poolState: second.poolState });
  const sonnet2 = rebuilt.modelPoolByProvider.get('anthropic').get('claude-sonnet');

  assert.equal(getModelTokenUsage(sonnet2, 'CLAUDE_KEY_A', NOW), 820000, 'usage restored, not zeroed');
  assert.equal(getModelTokenRemaining(sonnet2, 'CLAUDE_KEY_A', NOW), 180000);
});

test('the whole acceptance run leaves no secret in persisted state', async () => {
  const h = install(ACCEPTANCE);
  await h.request('anthropic', 'claude-sonnet', { usage: { total_tokens: 1000 }, pin: 'CLAUDE_KEY_A' });
  const snapshot = StatePersistence.serialize({ poolState: h.poolState, circuitSnapshot: {}, quotaSnapshot: {} });
  const text = JSON.stringify(snapshot);
  assert.equal(text.includes('secret-for-'), false, 'no credential value is persisted');
  assert.equal(text.includes('CLAUDE_KEY_A'), true, 'only the ref is persisted');
  assert.equal(text.includes('1000000'), false, 'the configured limit is not copied into state');
});

// test/resolver-routing.test.mjs — request-scoped model pool ownership, quota
// guards, and the resolver's fail-closed behaviour.
//
// These exercise the real production modules (lib/pool-builder.js,
// lib/pool-index.js, lib/resolver.js) rather than re-implementing routing, so a
// regression in the shipped code fails here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPools } from '../lib/pool-builder.js';
import { createResolver } from '../lib/resolver.js';
import { modelPoolsForRef } from '../lib/pool-index.js';
import { selectPool } from '../lib/pool.js';
import { initializePoolState } from '../lib/pool-state.js';
import { consumeModelTokens, getModelTokenRemaining, getModelTokenUsage } from '../lib/model-quota.js';

const WINDOW = { type: 'midnight_utc', hour: 0 };
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** The acceptance configuration from the task: two models, two shared keys. */
function acceptanceConfig() {
  return {
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
  };
}

/**
 * Build a runtime exactly as apply() does, then wrap it in a credential store
 * so the resolver can be driven without the cordis runtime.
 */
function harness(providers, { credentialRefs = null, quotaResetWindow = WINDOW } = {}) {
  const cfg = { providers, quotaResetWindow, routingStrategy: 'round-robin' };
  const built = buildPools({ cfg, poolState: new Map() });
  // Every configured ref — base pool and model pool alike — is a real
  // credential in the store, which is what a working deployment looks like.
  const allRefs = new Set();
  for (const p of providers) {
    for (const k of p.keys ?? []) allRefs.add(k);
    for (const mp of Object.values(p.models ?? {})) {
      for (const k of mp.keys ?? []) allRefs.add(k);
    }
  }
  const refs = credentialRefs ?? allRefs;
  const store = new Map([...refs].map((ref) => [ref, `secret-for-${ref}`]));
  const original = async (ref) => (store.has(ref) ? { value: store.get(ref), source: 'stored' } : undefined);

  const runtime = {
    ...built,
    routingStrategy: 'round-robin',
    quotaResetWindow,
  };
  // `buildRuntime()` in lib/index.js returns a memoised snapshot; tests model
  // that with a stable reference, and the request-scoped pool is supplied per call.
  let requested = null;
  const resolve = createResolver({
    buildRuntime: () => runtime,
    currentPool: () => requested,
    onPicked: (pool, candidate) => { if (requested === pool) runtime.pickedRef = candidate; },
    // Pinned wall clock so lazy resets are deterministic; the runtime itself
    // always uses the real clock.
    now: () => NOW,
  });

  /**
   * Run one resolve inside the given request-scoped pool. `preferRef` parks the
   * shared round-robin cursor on a specific credential, which is how a test can
   * observe "this key is still eligible" independently of rotation order.
   */
  const asRequest = (pool, ref, preferRef = null) => {
    if (preferRef) {
      const list = pool.weightedRefs ?? pool.refs;
      const index = list.indexOf(preferRef);
      if (index >= 0) pool.state.pointer = index;
    }
    requested = pool;
    try {
      return resolve(ref, original);
    } finally {
      requested = null;
    }
  };

  return {
    ...built,
    runtime,
    original,
    store,
    asRequest,
    /** Run one resolve outside any rotation (plain credentials.resolve). */
    bare: (ref) => {
      requested = null;
      return resolve(ref, original);
    },
  };
}

const baseRef = (h) => h.poolByRef.get('CLAUDE_KEY_A') ?? h.providerToPool.get('anthropic');

test('pool construction carries explicit provider/model/quotas identity', () => {
  const h = harness([acceptanceConfig()]);
  const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  const opus = h.modelPoolByProvider.get('anthropic').get('claude-opus');
  const base = h.providerToPool.get('anthropic');

  assert.equal(sonnet.provider, 'anthropic');
  assert.equal(sonnet.model, 'claude-sonnet');
  assert.equal(sonnet.quotas.CLAUDE_KEY_A.tokenLimit, 1000000);
  assert.equal(sonnet.hasModelQuota, true);

  assert.equal(opus.model, 'claude-opus');
  assert.equal(opus.quotas.CLAUDE_KEY_A.tokenLimit, 200000);

  assert.equal(base.model, null, 'a provider base pool has no model');
  assert.deepEqual(Object.keys(base.quotas), [], 'and carries no quotas');
  assert.equal(base.hasModelQuota, false);
});

test('allPools enumerates every pool even when refs collide across models', () => {
  const h = harness([acceptanceConfig()]);
  const bases = h.pools.map((p) => p.base).sort();
  assert.deepEqual(bases, ['anthropic', 'anthropic::claude-opus', 'anthropic::claude-sonnet']);
  assert.equal(new Set(bases).size, bases.length, 'no duplicates');
  // The old Map<ref, pool> could only remember one model pool per ref.
  assert.deepEqual(
    modelPoolsForRef(h.index, 'CLAUDE_KEY_A').map((p) => p.base).sort(),
    ['anthropic::claude-opus', 'anthropic::claude-sonnet'],
  );
});

test('the compatibility poolByRef lookup is deterministic and base-pool-first', () => {
  const h = harness([acceptanceConfig()]);
  // KEY_A is declared by the provider base pool, so that is what a bare
  // lookup returns — not whichever model pool happened to be built last.
  assert.equal(h.poolByRef.get('CLAUDE_KEY_A').base, 'anthropic');
});

test('same ref in two model pools is not hijacked by build order', async () => {
  // Both models claim KEY_A. Requesting Sonnet must rotate the Sonnet pool, and
  // requesting Opus must rotate the Opus pool, regardless of iteration order.
  const h = harness([acceptanceConfig()]);
  const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  const opus = h.modelPoolByProvider.get('anthropic').get('claude-opus');

  // Spoil the Sonnet budget for KEY_A only.
  consumeModelTokens(sonnet, 'CLAUDE_KEY_A', 1000000, WINDOW, NOW);

  const sonnetHit = await h.asRequest(sonnet, 'CLAUDE_KEY_A');
  assert.equal(sonnetHit.value, 'secret-for-CLAUDE_KEY_B', 'Sonnet skips the exhausted key');

  const opusHit = await h.asRequest(opus, 'CLAUDE_KEY_A');
  assert.equal(opusHit.value, 'secret-for-CLAUDE_KEY_A', 'Opus still uses KEY_A');

  // And the Opus pick did not leak back into the Sonnet pool's cursor/state.
  assert.equal(sonnet.state.lastUsed, 'CLAUDE_KEY_B');
  assert.equal(opus.state.lastUsed, 'CLAUDE_KEY_A');
  assert.equal(opus.state.tokenUsage.has('CLAUDE_KEY_A'), false, 'no Sonnet usage leaked into Opus');
});

test('key rotation: the next available key is chosen for the requested model only', async () => {
  const h = harness([acceptanceConfig()]);
  const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');

  const first = await h.asRequest(sonnet, 'CLAUDE_KEY_A');
  assert.equal(first.value, 'secret-for-CLAUDE_KEY_A');
  consumeModelTokens(sonnet, 'CLAUDE_KEY_A', 1000000, WINDOW, NOW);

  const second = await h.asRequest(sonnet, 'CLAUDE_KEY_A');
  assert.equal(second.value, 'secret-for-CLAUDE_KEY_B', 'rotates to the funded sibling');
  assert.equal(h.store.get('CLAUDE_KEY_A'), 'secret-for-CLAUDE_KEY_A', 'reported by ref, not by value');
});

test('request-scoped pool substitutes a model-only key for the profile ref', async () => {
  // Provider base keys: KEY_A. Model pool keys: KEY_B, KEY_C.
  // The credentials profile resolves its apiKeyEnv (KEY_A) but the model pool
  // must serve its own keys.
  const h = harness([{
    provider: 'anthropic',
    keys: ['CLAUDE_KEY_A'],
    models: {
      'claude-sonnet': { keys: ['CLAUDE_KEY_B', 'CLAUDE_KEY_C'] },
    },
  }]);
  const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  const hit = await h.asRequest(sonnet, 'CLAUDE_KEY_A', 'CLAUDE_KEY_B');
  assert.ok(hit.value === 'secret-for-CLAUDE_KEY_B' || hit.value === 'secret-for-CLAUDE_KEY_C',
    'a model-pool key is served even though the requested ref is a base-pool ref');
});

test('an unrelated ref resolved during a request is not hijacked', async () => {
  // A different provider's credential, resolved inside another provider's
  // request scope, must go straight to the original resolver.
  const h = harness([
    acceptanceConfig(),
    { provider: 'openai', keys: ['OPENAI_KEY_X'] },
  ], { credentialRefs: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B', 'OPENAI_KEY_X'] });
  const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  const hit = await h.asRequest(sonnet, 'OPENAI_KEY_X');
  assert.equal(hit.value, 'secret-for-OPENAI_KEY_X', 'untouched by the Anthropic request scope');
});

test('FAIL CLOSED: all keys exhausted refuses instead of bypassing quota', async () => {
  const h = harness([{
    provider: 'anthropic',
    keys: ['CLAUDE_KEY_A'],
    models: {
      'claude-sonnet': {
        keys: ['CLAUDE_KEY_A'],
        quotas: { CLAUDE_KEY_A: { tokenLimit: 100 } },
      },
    },
  }]);
  const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  consumeModelTokens(sonnet, 'CLAUDE_KEY_A', 100, WINDOW, NOW);

  await assert.rejects(
    () => h.asRequest(sonnet, 'CLAUDE_KEY_A'),
    (err) => {
      assert.equal(err.code, 'LOCAL_MODEL_QUOTA_EXHAUSTED');
      assert.equal(err.localQuota, true);
      return true;
    },
    'the original credential must never be handed out as a bypass',
  );
});

test('without an active request scope the resolver keeps legacy behaviour', async () => {
  // Outside rotation there is no request-scoped pool, so exhaustion of a model
  // pool must not break a plain credentials.resolve() call.
  const h = harness([{
    provider: 'anthropic',
    keys: ['CLAUDE_KEY_A'],
    models: {
      'claude-sonnet': {
        keys: ['CLAUDE_KEY_A'],
        quotas: { CLAUDE_KEY_A: { tokenLimit: 10 } },
      },
    },
  }]);
  const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  consumeModelTokens(sonnet, 'CLAUDE_KEY_A', 10, WINDOW, NOW);
  const hit = await h.bare('CLAUDE_KEY_A');
  assert.equal(hit.value, 'secret-for-CLAUDE_KEY_A', 'legacy callers are unaffected');
});

test('a pool with no quota configuration routes exactly as before', async () => {
  const h = harness([{
    provider: 'anthropic',
    keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
    models: { 'claude-sonnet': { keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'] } },
  }]);
  const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  assert.equal(sonnet.hasModelQuota, false);
  const first = await h.asRequest(sonnet, 'CLAUDE_KEY_A');
  const second = await h.asRequest(sonnet, 'CLAUDE_KEY_A');
  assert.equal(first.value, 'secret-for-CLAUDE_KEY_A');
  assert.equal(second.value, 'secret-for-CLAUDE_KEY_B', 'plain round-robin still rotates');
  assert.equal(sonnet.state.tokenUsage.size, 0, 'no quota state is invented');
});

test('quota exhaustion never writes a credential-failure signal', async () => {
  const h = harness([{
    provider: 'anthropic',
    keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
    models: {
      'claude-sonnet': {
        keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
        quotas: { CLAUDE_KEY_A: { tokenLimit: 100 } },
      },
    },
  }]);
  const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  consumeModelTokens(sonnet, 'CLAUDE_KEY_A', 100, WINDOW, NOW);
  await h.asRequest(sonnet, 'CLAUDE_KEY_A');

  assert.equal(sonnet.state.failedUntil.has('CLAUDE_KEY_A'), false, 'no cooldown for a spent budget');
  assert.equal(sonnet.state.failCounts.has('CLAUDE_KEY_A'), false, 'no failure count');
  assert.equal(sonnet.state.authFailCounts.has('CLAUDE_KEY_A'), false);
  assert.equal(sonnet.state.brokenUntil.has('CLAUDE_KEY_A'), false, 'not marked broken');
});

test('least-loaded and lowest-latency cannot select an exhausted key', async () => {
  for (const strategy of ['least-loaded', 'lowest-latency']) {
    const h = harness([{
      provider: 'anthropic',
      keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
      routingStrategy: strategy,
      models: {
        'claude-sonnet': {
          keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
          quotas: { CLAUDE_KEY_A: { tokenLimit: 100 } },
        },
      },
    }]);
    const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');
    consumeModelTokens(sonnet, 'CLAUDE_KEY_A', 100, WINDOW, NOW);
    // Force a latency/concurrency preference for the exhausted key.
    const deps = {
      latencyHistogram: { snapshot: (ref) => (ref === 'CLAUDE_KEY_A' ? { p95: 1 } : { p95: 900 }) },
      concurrencyTracker: { getActive: (ref) => (ref === 'CLAUDE_KEY_A' ? 0 : 5) },
    };
    const requested = sonnet;
    const resolve = createResolver({
      buildRuntime: () => h.runtime,
      currentPool: () => requested,
      now: () => NOW,
      ...deps,
    });
    const hit = await resolve('CLAUDE_KEY_A', h.original);
    assert.equal(hit.value, 'secret-for-CLAUDE_KEY_B', `${strategy} must skip the exhausted key`);
  }
});

test('request-scoped ownership never crosses into another model pool', async () => {
  const h = harness([acceptanceConfig()]);
  const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  const opus = h.modelPoolByProvider.get('anthropic').get('claude-opus');
  await h.asRequest(sonnet, 'CLAUDE_KEY_A');
  assert.equal(sonnet.state.usageCounts.get('CLAUDE_KEY_A'), 1);
  assert.equal(opus.state.usageCounts.get('CLAUDE_KEY_A'), undefined, 'Opus state untouched');
});

test('selectPool prefers the model sub-pool and falls back to the base pool', () => {
  const h = harness([acceptanceConfig()]);
  const byModel = h.modelPoolByProvider;
  const providers = h.providerToPool;
  assert.equal(selectPool(byModel, providers, 'anthropic', 'claude-sonnet').model, 'claude-sonnet');
  assert.equal(selectPool(byModel, providers, 'anthropic', 'claude-opus').model, 'claude-opus');
  assert.equal(selectPool(byModel, providers, 'anthropic', 'unknown-model').model, null);
  // Prefix matching still resolves a versioned model id to its pool.
  assert.equal(selectPool(byModel, providers, 'anthropic', 'claude-sonnet-4-5').model, 'claude-sonnet');
});

test('an exhausted key does not block a different model in the same provider', async () => {
  const h = harness([acceptanceConfig()]);
  const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  const opus = h.modelPoolByProvider.get('anthropic').get('claude-opus');

  consumeModelTokens(sonnet, 'CLAUDE_KEY_A', 1000000, WINDOW, NOW);
  consumeModelTokens(sonnet, 'CLAUDE_KEY_B', 1000000, WINDOW, NOW);
  // Sonnet is fully spent; a Sonnet request now fails closed.
  await assert.rejects(() => h.asRequest(sonnet, 'CLAUDE_KEY_A'));

  // Opus is untouched and still routes normally.
  const hit = await h.asRequest(opus, 'CLAUDE_KEY_A');
  assert.equal(hit.value, 'secret-for-CLAUDE_KEY_A');
  assert.equal(getModelTokenRemaining(opus, 'CLAUDE_KEY_A', NOW), 200000);
});

test('the end-to-end acceptance scenario', async () => {
  // Provider test-provider; Sonnet keys limited to 100, Opus keys to 50.
  const h = harness([{
    provider: 'test-provider',
    keys: ['KEY_A', 'KEY_B'],
    models: {
      sonnet: {
        keys: ['KEY_A', 'KEY_B'],
        quotas: { KEY_A: { tokenLimit: 100 }, KEY_B: { tokenLimit: 100 } },
      },
      opus: {
        keys: ['KEY_A', 'KEY_B'],
        quotas: { KEY_A: { tokenLimit: 50 }, KEY_B: { tokenLimit: 50 } },
      },
    },
  }], { credentialRefs: ['KEY_A', 'KEY_B'] });

  const sonnet = h.modelPoolByProvider.get('test-provider').get('sonnet');
  const opus = h.modelPoolByProvider.get('test-provider').get('opus');

  // Two Sonnet requests on KEY_A consuming 60 then 50. The cursor is pinned on
  // KEY_A so the scenario exercises budget accounting rather than rotation order.
  const r1 = await h.asRequest(sonnet, 'KEY_A', 'KEY_A');
  assert.equal(r1.value, 'secret-for-KEY_A');
  consumeModelTokens(sonnet, 'KEY_A', 60, WINDOW, NOW);
  const r2 = await h.asRequest(sonnet, 'KEY_A', 'KEY_A');
  assert.equal(r2.value, 'secret-for-KEY_A', 'still available at 60/100');
  consumeModelTokens(sonnet, 'KEY_A', 50, WINDOW, NOW);

  assert.equal(getModelTokenUsage(sonnet, 'KEY_A', NOW), 110);
  assert.equal(getModelTokenRemaining(sonnet, 'KEY_A', NOW), 0);
  assert.equal(getModelTokenUsage(sonnet, 'KEY_B', NOW), 0);

  // The next Sonnet request must select KEY_B, whatever the cursor says.
  const r3 = await h.asRequest(sonnet, 'KEY_A', 'KEY_A');
  assert.equal(r3.value, 'secret-for-KEY_B', 'Sonnet rotates to KEY_B');

  // Opus may still use KEY_A.
  const r4 = await h.asRequest(opus, 'KEY_A', 'KEY_A');
  assert.equal(r4.value, 'secret-for-KEY_A', 'Opus is still allowed to select KEY_A');
  consumeModelTokens(opus, 'KEY_A', 20, WINDOW, NOW);

  // Final asserted state.
  assert.equal(getModelTokenUsage(sonnet, 'KEY_A', NOW), 110, 'Sonnet KEY_A used 110');
  assert.equal(getModelTokenRemaining(sonnet, 'KEY_A', NOW), 0, 'Sonnet KEY_A exhausted');
  assert.equal(getModelTokenRemaining(sonnet, 'KEY_B', NOW), 100, 'Sonnet KEY_B available');
  assert.equal(getModelTokenUsage(opus, 'KEY_A', NOW), 20, 'Opus KEY_A used 20');
  assert.equal(getModelTokenRemaining(opus, 'KEY_A', NOW), 30, 'Opus KEY_A remaining 30');
  assert.equal(getModelTokenRemaining(opus, 'KEY_B', NOW), 50, 'Opus KEY_B available');
});

// test/backward-compat.test.mjs — a configuration written for the pre-quota
// plugin must behave identically after this change.
//
// The rule under test: no `quotas` means no local model token limit at all —
// never a zero budget, never a pre-exhausted key, never a required migration.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPools } from '../lib/pool-builder.js';
import { selectPool } from '../lib/pool.js';
import { getModelQuotaStatus, isModelQuotaAvailable, hasModelQuotaConfig } from '../lib/model-quota.js';
import { createResolver } from '../lib/resolver.js';

const WINDOW = { type: 'midnight_utc', hour: 0 };
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** The exact legacy shape: models with keys and nothing else. */
const LEGACY = {
  providers: [{
    provider: 'anthropic',
    keys: ['KEY_A', 'KEY_B'],
    models: {
      'claude-sonnet': { keys: ['KEY_A', 'KEY_B'] },
      'claude-opus': { keys: ['KEY_A', 'KEY_B'] },
    },
  }],
};

function build(cfg, refs = ['KEY_A', 'KEY_B']) {
  const built = buildPools({ cfg: { ...cfg, quotaResetWindow: WINDOW }, poolState: new Map() });
  const store = new Map(refs.map((r) => [r, `secret-for-${r}`]));
  const original = async (ref) => (store.has(ref) ? { value: store.get(ref) } : undefined);
  return { ...built, store, original };
}

test('a legacy config parses and exposes no quota configuration', () => {
  const h = build(LEGACY);
  for (const pool of h.pools) {
    assert.equal(hasModelQuotaConfig(pool), false, `${pool.base} has no quota`);
    assert.equal(Object.keys(pool.quotas).length, 0);
    assert.equal(pool.hasModelQuota, false);
  }
  // Model pools still exist and carry identity — that part is unchanged.
  assert.equal(h.modelPoolByProvider.get('anthropic').get('claude-sonnet').model, 'claude-sonnet');
  assert.equal(h.pools.length, 3, 'base pool + two model pools');
});

test('no credential is ever reported exhausted by default', () => {
  const h = build(LEGACY);
  for (const pool of h.pools) {
    for (const ref of pool.refs) {
      assert.equal(getModelQuotaStatus(pool, ref, NOW), null, 'unlimited, not exhausted');
      assert.equal(isModelQuotaAvailable(pool, ref, NOW), true);
    }
  }
});

test('legacy round-robin selection is unchanged', async () => {
  const h = build(LEGACY);
  const sonnet = h.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  const runtime = { ...h, routingStrategy: 'round-robin', quotaResetWindow: WINDOW };
  const resolve = createResolver({
    buildRuntime: () => runtime,
    currentPool: () => sonnet,
    now: () => NOW,
  });
  const first = await resolve('KEY_A', h.original);
  const second = await resolve('KEY_A', h.original);
  assert.equal(first.value, 'secret-for-KEY_A');
  assert.equal(second.value, 'secret-for-KEY_B', 'the cursor still advances one slot per call');
  assert.equal(sonnet.state.tokenUsage.size, 0);
});

test('an empty quotas object is the same as no quotas', () => {
  const h = build({
    providers: [{
      provider: 'anthropic',
      keys: ['KEY_A'],
      models: { m: { keys: ['KEY_A'], quotas: {} } },
    }],
  });
  const pool = h.modelPoolByProvider.get('anthropic').get('m');
  assert.equal(hasModelQuotaConfig(pool), false);
  assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NOW), true);
  assert.equal(getModelQuotaStatus(pool, 'KEY_A', NOW), null);
});

test('a quota of zero or a negative limit means no limit, not zero budget', () => {
  for (const tokenLimit of [0, -1, null, undefined, NaN, 'abc']) {
    const h = build({
      providers: [{
        provider: 'anthropic',
        keys: ['KEY_A'],
        models: { m: { keys: ['KEY_A'], quotas: { KEY_A: { tokenLimit } } } },
      }],
    });
    const pool = h.modelPoolByProvider.get('anthropic').get('m');
    assert.equal(hasModelQuotaConfig(pool), false, `tokenLimit=${String(tokenLimit)} disables the budget`);
    assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NOW), true, 'never pre-exhausted');
  }
});

test('a model pool with no quotas falls back to the provider base pool', () => {
  const h = build(LEGACY);
  assert.equal(selectPool(h.modelPoolByProvider, h.providerToPool, 'anthropic', 'unknown-model'),
    h.providerToPool.get('anthropic'));
});

test('quota config does not disturb other pool fields', () => {
  const h = build({
    providers: [{
      provider: 'anthropic',
      keys: ['KEY_A', 'KEY_B'],
      weights: [3, 1],
      expiresAt: [NOW + 86400000, 0],
      rpmLimit: 60,
      routingStrategy: 'least-loaded',
      models: {
        m: {
          keys: ['KEY_A', 'KEY_B'],
          weights: [5, 1],
          quotas: { KEY_A: { tokenLimit: 500 } },
        },
      },
    }],
  });
  const pool = h.modelPoolByProvider.get('anthropic').get('m');
  assert.deepEqual(pool.weights, [5, 1], 'model weights are preserved');
  assert.equal(pool.weightedRefs.filter((r) => r === 'KEY_A').length, 5, 'weighted routing is preserved');
  assert.equal(pool.routingStrategy, 'least-loaded');
  assert.equal(pool.quotaResetWindow, WINDOW);
  assert.equal(pool.quotas.KEY_B, undefined, 'only configured refs get a budget');
});

test('tokenLimit accepts a numeric string from a raw YAML section', () => {
  // A legacy host may hand the raw section to apply() without Schemastery.
  const h = build({
    providers: [{
      provider: 'anthropic',
      keys: ['KEY_A'],
      models: { m: { keys: ['KEY_A'], quotas: { KEY_A: { tokenLimit: '1000' } } } },
    }],
  });
  const pool = h.modelPoolByProvider.get('anthropic').get('m');
  assert.equal(pool.quotas.KEY_A.tokenLimit, 1000);
  assert.equal(getModelQuotaStatus(pool, 'KEY_A', NOW).limit, 1000);
});

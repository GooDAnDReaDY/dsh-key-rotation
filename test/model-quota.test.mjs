// test/model-quota.test.mjs — the pure model-token-quota contract.
//
// Covers the acceptance requirements for Provider × Credential Key × Model ×
// Token Quota: usage extraction, lazy initialisation, consumption, lazy reset,
// dynamic limits, and strict Key × Model isolation.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeModelQuotas,
  hasModelQuotaConfig,
  getModelTokenLimit,
  getModelTokenUsage,
  getModelTokenRemaining,
  getModelQuotaStatus,
  isModelQuotaAvailable,
  anyModelQuotaAvailable,
  filterQuotaEligible,
  resetModelQuotaIfNeeded,
  consumeModelTokens,
  extractUsageTokens,
  formatModelQuotaExhaustion,
} from '../lib/model-quota.js';

const WINDOW = { type: 'midnight_utc', hour: 0 };
// Fixed wall clock: 2026-01-15T12:00:00Z. Never Date.now() — reset boundaries
// are calendar maths and must be reproducible.
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const NEXT_MIDNIGHT = Date.UTC(2026, 0, 16, 0, 0, 0);

/** Minimal pool shaped like the runtime's, with only what quota code reads. */
function makePool(refs, quotas, extra = {}) {
  return {
    base: 'anthropic::claude-sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet',
    refs,
    quotas: normalizeModelQuotas(quotas),
    hasModelQuota: Object.keys(normalizeModelQuotas(quotas)).length > 0,
    quotaResetWindow: WINDOW,
    state: { tokenUsage: new Map() },
    ...extra,
  };
}

test('extractUsageTokens: explicit totals win over component pairs', () => {
  assert.equal(extractUsageTokens({ total_tokens: 123 }), 123);
  assert.equal(extractUsageTokens({ totalTokens: 456 }), 456);
  assert.equal(extractUsageTokens({ total_tokens: 10, input_tokens: 99, output_tokens: 99 }), 10);
});

test('extractUsageTokens: input+output and prompt+completion pairs', () => {
  assert.equal(extractUsageTokens({ input_tokens: 100, output_tokens: 23 }), 123);
  assert.equal(extractUsageTokens({ inputTokens: 100, outputTokens: 23 }), 123);
  assert.equal(extractUsageTokens({ prompt_tokens: 100, completion_tokens: 23 }), 123);
  assert.equal(extractUsageTokens({ promptTokens: 100, completionTokens: 23 }), 123);
});

test('extractUsageTokens: a single side of a pair still counts', () => {
  assert.equal(extractUsageTokens({ input_tokens: 100 }), 100);
  assert.equal(extractUsageTokens({ output_tokens: 23 }), 23);
  assert.equal(extractUsageTokens({ promptTokens: 7 }), 7);
});

test('extractUsageTokens: invalid, negative and NaN values are ignored', () => {
  assert.equal(extractUsageTokens(null), null);
  assert.equal(extractUsageTokens(undefined), null);
  assert.equal(extractUsageTokens('nope'), null);
  assert.equal(extractUsageTokens({}), null);
  assert.equal(extractUsageTokens({ total_tokens: -5 }), null);
  assert.equal(extractUsageTokens({ total_tokens: NaN }), null);
  assert.equal(extractUsageTokens({ total_tokens: Infinity }), null);
  assert.equal(extractUsageTokens({ total_tokens: '123' }), null, 'numeric strings are not silently trusted');
  assert.equal(extractUsageTokens({ input_tokens: -1, output_tokens: 5 }), 5, 'the usable half is kept');
  assert.equal(extractUsageTokens({ input_tokens: NaN, output_tokens: NaN }), null);
});

test('extractUsageTokens: fractional totals are floored to integers', () => {
  assert.equal(extractUsageTokens({ total_tokens: 10.9 }), 10);
  assert.equal(extractUsageTokens({ input_tokens: 1.5, output_tokens: 2.4 }), 3);
});

test('normalizeModelQuotas: documented shape, shorthand, and rejected entries', () => {
  const q = normalizeModelQuotas({
    KEY_A: { tokenLimit: 1000 },
    KEY_B: 2000,
    KEY_ZERO: { tokenLimit: 0 },
    KEY_NEG: { tokenLimit: -5 },
    KEY_NULL: { tokenLimit: null },
    KEY_MISSING: {},
    __proto__: { tokenLimit: 5 },
  });
  assert.equal(q.KEY_A.tokenLimit, 1000);
  assert.equal(q.KEY_B.tokenLimit, 2000);
  assert.equal(q.KEY_ZERO, undefined, 'a zero limit is not a budget');
  assert.equal(q.KEY_NEG, undefined);
  assert.equal(q.KEY_NULL, undefined);
  assert.equal(q.KEY_MISSING, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(q, '__proto__'), false, 'prototype keys are dropped');
  assert.equal(Object.getPrototypeOf(q), null);
});

test('no quota configured behaves as unlimited (legacy configuration)', () => {
  const pool = makePool(['KEY_A', 'KEY_B'], {});
  assert.equal(hasModelQuotaConfig(pool), false);
  assert.equal(getModelTokenLimit(pool, 'KEY_A'), null);
  assert.equal(getModelTokenRemaining(pool, 'KEY_A', NOW), null);
  assert.equal(getModelQuotaStatus(pool, 'KEY_A', NOW), null, 'status is null, not a zero budget');
  assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NOW), true);
  assert.deepEqual(filterQuotaEligible(pool, pool.refs, NOW), ['KEY_A', 'KEY_B']);
  // Reads must not create state for an unlimited credential.
  assert.equal(pool.state.tokenUsage.size, 0);
});

test('quota initialisation: zero used and the next calendar reset boundary', () => {
  const pool = makePool(['KEY_A'], { KEY_A: { tokenLimit: 1000 } });
  const status = getModelQuotaStatus(pool, 'KEY_A', NOW);
  assert.equal(status.configured, true);
  assert.equal(status.limit, 1000);
  assert.equal(status.used, 0);
  assert.equal(status.remaining, 1000);
  assert.equal(status.resetAt, NEXT_MIDNIGHT);
  assert.equal(status.exhausted, false);
  assert.ok(status.resetAt > NOW, 'resetAt is a future wall-clock epoch timestamp');
});

test('consume accumulates, recomputes remaining, and flags exhaustion', () => {
  const pool = makePool(['KEY_A'], { KEY_A: { tokenLimit: 1000 } });
  let st = consumeModelTokens(pool, 'KEY_A', 250, WINDOW, NOW);
  assert.equal(st.used, 250);
  assert.equal(st.remaining, 750);
  assert.equal(st.exhausted, false);
  st = consumeModelTokens(pool, 'KEY_A', 250, WINDOW, NOW);
  assert.equal(st.used, 500);
  assert.equal(getModelTokenUsage(pool, 'KEY_A', NOW), 500);
  assert.equal(getModelTokenRemaining(pool, 'KEY_A', NOW), 500);
  st = consumeModelTokens(pool, 'KEY_A', 500, WINDOW, NOW);
  assert.equal(st.used, 1000);
  assert.equal(st.remaining, 0);
  assert.equal(st.exhausted, true);
  assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NOW), false);
});

test('the final request may overshoot the limit (no reservation in this version)', () => {
  const pool = makePool(['KEY_A'], { KEY_A: { tokenLimit: 1000 } });
  consumeModelTokens(pool, 'KEY_A', 999, WINDOW, NOW);
  assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NOW), true, 'still available before the request');
  const st = consumeModelTokens(pool, 'KEY_A', 5000, WINDOW, NOW);
  assert.equal(st.used, 5999);
  assert.equal(st.remaining, 0);
  assert.equal(st.exhausted, true);
  assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NOW), false);
});

test('consume is a no-op for unlimited credentials and invalid token counts', () => {
  const pool = makePool(['KEY_A', 'KEY_B'], { KEY_A: { tokenLimit: 100 } });
  assert.equal(consumeModelTokens(pool, 'KEY_B', 500, WINDOW, NOW), null, 'unlimited');
  assert.equal(consumeModelTokens(pool, 'KEY_A', 0, WINDOW, NOW), null, 'zero');
  assert.equal(consumeModelTokens(pool, 'KEY_A', -10, WINDOW, NOW), null, 'negative');
  assert.equal(consumeModelTokens(pool, 'KEY_A', NaN, WINDOW, NOW), null, 'NaN');
  assert.equal(consumeModelTokens(pool, 'KEY_A', undefined, WINDOW, NOW), null, 'missing usage');
  assert.equal(consumeModelTokens(pool, 'KEY_A', '100', WINDOW, NOW), null, 'string');
  assert.equal(pool.state.tokenUsage.size, 0, 'nothing was recorded');
  assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NOW), true);
});

test('missing usage never marks a key exhausted', () => {
  const pool = makePool(['KEY_A'], { KEY_A: { tokenLimit: 100 } });
  // A successful request that reported no usage at all.
  assert.equal(extractUsageTokens(undefined), null);
  assert.equal(consumeModelTokens(pool, 'KEY_A', extractUsageTokens(undefined), WINDOW, NOW), null);
  assert.equal(getModelTokenRemaining(pool, 'KEY_A', NOW), 100);
  assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NOW), true);
});

test('lazy reset: counters survive until resetAt and clear after it', () => {
  const pool = makePool(['KEY_A'], { KEY_A: { tokenLimit: 1000 } });
  consumeModelTokens(pool, 'KEY_A', 1000, WINDOW, NOW);
  assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NOW), false);

  // One millisecond before the boundary the budget is still spent.
  assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NEXT_MIDNIGHT - 1), false);
  assert.equal(getModelTokenUsage(pool, 'KEY_A', NEXT_MIDNIGHT - 1), 1000);

  // At the boundary the window rolls over lazily, with no timer involved.
  assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NEXT_MIDNIGHT), true);
  assert.equal(getModelTokenUsage(pool, 'KEY_A', NEXT_MIDNIGHT), 0);
  const status = getModelQuotaStatus(pool, 'KEY_A', NEXT_MIDNIGHT);
  assert.equal(status.used, 0);
  assert.equal(status.remaining, 1000);
  assert.equal(status.resetAt, Date.UTC(2026, 0, 17, 0, 0, 0), 'the next window boundary is recomputed');
});

test('resetModelQuotaIfNeeded only clears an elapsed stored window', () => {
  const pool = makePool(['KEY_A'], { KEY_A: { tokenLimit: 100 } });
  assert.equal(resetModelQuotaIfNeeded(pool, 'KEY_A', WINDOW, NOW), false, 'cold pool is a no-op');
  consumeModelTokens(pool, 'KEY_A', 100, WINDOW, NOW);
  assert.equal(resetModelQuotaIfNeeded(pool, 'KEY_A', WINDOW, NEXT_MIDNIGHT - 1), false);
  assert.equal(getModelTokenUsage(pool, 'KEY_A', NEXT_MIDNIGHT - 1), 100);
  assert.equal(resetModelQuotaIfNeeded(pool, 'KEY_A', WINDOW, NEXT_MIDNIGHT), true);
  assert.equal(getModelTokenUsage(pool, 'KEY_A', NEXT_MIDNIGHT), 0);
});

test('wall-clock windows: midnight_pst and rolling_24h both produce finite resets', () => {
  for (const window of [{ type: 'midnight_pst', hour: 0 }, { type: 'rolling_24h' }, undefined]) {
    const pool = makePool(['KEY_A'], { KEY_A: { tokenLimit: 10 } });
    pool.quotaResetWindow = window;
    const status = getModelQuotaStatus(pool, 'KEY_A', NOW);
    assert.ok(Number.isFinite(status.resetAt), `finite resetAt for ${JSON.stringify(window)}`);
    assert.ok(status.resetAt > NOW, `future resetAt for ${JSON.stringify(window)}`);
  }
});

test('corrupt stored state reads as zero, never as NaN or negative', () => {
  const pool = makePool(['KEY_A'], { KEY_A: { tokenLimit: 100 } });
  for (const bad of [
    { used: NaN, resetAt: NEXT_MIDNIGHT },
    { used: -50, resetAt: NEXT_MIDNIGHT },
    { used: 10, resetAt: NaN },
    { used: 10, resetAt: -1 },
    { used: '10', resetAt: NEXT_MIDNIGHT },
    null,
    'garbage',
  ]) {
    pool.state.tokenUsage.set('KEY_A', bad);
    const status = getModelQuotaStatus(pool, 'KEY_A', NOW);
    assert.equal(status.used, 0, `recovered from ${JSON.stringify(bad)}`);
    assert.equal(Number.isFinite(status.used), true);
    assert.equal(status.used >= 0, true);
    assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NOW), true);
  }
});

test('MODEL ISOLATION: an exhausted Sonnet key stays available for Opus', () => {
  // The heart of the feature: one credential, two model pools, two budgets.
  const sonnet = makePool(['KEY_A', 'KEY_B'], {
    KEY_A: { tokenLimit: 1000 },
    KEY_B: { tokenLimit: 1000 },
  });
  const opus = makePool(['KEY_A', 'KEY_B'], {
    KEY_A: { tokenLimit: 200 },
    KEY_B: { tokenLimit: 200 },
  }, { model: 'claude-opus', base: 'anthropic::claude-opus' });

  consumeModelTokens(sonnet, 'KEY_A', 1000, WINDOW, NOW);
  assert.equal(isModelQuotaAvailable(sonnet, 'KEY_A', NOW), false, 'Sonnet exhausted');

  // The same ref, another model pool: untouched.
  assert.equal(isModelQuotaAvailable(opus, 'KEY_A', NOW), true, 'Opus must remain available');
  assert.equal(getModelTokenUsage(opus, 'KEY_A', NOW), 0);
  assert.equal(getModelTokenRemaining(opus, 'KEY_A', NOW), 200);
  assert.equal(getModelQuotaStatus(opus, 'KEY_A', NOW).exhausted, false);
});

test('key rotation: an exhausted key is filtered out, its sibling is chosen', () => {
  const pool = makePool(['KEY_A', 'KEY_B'], {
    KEY_A: { tokenLimit: 100 },
    KEY_B: { tokenLimit: 100 },
  });
  consumeModelTokens(pool, 'KEY_A', 100, WINDOW, NOW);
  assert.deepEqual(filterQuotaEligible(pool, pool.refs, NOW), ['KEY_B']);
  assert.deepEqual(filterQuotaEligible(pool, pool.weightedRefs ?? pool.refs, NOW), ['KEY_B']);
  assert.equal(anyModelQuotaAvailable(pool, NOW), true);
});

test('all keys exhausted: nothing is eligible and the pool reports exhausted', () => {
  const pool = makePool(['KEY_A', 'KEY_B'], {
    KEY_A: { tokenLimit: 100 },
    KEY_B: { tokenLimit: 50 },
  });
  consumeModelTokens(pool, 'KEY_A', 100, WINDOW, NOW);
  consumeModelTokens(pool, 'KEY_B', 50, WINDOW, NOW);
  assert.deepEqual(filterQuotaEligible(pool, pool.refs, NOW), []);
  assert.equal(anyModelQuotaAvailable(pool, NOW), false);
  assert.ok(formatModelQuotaExhaustion('anthropic', pool).length > 0);
});

test('weighted routing cannot resurrect an exhausted key', () => {
  // KEY_A carries a heavy weight; its budget is still what decides.
  const pool = makePool(['KEY_A', 'KEY_B'], { KEY_A: { tokenLimit: 10 } });
  pool.weightedRefs = ['KEY_A', 'KEY_A', 'KEY_A', 'KEY_A', 'KEY_B'];
  consumeModelTokens(pool, 'KEY_A', 10, WINDOW, NOW);
  const eligible = filterQuotaEligible(pool, pool.weightedRefs, NOW);
  assert.deepEqual([...new Set(eligible)], ['KEY_B']);
  assert.equal(eligible.includes('KEY_A'), false);
});

test('dynamic limit: shrinking below used exhausts immediately, growing restores headroom', () => {
  const quotas = { KEY_A: { tokenLimit: 1000000 } };
  const pool = makePool(['KEY_A'], quotas);
  consumeModelTokens(pool, 'KEY_A', 700000, WINDOW, NOW);
  assert.equal(getModelTokenRemaining(pool, 'KEY_A', NOW), 300000);

  // Limit lowered under the consumed amount: exhausted at once, used preserved.
  pool.quotas = normalizeModelQuotas({ KEY_A: { tokenLimit: 500000 } });
  let status = getModelQuotaStatus(pool, 'KEY_A', NOW);
  assert.equal(status.used, 700000, 'usage is not reset by a config change');
  assert.equal(status.exhausted, true);
  assert.equal(status.remaining, 0);
  assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NOW), false);

  // Limit raised again: headroom returns without clearing usage.
  pool.quotas = normalizeModelQuotas({ KEY_A: { tokenLimit: 2000000 } });
  status = getModelQuotaStatus(pool, 'KEY_A', NOW);
  assert.equal(status.used, 700000);
  assert.equal(status.remaining, 1300000);
  assert.equal(status.exhausted, false);
  assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NOW), true);
});

test('deleting a quota restores unlimited immediately, keeping history harmless', () => {
  const pool = makePool(['KEY_A'], { KEY_A: { tokenLimit: 100 } });
  consumeModelTokens(pool, 'KEY_A', 100, WINDOW, NOW);
  assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NOW), false);

  // The quota entry is removed from configuration.
  pool.quotas = normalizeModelQuotas({});
  pool.hasModelQuota = false;
  assert.equal(hasModelQuotaConfig(pool), false);
  assert.equal(isModelQuotaAvailable(pool, 'KEY_A', NOW), true, 'unlimited again');
  assert.equal(getModelQuotaStatus(pool, 'KEY_A', NOW), null);
  assert.equal(getModelTokenLimit(pool, 'KEY_A'), null);
  // Stale usage may linger; it must not block anything.
  assert.deepEqual(filterQuotaEligible(pool, pool.refs, NOW), ['KEY_A']);
});

test('a ref with no quota in a quota-configured pool stays unlimited', () => {
  const pool = makePool(['KEY_A', 'KEY_B'], { KEY_A: { tokenLimit: 10 } });
  consumeModelTokens(pool, 'KEY_A', 10, WINDOW, NOW);
  assert.equal(isModelQuotaAvailable(pool, 'KEY_B', NOW), true, 'KEY_B has no configured budget');
  assert.equal(getModelQuotaStatus(pool, 'KEY_B', NOW), null);
  assert.deepEqual(filterQuotaEligible(pool, pool.refs, NOW), ['KEY_B']);
});

test('usage never becomes NaN or negative under adversarial input', () => {
  const pool = makePool(['KEY_A'], { KEY_A: { tokenLimit: 100 } });
  for (const bad of [NaN, Infinity, -Infinity, -1, '5', null, undefined, {}, [], () => {}]) {
    consumeModelTokens(pool, 'KEY_A', bad, WINDOW, NOW);
  }
  const used = getModelTokenUsage(pool, 'KEY_A', NOW);
  assert.equal(Number.isFinite(used), true);
  assert.ok(used >= 0);
  assert.equal(used, 0);
});

test('consumption saturates instead of overflowing to Infinity', () => {
  const pool = makePool(['KEY_A'], { KEY_A: { tokenLimit: Number.MAX_SAFE_INTEGER } });
  consumeModelTokens(pool, 'KEY_A', Number.MAX_SAFE_INTEGER, WINDOW, NOW);
  consumeModelTokens(pool, 'KEY_A', Number.MAX_SAFE_INTEGER, WINDOW, NOW);
  const used = getModelTokenUsage(pool, 'KEY_A', NOW);
  assert.equal(Number.isFinite(used), true);
  assert.equal(used, Number.MAX_SAFE_INTEGER);
});

test('quota reset window falls back safely when none is configured', () => {
  const pool = makePool(['KEY_A'], { KEY_A: { tokenLimit: 10 } });
  pool.quotaResetWindow = null;
  const status = getModelQuotaStatus(pool, 'KEY_A', NOW);
  assert.ok(Number.isFinite(status.resetAt));
  assert.ok(status.resetAt > NOW);
});

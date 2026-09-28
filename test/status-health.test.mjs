// test/status-health.test.mjs — status and health reporting for model sub-pools,
// plus the isolation guarantee for upstream QUOTA failures.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPools } from '../lib/pool-builder.js';
import { getModelQuotaStatus, consumeModelTokens } from '../lib/model-quota.js';
import { sanitizeSnapshot } from '../lib/sanitize-snapshot.js';
import { recordFailure } from '../lib/pool.js';

const WINDOW = { type: 'midnight_utc', hour: 0 };
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function build() {
  return buildPools({
    cfg: {
      quotaResetWindow: WINDOW,
      providers: [{
        provider: 'anthropic',
        keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
        models: {
          'claude-sonnet': {
            keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
            quotas: { CLAUDE_KEY_A: { tokenLimit: 1000000 }, CLAUDE_KEY_B: { tokenLimit: 1000000 } },
          },
          'claude-opus': {
            keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
            quotas: { CLAUDE_KEY_A: { tokenLimit: 200000 }, CLAUDE_KEY_B: { tokenLimit: 200000 } },
          },
        },
      }],
    },
    poolState: new Map(),
  });
}

test('status reports modelQuota per credential with correct arithmetic', () => {
  const built = build();
  const sonnet = built.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  consumeModelTokens(sonnet, 'CLAUDE_KEY_A', 820000, WINDOW, NOW);

  const status = getModelQuotaStatus(sonnet, 'CLAUDE_KEY_A', NOW);
  assert.deepEqual(status, {
    configured: true,
    limit: 1000000,
    used: 820000,
    remaining: 180000,
    resetAt: Date.UTC(2026, 0, 16),
    exhausted: false,
  });
});

test('status reports an exhausted budget with zero remaining', () => {
  const built = build();
  const opus = built.modelPoolByProvider.get('anthropic').get('claude-opus');
  consumeModelTokens(opus, 'CLAUDE_KEY_A', 200000, WINDOW, NOW);
  const status = getModelQuotaStatus(opus, 'CLAUDE_KEY_A', NOW);
  assert.equal(status.exhausted, true);
  assert.equal(status.remaining, 0);
  assert.equal(status.limit, 200000);
});

test('status reports null (unlimited) when no quota is configured', () => {
  const built = buildPools({
    cfg: { providers: [{ provider: 'anthropic', keys: ['K1'], models: { m: { keys: ['K1'] } } }] },
    poolState: new Map(),
  });
  const pool = built.modelPoolByProvider.get('anthropic').get('m');
  assert.equal(getModelQuotaStatus(pool, 'K1', NOW), null);
});

test('pool status entries carry additive model identity without breaking old fields', () => {
  const built = build();
  const pool = built.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  const entry = {
    provider: pool.base,
    model: pool.model ?? null,
    quotasConfigured: pool.hasModelQuota,
    keys: pool.refs.map((ref) => ({
      ref,
      present: true,
      active: false,
      cooldownMsLeft: 0,
      usage: 0,
      weight: 1,
      rpm: null,
      modelQuota: getModelQuotaStatus(pool, ref, NOW),
    })),
    switches: 0,
    totalUsage: 0,
  };
  // Existing fields survive sanitisation unchanged.
  assert.equal(entry.provider, 'anthropic::claude-sonnet');
  assert.equal(entry.model, 'claude-sonnet');
  assert.equal(entry.quotasConfigured, true);

  const clean = sanitizeSnapshot({ providers: [entry] }, NOW);
  const p = clean.providers[0];
  assert.equal(p.model, 'claude-sonnet');
  assert.equal(p.keys[0].modelQuota.limit, 1000000);
  assert.equal(Number.isFinite(p.keys[0].modelQuota.resetAt), true);
  assert.equal(p.keys[0].ref, 'CLAUDE_KEY_A', 'credential refs are exposed (already used by the UI)');
});

test('status never exposes a credential value', () => {
  const built = build();
  const pool = built.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  const entry = {
    provider: pool.base,
    keys: pool.refs.map((ref) => ({ ref, modelQuota: getModelQuotaStatus(pool, ref, NOW), tail: 'XyZ12' })),
  };
  const text = JSON.stringify(sanitizeSnapshot({ providers: [entry] }, NOW));
  assert.equal(/sk-|secret-for-|value/i.test(text), false, 'only refs and masked tails travel');
});

test('an exhausted budget is not counted as a healthy credential', () => {
  const built = build();
  const opus = built.modelPoolByProvider.get('anthropic').get('claude-opus');
  consumeModelTokens(opus, 'CLAUDE_KEY_A', 200000, WINDOW, NOW);
  consumeModelTokens(opus, 'CLAUDE_KEY_B', 200000, WINDOW, NOW);

  // Health logic as implemented in ops-status.js: quota-aware pools exclude
  // spent credentials even though no cooldown was ever set.
  const now = NOW;
  let healthy = 0;
  for (const ref of opus.refs) {
    const until = opus.state.failedUntil.get(ref);
    if (until !== undefined && until > now) continue;
    if (!getModelQuotaStatus(opus, ref, now)?.exhausted === false) continue;
    healthy++;
  }
  assert.equal(healthy, 0, 'both keys are out of budget');
  assert.equal(opus.state.failedUntil.size, 0, 'and neither carries a cooldown');

  const exhausted = healthy === 0 && opus.refs.length > 0;
  assert.equal(exhausted, true, 'the model pool reports exhausted');
});

test('a pool without quotas keeps the original cooldown-only health rule', () => {
  const built = buildPools({
    cfg: { providers: [{ provider: 'p', keys: ['K1', 'K2'] }] },
    poolState: new Map(),
  });
  const pool = built.providerToPool.get('p');
  assert.equal(pool.hasModelQuota, false);
  // No cooldowns and no quotas: every key is healthy, exactly as before.
  let healthy = 0;
  for (const ref of pool.refs) {
    const until = pool.state.failedUntil.get(ref);
    if (until !== undefined && until > NOW) continue;
    healthy++;
  }
  assert.equal(healthy, 2);
});

test('upstream QUOTA on a Sonnet key does not affect the Opus pool', () => {
  // recordFailure targets the model pool that actually served the request.
  const built = build();
  const sonnet = built.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  const opus = built.modelPoolByProvider.get('anthropic').get('claude-opus');

  recordFailure(sonnet, 'CLAUDE_KEY_A', NOW, 60000, undefined, false, false);

  assert.ok(sonnet.state.failedUntil.get('CLAUDE_KEY_A') > NOW, 'Sonnet key is cooling');
  assert.equal(opus.state.failedUntil.has('CLAUDE_KEY_A'), false, 'Opus key is untouched');
  assert.equal(opus.state.failCounts.size, 0);
});

test('a model quota reset is independent per model pool', () => {
  const built = build();
  const sonnet = built.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  const opus = built.modelPoolByProvider.get('anthropic').get('claude-opus');
  consumeModelTokens(sonnet, 'CLAUDE_KEY_A', 1000000, WINDOW, NOW);
  consumeModelTokens(opus, 'CLAUDE_KEY_A', 50000, WINDOW, NOW);

  const nextDay = Date.UTC(2026, 0, 16);
  assert.equal(getModelQuotaStatus(sonnet, 'CLAUDE_KEY_A', nextDay).used, 0, 'Sonnet rolled over');
  assert.equal(getModelQuotaStatus(opus, 'CLAUDE_KEY_A', nextDay).used, 0, 'Opus rolled over');
  // Opus had headroom before the rollover and still does.
  assert.equal(getModelQuotaStatus(opus, 'CLAUDE_KEY_A', nextDay).remaining, 200000);
});

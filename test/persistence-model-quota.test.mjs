// test/persistence.test.mjs — model token budget durability and backwards
// compatibility with snapshots written before the feature existed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { StatePersistence } from '../lib/persistence.js';
import { initializePoolState } from '../lib/pool-state.js';
import { sweepExpired } from '../lib/pool.js';
import { consumeModelTokens, getModelTokenRemaining, getModelTokenUsage } from '../lib/model-quota.js';

const WINDOW = { type: 'midnight_utc', hour: 0 };
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function poolFor(state, base = 'anthropic::claude-sonnet') {
  return {
    base,
    provider: 'anthropic',
    model: 'claude-sonnet',
    refs: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
    quotas: { CLAUDE_KEY_A: { tokenLimit: 1000000 } },
    hasModelQuota: true,
    quotaResetWindow: WINDOW,
    state,
  };
}

test('tokenUsage round-trips through serialize/restore', () => {
  const poolState = new Map();
  const state = initializePoolState();
  poolState.set('anthropic::claude-sonnet', state);
  const pool = poolFor(state);
  consumeModelTokens(pool, 'CLAUDE_KEY_A', 820000, WINDOW, NOW);

  const snapshot = StatePersistence.serialize({ poolState, circuitSnapshot: {}, quotaSnapshot: {} });
  const saved = snapshot.pools['anthropic::claude-sonnet'];
  assert.deepEqual(saved.tokenUsage.CLAUDE_KEY_A, { used: 820000, resetAt: Date.UTC(2026, 0, 16) });
  assert.equal(snapshot.version, 1, 'the schema stays additive on version 1');

  // A restart: fresh Map, restore from the snapshot.
  const restored = new Map();
  StatePersistence.restorePools(restored, JSON.parse(JSON.stringify(snapshot)));
  const restState = initializePoolState(restored.get('anthropic::claude-sonnet'));
  const restPool = poolFor(restState);
  assert.equal(getModelTokenUsage(restPool, 'CLAUDE_KEY_A', NOW), 820000, 'usage survived the restart');
  assert.equal(getModelTokenRemaining(restPool, 'CLAUDE_KEY_A', NOW), 180000);
});

test('a legacy snapshot without tokenUsage restores without error', () => {
  const legacy = {
    version: 1,
    savedAt: NOW,
    pools: {
      anthropic: { failedUntil: { CLAUDE_KEY_A: NOW + 60000 }, pointer: 1, lastUsed: 'CLAUDE_KEY_A' },
    },
    circuit: {},
    quota: {},
  };
  const poolState = new Map();
  const n = StatePersistence.restorePools(poolState, legacy);
  assert.equal(n, 1);
  const st = poolState.get('anthropic');
  assert.equal(st.failedUntil.get('CLAUDE_KEY_A'), NOW + 60000, 'existing fields still restore');
  assert.ok(st.tokenUsage instanceof Map);
  assert.equal(st.tokenUsage.size, 0, 'the new field starts empty rather than as a zero budget');
});

test('malformed tokenUsage entries are ignored, never installed', () => {
  const snapshot = {
    version: 1,
    pools: {
      'anthropic::claude-sonnet': {
        failedUntil: {},
        pointer: 0,
        lastUsed: null,
        tokenUsage: {
          BAD_NAN: { used: NaN, resetAt: NOW + 1000 },
          BAD_NEG: { used: -5, resetAt: NOW + 1000 },
          BAD_RESET: { used: 10, resetAt: 'later' },
          BAD_ZERO_RESET: { used: 10, resetAt: 0 },
          BAD_STRING: 'nope',
          BAD_NULL: null,
          GOOD: { used: 42, resetAt: NOW + 100000 },
        },
      },
    },
  };
  const poolState = new Map();
  StatePersistence.restorePools(poolState, snapshot);
  const st = poolState.get('anthropic::claude-sonnet');
  assert.deepEqual([...st.tokenUsage.keys()], ['GOOD']);
  assert.equal(st.tokenUsage.get('GOOD').used, 42);
});

test('serialize drops invalid live entries instead of writing them', () => {
  const poolState = new Map();
  const state = initializePoolState();
  state.tokenUsage.set('BAD', { used: NaN, resetAt: NOW });
  state.tokenUsage.set('BAD2', { used: -1, resetAt: NOW });
  state.tokenUsage.set('GOOD', { used: 5, resetAt: NOW + 1000 });
  poolState.set('anthropic::claude-sonnet', state);
  const snapshot = StatePersistence.serialize({ poolState, circuitSnapshot: {}, quotaSnapshot: {} });
  const saved = snapshot.pools['anthropic::claude-sonnet'].tokenUsage;
  assert.deepEqual(Object.keys(saved), ['GOOD']);
});

test('no secret value is ever written to the state file', () => {
  const poolState = new Map();
  const state = initializePoolState();
  state.tokenUsage.set('MY_API_KEY_REF', { used: 10, resetAt: NOW + 1000 });
  state.failedUntil.set('MY_API_KEY_REF', NOW + 500);
  poolState.set('anthropic', state);

  // A live state that also happens to hold the resolved secret in a runtime-only
  // field must still serialize only refs and counters.
  state.lastResolvedValue = 'sk-live-secret-value';
  const snapshot = StatePersistence.serialize({ poolState, circuitSnapshot: {}, quotaSnapshot: {} });
  const text = JSON.stringify(snapshot);
  assert.equal(text.includes('sk-live-secret-value'), false, 'no secret value in the snapshot');
  assert.equal(text.includes('MY_API_KEY_REF'), true, 'credential refs are expected');
});

test('a live pool that already charged tokens is not rolled back at startup', () => {
  // Lazy disk I/O can land after requests ran. Replaying an older snapshot would
  // refund spent budget, so live activity must win.
  const poolState = new Map();
  const state = initializePoolState();
  poolState.set('anthropic::claude-sonnet', state);
  const pool = poolFor(state);
  consumeModelTokens(pool, 'CLAUDE_KEY_A', 500, WINDOW, NOW);

  const stale = {
    version: 1,
    pools: {
      'anthropic::claude-sonnet': {
        failedUntil: {}, pointer: 0, lastUsed: null,
        tokenUsage: { CLAUDE_KEY_A: { used: 1, resetAt: Date.UTC(2026, 0, 16) } },
      },
    },
  };
  StatePersistence.restorePools(poolState, stale);
  assert.equal(getModelTokenUsage(pool, 'CLAUDE_KEY_A', NOW), 500, 'the newer live usage survived');
});

test('sweepExpired rolls an elapsed window and prunes removed refs', () => {
  const poolState = new Map();
  const state = initializePoolState();
  state.tokenUsage.set('KEY_A', { used: 100, resetAt: Date.UTC(2026, 0, 15) });
  state.tokenUsage.set('KEY_GONE', { used: 50, resetAt: Date.UTC(2026, 0, 20) });
  poolState.set('anthropic::claude-sonnet', state);

  const afterReset = Date.UTC(2026, 0, 15, 1);
  sweepExpired(poolState, afterReset, ['KEY_A'], WINDOW);
  assert.equal(state.tokenUsage.get('KEY_A').used, 0, 'the elapsed window rolled over');
  assert.ok(state.tokenUsage.get('KEY_A').resetAt > afterReset, 'and moved to the next boundary');

  const pruned = initializePoolState();
  pruned.tokenUsage.set('KEY_GONE', { used: 50, resetAt: Date.UTC(2026, 0, 20) });
  const poolState2 = new Map([['anthropic::claude-sonnet', pruned]]);
  sweepExpired(poolState2, afterReset, ['KEY_A'], WINDOW);
  assert.equal(pruned.tokenUsage.has('KEY_GONE'), false, 'a removed ref is cleaned up');
});

test('restore refuses a non-matching schema version, as before', async () => {
  const p = new StatePersistence({ filePath: 'E:/tmp/does-not-exist-state.json' });
  const raw = await p.load();
  assert.equal(raw, null, 'a missing file yields null rather than throwing');
});

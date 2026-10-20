import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sweepExpired } from '../lib/pool.js';
import { initializePoolState } from '../lib/pool-state.js';
import { buildPools, cleanupRemovedProviders } from '../lib/pool-builder.js';
import { CloneLifecycleManager } from '../lib/clone-lifecycle.js';

test('GitHub #26 regression: sweepExpired handles heterogeneous poolState values safely without throwing', () => {
  const poolState = new Map();

  // Valid pool state
  const validState = initializePoolState();
  validState.failedUntil.set('KEY_EXPIRED', 1000);
  validState.failedUntil.set('KEY_FUTURE', 5000);
  poolState.set('valid-pool', validState);

  // Heterogeneous non-state values that previously triggered fatal TypeError in 0.8.69
  poolState.set('openai:clones', new Set(['openai-2', 'openai-3']));
  poolState.set('null-entry', null);
  poolState.set('undefined-entry', undefined);
  poolState.set('string-entry', 'some-string');
  poolState.set('plain-object', {});
  poolState.set('bad-failed-until', { failedUntil: null });

  // In 0.8.69 this threw: TypeError: Cannot read properties of undefined (reading 'entries')
  let cleared = 0;
  assert.doesNotThrow(() => {
    cleared = sweepExpired(poolState, 2000);
  }, 'sweepExpired must not throw when encountering non-pool-state values');

  assert.equal(cleared, 1, 'must clear the expired key from valid state');
  assert.equal(validState.failedUntil.has('KEY_EXPIRED'), false);
  assert.equal(validState.failedUntil.has('KEY_FUTURE'), true);
});

test('GitHub #26 regression: cleanupRemovedProviders does NOT store Set objects in poolState', () => {
  const poolState = new Map();
  const cloneLifecycle = new CloneLifecycleManager();

  const cfg = {
    providers: [
      { provider: 'openai', keys: ['KEY_1', 'KEY_2', 'KEY_3'] },
      { provider: 'anthropic', keys: ['A_KEY_1', 'A_KEY_2'] },
    ],
  };

  const expectedClones = new Set(['openai-2', 'openai-3', 'anthropic-2']);

  cleanupRemovedProviders({
    cfg,
    poolState,
    pools: [],
    providerToPool: new Map(),
    expectedClones,
    cloneLifecycle,
  });

  // In 0.8.69, cleanupRemovedProviders stored `${p.provider}:clones` Set in poolState.
  // Verify poolState contains only valid pool states with failedUntil Map
  for (const [key, val] of poolState.entries()) {
    assert.equal(
      key.includes(':clones'),
      false,
      `poolState key "${key}" must not store clone metadata`,
    );
    assert.ok(val && typeof val === 'object', `poolState value for "${key}" must be an object`);
    assert.ok(
      val.failedUntil instanceof Map,
      `poolState value for "${key}" must have failedUntil Map`,
    );
  }
});
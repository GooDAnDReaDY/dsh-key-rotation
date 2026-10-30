import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/core/index.js';
import * as legacyKsm from '../lib/key-state-machine.js';
import * as legacyConc from '../lib/concurrency.js';
import * as legacyQuota from '../lib/quota.js';
import * as mainIndex from '../lib/index.js';

test('issue #530 - lib/core layer exports and facades', () => {
  // 1. Key State Machine
  assert.equal(typeof core.KeyStateMachine, 'function');
  assert.equal(typeof legacyKsm.KeyStateMachine, 'function');
  assert.deepEqual(core.KEY_STATES, legacyKsm.KEY_STATES);

  // 2. Concurrency
  assert.equal(typeof core.ConcurrencyTracker, 'function');
  assert.equal(typeof legacyConc.ConcurrencyTracker, 'function');

  // 3. Quota
  assert.equal(typeof core.QuotaStore, 'function');
  assert.equal(typeof legacyQuota.QuotaStore, 'function');

  // 4. Pool and Rotate
  assert.equal(typeof core.applyCooldown, 'function');
  assert.equal(typeof core.recordFailure, 'function');
  assert.equal(typeof core.recordSuccess, 'function');
  assert.equal(typeof core.createRotate, 'function');

  // 5. Main index exports layer facades
  assert.ok(mainIndex.core);
  assert.ok(mainIndex.transports);
  assert.equal(mainIndex.core.KeyStateMachine, core.KeyStateMachine);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyStateMachine, KEY_STATES, VALID_TRANSITIONS } from '../lib/key-state-machine.js';
import { initializePoolState } from '../lib/pool-state.js';
import { recordFailure, recordSuccess, applyCooldown } from '../lib/pool.js';

test('issue #529 - KEY_STATES and VALID_TRANSITIONS definitions', () => {
  assert.equal(KEY_STATES.ACTIVE, 'ACTIVE');
  assert.equal(KEY_STATES.COOLDOWN, 'COOLDOWN');
  assert.equal(KEY_STATES.PROBING, 'PROBING');
  assert.equal(KEY_STATES.EXHAUSTED, 'EXHAUSTED');
  assert.equal(KEY_STATES.PAUSED, 'PAUSED');
  assert.equal(KEY_STATES.REVOKED, 'REVOKED');

  assert.ok(VALID_TRANSITIONS[KEY_STATES.ACTIVE].includes(KEY_STATES.COOLDOWN));
  assert.ok(VALID_TRANSITIONS[KEY_STATES.COOLDOWN].includes(KEY_STATES.PROBING));
  assert.ok(VALID_TRANSITIONS[KEY_STATES.PROBING].includes(KEY_STATES.ACTIVE));
  assert.ok(VALID_TRANSITIONS[KEY_STATES.ACTIVE].includes(KEY_STATES.PAUSED));
  assert.ok(VALID_TRANSITIONS[KEY_STATES.ACTIVE].includes(KEY_STATES.REVOKED));
});

test('issue #529 - KeyStateMachine deterministic state transitions', () => {
  const sm = new KeyStateMachine();
  const ref = 'key-test-1';
  const now = 1000000;

  // Initial state is ACTIVE
  assert.equal(sm.getState(ref, {}, now), KEY_STATES.ACTIVE);
  assert.equal(sm.isUsable(ref, {}, now), true);

  // Transition to COOLDOWN
  sm.transitionToCooldown(ref, { cooldownMs: 5000, reason: 'RATE_LIMIT' }, now);
  assert.equal(sm.getState(ref, {}, now), KEY_STATES.COOLDOWN);
  assert.equal(sm.isUsable(ref, {}, now), false);

  // During cooldown window
  assert.equal(sm.getState(ref, {}, now + 2000), KEY_STATES.COOLDOWN);

  // After cooldown window elapses -> PROBING
  assert.equal(sm.getState(ref, {}, now + 6000), KEY_STATES.PROBING);
  assert.equal(sm.isUsable(ref, {}, now + 6000), true);

  // Successful probe -> ACTIVE
  sm.activate(ref, { reason: 'PROBE_SUCCESS' }, now + 6500);
  assert.equal(sm.getState(ref, {}, now + 6500), KEY_STATES.ACTIVE);
  assert.equal(sm.isUsable(ref, {}, now + 6500), true);

  // Pause
  sm.pause(ref, 'MANUAL_MAINTENANCE', {}, now + 7000);
  assert.equal(sm.getState(ref, {}, now + 7000), KEY_STATES.PAUSED);
  assert.equal(sm.isUsable(ref, {}, now + 7000), false);

  // Unpause
  sm.unpause(ref, {}, now + 8000);
  assert.equal(sm.getState(ref, {}, now + 8000), KEY_STATES.ACTIVE);

  // Revoke
  sm.revoke(ref, 'AUTH_INVALID', {}, now + 9000);
  assert.equal(sm.getState(ref, {}, now + 9000), KEY_STATES.REVOKED);
  assert.equal(sm.isUsable(ref, {}, now + 9000), false);
});

test('issue #529 - Transition history tracking and stats', () => {
  const sm = new KeyStateMachine({ maxHistory: 5 });
  const refA = 'key-a';
  const refB = 'key-b';
  const now = 2000000;

  sm.transitionToCooldown(refA, { cooldownMs: 1000 }, now);
  sm.activate(refA, {}, now + 2000);
  sm.pause(refB, 'USER_PAUSE', {}, now + 3000);

  const historyA = sm.getHistory(refA);
  assert.equal(historyA.length, 2);
  assert.equal(historyA[0].from, KEY_STATES.ACTIVE);
  assert.equal(historyA[0].to, KEY_STATES.COOLDOWN);
  assert.equal(historyA[1].to, KEY_STATES.ACTIVE);

  const stats = sm.getStats([refA, refB], {}, now + 3500);
  assert.equal(stats.total, 2);
  assert.equal(stats[KEY_STATES.ACTIVE], 1);
  assert.equal(stats[KEY_STATES.PAUSED], 1);
  assert.equal(stats[KEY_STATES.COOLDOWN], 0);
});

test('issue #529 - Integration with pool.js and pool-state.js', () => {
  const state = initializePoolState();
  assert.ok(state.keyStateMachine instanceof KeyStateMachine);

  const pool = {
    provider: 'openai',
    keys: ['k1', 'k2'],
    state,
  };

  const now = 3000000;

  // recordFailure updates keyStateMachine
  recordFailure(pool, 'k1', now, 1000, 5000);
  assert.equal(state.keyStateMachine.getState('k1', state, now), KEY_STATES.COOLDOWN);

  // recordSuccess updates keyStateMachine
  recordSuccess(pool, 'k1', now + 2000);
  assert.equal(state.keyStateMachine.getState('k1', state, now + 2000), KEY_STATES.ACTIVE);

  // applyCooldown updates keyStateMachine
  applyCooldown(pool, 'k2', 4000, now);
  assert.equal(state.keyStateMachine.getState('k2', state, now), KEY_STATES.COOLDOWN);
});

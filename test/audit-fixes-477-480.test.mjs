// test/audit-fixes-477-480.test.mjs
// Verification tests for audit findings #477, #478, #479, #480.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';

import { notifyEarlyWarning } from '../lib/notify-events.js';
import { createRotate } from '../lib/rotate.js';
import { markKeyDraining, isKeyDraining, clearAllDraining } from '../lib/key-drain.js';
import { setupKeyDrainEffect, setupProactiveHealthProbeEffect } from '../lib/lifecycle.js';
import { QUOTA_WINDOW_TYPES, isBlockedUntilReset } from '../lib/quota-window.js';
import { Config } from '../lib/index.js';

test('Fix #477: rotate() triggers notifyEarlyWarning during key penalization when below threshold', async () => {
  let warningPayload = null;
  const mockNotifyEarlyWarning = (runtime, pool, info) => {
    warningPayload = info;
  };

  const pool = {
    base: 'demo-provider',
    provider: 'demo-provider',
    refs: ['KEY_1', 'KEY_2', 'KEY_3', 'KEY_4'],
    state: {
      pointer: 0,
      failedUntil: new Map(),
      failCounts: new Map(),
      events: [],
    },
    cooldownMs: 60000,
    maxCooldownMs: 300000,
  };

  // Pre-fail 2 out of 4 keys so that 1 more failure drops available to 1/4 (25%)
  pool.state.failedUntil.set('KEY_1', Date.now() + 60000);
  pool.state.failedUntil.set('KEY_2', Date.now() + 60000);

  const runtime = {
    earlyWarningNotify: true,
    earlyWarningKeyThreshold: 0.25,
    notifyWebhook: 'https://webhook.example.com',
    quotaResetWindow: null,
    concurrencyLimit: 0,
    switchCodes: ['RATE_LIMIT'],
  };

  const dispatchStorage = new AsyncLocalStorage();
  const llm = {
    stream(options) {
      return (async function* () {
        const store = dispatchStorage.getStore();
        if (store) store.pickedRef = 'KEY_3';
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { code: 'RATE_LIMIT', message: 'Too many requests' },
          },
        };
      })();
    },
  };

  const rotate = createRotate({
    ctx: { get: (name) => (name === 'llm' ? llm : undefined) },
    dispatchStorage,
    buildRuntime: () => runtime,
    pushEvent: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    notifyEarlyWarning: mockNotifyEarlyWarning,
    recordLatency: () => {},
    latencyHistogram: null,
    concurrencyTracker: { isEnabled: () => false, getActive: () => 0 },
    MARKER: Symbol('marker'),
    finishError: (code, msg) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message: msg } } }),
    setRotateStartMs: () => {},
    quotaStore: null,
    circuitBreaker: null,
    now: () => Date.now(),
    logger: { warn: () => {}, debug: () => {} },
  });

  // Call rotate and drain until switch or finish
  for await (const _ of rotate({ provider: 'demo-provider', stream: true }, pool)) {
    // drain stream to trigger failure evaluation
  }

  // Early warning should have fired because only KEY_4 remains (1/4 <= 0.25)
  assert.ok(warningPayload, 'notifyEarlyWarning should have been called');
  assert.equal(warningPayload.provider, 'demo-provider');
  assert.equal(warningPayload.availableCount, 1);
  assert.equal(warningPayload.totalCount, 4);
});

test('Fix #478: setupProactiveHealthProbeEffect logs errors at debug level instead of empty catch', async () => {
  const loggedDebug = [];
  const mockLogger = {
    warn: () => {},
    debug: (msg, err) => { loggedDebug.push({ msg, err }); },
  };

  let effectDispose = null;
  let timerFn = null;
  const mockCtx = {
    effect: (fn) => {
      effectDispose = fn();
      return effectDispose;
    },
    credentials: {
      resolve: async () => { throw new Error('Simulated credential failure'); },
    },
  };

  const mockTimers = {
    setInterval: (fn) => {
      timerFn = fn;
      return { unref: () => {} };
    },
    clearInterval: () => {},
  };

  const pool = {
    base: 'test-p',
    refs: ['KEY_BROKEN'],
    state: {
      brokenUntil: new Map([['KEY_BROKEN', Date.now() + 100000]]),
      failedUntil: new Map(),
    },
  };

  setupProactiveHealthProbeEffect(
    mockCtx,
    () => ({ proactiveHealthProbing: true, proactiveProbeIntervalMs: 5000 }),
    () => ({ pools: [pool] }),
    () => ({ probeModels: async () => ({ ok: false }) }),
    mockLogger,
    mockTimers
  );

  assert.ok(timerFn, 'Timer function should be scheduled');
  await timerFn();

  // Check that debug log was emitted and not swallowed silently
  assert.ok(loggedDebug.length > 0, 'Debug log should be recorded for failed probe/credential');
  assert.ok(loggedDebug[0].msg.includes('KEY_BROKEN'));
});

test('Fix #479: setupKeyDrainEffect clears draining keys on plugin teardown', () => {
  markKeyDraining('KEY_OLD', 'provider_x');
  assert.equal(isKeyDraining('KEY_OLD'), true);

  let effectCleanup = null;
  const mockCtx = {
    effect: (fn) => {
      effectCleanup = fn();
      return effectCleanup;
    },
  };

  setupKeyDrainEffect(mockCtx);
  assert.ok(typeof effectCleanup === 'function', 'setupKeyDrainEffect must return cleanup callback');

  // Trigger teardown
  effectCleanup();
  assert.equal(isKeyDraining('KEY_OLD'), false, 'draining keys must be cleared after effect disposal');
});

test('Fix #480: QUOTA_WINDOW_TYPES is exported array and used in schema', () => {
  assert.ok(Array.isArray(QUOTA_WINDOW_TYPES));
  assert.ok(QUOTA_WINDOW_TYPES.includes('midnight_utc'));
  assert.ok(QUOTA_WINDOW_TYPES.includes('midnight_pst'));
  assert.ok(QUOTA_WINDOW_TYPES.includes('rolling_24h'));

  // Test isBlockedUntilReset helper logic
  const now = 1000;
  assert.equal(isBlockedUntilReset(2000, 1500, now), true);
  assert.equal(isBlockedUntilReset(1000, 1500, now), false);
  assert.equal(isBlockedUntilReset(NaN, 1500, now), false);
  assert.equal(isBlockedUntilReset(2000, null, now), false);
});

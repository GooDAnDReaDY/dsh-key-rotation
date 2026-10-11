import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionTrace, getSelectionTraces, clearSelectionTraces, redactSecret } from '../lib/selection-trace.js';
import { createRotate } from '../lib/rotate.js';

test('Issue #461: Selection Trace unit tests', async (t) => {
  await t.test('redactSecret masks raw API tokens and passes safe refs', () => {
    assert.equal(redactSecret('MY_API_KEY_ENV'), 'MY_API_KEY_ENV');
    assert.equal(redactSecret('sk-1234567890abcdef1234567890'), '...67890');
    assert.equal(redactSecret('key-abcdef1234567890'), '...67890');
    assert.equal(redactSecret(123), 123);
  });

  await t.test('createSelectionTrace records events and bounds buffer', () => {
    clearSelectionTraces();
    const trace = createSelectionTrace('req-test-1', { provider: 'deepseek', model: 'chat' });
    trace.addStep('KEY_1', 'SKIPPED', 'COOLDOWN', 'In cooldown until 1000');
    trace.addStep('KEY_2', 'DISPATCHED', 'ATTEMPT', 'Attempt 1');
    trace.addStep('KEY_2', 'FAILED', 'RATE_LIMIT', '429 Rate limit exceeded');
    trace.addStep('KEY_3', 'DISPATCHED', 'ATTEMPT', 'Attempt 2');
    const summary = trace.finish('SUCCESS', 'KEY_3');

    assert.equal(summary.requestId, 'req-test-1');
    assert.equal(summary.provider, 'deepseek');
    assert.equal(summary.selectedRef, 'KEY_3');
    assert.equal(summary.steps.length, 4);
    assert.equal(summary.steps[0].decision, 'SKIPPED');
    assert.equal(summary.steps[0].reasonCode, 'COOLDOWN');

    const traces = getSelectionTraces();
    assert.ok(traces.length >= 1);
    assert.equal(traces[traces.length - 1].requestId, 'req-test-1');
    clearSelectionTraces();
    assert.equal(getSelectionTraces().length, 0);
  });
});

test('Issue #461: Rotate records selection traces during execution', async (t) => {
  clearSelectionTraces();
  const pool = {
    refs: ['key-alpha', 'key-beta'],
    state: {
      failedUntil: new Map(),
      failCounts: new Map(),
      switches: 0,
      lastUsed: 'key-alpha',
    },
  };
  const ctx = {
    get(svc) {
      if (svc === 'llm') {
        return {
          stream: async function* () {
            yield { type: 'text-delta', text: 'Hello' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          }
        };
      }
      return null;
    },
  };
  const dispatchStorage = { run(store, fn) { return fn(); } };
  const rotate = createRotate({
    ctx,
    dispatchStorage,
    buildRuntime: () => ({ switchCodes: ['RATE_LIMIT'], providerToPool: { mock: pool } }),
    pushEvent: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    recordLatency: () => {},
    latencyHistogram: { record: () => {} },
    concurrencyTracker: { isEnabled: () => false },
    MARKER: '__dshKeyRotation',
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    setRotateStartMs: () => {},
    now: () => Date.now(),
  });

  const stream = rotate({ provider: 'mock', requestId: 'req-461-audit' }, pool);
  for await (const chunk of stream) {}

  const traces = getSelectionTraces();
  assert.ok(traces.length >= 1, 'Trace must be saved in buffer');
  const last = traces[traces.length - 1];
  assert.equal(last.requestId, 'req-461-audit');
  assert.equal(last.outcome, 'SUCCESS');
  assert.ok(last.steps.some((s) => s.decision === 'DISPATCHED'));
});

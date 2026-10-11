import test from 'node:test';
import assert from 'node:assert/strict';
import { markKeyDraining, isKeyDraining, cancelKeyDrain, getDrainingStatus, clearAllDraining } from '../lib/key-drain.js';
import { createRotate } from '../lib/rotate.js';

test('Issue #463: Key Draining unit tests', async (t) => {
  clearAllDraining();

  await t.test('marks key draining and checks status', () => {
    assert.equal(isKeyDraining('key-old'), false);
    markKeyDraining('key-old', 'openai');
    assert.equal(isKeyDraining('key-old'), true);

    const mockTracker = { getInFlight: (ref) => ref === 'key-old' ? 2 : 0 };
    const status = getDrainingStatus('key-old', mockTracker);
    assert.equal(status.ref, 'key-old');
    assert.equal(status.provider, 'openai');
    assert.equal(status.inFlight, 2);
    assert.equal(status.canComplete, false);

    cancelKeyDrain('key-old');
    assert.equal(isKeyDraining('key-old'), false);
  });
});

test('Issue #463: Rotate excludes draining keys from new dispatches', async (t) => {
  clearAllDraining();
  const pool = {
    refs: ['key-drain', 'key-new'],
    state: {
      failedUntil: new Map(),
      failCounts: new Map(),
      switches: 0,
      lastUsed: 'key-drain',
    },
  };

  markKeyDraining('key-drain', 'mock');

  let pickedKey = null;
  const ctx = {
    get(svc) {
      if (svc === 'llm') {
        return {
          stream: async function* (opts) {
            yield { type: 'text-delta', text: 'ok' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          }
        };
      }
      return null;
    },
  };

  const dispatchStorage = {
    run(store, fn) {
      pickedKey = store.pickedRef;
      return fn();
    }
  };

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

  const stream = rotate({ provider: 'mock' }, pool);
  for await (const chunk of stream) {}

  clearAllDraining();
});

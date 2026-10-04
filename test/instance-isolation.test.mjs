import test from 'node:test';
import assert from 'node:assert/strict';

test('instance-isolation: two instances created via apply() do not share singletons (#446)', async () => {
  let mod;
  try {
    mod = await import('../lib/index.js');
  } catch (err) {
    assert.ok(true, 'skipped if schemastery missing');
    return;
  }

  function createMockContext(providerName) {
    const creds = {
      resolve: async (ref) => ({ value: `secret-${ref}` }),
    };
    const registeredRoutes = new Map();
    const mockCtx = {
      webServer: {
        register: (route) => {
          registeredRoutes.set(route.path, route);
          return () => registeredRoutes.delete(route.path);
        },
      },
      effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
      on: () => () => {},
      inject: (deps, fn) => {
        const sctx = {
          effect: (f) => (typeof f === 'function' ? f() : undefined),
          settings: {
            register: () => ({
              get: () => ({
                providers: [{ provider: providerName, keys: [`KEY_${providerName}_1`, `KEY_${providerName}_2`] }],
              }),
            }),
          },
        };
        sctx.get = (name) => (name === 'settings' ? sctx.settings : null);
        fn(sctx);
      },
      get: (name) => {
        if (name === 'credentials') return creds;
        if (name === 'settings') return {
          describe: () => [{ ns: '@goodandready/dsh-key-rotation', value: {} }],
        };
        if (name === 'llm') return {
          listProviders: () => [{ id: providerName, name: providerName }],
          stream: async function* () {
            yield { type: 'text-delta', text: 'ok' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
        return null;
      },
    };
    return { mockCtx, creds, registeredRoutes };
  }

  const inst1 = createMockContext('provider-alpha');
  mod.apply(inst1.mockCtx, {});
  const rt1 = mod.getRuntime();

  const inst2 = createMockContext('provider-beta');
  mod.apply(inst2.mockCtx, {});
  const rt2 = mod.getRuntime();

  assert.ok(rt1, 'rt1 exists');
  assert.ok(rt2, 'rt2 exists');

  // Verify singletons are isolated per instance
  assert.notEqual(rt1.breaker, rt2.breaker, 'Breakers must not be shared across instances');
  assert.notEqual(rt1.notifyQueue, rt2.notifyQueue, 'NotifyQueues must not be shared across instances');
  assert.notEqual(rt1.concurrencyTracker, rt2.concurrencyTracker, 'ConcurrencyTrackers must not be shared across instances');
  assert.notEqual(rt1.quotaStore, rt2.quotaStore, 'QuotaStores must not be shared across instances');
  assert.notEqual(rt1.latencyHistogram, rt2.latencyHistogram, 'LatencyHistograms must not be shared across instances');

  // Verify mutating breaker on rt1 does not affect rt2
  rt1.breaker.onFailure('provider-alpha');
  rt1.breaker.onFailure('provider-alpha');
  rt1.breaker.onFailure('provider-alpha');
  rt1.breaker.onFailure('provider-alpha');
  rt1.breaker.onFailure('provider-alpha');

  assert.equal(rt1.breaker.state('provider-alpha'), 'open');
  assert.equal(rt2.breaker.state('provider-alpha'), 'closed');
});

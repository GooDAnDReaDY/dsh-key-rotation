// test/dsh-llm-021-alpha2.test.mjs — Verify @deepseek-ai/dsh-llm 0.2.1-alpha.2 compatibility (#484)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import semver from 'semver';

test('Issue #484: peerDependencies compatibility check with DSH evaluatePluginCompatibility rules', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const peerRange = pkg.peerDependencies['@deepseek-ai/dsh-llm'];
  assert.ok(peerRange, 'Must declare @deepseek-ai/dsh-llm peerDependency');

  // Mirrors @deepseek-ai/dsh-app-boot evaluatePluginCompatibility
  function evaluateCompatibility(range, runtimeVersion) {
    return semver.satisfies(runtimeVersion, range, { includePrerelease: true });
  }

  // 1. Current range admits 0.2.1-alpha.2
  assert.ok(
    evaluateCompatibility(peerRange, '0.2.1-alpha.2'),
    'Current peerDependency range must admit DSH / dsh-llm 0.2.1-alpha.2'
  );

  // 2. Also compatible with standard package manager install (without includePrerelease)
  assert.ok(
    semver.satisfies('0.2.1-alpha.2', peerRange),
    'Package managers must resolve 0.2.1-alpha.2 within peer range'
  );

  // 3. Regression proof: old range strictly rejected 0.2.1-alpha.2
  const oldRange = '^0.1.7-rc.2 || >=0.2.0-rc.1 <0.2.1-0';
  assert.ok(
    !evaluateCompatibility(oldRange, '0.2.1-alpha.2'),
    'Old range must have failed on 0.2.1-alpha.2 (causing core to skip plugin)'
  );

  // 4. Backward compatibility preserved for 0.2.0 and 0.1.7 lines
  assert.ok(evaluateCompatibility(peerRange, '0.2.0-rc.2'), 'Must preserve 0.2.0-rc.2');
  assert.ok(evaluateCompatibility(peerRange, '0.2.0'), 'Must preserve 0.2.0');
  assert.ok(evaluateCompatibility(peerRange, '0.1.7-rc.2'), 'Must preserve 0.1.7-rc.2');

  // 5. Admits 0.2.2 line (including alpha/rc) and guards against untested 0.2.3 line (#567)
  assert.ok(evaluateCompatibility(peerRange, '0.2.2-alpha.1'), 'Must admit 0.2.2-alpha.1');
  assert.ok(evaluateCompatibility(peerRange, '0.2.2-alpha.2'), 'Must admit 0.2.2-alpha.2');
  assert.ok(!evaluateCompatibility(peerRange, '0.2.3-alpha.1'), 'Must not admit 0.2.3 line prereleases');
});

test('Issue #484: Launch, key rotation, and pool status on dsh-llm 0.2.1-alpha.2 runtime', async () => {
  const plugin = await import('../lib/index.js?test=dsh-llm-021-alpha2-final3');

  const registeredRoutes = new Map();
  const eventListeners = new Map();
  const credentialsStore = new Map([
    ['SK_ALPHA', { value: 'sk-deepseek-alpha-secret' }],
    ['SK_BETA', { value: 'sk-deepseek-beta-secret' }],
  ]);

  let streamDispatchCount = 0;
  const dispatchedKeys = [];

  // Mock settings for dsh-key-rotation
  const settingsSection = {
    persistenceEnabled: false,
    cooldownMs: 2000,
    switchCodes: ['RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT'],
    providers: [
      {
        provider: 'deepseek',
        keys: ['SK_ALPHA', 'SK_BETA'],
      },
    ],
  };

  let mockCtx;

  // 0.2.1-alpha.2 style llm service and waterfall hook
  const llmService = {
    stream(options) {
      streamDispatchCount++;
      const pool = plugin.getRuntime()?.providerToPool?.get('deepseek');
      const activeRef = streamDispatchCount === 1 ? 'SK_ALPHA' : 'SK_BETA';
      if (pool) pool.state.lastUsed = activeRef;
      dispatchedKeys.push(activeRef);

      return (async function* () {
        if (streamDispatchCount === 1) {
          // First key receives 429 Rate Limit error chunk
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { code: 'RATE_LIMIT', message: 'Rate limit exceeded on SK_ALPHA', status: 429 },
            },
          };
        } else {
          // Failover key receives valid response
          yield { type: 'text-delta', text: 'Success on failover key SK_BETA' };
          yield { type: 'finish', reason: { kind: 'stop' }, usage: { totalTokens: 42 } };
        }
      })();
    },
  };

  mockCtx = {
    webServer: {
      register(route) {
        registeredRoutes.set(route.path, route);
        return () => registeredRoutes.delete(route.path);
      },
    },
    effect(fn) {
      return fn();
    },
    on(event, handler) {
      eventListeners.set(event, handler);
      return () => eventListeners.delete(event);
    },
    get(serviceName) {
      if (serviceName === 'credentials') {
        return {
          resolve: async (ref) => credentialsStore.get(ref) || null,
          describe: async () => ({ source: 'file' }),
        };
      }
      if (serviceName === 'settings') {
        return {
          describe: () => [{ ns: 'dsh-key-rotation', value: settingsSection, revision: 1 }],
          get: () => settingsSection,
        };
      }
      if (serviceName === 'llm') {
        return llmService;
      }
      return null;
    },
  };

  // Mount plugin
  plugin.apply(mockCtx, settingsSection);

  // 1. Verify plugin launched and registered expected services & routes
  const runtime = plugin.getRuntime();
  assert.ok(runtime, 'Runtime must be initialized');
  assert.ok(registeredRoutes.has('/dsh-key-rotation/status'), 'Must register /status route');
  assert.ok(registeredRoutes.has('/dsh-key-rotation/config'), 'Must register /config route');
  assert.ok(eventListeners.has('llm/stream'), 'Must register llm/stream interceptor');

  const pool = runtime.providerToPool.get('deepseek');
  assert.ok(pool, 'DeepSeek pool must be created');
  assert.deepEqual(pool.refs, ['SK_ALPHA', 'SK_BETA'], 'Pool must contain both keys');
  assert.equal(pool.state.switches ?? 0, 0, 'Initial switches count must be 0');

  // 2. Execute request through llm/stream hook (0.2.1-alpha.2 waterfall pattern)
  const streamHook = eventListeners.get('llm/stream');
  const requestOptions = { provider: 'deepseek', model: 'deepseek-chat' };

  const collectedChunks = [];
  const generator = streamHook(requestOptions, () => {
    throw new Error('Fallback next() should not be called when pool is healthy');
  });

  for await (const chunk of generator) {
    collectedChunks.push(chunk);
  }

  // Verify stream outcome
  const textChunks = collectedChunks.filter((c) => c.type === 'text-delta');
  assert.equal(textChunks.length, 1, 'Must receive text-delta from failover key');
  assert.equal(textChunks[0].text, 'Success on failover key SK_BETA');

  const finishChunk = collectedChunks.find((c) => c.type === 'finish');
  assert.ok(finishChunk, 'Must receive finish chunk');
  assert.equal(finishChunk.reason.kind, 'stop', 'Final chunk must be stop (not error)');

  // 3. Verify key rotation happened: SK_ALPHA failed -> failover to SK_BETA
  assert.equal(pool.state.switches, 1, 'Switches count must increment to 1');
  const alphaFailedUntil = pool.state.failedUntil.get('SK_ALPHA') ?? 0;
  assert.ok(alphaFailedUntil > Date.now() - 100, 'SK_ALPHA must be in cooldown');
  assert.equal(pool.state.failCounts.get('SK_ALPHA'), 1, 'SK_ALPHA failCount must be 1');

  // 4. Verify pool status via /dsh-key-rotation/status route
  const statusRoute = registeredRoutes.get('/dsh-key-rotation/status');
  assert.ok(statusRoute, 'Status route must be registered');

  let responseBody = null;
  let responseStatus = 0;
  const mockReq = {
    method: 'GET',
    url: '/dsh-key-rotation/status',
    headers: { host: '127.0.0.1:8765' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const mockRes = {
    writeHead(code, headers) {
      responseStatus = code;
    },
    end(data) {
      responseBody = JSON.parse(data);
    },
  };

  await statusRoute.handler(mockReq, mockRes);

  assert.equal(responseStatus, 200, 'Status route must return 200 OK');
  assert.ok(responseBody, 'Status response body must be present');
  assert.ok(responseBody.providers, 'Status response must contain providers');

  const deepseekProvider = responseBody.providers.find((p) => p.provider === 'deepseek');
  assert.ok(deepseekProvider, 'DeepSeek provider status must be in response');
  assert.equal(deepseekProvider.switches, 1, 'Provider status switches must be 1');
  assert.equal(deepseekProvider.keys.length, 2, 'Total keys must be 2');

  const alphaKey = deepseekProvider.keys.find((k) => k.ref === 'SK_ALPHA');
  assert.ok(alphaKey, 'SK_ALPHA status must be reported');
  assert.ok(alphaKey.cooldownMsLeft > 0, 'SK_ALPHA must have cooldownMsLeft > 0');

  const betaKey = deepseekProvider.keys.find((k) => k.ref === 'SK_BETA');
  assert.ok(betaKey, 'SK_BETA status must be reported');
  assert.equal(betaKey.cooldownMsLeft, 0, 'SK_BETA must not be in cooldown');
});
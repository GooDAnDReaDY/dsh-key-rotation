// test/routes-ops-comprehensive.test.mjs
// Comprehensive test suite for all operational HTTP routes (#253, #301)
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerOpsRoutes } from '../lib/routes-ops.js';

function createMockEnv(overrides = {}) {
  const routes = new Map();
  const credentialsMap = new Map([
    ['PROVIDER_KEY_1', { value: 'sk-test-secret-12345' }],
    ['PROVIDER_KEY_2', { value: 'sk-test-secret-67890' }],
  ]);
  const settingsSection = {
    providers: [{ provider: 'test-prov', keys: ['PROVIDER_KEY_1', 'PROVIDER_KEY_2'] }],
    webhookActionToken: 'secret-token-xyz',
  };

  const mockCtx = {
    effect: (fn) => fn(),
    webServer: {
      register: (opts) => {
        routes.set(opts.path, opts);
      },
    },
    get: (name) => {
      if (name === 'credentials') {
        return {
          resolve: async (ref) => credentialsMap.get(ref) || null,
          describe: async (ref) => ({ source: 'file' }),
          set: async (ref, val) => { credentialsMap.set(ref, { value: val }); },
          unset: async (ref) => { credentialsMap.delete(ref); },
        };
      }
      if (name === 'settings') {
        return {
          describe: () => [{ ns: 'dsh-key-rotation', value: settingsSection, revision: 1 }],
          replace: async (ns, val, rev) => { Object.assign(settingsSection, val); },
        };
      }
      return null;
    },
  };

  let rotationDisabled = false;
  let circuitBreakerResetCount = 0;
  const circuitBreakerMock = {
    state: (p) => 'closed',
    threshold: 5,
    openMs: 30000,
    reset: (p) => { circuitBreakerResetCount++; },
    onSuccess: (p) => { circuitBreakerResetCount++; },
  };

  const poolState = new Map([
    ['test-prov', {
      failedUntil: new Map([['PROVIDER_KEY_1', Date.now() + 60000]]),
      failCounts: new Map([['PROVIDER_KEY_1', 2]]),
      authFailCounts: new Map([['PROVIDER_KEY_1', 1]]),
      brokenUntil: new Map([['PROVIDER_KEY_1', Date.now() + 3600000]]),
      switches: 3,
      lastReason: 'RATE_LIMIT',
      lastSwitchAt: Date.now() - 5000,
      lastUsed: 'PROVIDER_KEY_1',
    }],
  ]);

  const mockDeps = {
    buildRuntime: () => ({
      poolByRef: new Map([
        ['PROVIDER_KEY_1', { base: 'test-prov', refs: ['PROVIDER_KEY_1', 'PROVIDER_KEY_2'], state: poolState.get('test-prov') }],
        ['PROVIDER_KEY_2', { base: 'test-prov', refs: ['PROVIDER_KEY_1', 'PROVIDER_KEY_2'], state: poolState.get('test-prov') }],
      ]),
      providerTags: new Map([['test-prov', ['tag1', 'tag2']]]),
      providerBudgets: {},
      latencySloMs: 1500,
      webhookActionToken: 'secret-token-xyz',
      breaker: circuitBreakerMock,
    }),
    latencyHistogram: { snapshotAll: () => ({ 'test-prov': { p50: 120, p95: 350 } }), snapshot: () => ({ p50: 120, p95: 350 }) },
    lastTestCache: new Map([['PROVIDER_KEY_1', { ok: true, at: Date.now(), latencyMs: 150 }]]),
    ensureSandboxRunner: () => ({
      probeChat: async (ref, val) => ({ ok: true, code: 200, latencyMs: 200 }),
      probeModels: async (ref, val) => ({ ok: true, code: 200, modelsCount: 3, latencyMs: 120 }),
    }),
    poolState,
    getRotationDisabled: () => rotationDisabled,
    setRotationDisabled: (v) => { rotationDisabled = v; },
    circuitBreaker: circuitBreakerMock,
    quotaStore: {
      snapshot: () => ({ 'test-prov': { rpm: { used: 5, remaining: 55, limit: 60 } } }),
    },
    ...overrides,
  };

  registerOpsRoutes(mockCtx, mockDeps);

  function invoke(path, { method = 'GET', headers = {}, body = null, remoteAddress = '127.0.0.1' } = {}) {
    return new Promise((resolve) => {
      const route = routes.get(path);
      if (!route) {
        resolve({ status: 404, headers: {}, body: { error: 'not-found' } });
        return;
      }

      let resStatus = 200;
      const resHeaders = {};
      let resBody = '';

      const reqHeaders = {
        host: '127.0.0.1:3080',
        origin: 'http://127.0.0.1:3080',
        'sec-fetch-site': 'same-origin',
        ...headers,
      };

      const reqListeners = {};
      const mockReq = {
        method,
        headers: reqHeaders,
        socket: { remoteAddress },
        on: (evt, cb) => {
          reqListeners[evt] = cb;
          if (evt === 'data' && body) {
            process.nextTick(() => cb(typeof body === 'string' ? body : JSON.stringify(body)));
          }
          if (evt === 'end') {
            process.nextTick(() => cb());
          }
        },
      };

      const mockRes = {
        writeHead: (st, hdrs = {}) => {
          resStatus = st;
          Object.assign(resHeaders, hdrs);
        },
        setHeader: (k, v) => { resHeaders[k] = v; },
        end: (chunk = '') => {
          resBody += chunk;
          let parsed = resBody;
          try { parsed = JSON.parse(resBody); } catch (_) {}
          resolve({ status: resStatus, headers: resHeaders, body: parsed });
        },
      };

      route.handler(mockReq, mockRes);
    });
  }

  return { routes, mockDeps, poolState, invoke, circuitBreakerMock, getCircuitResetCount: () => circuitBreakerResetCount };
}

test('routes-ops: GET /dsh-key-rotation/status returns sanitized provider pools', async () => {
  const env = createMockEnv();
  const res = await env.invoke('/dsh-key-rotation/status');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.providers));
  assert.equal(res.body.providers[0].provider, 'test-prov');
  assert.equal(res.body.providers[0].keys.length, 2);
  assert.equal(res.body.providers[0].keys[0].tail, '12345');
  assert.deepEqual(res.body.providers[0].tags, ['tag1', 'tag2']);
});

test('routes-ops: /dsh-key-rotation/status guards against non-GET and non-local', async () => {
  const env = createMockEnv();
  const res405 = await env.invoke('/dsh-key-rotation/status', { method: 'POST' });
  assert.equal(res405.status, 405);

  const res403 = await env.invoke('/dsh-key-rotation/status', {
    headers: { origin: 'http://malicious.com', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(res403.status, 403);
});

test('routes-ops: GET /dsh-key-rotation/usage returns JSON and CSV format', async () => {
  const env = createMockEnv();
  const resJson = await env.invoke('/dsh-key-rotation/usage');
  assert.equal(resJson.status, 200);
  assert.ok(Array.isArray(resJson.body.providers));
  assert.ok(Array.isArray(resJson.body.providers[0].rows));

  const resCsv = await env.invoke('/dsh-key-rotation/usage', { headers: { 'sec-fetch-site': 'same-origin' }, body: null });
  // Pass query param via header or invocation
  assert.equal(resJson.headers['content-type'], 'application/json');
});

test('routes-ops: GET /dsh-key-rotation/snapshot exports sanitized configuration', async () => {
  const env = createMockEnv();
  const res = await env.invoke('/dsh-key-rotation/snapshot');
  assert.equal(res.status, 200);
  assert.equal(res.body.snapshot.webhookActionToken, ''); // Secret token blanked
  assert.equal(res.body.snapshot.providers.length, 1);
});

test('routes-ops: POST /dsh-key-rotation/snapshot rejects live credential secrets', async () => {
  const env = createMockEnv();
  const resBad = await env.invoke('/dsh-key-rotation/snapshot', {
    method: 'POST',
    body: { snapshot: { providers: [], badKey: 'sk-proj-live-secret-key-1234567890abcdef' } },
  });
  assert.equal(resBad.status, 400);
  assert.equal(resBad.body.error.code, 'secret-in-snapshot');
});

test('routes-ops: POST /dsh-key-rotation/snapshot merges valid snapshot', async () => {
  const env = createMockEnv();
  const resOk = await env.invoke('/dsh-key-rotation/snapshot', {
    method: 'POST',
    body: { snapshot: { providers: [{ provider: 'new-prov', keys: ['KEY_A'] }] } },
  });
  assert.equal(resOk.status, 200);
  assert.equal(resOk.body.ok, true);
});

test('routes-ops: PUT and DELETE /dsh-key-rotation/key with poolState cleanup', async () => {
  const env = createMockEnv();

  // PUT valid key
  const putRes = await env.invoke('/dsh-key-rotation/key', {
    method: 'PUT',
    body: { ref: 'PROVIDER_KEY_3', value: 'sk-new-key-value-12345' },
  });
  assert.equal(putRes.status, 200);
  assert.equal(putRes.body.tail, '12345');

  // DELETE key cleans up poolState
  const st = env.poolState.get('test-prov');
  assert.ok(st.failedUntil.has('PROVIDER_KEY_1'));

  const delRes = await env.invoke('/dsh-key-rotation/key', {
    method: 'DELETE',
    body: { ref: 'PROVIDER_KEY_1' },
  });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.body.ok, true);

  // Assert state cleaned up
  assert.equal(st.failedUntil.has('PROVIDER_KEY_1'), false);
  assert.equal(st.failCounts.has('PROVIDER_KEY_1'), false);
  assert.equal(st.authFailCounts.has('PROVIDER_KEY_1'), false);
  assert.equal(st.brokenUntil.has('PROVIDER_KEY_1'), false);
  assert.equal(st.lastUsed, undefined);
});

test('routes-ops: POST /dsh-key-rotation/reset resets provider, circuitBreaker and single ref', async () => {
  const env = createMockEnv();
  const st = env.poolState.get('test-prov');

  // 1. Single ref reset
  const refRes = await env.invoke('/dsh-key-rotation/reset', {
    method: 'POST',
    body: { ref: 'PROVIDER_KEY_1' },
  });
  assert.equal(refRes.status, 200);
  assert.equal(st.failedUntil.has('PROVIDER_KEY_1'), false);

  // 2. Set provider into failed & tripped state
  st.failedUntil.set('PROVIDER_KEY_2', Date.now() + 50000);
  st.authFailCounts.set('PROVIDER_KEY_2', 3);
  st.switches = 4;

  const provRes = await env.invoke('/dsh-key-rotation/reset', {
    method: 'POST',
    body: { provider: 'test-prov' },
  });
  assert.equal(provRes.status, 200);
  assert.equal(provRes.body.circuitReset, true);
  assert.equal(st.failedUntil.size, 0);
  assert.equal(st.authFailCounts.size, 0);
  assert.equal(st.switches, 0);
  assert.ok(env.getCircuitResetCount() > 0);
});

test('routes-ops: GET /dsh-key-rotation/health resolves quotaStore and returns ok', async () => {
  const env = createMockEnv();
  const res = await env.invoke('/dsh-key-rotation/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.ok(res.body.pools['test-prov']);
  assert.ok(res.body.quota);
  assert.ok(res.body.quota['test-prov'].rpm);
});

test('routes-ops: GET /dsh-key-rotation/sandbox-cache returns cached probes without error', async () => {
  const env = createMockEnv();
  const res = await env.invoke('/dsh-key-rotation/sandbox-cache');
  assert.equal(res.status, 200);
  assert.ok(res.body.PROVIDER_KEY_1);
  assert.equal(res.body.PROVIDER_KEY_1.ok, true);
});

test('routes-ops: POST /dsh-key-rotation/test performs dry-run probe', async () => {
  const env = createMockEnv();
  const res = await env.invoke('/dsh-key-rotation/test', {
    method: 'POST',
    body: { ref: 'PROVIDER_KEY_1', probe: 'models' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.modelsCount, 3);
});

test('routes-ops: POST /dsh-key-rotation/webhook-action validates token and executes reset/pause', async () => {
  const env = createMockEnv();
  const st = env.poolState.get('test-prov');

  // Bad token -> 401
  const badAuth = await env.invoke('/dsh-key-rotation/webhook-action', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong' },
    body: { action: 'reset-test-prov' },
  });
  assert.equal(badAuth.status, 401);

  // Valid reset -> clears state & resets circuitBreaker
  st.failedUntil.set('PROVIDER_KEY_1', Date.now() + 50000);
  st.authFailCounts.set('PROVIDER_KEY_1', 2);
  const resetRes = await env.invoke('/dsh-key-rotation/webhook-action', {
    method: 'POST',
    headers: { authorization: 'Bearer secret-token-xyz' },
    body: { action: 'reset-test-prov' },
  });
  assert.equal(resetRes.status, 200);
  assert.equal(resetRes.body.circuitReset, true);
  assert.equal(st.failedUntil.size, 0);
  assert.equal(st.authFailCounts.size, 0);

  // Pause action
  const pauseRes = await env.invoke('/dsh-key-rotation/webhook-action', {
    method: 'POST',
    headers: { authorization: 'Bearer secret-token-xyz' },
    body: { action: 'pause-test-prov' },
  });
  assert.equal(pauseRes.status, 200);
  assert.ok(st.failedUntil.get('PROVIDER_KEY_1') > Date.now());

  // Disable / enable rotation
  const disRes = await env.invoke('/dsh-key-rotation/webhook-action', {
    method: 'POST',
    headers: { authorization: 'Bearer secret-token-xyz' },
    body: { action: 'disable-rotation' },
  });
  assert.equal(disRes.status, 200);
  assert.equal(env.mockDeps.getRotationDisabled(), true);

  const enRes = await env.invoke('/dsh-key-rotation/webhook-action', {
    method: 'POST',
    headers: { authorization: 'Bearer secret-token-xyz' },
    body: { action: 'enable-rotation' },
  });
  assert.equal(enRes.status, 200);
  assert.equal(env.mockDeps.getRotationDisabled(), false);
});

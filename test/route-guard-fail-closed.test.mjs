// test/route-guard-fail-closed.test.mjs
// Test fail-closed origin and source contract for every guarded route (#353)
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleConfigBridge } from '../lib/http-bridge.js';
import { registerOpsRoutes } from '../lib/routes-ops.js';

function setupEnvironment() {
  const routes = new Map();
  const credentialsMap = new Map([['TEST_KEY', { value: 'sk-test-12345' }]]);
  const settingsSection = {
    providers: [{ provider: 'test', keys: ['TEST_KEY'] }],
    cooldownMs: 60000,
  };

  const mockCtx = {
    effect: (fn) => fn(),
    webServer: {
      register: (opts) => { routes.set(opts.path, opts); },
    },
    get: (name) => {
      if (name === 'credentials') {
        return {
          resolve: async (ref) => credentialsMap.get(ref) || null,
          describe: async () => ({ source: 'file' }),
          set: async (ref, val) => { credentialsMap.set(ref, { value: val }); },
        };
      }
      if (name === 'settings') {
        return {
          describe: () => [{ ns: 'dsh-key-rotation', value: settingsSection, revision: 1 }],
          replace: async () => {},
          mutate: async () => {},
        };
      }
      return null;
    },
  };

  const mockDeps = {
    buildRuntime: () => ({
      poolByRef: new Map(),
      providerTags: new Map(),
      providerBudgets: {},
      latencySloMs: 1500,
    }),
    poolState: new Map(),
    latencyHistogram: { snapshotAll: () => ({}), snapshot: () => ({}) },
    lastTestCache: new Map(),
    ensureSandboxRunner: () => ({
      probeChat: async () => ({ ok: true, code: 200 }),
      probeModels: async () => ({ ok: true, code: 200 }),
    }),
    circuitBreaker: { reset: () => {}, state: () => 'closed' },
    getRotationDisabled: () => false,
    setRotationDisabled: () => {},
    quotaStore: { snapshot: () => ({}) },
  };

  registerOpsRoutes(mockCtx, mockDeps);
  routes.set('/dsh-key-rotation/config', {
    path: '/dsh-key-rotation/config',
    handler: (req, res) => handleConfigBridge(mockCtx, req, res, () => new Set()),
  });

  return { routes, mockCtx };
}

function invoke(routeHandler, { method = 'GET', headers = {}, remoteAddress = '127.0.0.1', body = null } = {}) {
  return new Promise((resolve) => {
    let resStatus = 200;
    let resBody = '';

    const reqListeners = {};
    const req = {
      method,
      headers: { ...headers },
      socket: { remoteAddress },
      on: (evt, cb) => {
        reqListeners[evt] = cb;
        if (evt === 'data' && body) process.nextTick(() => cb(typeof body === 'string' ? body : JSON.stringify(body)));
        if (evt === 'end') process.nextTick(() => cb());
      },
    };

    const res = {
      writeHead: (code) => { resStatus = code; },
      end: (data = '') => {
        resBody += data;
        let parsed = null;
        try { parsed = JSON.parse(resBody); } catch { parsed = resBody; }
        resolve({ status: resStatus, body: parsed });
      },
      setHeader: () => {},
    };

    routeHandler(req, res);
  });
}

const guardedRoutes = [
  { path: '/dsh-key-rotation/status', method: 'GET' },
  { path: '/dsh-key-rotation/health', method: 'GET' },
  { path: '/dsh-key-rotation/usage', method: 'GET' },
  { path: '/dsh-key-rotation/snapshot', method: 'GET' },
  { path: '/dsh-key-rotation/sandbox-cache', method: 'GET' },
  { path: '/dsh-key-rotation/key', method: 'PUT', body: { ref: 'TEST_KEY', value: 'sk-new' } },
  { path: '/dsh-key-rotation/reset', method: 'POST', body: { ref: 'TEST_KEY' } },
  { path: '/dsh-key-rotation/test', method: 'POST', body: { ref: 'TEST_KEY' } },
  { path: '/dsh-key-rotation/config', method: 'GET' },
  { path: '/dsh-key-rotation/config', method: 'PUT', body: { ops: [{ op: 'set', path: ['cooldownMs'], value: 90000 }], expectedRevision: 1 } },
  { path: '/dsh-key-rotation/config', method: 'DELETE' },
];

test('fail-closed guard (#353): every guarded route rejects requests missing Origin header', async () => {
  const { routes } = setupEnvironment();
  for (const { path, method, body } of guardedRoutes) {
    const route = routes.get(path);
    assert.ok(route, `route ${path} must be registered`);

    const res = await invoke(route.handler, {
      method,
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1:3080' }, // NO Origin header!
      body,
    });
    assert.equal(res.status, 403, `route ${method} ${path} must reject request missing Origin with 403`);
  }
});

test('fail-closed guard (#353): every guarded route rejects mismatched Origin', async () => {
  const { routes } = setupEnvironment();
  for (const { path, method, body } of guardedRoutes) {
    const route = routes.get(path);
    const res = await invoke(route.handler, {
      method,
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1:3080', origin: 'http://evil-attacker.example' },
      body,
    });
    assert.equal(res.status, 403, `route ${method} ${path} must reject mismatched Origin with 403`);
  }
});

test('fail-closed guard (#353): every guarded route rejects cross-site Sec-Fetch-Site', async () => {
  const { routes } = setupEnvironment();
  for (const { path, method, body } of guardedRoutes) {
    const route = routes.get(path);
    const res = await invoke(route.handler, {
      method,
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
      body,
    });
    assert.equal(res.status, 403, `route ${method} ${path} must reject Sec-Fetch-Site: cross-site with 403`);
  }
});

test('fail-closed guard (#353): valid loopback same-origin requests pass trust gate', async () => {
  const { routes } = setupEnvironment();
  for (const { path, method, body } of guardedRoutes) {
    const route = routes.get(path);
    const res = await invoke(route.handler, {
      method,
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
      body,
    });
    assert.notEqual(res.status, 403, `route ${method} ${path} must not return 403 for valid same-origin loopback`);
  }
});

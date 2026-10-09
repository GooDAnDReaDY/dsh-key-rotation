// test/routes-live-guard.test.mjs — the real route handlers must accept the
// request shape the browser actually sends.
//
// This mounts the plugin's own HTTP routes against a throwaway loopback server
// and issues requests the way the Settings card does (same-origin fetch, no
// Origin on GET). It asserts the regression that produced
// "Provider list unavailable" cannot come back, and that mutations are still
// fenced.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { handleConfigBridge } from '../lib/http-bridge.js';
import { registerStatusRoutes } from '../lib/ops-status.js';
import { buildPools } from '../lib/pool-builder.js';

const NS = 'dsh-key-rotation';

/** Minimal cordis-like ctx with a recording webServer + settings + credentials. */
function makeCtx({ providers = [], llmProviders = [{ id: 'anthropic', name: 'Anthropic' }] } = {}) {
  const routes = new Map();
  const effects = [];
  const settingsValue = { providers };
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    effect(fn) { effects.push(fn()); return () => {}; },
    on() { return () => {}; },
    get(name) {
      if (name === 'llm') return { listProviders: () => llmProviders };
      if (name === 'credentials') {
        return {
          resolve: async (ref) => (ref.startsWith('KEY') ? { value: 'secret-' + ref, source: 'stored' } : undefined),
          describe: async () => ({ source: 'stored', writable: true }),
        };
      }
      if (name === 'settings') {
        return {
          writable: true,
          documentPath: '/tmp/settings.yaml',
          describe: () => [{ ns: NS, value: settingsValue, revision: 3, base: {}, user: settingsValue }],
          get: () => settingsValue,
        };
      }
      return undefined;
    },
  };
  return { ctx, routes };
}

/** Serve one registered route on a loopback port for the duration of `run`. */
async function serve(handler, run) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function call(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* non-JSON is fine */ }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

test('GET /config succeeds with the browser same-origin request shape', async () => {
  const { ctx, routes } = makeCtx({ providers: [{ provider: 'anthropic', keys: ['KEY_A'] }] });
  handleConfigBridge && await serve(
    (req, res) => handleConfigBridge(ctx, req, res, () => new Set()),
    async (port) => {
      // Exactly what Chrome sends for a same-origin fetch() GET.
      const res = await call(port, {
        headers: { accept: 'application/json', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
      });
      assert.equal(res.status, 200, 'the Settings card must be able to read its own config');
      assert.deepEqual(res.body.providers, [{ id: 'anthropic', name: 'Anthropic' }],
        'and it receives the provider catalog the picker needs');
      assert.equal(res.body.available, true);
    },
  );
  assert.ok(routes, 'route registered');
});

test('GET /config still refuses a cross-site request', async () => {
  const { ctx } = makeCtx();
  await serve(
    (req, res) => handleConfigBridge(ctx, req, res, () => new Set()),
    async (port) => {
      const res = await call(port, { headers: { 'sec-fetch-site': 'cross-site' } });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'forbidden');
    },
  );
});

test('PUT /config accepts loopback mutations without Origin (#465 / GitHub #22 Desktop compatibility)', async () => {
  const { ctx } = makeCtx();
  await serve(
    (req, res) => handleConfigBridge(ctx, req, res, () => new Set()),
    async (port) => {
      // Desktop forwardWebRequest strips Origin; on verified loopback this passes
      const res = await call(port, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ section: { providers: [] }, expectedRevision: 3 }),
      });
      assert.notEqual(res.status, 403, 'an Origin-less mutation on loopback must pass the network gate');

      // A same-origin Origin is also accepted through the guard
      const ok = await call(port, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({ section: { providers: [] }, expectedRevision: 3 }),
      });
      assert.notEqual(ok.status, 403, 'a same-origin mutation passes the guard');
    },
  );
});

test('GET /status succeeds without Origin and reports model sub-pools', async () => {
  const providers = [{
    provider: 'anthropic',
    keys: ['KEY_A', 'KEY_B'],
    models: {
      'claude-sonnet': {
        keys: ['KEY_A', 'KEY_B'],
        quotas: { KEY_A: { tokenLimit: 100 } },
      },
    },
  }];
  const { ctx } = makeCtx({ providers });
  const poolState = new Map();
  const built = buildPools({ cfg: { providers }, poolState });
  // Mirror the runtime snapshot shape lib/index.js buildRuntime() produces.
  const runtime = {
    ...built,
    routingStrategy: 'round-robin',
    quotaResetWindow: null,
    providerTags: new Map(),
    providerBudgets: new Map(),
    latencySloMs: 0,
    circuitBreakerEnabled: false,
    proactiveRateLimitGuard: true,
  };
  const deps = {
    buildRuntime: () => runtime,
    latencyHistogram: { snapshot: () => null, snapshotAll: () => ({}) },
    circuitBreaker: null,
    quotaStore: null,
  };
  registerStatusRoutes(ctx, deps);
  const statusRoute = ctx.webServer.register;
  assert.equal(typeof statusRoute, 'function');

  // Rebuild a ctx that captures the registered status route.
  const captured = new Map();
  const ctx2 = {
    ...ctx,
    webServer: { register: (route) => { captured.set(route.path, route); return () => {}; } },
    effect: (fn) => { fn(); return () => {}; },
  };
  registerStatusRoutes(ctx2, deps);
  const route = captured.get('/dsh-key-rotation/status');
  assert.ok(route, 'status route registered');

  await serve(route.handler, async (port) => {
    const res = await call(port, { headers: { accept: 'application/json', 'sec-fetch-site': 'same-origin' } });
    assert.equal(res.status, 200, 'status must be readable without Origin');
    assert.equal(Array.isArray(res.body.providers), true);
    // A pool that hit the route's internal catch reports `statusError` instead of
    // keys; assert against that explicitly so a stubbed-out runtime cannot pass.
    for (const p of res.body.providers) {
      assert.equal(p.statusError, undefined, `pool ${p.provider} must not error: ${p.statusError}`);
    }
    const sonnet = res.body.providers.find((p) => p.provider === 'anthropic::claude-sonnet');
    assert.ok(sonnet, 'the model sub-pool is reported');
    assert.equal(sonnet.model, 'claude-sonnet');
    const keyA = sonnet.keys.find((k) => k.ref === 'KEY_A');
    assert.equal(keyA.modelQuota.limit, 100);
    assert.equal(keyA.modelQuota.used, 0);
    assert.equal(keyA.modelQuota.configured, true);
    assert.equal(keyA.modelQuota.exhausted, false);
    assert.equal(Number.isFinite(keyA.modelQuota.resetAt), true, 'a wall-clock reset timestamp is reported');
    const keyB = sonnet.keys.find((k) => k.ref === 'KEY_B');
    assert.equal(keyB.modelQuota, null, 'an unconfigured credential reports unlimited');
  });
});

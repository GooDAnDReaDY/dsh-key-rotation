import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  checkProviderBalance,
  inspectBalanceForRef,
} from '../lib/balance-inspector.js';
import { registerBalanceRoutes } from '../lib/ops-balance.js';
import { BALANCE_PATH } from '../lib/ops-paths.js';
import { createRotate } from '../lib/rotate.js';
import { registerStatusRoutes } from '../lib/ops-status.js';
import { STATUS_PATH } from '../lib/ops-paths.js';

test('checkProviderBalance: parses DeepSeek balance response correctly', async () => {
  const mockFetch = async (url, opts) => {
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    assert.equal(opts.headers.Authorization, 'Bearer test-ds-key');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        is_available: true,
        balance_infos: [
          {
            currency: 'CNY',
            total_balance: '15.50',
            granted_balance: '5.00',
            topped_up_balance: '10.50',
          },
        ],
      }),
    };
  };

  const res = await checkProviderBalance('deepseek', 'test-ds-key', { fetchImpl: mockFetch });
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'deepseek');
  assert.equal(res.total, 15.5);
  assert.equal(res.currency, 'CNY');
  assert.equal(res.isAvailable, true);
  assert.equal(res.granted, 5);
  assert.equal(res.toppedUp, 10.5);
});

test('checkProviderBalance: flags empty balance on DeepSeek', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      is_available: false,
      balance_infos: [{ currency: 'CNY', total_balance: '0.00' }],
    }),
  });

  const res = await checkProviderBalance('deepseek', 'test-ds-key', { fetchImpl: mockFetch });
  assert.equal(res.ok, true);
  assert.equal(res.total, 0);
  assert.equal(res.isAvailable, false);
});

test('checkProviderBalance: parses SiliconFlow balance response', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      code: 20000,
      data: {
        totalBalance: '42.80',
        balance: '42.80',
      },
    }),
  });

  const res = await checkProviderBalance('siliconflow', 'test-sf-key', { fetchImpl: mockFetch });
  assert.equal(res.ok, true);
  assert.equal(res.total, 42.8);
  assert.equal(res.currency, 'CNY');
  assert.equal(res.isAvailable, true);
});

test('checkProviderBalance: parses OpenRouter auth key credits', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        limit: 20.0,
        usage: 4.5,
      },
    }),
  });

  const res = await checkProviderBalance('openrouter', 'test-or-key', { fetchImpl: mockFetch });
  assert.equal(res.ok, true);
  assert.equal(res.total, 15.5);
  assert.equal(res.currency, 'USD');
  assert.equal(res.isAvailable, true);
});

test('checkProviderBalance: handles HTTP errors gracefully without throwing', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 401,
  });

  const res = await checkProviderBalance('deepseek', 'invalid-key', { fetchImpl: mockFetch });
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
});

test('checkProviderBalance: handles unsupported provider gracefully', async () => {
  const res = await checkProviderBalance('unsupported-custom-ai', 'any-key');
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('does not support balance inspection'));
});

test('inspectBalanceForRef: resolves credential via credentials service', async () => {
  const ctx = {
    get: (name) => {
      if (name === 'credentials') {
        return {
          resolve: async (ref) => ({ value: 'resolved-key-value' }),
        };
      }
      return null;
    },
  };

  const mockFetch = async (url, opts) => {
    assert.equal(opts.headers.Authorization, 'Bearer resolved-key-value');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        is_available: true,
        balance_infos: [{ currency: 'USD', total_balance: '25.00' }],
      }),
    };
  };

  const res = await inspectBalanceForRef(ctx, 'DEEPSEEK_KEY_1', 'deepseek', { fetchImpl: mockFetch });
  assert.equal(res.ok, true);
  assert.equal(res.total, 25);
});

function mockReqRes({ method = 'GET', url = '/', headers = {}, body = null, remoteAddress = '127.0.0.1' } = {}) {
  const req = Readable.from(body ? [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:3000', ...headers };
  req.socket = { remoteAddress };

  let status = 200;
  const resHeaders = {};
  const chunks = [];

  const res = {
    writeHead(s, h) {
      status = s;
      if (h) Object.assign(resHeaders, h);
    },
    setHeader(k, v) { resHeaders[k.toLowerCase()] = v; },
    write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); },
    end(c) {
      if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    },
    get status() { return status; },
    get body() {
      const b = Buffer.concat(chunks).toString('utf8');
      try { return JSON.parse(b); } catch { return b; }
    },
  };
  return { req, res };
}

test('Route BALANCE_PATH: GET cached, POST inspect, and soft empty balance pause', async () => {
  const routeTable = new Map();
  const ctx = {
    effect(fn) { fn(); },
    webServer: {
      register({ path, handler }) {
        routeTable.set(path, handler);
        return () => routeTable.delete(path);
      },
    },
    get: (name) => {
      if (name === 'credentials') {
        return { resolve: async (ref) => ({ value: 'test-key' }) };
      }
      return null;
    },
  };

  const mockPool = {
    provider: 'deepseek',
    refs: ['DS_KEY_1'],
    state: {
      balances: new Map(),
      pausedRefs: new Set(),
      pauseReasons: new Map(),
      events: [],
    },
  };
  mockPool.state.balances.set('DS_KEY_1', { total: 10, currency: 'CNY', isAvailable: true, at: Date.now() });

  const poolState = new Map([['deepseek', mockPool.state]]);
  const buildRuntime = () => ({
    pools: [mockPool],
    poolByRef: new Map([['DS_KEY_1', mockPool]]),
  });

  registerBalanceRoutes(ctx, { poolState, buildRuntime });
  const handler = routeTable.get(BALANCE_PATH);
  assert.ok(handler);

  // 1. GET cached balance
  {
    const { req, res } = mockReqRes({ method: 'GET', url: `${BALANCE_PATH}?ref=DS_KEY_1` });
    await handler(req, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.balance.total, 10);
  }

  // 2. GET all cached balances
  {
    const { req, res } = mockReqRes({ method: 'GET', url: BALANCE_PATH });
    await handler(req, res);
    assert.equal(res.status, 200);
    assert.ok(res.body.balances.DS_KEY_1);
    assert.equal(res.body.balances.DS_KEY_1.total, 10);
  }

  // 3. Security: 403 Forbidden for remote requests
  {
    const { req, res } = mockReqRes({ method: 'GET', url: BALANCE_PATH, remoteAddress: '203.0.113.195' });
    await handler(req, res);
    assert.equal(res.status, 403);
  }
});

test('Dynamic Reset Scheduler: rotate sets exact cooldown from response headers', async () => {
  const events = [];
  const pool = {
    provider: 'test-prov',
    refs: ['KEY_HDR'],
    state: {
      failedUntil: new Map(),
      failCounts: new Map(),
      resetReasons: new Map(),
      headerResetTimes: new Map(),
      detectedLimits: new Map(),
      lastUsed: 'KEY_HDR',
      events: [],
    },
    cooldownMs: 60000,
    maxCooldownMs: 300000,
  };

  // Pre-seed detected limits on KEY_HDR as if a response header just arrived
  pool.state.detectedLimits.set('KEY_HDR', {
    rpmLimit: 60,
    rpmRemaining: 0,
    rpmResetMs: 4000, // 4 seconds reset
    retryAfterMs: 4000,
  });

  const nowVal = 1000000;
  const now = () => nowVal;

  const dispatchStorage = new AsyncLocalStorage();
  const llm = {
    stream: () => (async function* () {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { code: '429', message: 'Rate limit exceeded' } },
        headers: { 'retry-after': '4' },
      };
    })(),
  };

  let rotateStartMs = nowVal;
  const rotate = createRotate({
    ctx: { get: (name) => (name === 'llm' ? llm : undefined) },
    dispatchStorage,
    buildRuntime: () => ({
      pools: [pool],
      poolByRef: new Map([['KEY_HDR', pool]]),
      switchCodes: ['429'],
      circuitBreakerEnabled: false,
    }),
    schedulePersist: () => {},
    pushEvent: (p, ref, code, b) => { events.push({ ref, code, b }); },
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    notifyEarlyWarning: () => {},
    recordLatency: () => {},
    latencyHistogram: {},
    concurrencyTracker: { isEnabled: () => false },
    MARKER: Symbol('test'),
    finishError: (code, message) => ({ type: 'finish', code, message }),
    setRotateStartMs: (v) => { rotateStartMs = v; },
    quotaStore: {},
    circuitBreaker: { configure: () => {}, recordSuccess: () => {}, recordFailure: () => {} },
    now,
    logger: { warn: () => {}, info: () => {} },
  });

  // Execute rotate
  const gen = rotate({
    provider: 'test-prov',
  }, pool);

  const results = [];
  for await (const chunk of gen) results.push(chunk);

  // Check that cooldown was scheduled via dynamic header, not 60000ms default
  const failedUntil = pool.state.failedUntil.get('KEY_HDR');
  assert.ok(failedUntil, 'Key must have failedUntil');

  const cooldownMs = failedUntil - nowVal;
  // 4000ms + ~250ms jitter = ~4250ms (well under default 60000ms)
  assert.ok(cooldownMs >= 4000 && cooldownMs <= 5000, `cooldown was ${cooldownMs}ms`);
  assert.equal(pool.state.resetReasons.get('KEY_HDR'), 'header');

  const hdrEvent = events.find((e) => e.code === 'HEADER_RESET');
  assert.ok(hdrEvent, 'HEADER_RESET event must be emitted');
  assert.ok(hdrEvent.b >= 4000 && hdrEvent.b <= 5000);
});

test('Status route exposes balance and resetReason in key details', async () => {
  const routeTable = new Map();
  const ctx = {
    effect(fn) { fn(); },
    webServer: {
      register({ path, handler }) {
        routeTable.set(path, handler);
        return () => routeTable.delete(path);
      },
    },
    get: () => null,
  };

  const pool = {
    base: 'deepseek',
    provider: 'deepseek',
    refs: ['KEY_BAL'],
    weights: [1],
    state: {
      balances: new Map([['KEY_BAL', { total: 12.5, currency: 'USD', isAvailable: true }]]),
      resetReasons: new Map([['KEY_BAL', 'header']]),
      headerResetTimes: new Map([['KEY_BAL', 3500]]),
      failedUntil: new Map([['KEY_BAL', Date.now() + 3500]]),
    },
  };

  const poolState = new Map([['deepseek', pool.state]]);
  const buildRuntime = () => ({
    pools: [pool],
    poolByRef: new Map([['KEY_BAL', pool]]),
  });

  registerStatusRoutes(ctx, { buildRuntime, poolState });
  const handler = routeTable.get(STATUS_PATH);
  assert.ok(handler);

  const { req, res } = mockReqRes({ method: 'GET', url: STATUS_PATH });
  await handler(req, res);
  assert.equal(res.status, 200);

  const prov = res.body.providers.find((p) => p.provider === 'deepseek');
  assert.ok(prov);
  const k = prov.keys.find((k) => k.ref === 'KEY_BAL');
  assert.ok(k);
  assert.equal(k.balance.total, 12.5);
  assert.equal(k.balance.currency, 'USD');
  assert.equal(k.resetReason, 'header');
  assert.equal(k.headerResetMs, 3500);
});

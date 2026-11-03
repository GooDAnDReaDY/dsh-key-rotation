import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { registerQuickActionRoutes } from '../lib/routes/quick-action.js';
import { registerStatusRoutes } from '../lib/routes/status.js';
import { HEALTH_PATH, QUICK_ACTION_PATH } from '../lib/routes/paths.js';
import { keyTail } from '../lib/pool.js';

class MockResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.body = '';
  }
  writeHead(code, headers) {
    this.statusCode = code;
    Object.assign(this.headers, headers);
  }
  end(content) {
    this.body = content;
  }
  json() {
    return JSON.parse(this.body);
  }
}

function createMockCordis(handlers) {
  return {
    webServer: {
      register: (route) => {
        handlers.set(route.path, route.handler);
        return () => {};
      },
    },
    effect: (fn) => {
      fn();
      return () => {};
    },
  };
}

function createPostRequest(bodyObj) {
  const stream = new PassThrough();
  stream.method = 'POST';
  stream.headers = { host: '127.0.0.1:3005', origin: 'http://127.0.0.1:3005', 'content-type': 'application/json' };
  stream.socket = { remoteAddress: '127.0.0.1' };
  stream.end(JSON.stringify(bodyObj));
  return stream;
}

test('Interactive Header Chip - Health endpoint exposes keys, pinnedRef and promptCacheHits', async () => {
  const handlers = new Map();
  const ctx = createMockCordis(handlers);

  const mockPool = {
    base: 'openai',
    provider: 'openai',
    refs: ['KEY_ALPHA_1234', 'KEY_BETA_5678'],
    pinnedRef: 'KEY_BETA_5678',
    state: {
      lastUsed: 'KEY_ALPHA_1234',
      promptCacheHits: 42,
      failedUntil: new Map([['KEY_ALPHA_1234', Date.now() + 60000]]),
      pausedRefs: new Set(),
      failCounts: new Map(),
      resetReasons: new Map(),
      headerResetTimes: new Map(),
    },
  };

  const deps = {
    buildRuntime: () => ({
      pools: [mockPool],
      poolByRef: new Map([['openai', mockPool]]),
      showChatHeaderChip: true,
      circuitBreakerEnabled: true,
    }),
    latencyHistogram: { snapshotAll: () => ({}) },
    circuitBreaker: { state: () => 'closed' },
    notifyQueue: null,
    quotaStore: null,
  };

  registerStatusRoutes(ctx, deps);

  const healthHandler = handlers.get(HEALTH_PATH);
  assert.ok(healthHandler, 'Health handler registered');

  const req = {
    method: 'GET',
    headers: { host: '127.0.0.1:3005', 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res = new MockResponse();

  await healthHandler(req, res);

  assert.equal(res.statusCode, 200);
  const data = res.json();
  assert.equal(data.status, 'ok');
  assert.equal(data.showChatHeaderChip, true);
  assert.ok(data.pools.openai);

  const poolData = data.pools.openai;
  assert.equal(poolData.pinnedRef, 'KEY_BETA_5678');
  assert.equal(poolData.pinnedTail, keyTail('KEY_BETA_5678'));
  assert.equal(poolData.promptCacheHits, 42);
  assert.equal(poolData.keys.length, 2);

  const key1 = poolData.keys.find((k) => k.ref === 'KEY_ALPHA_1234');
  assert.ok(key1);
  assert.equal(key1.tail, keyTail('KEY_ALPHA_1234'));
  assert.equal(key1.active, true);
  assert.equal(key1.pinned, false);
  assert.equal(key1.cooling, true);

  const key2 = poolData.keys.find((k) => k.ref === 'KEY_BETA_5678');
  assert.ok(key2);
  assert.equal(key2.tail, keyTail('KEY_BETA_5678'));
  assert.equal(key2.active, false);
  assert.equal(key2.pinned, true);
  assert.equal(key2.cooling, false);
});

test('Interactive Header Chip - Quick-action pins valid key in pool', async () => {
  const handlers = new Map();
  const ctx = createMockCordis(handlers);

  const events = [];
  const mockPool = {
    base: 'anthropic',
    provider: 'anthropic',
    refs: ['KEY_CLAUDE_9999', 'KEY_CLAUDE_8888'],
    pinnedRef: null,
    state: {
      lastUsed: 'KEY_CLAUDE_9999',
      cursor: 0,
      pointer: 0,
      failedUntil: new Map(),
      pausedRefs: new Set(),
    },
  };

  const deps = {
    buildRuntime: () => ({
      pools: [mockPool],
      poolByRef: new Map([['anthropic', mockPool]]),
    }),
    pushEvent: (p, ref, eventType, cooldown) => {
      events.push({ ref, eventType, cooldown });
    },
    circuitBreaker: null,
  };

  registerQuickActionRoutes(ctx, deps);

  const qaHandler = handlers.get(QUICK_ACTION_PATH);
  assert.ok(qaHandler, 'Quick-action handler registered');

  // Test pinning KEY_CLAUDE_8888
  const reqPin = createPostRequest({ action: 'pin', provider: 'anthropic', ref: 'KEY_CLAUDE_8888' });
  const resPin = new MockResponse();

  await qaHandler(reqPin, resPin);

  assert.equal(resPin.statusCode, 200);
  const pinData = resPin.json();
  assert.equal(pinData.ok, true);
  assert.equal(pinData.action, 'pin');
  assert.equal(pinData.pinnedRef, 'KEY_CLAUDE_8888');
  assert.equal(pinData.pinnedTail, keyTail('KEY_CLAUDE_8888'));
  assert.equal(mockPool.pinnedRef, 'KEY_CLAUDE_8888');
  assert.equal(mockPool.state.lastUsed, 'KEY_CLAUDE_8888');
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'KEY_PINNED');
  assert.equal(events[0].ref, 'KEY_CLAUDE_8888');

  // Test unpinning back to Auto (empty ref)
  const reqUnpin = createPostRequest({ action: 'pin', provider: 'anthropic', ref: '' });
  const resUnpin = new MockResponse();

  await qaHandler(reqUnpin, resUnpin);

  assert.equal(resUnpin.statusCode, 200);
  const unpinData = resUnpin.json();
  assert.equal(unpinData.ok, true);
  assert.equal(unpinData.pinnedRef, null);
  assert.equal(unpinData.pinnedTail, null);
  assert.equal(mockPool.pinnedRef, null);
  assert.equal(events.length, 2);
  assert.equal(events[1].eventType, 'KEY_UNPINNED');

  // Test rejecting key not in pool
  const reqInvalid = createPostRequest({ action: 'pin', provider: 'anthropic', ref: 'NON_EXISTENT_KEY' });
  const resInvalid = new MockResponse();

  await qaHandler(reqInvalid, resInvalid);

  assert.equal(resInvalid.statusCode, 400);
  assert.equal(resInvalid.json().error.code, 'invalid-key');
});

test('Interactive Header Chip - Client bundle size limit and syntax check', () => {
  const clientPath = resolve('lib/client.js');
  const content = readFileSync(clientPath, 'utf8');

  assert.ok(content.length < 262144, `client.js size (${content.length}) must be < 262144 bytes`);
  assert.ok(content.includes('KeyRotationHeaderChip'), 'client.js must include KeyRotationHeaderChip');
  assert.ok(content.includes('quickAuto'), 'client.js must include quickAuto');
  assert.ok(content.includes('quickPinTitle'), 'client.js must include quickPinTitle');
});

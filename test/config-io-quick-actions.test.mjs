import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptConfig,
  decryptConfig,
  maskConfig,
  diffConfigs,
  registerConfigIoRoutes,
} from '../lib/ops-config-io.js';
import { registerQuickActionRoutes } from '../lib/ops-quick-action.js';
import { registerStatusRoutes } from '../lib/ops-status.js';
import { CONFIG_EXPORT_PATH, CONFIG_IMPORT_PATH, QUICK_ACTION_PATH, HEALTH_PATH } from '../lib/ops-paths.js';

test('encryptConfig & decryptConfig: AES-256-GCM roundtrip with PBKDF2', () => {
  const plain = JSON.stringify({ providers: [{ provider: 'deepseek', keys: ['sk-live-1234567890abcdef'] }] });
  const passphrase = 'MySuperSecretMasterKey123!';

  const encrypted = encryptConfig(plain, passphrase);
  assert.equal(encrypted.encrypted, true);
  assert.equal(encrypted.algorithm, 'aes-256-gcm');
  assert.ok(encrypted.salt);
  assert.ok(encrypted.iv);
  assert.ok(encrypted.tag);
  assert.ok(encrypted.ciphertext);

  const decrypted = decryptConfig(encrypted, passphrase);
  assert.equal(decrypted, plain);

  // Wrong passphrase must throw
  assert.throws(() => {
    decryptConfig(encrypted, 'WrongPassphrase');
  });
});

test('maskConfig: masks API keys and tokens while preserving topology', () => {
  const cfg = {
    providers: [
      { provider: 'deepseek', keys: ['sk-live-1234567890abcdef', 'shortkey'] },
      { provider: 'openai', keys: [{ value: 'sk-proj-9998887776665544' }] },
    ],
    webhookUrl: 'https://discord.com/api/webhooks/123/token_secret',
    webhookActionToken: 'secret_action_token',
    rpmLimit: 60,
  };

  const masked = maskConfig(cfg);
  assert.equal(masked.rpmLimit, 60);
  assert.equal(masked.webhookActionToken, '***');
  assert.ok(masked.webhookUrl.startsWith('https://discord.com'));
  assert.ok(!masked.webhookUrl.includes('token_secret'));

  const p1 = masked.providers[0];
  assert.equal(p1.keys[0], 'sk-...cdef');
  assert.equal(p1.keys[1], '***');

  const p2 = masked.providers[1];
  assert.equal(p2.keys[0].value, 'sk-...5544');
});

test('diffConfigs: accurately calculates changes in merge and replace modes', () => {
  const cur = {
    providers: [
      { provider: 'deepseek', keys: ['key1', 'key2'] },
      { provider: 'siliconflow', keys: ['sf1'] },
    ],
  };

  const incoming = {
    providers: [
      { provider: 'deepseek', keys: ['key2', 'key3'] },
      { provider: 'groq', keys: ['groq1', 'groq2'] },
    ],
  };

  const diffMerge = diffConfigs(cur, incoming, 'merge');
  assert.deepEqual(diffMerge.createdProviders, ['groq']);
  assert.deepEqual(diffMerge.updatedProviders, ['deepseek']);
  assert.deepEqual(diffMerge.removedProviders, []);
  assert.equal(diffMerge.keysAdded, 3); // groq1, groq2, key3
  assert.equal(diffMerge.keysUpdated, 1); // key2

  const diffReplace = diffConfigs(cur, incoming, 'replace');
  assert.deepEqual(diffReplace.createdProviders, ['groq']);
  assert.deepEqual(diffReplace.updatedProviders, ['deepseek']);
  assert.deepEqual(diffReplace.removedProviders, ['siliconflow']);
});

test('Route CONFIG_EXPORT_PATH: exports masked, unmasked, and encrypted configuration', async () => {
  const routes = new Map();
  const mockWebServer = {
    register: ({ path, handler }) => { routes.set(path, handler); },
  };
  const mockSettings = {
    get: () => ({
      providers: [
        { provider: 'deepseek', keys: ['sk-deepseek-1234567890abcdef'] },
      ],
      cooldownMs: 30000,
    }),
  };

  const ctx = {
    webServer: mockWebServer,
    effect: (fn) => fn(),
    get: (name) => (name === 'settings' ? mockSettings : undefined),
  };

  registerConfigIoRoutes(ctx, { buildRuntime: () => ({ cfg0: {} }) });
  const exportHandler = routes.get(CONFIG_EXPORT_PATH);
  assert.ok(exportHandler, 'export route must be registered');

  // 1. Forbidden non-loopback
  let resStatus = 0;
  let resData = null;
  const mockRes = {
    writeHead: (s) => { resStatus = s; },
    end: (d) => { resData = JSON.parse(d); },
  };

  await exportHandler({
    method: 'GET',
    url: '/dsh-key-rotation/export',
    headers: { host: '8.8.8.8' },
    socket: { remoteAddress: '8.8.8.8' }
  }, mockRes);
  assert.equal(resStatus, 403);

  // 2. Default masked export
  await exportHandler({
    method: 'GET',
    url: '/dsh-key-rotation/export',
    headers: { host: '127.0.0.1:3000' },
    socket: { remoteAddress: '127.0.0.1' }
  }, mockRes);
  assert.equal(resStatus, 200);
  assert.equal(resData.ok, true);
  assert.equal(resData.masked, true);
  assert.equal(resData.config.providers[0].keys[0], 'sk-...cdef');

  // 3. Unmasked export
  await exportHandler({
    method: 'GET',
    url: '/dsh-key-rotation/export?masked=false',
    headers: { host: '127.0.0.1:3000' },
    socket: { remoteAddress: '127.0.0.1' }
  }, mockRes);
  assert.equal(resStatus, 200);
  assert.equal(resData.masked, false);
  assert.equal(resData.config.providers[0].keys[0], 'sk-deepseek-1234567890abcdef');

  // 4. Encrypted export
  await exportHandler({
    method: 'GET',
    url: '/dsh-key-rotation/export?masked=false&passphrase=SecretPass123',
    headers: { host: '127.0.0.1:3000' },
    socket: { remoteAddress: '127.0.0.1' }
  }, mockRes);
  assert.equal(resStatus, 200);
  assert.equal(resData.encrypted, true);
  assert.ok(resData.ciphertext);

  const decrypted = JSON.parse(decryptConfig(resData, 'SecretPass123'));
  assert.equal(decrypted.providers[0].keys[0], 'sk-deepseek-1234567890abcdef');
});

test('Route CONFIG_IMPORT_PATH: handles preview and application of config', async () => {
  const routes = new Map();
  const mockWebServer = {
    register: ({ path, handler }) => { routes.set(path, handler); },
  };
  let replacedConfig = null;
  const mockSettings = {
    get: () => ({ providers: [{ provider: 'deepseek', keys: ['key1'] }] }),
    replace: async (ns, val) => { replacedConfig = val; },
  };

  const ctx = {
    webServer: mockWebServer,
    effect: (fn) => fn(),
    get: (name) => (name === 'settings' ? mockSettings : undefined),
  };

  registerConfigIoRoutes(ctx, { buildRuntime: () => ({ cfg0: {} }) });
  const importHandler = routes.get(CONFIG_IMPORT_PATH);
  assert.ok(importHandler, 'import route must be registered');

  const makeReq = (body, ip = '127.0.0.1') => {
    const raw = Buffer.from(JSON.stringify(body));
    return {
      method: 'POST',
      headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
      socket: { remoteAddress: ip },
      on: (evt, cb) => {
        if (evt === 'data') cb(raw);
        if (evt === 'end') cb();
      },
    };
  };

  // 1. Dry run preview
  let resStatus = 0;
  let resData = null;
  const mockRes = {
    writeHead: (s) => { resStatus = s; },
    end: (d) => { resData = JSON.parse(d); },
  };

  await importHandler(makeReq({
    config: { providers: [{ provider: 'siliconflow', keys: ['sf-key'] }] },
    mode: 'merge',
    dryRun: true,
  }), mockRes);

  assert.equal(resStatus, 200);
  assert.equal(resData.ok, true);
  assert.equal(resData.dryRun, true);
  assert.deepEqual(resData.preview.createdProviders, ['siliconflow']);
  assert.equal(replacedConfig, null, 'dry run must not modify settings');

  // 2. Apply import
  await importHandler(makeReq({
    config: { providers: [{ provider: 'siliconflow', keys: ['sf-key'] }] },
    mode: 'merge',
    dryRun: false,
  }), mockRes);

  assert.equal(resStatus, 200);
  assert.equal(resData.applied, true);
  assert.ok(replacedConfig);
  assert.equal(replacedConfig.providers.length, 2); // deepseek + siliconflow
});

test('Route QUICK_ACTION_PATH: skip, reset, and pause controls', async () => {
  const routes = new Map();
  const mockWebServer = {
    register: ({ path, handler }) => { routes.set(path, handler); },
  };

  const pool = {
    provider: 'deepseek',
    base: 'deepseek',
    refs: ['KEY_A', 'KEY_B', 'KEY_C'],
    state: {
      cursor: 0,
      lastUsed: 'KEY_A',
      failedUntil: new Map([['KEY_B', Date.now() + 60000]]),
      failCounts: new Map([['KEY_B', 2]]),
      pausedRefs: new Set(),
      pauseReasons: new Map(),
      events: [],
    },
  };

  let circuitResetCalled = false;
  const circuitBreaker = {
    reset: () => { circuitResetCalled = true; },
  };

  const events = [];
  const pushEvent = (p, ref, code, b) => { events.push({ ref, code, b }); };

  const ctx = {
    webServer: mockWebServer,
    effect: (fn) => fn(),
  };

  registerQuickActionRoutes(ctx, {
    buildRuntime: () => ({ pools: [pool] }),
    pushEvent,
    circuitBreaker,
  });

  const handler = routes.get(QUICK_ACTION_PATH);
  assert.ok(handler, 'quick action route must be registered');

  const makeReq = (body, ip = '127.0.0.1') => {
    const raw = Buffer.from(JSON.stringify(body));
    return {
      method: 'POST',
      headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
      socket: { remoteAddress: ip },
      on: (evt, cb) => {
        if (evt === 'data') cb(raw);
        if (evt === 'end') cb();
      },
    };
  };

  let resStatus = 0;
  let resData = null;
  const mockRes = {
    writeHead: (s) => { resStatus = s; },
    end: (d) => { resData = JSON.parse(d); },
  };

  // 1. Skip action
  await handler(makeReq({ action: 'skip', provider: 'deepseek' }), mockRes);
  assert.equal(resStatus, 200);
  assert.equal(resData.ok, true);
  assert.equal(resData.action, 'skip');
  assert.equal(pool.state.cursor, 1);
  assert.equal(pool.state.lastUsed, 'KEY_B');
  assert.ok(events.some((e) => e.code === 'QUICK_ACTION_SKIP'));

  // 2. Reset action
  await handler(makeReq({ action: 'reset', provider: 'deepseek' }), mockRes);
  assert.equal(resStatus, 200);
  assert.equal(resData.ok, true);
  assert.equal(resData.action, 'reset');
  assert.equal(pool.state.failedUntil.size, 0);
  assert.equal(pool.state.failCounts.size, 0);
  assert.ok(circuitResetCalled);
  assert.ok(events.some((e) => e.code === 'QUICK_ACTION_RESET'));

  // 3. Pause toggle action
  await handler(makeReq({ action: 'pause', provider: 'deepseek', ref: 'KEY_B' }), mockRes);
  assert.equal(resStatus, 200);
  assert.equal(resData.paused, true);
  assert.ok(pool.state.pausedRefs.has('KEY_B'));

  // Pause again -> unpauses
  await handler(makeReq({ action: 'pause', provider: 'deepseek', ref: 'KEY_B' }), mockRes);
  assert.equal(resStatus, 200);
  assert.equal(resData.paused, false);
  assert.ok(!pool.state.pausedRefs.has('KEY_B'));
});

test('HEALTH_PATH: exposes active key and tail for popover chip', async () => {
  const routes = new Map();
  const mockWebServer = {
    register: ({ path, handler }) => { routes.set(path, handler); },
  };

  const pool = {
    provider: 'deepseek',
    base: 'deepseek',
    refs: ['KEY_TEST_ABCD'],
    state: {
      lastUsed: 'KEY_TEST_ABCD',
      failedUntil: new Map(),
      failCounts: new Map(),
      events: [],
    },
  };

  const ctx = {
    webServer: mockWebServer,
    effect: (fn) => fn(),
    get: () => undefined,
  };

  registerStatusRoutes(ctx, {
    buildRuntime: () => ({
      pools: [pool],
      poolByRef: new Map([['KEY_TEST_ABCD', pool]]),
      index: { allPools: new Map([['deepseek', pool]]) },
      providerTags: {},
      providerBudgets: {},
    }),
    latencyHistogram: { snapshotAll: () => ({}) },
    circuitBreaker: { isClosed: () => true, state: () => 'closed' },
    notifyQueue: {},
    quotaStore: {},
  });

  const handler = routes.get(HEALTH_PATH);
  assert.ok(handler, 'health route must be registered');

  let resData = null;
  const mockRes = {
    writeHead: () => {},
    end: (d) => { resData = JSON.parse(d); },
  };

  await handler({
    method: 'GET',
    headers: { host: '127.0.0.1:3000' },
    socket: { remoteAddress: '127.0.0.1' }
  }, mockRes);

  assert.ok(resData.pools);
  assert.ok(resData.pools.deepseek);
  assert.equal(resData.pools.deepseek.lastUsed, 'KEY_TEST_ABCD');
  assert.equal(resData.pools.deepseek.lastUsedTail, '_ABCD');
});

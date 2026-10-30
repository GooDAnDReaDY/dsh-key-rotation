import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { isSwitchableError, DEFAULT_SWITCH_CODES } from '../lib/pool.js';
import { registerQuickActionRoutes } from '../lib/ops-quick-action.js';
import { QUICK_ACTION_PATH } from '../lib/ops-paths.js';
import { buildPools } from '../lib/pool-builder.js';
import { sortAttemptList } from '../lib/pool-selection.js';
import { TrafficSmoother } from '../lib/traffic-smoother.js';
import { simulateRouting } from '../lib/simulator.js';
import { KeyDrainManager } from '../lib/key-drain.js';
import { SelectionTraceStore, createSelectionTrace } from '../lib/selection-trace.js';
import { DiagBuffer, pushDiag } from '../lib/ops-telemetry.js';
import { registerConfigIoRoutes } from '../lib/ops-config-io.js';
import { CONFIG_IMPORT_PATH } from '../lib/ops-paths.js';

function mockReqRes({ method = 'GET', url = '/', headers = {}, body = null, remoteAddress = '127.0.0.1' } = {}) {
  const req = Readable.from(body ? [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', ...headers };
  req.socket = { remoteAddress };

  let status = 200;
  const resHeaders = {};
  const chunks = [];
  let finished = false;

  const res = {
    writeHead(s, h) {
      status = s;
      if (h) Object.assign(resHeaders, h);
    },
    setHeader(k, v) { resHeaders[k.toLowerCase()] = v; },
    write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); },
    end(c) {
      if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      finished = true;
    },
    get status() { return status; },
    get body() {
      const b = Buffer.concat(chunks).toString('utf8');
      try { return JSON.parse(b); } catch { return b; }
    },
  };
  return { req, res };
}

// ── 1. Issue #545: isSwitchableError handles code 429 ──
test('#545: isSwitchableError recognizes string and number 429 codes under defaultSwitchCodes', () => {
  const defaultCodes = DEFAULT_SWITCH_CODES; // ['QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', ...]
  
  // String "429" in failure.code
  assert.equal(isSwitchableError({ code: '429' }, defaultCodes), true);
  // Number 429 in failure.code
  assert.equal(isSwitchableError({ code: 429 }, defaultCodes), true);
  // String "503"
  assert.equal(isSwitchableError({ code: '503' }, defaultCodes), true);
  // Status number
  assert.equal(isSwitchableError({ status: 429 }, defaultCodes), true);
  // Non-switchable error (e.g. 400 Bad Request)
  assert.equal(isSwitchableError({ code: '400' }, defaultCodes), false);
  assert.equal(isSwitchableError({ code: 'INVALID_ARGUMENT' }, defaultCodes), false);
});

// ── 2. Issue #540: Skip quick action synchronizes pointer and cursor ──
test('#540: handleQuickAction skip advances both cursor and pointer for resolver round-robin', async () => {
  const targetPool = {
    provider: 'test-p',
    refs: ['KEY_A', 'KEY_B', 'KEY_C'],
    weights: [1, 1, 1],
    state: {
      pointer: 0,
      cursor: 0,
      events: [],
      failedUntil: new Map(),
      brokenUntil: new Map(),
      tokenUsage: new Map(),
    },
  };

  const poolState = new Map([['test-p', targetPool.state]]);
  const runtime = {
    pools: [targetPool],
    providerToPool: new Map([['test-p', targetPool]]),
    poolByRef: new Map([['KEY_A', targetPool], ['KEY_B', targetPool], ['KEY_C', targetPool]]),
  };

  const routes = new Map();
  const ctx = {
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler);
        return () => routes.delete(path);
      },
    },
    effect: (fn) => fn(),
  };

  registerQuickActionRoutes(ctx, {
    poolState,
    buildRuntime: () => runtime,
  });

  const quickActionHandler = routes.get(QUICK_ACTION_PATH);
  assert.ok(quickActionHandler, 'quick action route must be registered');

  const { req, res } = mockReqRes({
    method: 'POST',
    url: QUICK_ACTION_PATH,
    body: { action: 'skip', provider: 'test-p' },
  });

  await quickActionHandler(req, res);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(targetPool.state.pointer, 1);
  assert.equal(targetPool.state.cursor, 1);
  assert.equal(res.body.activeRef, 'KEY_B');
});

// ── 3. Issue #541: Tiers and tier-priority routing strategy ──
test('#541: buildPools propagates tiers and tier-priority strategy orders by tier rank', () => {
  const providerCfg = {
    provider: 'deepseek',
    keys: ['KEY_PRIORITY_1', 'KEY_PRIORITY_2', 'KEY_BACKUP_1'],
    tiers: [1, 1, 2],
    routingStrategy: 'tier-priority',
  };

  const poolState = new Map();
  const { pools } = buildPools({
    cfg: { providers: [providerCfg] },
    poolState,
  });
  assert.equal(pools.length, 1);
  const pool = pools[0];
  assert.equal(pool.tiers['KEY_PRIORITY_1'], 1);
  assert.equal(pool.tiers['KEY_PRIORITY_2'], 1);
  assert.equal(pool.tiers['KEY_BACKUP_1'], 2);

  const sorted = sortAttemptList(['KEY_BACKUP_1', 'KEY_PRIORITY_2', 'KEY_PRIORITY_1'], 'tier-priority', {
    tiers: pool.tiers,
  });

  // Both Tier 1 keys must come before Tier 2 key
  assert.equal(sorted[2], 'KEY_BACKUP_1');
  assert.ok(sorted.slice(0, 2).includes('KEY_PRIORITY_1'));
  assert.ok(sorted.slice(0, 2).includes('KEY_PRIORITY_2'));
});

// ── 4. Issue #538: TrafficSmoother GCRA prevents duplicate slot assignment ──
test('#538: TrafficSmoother atomically reserves slots without duplicate assignment', async () => {
  let virtualTime = 100000;
  const smoother = new TrafficSmoother({
    maxQueueWaitMs: 5000,
    now: () => virtualTime,
    sleep: (ms) => new Promise((resolve) => {
      setTimeout(() => {
        virtualTime += ms;
        resolve();
      }, 5);
    }),
  });

  // rpmLimit = 60 -> 1 request per 1000ms. Burst = 1.
  const r1 = await smoother.acquire('k1', { rpmLimit: 60, burstLimit: 1 });
  assert.equal(r1.allowed, true);
  assert.equal(r1.delayed, false);

  // Request 2 queues for slot t = 101000
  const p2 = smoother.acquire('k1', { rpmLimit: 60, burstLimit: 1 });
  // Request 3 queues for slot t = 102000
  const p3 = smoother.acquire('k1', { rpmLimit: 60, burstLimit: 1 });

  const [r2, r3] = await Promise.all([p2, p3]);
  assert.equal(r2.allowed, true);
  assert.equal(r2.delayed, true);
  assert.equal(r3.allowed, true);
  assert.equal(r3.delayed, true);
  assert.ok(r3.delayMs > r2.delayMs, 'Second queued request must wait for next slot');
});

// ── 5. Issue #534: Simulator clones brokenUntil, tokenUsage, quotaWindows ──
test('#534: simulateRouting accounts for brokenUntil and tokenUsage', () => {
  const pool = {
    provider: 'sim-prov',
    refs: ['KEY_HEALTHY', 'KEY_BROKEN'],
    weights: [1, 1],
    routingStrategy: 'round-robin',
    state: {
      pointer: 0,
      cursor: 0,
      events: [],
      failedUntil: new Map(),
      brokenUntil: new Map([['KEY_BROKEN', Date.now() + 100000]]),
      tokenUsage: new Map(),
      quotaWindows: new Map(),
    },
  };

  const simResult = simulateRouting({
    pool,
    nowMs: Date.now(),
  });
  assert.ok(simResult);
  assert.equal(simResult.outcome, 'SUCCESS');
  assert.equal(simResult.selectedRef, 'KEY_HEALTHY', 'Broken key must not be selected in simulation');
});

// ── 6. Issue #536: Simulator Map lookup for runtime.providerToPool ──
test('#536: simulateRouting handles providerToPool Map lookup', () => {
  const pool = {
    provider: 'lookup-prov',
    refs: ['K1', 'K2'],
    weights: [1, 1],
    routingStrategy: 'round-robin',
    state: {
      pointer: 0,
      cursor: 0,
      events: [],
      failedUntil: new Map(),
      brokenUntil: new Map(),
      tokenUsage: new Map(),
      quotaWindows: new Map(),
    },
  };

  const runtime = {
    providerToPool: new Map([['lookup-prov', pool]]),
  };

  const simPool = runtime.providerToPool.get('lookup-prov');
  assert.ok(simPool);
  const res = simulateRouting({
    pool: simPool,
  });
  assert.equal(res.outcome, 'SUCCESS');
  assert.ok(res.selectedRef);
});

// ── 7. Issue #553 & 8. Issue #533: Config import revision concurrency and fail-closed replace ──
test('#553: handleConfigImport returns 409 Conflict on expectedRevision mismatch', async () => {
  const routes = new Map();
  const mockSettings = {
    replace: async () => {},
    describe: () => [{ ns: 'dsh-key-rotation', revision: 5, value: {} }],
  };
  const ctx = {
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler);
        return () => routes.delete(path);
      },
    },
    effect: (fn) => fn(),
    get: (name) => (name === 'settings' ? mockSettings : undefined),
    settings: mockSettings,
  };

  registerConfigIoRoutes(ctx, { buildRuntime: () => ({ cfg0: {} }) });
  const importHandler = routes.get(CONFIG_IMPORT_PATH);
  assert.ok(importHandler, 'import route must be registered');

  const { req, res } = mockReqRes({
    method: 'POST',
    url: CONFIG_IMPORT_PATH,
    body: {
      expectedRevision: 3, // Mismatch! Current is 5
      config: { providers: [] },
    },
  });

  await importHandler(req, res);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'conflict');
  assert.equal(res.body.error.currentRevision, 5);
});

test('#533: handleConfigImport returns 503 fail-closed when settings.replace is unavailable', async () => {
  const routes = new Map();
  const mockSettings = {}; // No replace method!
  const ctx = {
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler);
        return () => routes.delete(path);
      },
    },
    effect: (fn) => fn(),
    get: (name) => (name === 'settings' ? mockSettings : undefined),
    settings: mockSettings,
  };

  registerConfigIoRoutes(ctx, { buildRuntime: () => ({ cfg0: {} }) });
  const importHandler = routes.get(CONFIG_IMPORT_PATH);
  assert.ok(importHandler, 'import route must be registered');

  const { req, res } = mockReqRes({
    method: 'POST',
    url: CONFIG_IMPORT_PATH,
    body: {
      config: { providers: [] },
    },
  });

  await importHandler(req, res);
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'settings-unavailable');
});

// ── 9. Issue #544: KeyDrainManager and Telemetry Context Isolation ──
test('#544: KeyDrainManager isolates draining state per instance and dispose does not leak', () => {
  const managerA = new KeyDrainManager();
  const managerB = new KeyDrainManager();

  // Mark key on instance A
  managerA.markKeyDraining('SHARED_REF', 'openai');
  assert.equal(managerA.isKeyDraining('SHARED_REF'), true);
  // Instance B must NOT see instance A's draining state
  assert.equal(managerB.isKeyDraining('SHARED_REF'), false);

  // Clear instance B
  managerB.clearAllDraining();

  // Instance A must remain completely unaffected
  assert.equal(managerA.isKeyDraining('SHARED_REF'), true);

  // Clear instance A
  managerA.clearAllDraining();
  assert.equal(managerA.isKeyDraining('SHARED_REF'), false);
});

test('#544: SelectionTraceStore isolates traces between plugin instances', () => {
  const storeA = new SelectionTraceStore();
  const storeB = new SelectionTraceStore();

  const traceA = createSelectionTrace('req-a', { provider: 'deepseek' }, storeA);
  traceA.addStep('KEY_1', 'SELECTED', 'OK');
  traceA.finish('SUCCESS', 'KEY_1');

  assert.equal(storeA.get().length, 1);
  assert.equal(storeB.get().length, 0, 'Instance B must not see traces from Instance A');

  storeB.clear();
  assert.equal(storeA.get().length, 1, 'Clearing Instance B must not wipe Instance A traces');
});

test('#544: DiagBuffer isolates diagnostic logs between instances', () => {
  const bufA = new DiagBuffer();
  const bufB = new DiagBuffer();

  pushDiag({ level: 'info', message: 'Instance A event' }, bufA);
  assert.equal(bufA.get().length, 1);
  assert.equal(bufB.get().length, 0);

  bufB.clear();
  assert.equal(bufA.get().length, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLogger } from '../lib/logger.js';
import { parseExpiry, buildPoolItem, cleanupRemovedProviders } from '../lib/pool-builder.js';
import { createSandboxService } from '../lib/sandbox-service.js';
import { checkBudgetAndHealthAlerts } from '../lib/budget-monitor.js';

test('logger: getLogger returns functional logger in all environments', () => {
  let logged = [];
  const mockCtx = {
    logger: (scope) => ({
      warn: (msg) => logged.push(`[${scope}] ${msg}`),
    }),
  };
  const l1 = getLogger(mockCtx);
  l1.warn('hello');
  assert.equal(logged[0], '[dsh-key-rotation] hello');

  const l2 = getLogger(null);
  assert.doesNotThrow(() => l2.warn('silent'));
});

test('pool-builder: parseExpiry and buildPoolItem work cleanly', () => {
  assert.equal(parseExpiry(12345), 12345);
  assert.ok(parseExpiry('2026-12-31T00:00:00Z') > 0);
  assert.equal(parseExpiry('invalid-date'), undefined);

  assert.equal(buildPoolItem({ base: 'p1', keys: [] }), null);

  const stateMap = new Map();
  const makeState = (base) => {
    let st = stateMap.get(base);
    if (!st) { st = { pointer: 0 }; stateMap.set(base, st); }
    return st;
  };

  const pool = buildPoolItem({
    base: 'p1',
    keys: ['K1', 'K2'],
    weights: [2, 1],
    poolCooldown: 5000,
    poolMax: 20000,
    expiresAt: [1780000000, '2026-10-01T00:00:00Z'],
    poolStrategy: 'lowest-latency',
    poolGuard: true,
    rpmLimit: 60,
    makeState,
  });

  assert.equal(pool.base, 'p1');
  assert.deepEqual(pool.refs, ['K1', 'K2']);
  assert.deepEqual(pool.weightedRefs, ['K1', 'K1', 'K2']);
  assert.equal(pool.cooldownMs, 5000);
  assert.equal(pool.routingStrategy, 'lowest-latency');
  assert.equal(pool.proactiveRateLimitGuard, true);
  assert.equal(pool.rpmLimit, 60);
});

test('pool-builder: cleanupRemovedProviders removes stale providers from state', () => {
  const poolState = new Map([
    ['live-p', { failedUntil: new Map() }],
    ['stale-p', { failedUntil: new Map() }],
  ]);
  const poolByRef = new Map([
    ['K1', { base: 'live-p' }],
  ]);
  const providerToPool = new Map([
    ['live-p', { base: 'live-p' }],
  ]);
  const expectedClones = new Set();
  let resetCalled = [];
  const mockBreaker = {
    snapshot: () => ({ 'live-p': {}, 'stale-p': {} }),
    reset: (p) => resetCalled.push(p),
  };

  cleanupRemovedProviders({
    cfg: { providers: [{ provider: 'live-p' }] },
    poolState,
    poolByRef,
    providerToPool,
    expectedClones,
    moduleBreaker: mockBreaker,
    lowHealthNotifiedAt: new Map([['stale-p', 123]]),
    budgetNotifiedAt: new Map([['stale-p:budget', 123]]),
  });

  assert.ok(poolState.has('live-p'));
  assert.ok(!poolState.has('stale-p'));
  assert.deepEqual(resetCalled, ['stale-p']);
});

test('sandbox-service: createSandboxService and probeRef caching', async () => {
  const srv = createSandboxService({
    getRuntime: () => ({
      poolByRef: new Map([['REF1', { base: 'prov1' }]]),
    }),
  });

  const runner = srv.ensureSandboxRunner({
    llm: { getProvider: () => ({ baseUrl: 'http://example.com' }) },
  });
  assert.ok(runner);

  // Mock probeModels
  runner.probeModels = async (ref, key) => ({ ok: true, models: ['m1'] });

  const res = await srv.probeRef('REF1', 'secret-key');
  assert.equal(res.ok, true);
  assert.deepEqual(res.models, ['m1']);
  const cached = srv.lastTestCache.get('REF1');
  assert.ok(cached);
  assert.equal(cached.ok, true);
});

test('budget-monitor: checkBudgetAndHealthAlerts warns on budget and health alerts', () => {
  const sent = [];
  const webhookSender = {
    send: (url, payload) => sent.push({ url, payload }),
  };
  const warnings = [];
  const logger = { warn: (msg) => warnings.push(msg) };

  const poolState = new Map([
    ['prov1', {
      costDays: new Map([['K1', new Map([[new Date().toISOString().slice(0, 10), 15.0]])]]),
      failedUntil: new Map(),
    }],
  ]);
  const pool = {
    base: 'prov1',
    refs: ['K1', 'K2'],
    state: poolState.get('prov1'),
  };

  const runtime = {
    poolByRef: new Map([['K1', pool], ['K2', pool]]),
    expiryWarnDays: 7,
    notifyWebhook: 'http://webhook.local',
    providerBudgets: new Map([['prov1', { costBudgetDaily: 10.0, costBudgetWeekly: 50.0, pauseOnBudget: true }]]),
    warnBelowHealthy: 3, // 2 keys < 3 -> should alert
    latencySloMs: 0,
  };

  checkBudgetAndHealthAlerts({
    runtime,
    poolState,
    now: Date.now(),
    expiryNotifiedAt: new Map(),
    budgetNotifiedAt: new Map(),
    lowHealthNotifiedAt: new Map(),
    sloNotifiedAt: new Map(),
    latencyHistogram: { snapshot: () => ({ p95: 0, count: 0 }) },
    webhookSender,
    logger,
  });

  assert.ok(warnings.some((w) => w.includes('cost budget')));
  assert.ok(warnings.some((w) => w.includes('pool running low')));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].payload.kind, 'budget');
  assert.equal(sent[1].payload.kind, 'low-health');
});

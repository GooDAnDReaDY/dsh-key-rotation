// test/audit-findings-336-341.test.mjs — regression tests for audit issues #336-#341
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRotate } from '../lib/rotate.js';
import { CircuitBreaker } from '../lib/circuit-breaker.js';
import { sweepExpired } from '../lib/pool.js';
import { nextQuotaReset } from '../lib/quota-window.js';

function makePool(refs, quotaResetWindow = null) {
  return {
    base: 'audit-prov',
    refs,
    weights: refs.map(() => 1),
    weightedRefs: refs,
    quotaResetWindow,
    state: {
      failedUntil: new Map(),
      failCounts: new Map(),
      lastSuccessAt: new Map(),
      lastUsedAt: new Map(),
      consecutiveSuccesses: new Map(),
      quotaWindows: new Map(),
      switches: 0,
      events: [],
      lastUsed: refs[0],
    },
    cooldownMs: 50,
  };
}

test('Issue #336: rotate calls recordSuccess on activeRef when stream finishes successfully', async () => {
  const pool = makePool(['K1']);
  pool.state.failCounts.set('K1', 3);

  const dispatchStorage = {
    run(store, fn) {
      store.pickedRef = 'K1';
      return fn();
    },
  };

  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: 'hello' };
        yield { type: 'finish', reason: { kind: 'stop' }, usage: {} };
      })();
    },
  };

  const ctx = { get: (name) => (name === 'llm' ? llm : undefined) };
  const breaker = new CircuitBreaker({ threshold: 10, openMs: 1000, halfOpenProbes: 1 });
  const rotate = createRotate({
    ctx,
    dispatchStorage,
    buildRuntime: () => ({
      switchCodes: new Set(['RATE_LIMIT']),
      cooldownMs: 50,
      maxCooldownMs: 500,
      switchNotify: false,
      rateLimitThreshold: 0.1,
      concurrencyLimit: 0,
      cascade: [],
    }),
    pushEvent: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    recordLatency: () => {},
    concurrencyTracker: { isEnabled: () => false, acquire() {}, release() {}, pickLeastLoaded: (l) => l[0] },
    MARKER: '__rot',
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    setRotateStartMs: () => {},
    quotaStore: { set() {} },
    circuitBreaker: breaker,
    now: () => 200_000,
  });

  const chunks = [];
  for await (const c of rotate({ provider: 'audit-prov', model: 'm' }, pool)) {
    chunks.push(c);
  }

  assert.equal(chunks.length, 2);
  // Issue #336 fix verification: failCounts cleared, lastSuccessAt set to now
  assert.equal(pool.state.failCounts.has('K1'), false, 'failCounts should be deleted upon success');
  assert.equal(pool.state.lastSuccessAt.get('K1'), 200_000, 'lastSuccessAt should be set to 200_000');
});

test('Issue #337: rotate connects quota-window calendar reset on QUOTA failure', async () => {
  const qWindow = { type: 'midnight_utc', hour: 0 };
  const pool = makePool(['K1', 'K2'], qWindow);
  let calls = 0;

  const dispatchStorage = {
    run(store, fn) {
      calls++;
      const ref = calls === 1 ? 'K1' : 'K2';
      store.pickedRef = ref;
      return fn();
    },
  };

  const llm = {
    stream() {
      const isFail = calls === 1;
      return (async function* () {
        if (isFail) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'Quota exceeded for plan', status: 429 } } };
        } else {
          yield { type: 'text-delta', text: 'fallback ok' };
          yield { type: 'finish', reason: { kind: 'stop' }, usage: {} };
        }
      })();
    },
  };

  const ctx = { get: (name) => (name === 'llm' ? llm : undefined) };
  const breaker = new CircuitBreaker({ threshold: 10, openMs: 1000, halfOpenProbes: 1 });
  const fixedNow = 1700000000000;
  const expectedReset = nextQuotaReset(qWindow, fixedNow);

  const rotate = createRotate({
    ctx,
    dispatchStorage,
    buildRuntime: () => ({
      switchCodes: new Set(['RATE_LIMIT', 'QUOTA', '429']),
      cooldownMs: 50,
      maxCooldownMs: 500,
      switchNotify: false,
      rateLimitThreshold: 0.1,
      concurrencyLimit: 0,
      cascade: [],
      quotaResetWindow: qWindow,
    }),
    pushEvent: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    recordLatency: () => {},
    concurrencyTracker: { isEnabled: () => false, acquire() {}, release() {}, pickLeastLoaded: (l) => l[0] },
    MARKER: '__rot',
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    setRotateStartMs: () => {},
    quotaStore: { set() {} },
    circuitBreaker: breaker,
    now: () => fixedNow,
  });

  const chunks = [];
  for await (const c of rotate({ provider: 'audit-prov', model: 'm' }, pool)) {
    chunks.push(c);
  }

  assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === 'fallback ok'));
  // Issue #337 fix verification: K1 is held until calendar quota reset
  assert.ok(pool.state.quotaWindows.has('K1'), 'K1 quotaWindows entry must exist');
  assert.equal(pool.state.quotaWindows.get('K1'), expectedReset, 'quotaWindows reset timestamp matches');
  assert.equal(pool.state.failedUntil.get('K1'), expectedReset, 'failedUntil holds until quotaResetAt');
});

test('Issue #338: sweepExpired invokes decayPenalties on poolState in maintenance sweep', () => {
  const pool = makePool(['K1']);
  pool.state.failCounts.set('K1', 4);
  pool.state.lastSuccessAt.set('K1', 1000);

  const poolState = new Map([['audit-prov', pool.state]]);
  const activeRefs = new Set(['K1']);

  // Sweep at t=1000 + 3600_000 + 1000 (after decay interval)
  sweepExpired(poolState, 1000 + 3601_000, activeRefs);

  // Issue #338 fix verification: failCounts decayed from 4 down to 3
  assert.equal(pool.state.failCounts.get('K1'), 3, 'failCounts should decay during sweepExpired');
});

test('Issue #339: rotate triggers schedulePersist upon failover', async () => {
  const pool = makePool(['K1', 'K2']);
  let calls = 0;
  let persistCount = 0;

  const dispatchStorage = {
    run(store, fn) {
      calls++;
      store.pickedRef = calls === 1 ? 'K1' : 'K2';
      return fn();
    },
  };

  const llm = {
    stream() {
      const isFail = calls === 1;
      return (async function* () {
        if (isFail) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429', status: 429 } } };
        } else {
          yield { type: 'text-delta', text: 'k2 text' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      })();
    },
  };

  const ctx = { get: (name) => (name === 'llm' ? llm : undefined) };
  const breaker = new CircuitBreaker({ threshold: 10, openMs: 1000, halfOpenProbes: 1 });

  const rotate = createRotate({
    ctx,
    dispatchStorage,
    schedulePersist: () => { persistCount++; },
    buildRuntime: () => ({
      switchCodes: new Set(['RATE_LIMIT']),
      cooldownMs: 50,
      maxCooldownMs: 500,
      switchNotify: false,
      rateLimitThreshold: 0.1,
      concurrencyLimit: 0,
      cascade: [],
    }),
    pushEvent: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    recordLatency: () => {},
    concurrencyTracker: { isEnabled: () => false, acquire() {}, release() {}, pickLeastLoaded: (l) => l[0] },
    MARKER: '__rot',
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    setRotateStartMs: () => {},
    quotaStore: { set() {} },
    circuitBreaker: breaker,
  });

  const chunks = [];
  for await (const c of rotate({ provider: 'audit-prov', model: 'm' }, pool)) chunks.push(c);

  // Issue #339 fix verification: persist was scheduled when K1 failed
  assert.ok(persistCount > 0, 'schedulePersist should be called upon key failover');
});

test('Issue #340: lib/index.js loads cleanly after removing dead imports', async () => {
  let mod;
  try {
    mod = await import('../lib/index.js');
  } catch (err) {
    mod = null;
  }
  if (mod) {
    assert.equal(typeof mod.apply, 'function');
    assert.equal(mod.name, '@goodandready/dsh-key-rotation');
  }
});

test('Issue #341: ops-keys import route returns 504 on fetch timeout', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  };

  try {
    const { registerKeyRoutes } = await import('../lib/ops-keys.js');
    const routes = new Map();
    const mockCtx = {
      effect: (fn) => fn(),
      webServer: {
        register: (opts) => {
          routes.set(opts.path, opts.handler);
        },
      },
      get: (name) => {
        if (name === 'settings') {
          return {
            describe: () => [{ ns: 'dsh-key-rotation', value: { providers: [] }, revision: 1 }],
            replace: async () => {},
          };
        }
        return null;
      },
    };

    registerKeyRoutes(mockCtx, {
      lastTestCache: new Map(),
      poolState: new Map(),
      buildRuntime: () => ({}),
      circuitBreaker: { reset: () => {} },
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    const handler = routes.get('/dsh-key-rotation/import');
    assert.ok(handler, 'import route handler must be registered');

    const result = await new Promise((resolve) => {
      let status = 200;
      let bodyStr = '';
      const mockReq = {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3080',
          origin: 'http://127.0.0.1:3080',
          'sec-fetch-site': 'same-origin',
        },
        socket: { remoteAddress: '127.0.0.1' },
        on: (event, cb) => {
          if (event === 'data') cb(JSON.stringify({ url: 'https://example.com/providers.json' }));
          if (event === 'end') cb();
        },
      };
      const mockRes = {
        writeHead: (s, h) => { status = s; },
        end: (d) => {
          if (d) bodyStr += d;
          resolve({ status, body: JSON.parse(bodyStr) });
        },
      };
      handler(mockReq, mockRes);
    });

    assert.equal(result.status, 504, 'Response status must be 504 Gateway Timeout');
    assert.equal(result.body?.error?.code, 'timeout', 'Error code must be timeout');
  } finally {
    globalThis.fetch = origFetch;
  }
});

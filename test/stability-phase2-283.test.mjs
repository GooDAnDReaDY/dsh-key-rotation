// test/stability-phase2-283.test.mjs — Unit coverage for Issue #283 Phase 2 enhancements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';

import {
  recordFailure,
  applyJitter,
  resetCircuitForProvider,
} from '../lib/pool.js';

import { CircuitBreaker } from '../lib/circuit-breaker.js';
import { registerOpsRoutes } from '../lib/routes-ops.js';

// =========================================================================
// 1. Jitter and Backoff Spread (#283)
// =========================================================================
test('applyJitter: bounds output within default +-12.5% factor', () => {
  const base = 60000;
  for (let i = 0; i < 50; i++) {
    const jittered = applyJitter(base);
    assert.ok(jittered >= 60000 * 0.875 - 1, `Jittered value ${jittered} too low`);
    assert.ok(jittered <= 60000 * 1.125 + 1, `Jittered value ${jittered} too high`);
  }
});

test('applyJitter: handles edge cases safely', () => {
  assert.equal(applyJitter(0), 0);
  assert.equal(applyJitter(-100), -100);
  assert.equal(applyJitter(NaN), NaN);
  assert.equal(applyJitter(Infinity), Infinity);
});

test('recordFailure: jitter=true introduces variation across repeated calls', () => {
  const pool = { state: { failedUntil: new Map(), failCounts: new Map() } };
  const values = new Set();
  for (let i = 0; i < 20; i++) {
    const b = recordFailure(pool, `K${i}`, 1000, 60000, 300000, false, true);
    values.add(b);
  }
  // Across 20 calls with +-12.5% jitter, we expect multiple distinct values
  assert.ok(values.size > 1, `Expected varied backoffs, got ${values.size}`);
});

// =========================================================================
// 2. Circuit Breaker Reset Helper (#283)
// =========================================================================
test('resetCircuitForProvider: handles null or undefined safely', () => {
  assert.equal(resetCircuitForProvider(null, 'openai'), false);
  assert.equal(resetCircuitForProvider(undefined, 'openai'), false);
  assert.equal(resetCircuitForProvider({}, null), false);
  assert.equal(resetCircuitForProvider({}, ''), false);
});

test('resetCircuitForProvider: resets circuitBreaker to closed state', () => {
  const cb = new CircuitBreaker({ threshold: 2, openMs: 60000 });
  cb.onFailure('openai');
  cb.onFailure('openai');
  assert.equal(cb.state('openai'), 'open');

  const ok = resetCircuitForProvider(cb, 'openai');
  assert.equal(ok, true);
  assert.equal(cb.state('openai'), 'closed');
});

// =========================================================================
// 3. Ops Route /reset Integration with Circuit Breaker (#283)
// =========================================================================
test('routes-ops: /dsh-key-rotation/reset resets both pool and circuit breaker', async () => {
  const routes = [];
  const mockCtx = {
    effect(fn) { fn(); },
    webServer: {
      register(cfg) {
        routes.push(cfg);
      },
    },
    get() { return null; },
  };

  const cb = new CircuitBreaker({ threshold: 2, openMs: 60000 });
  cb.onFailure('openai');
  cb.onFailure('openai');
  assert.equal(cb.state('openai'), 'open');

  const poolState = new Map([
    ['openai', {
      failedUntil: new Map([['K1', 999999]]),
      failCounts: new Map([['K1', 3]]),
      authFailCounts: new Map([['K1', 1]]),
      brokenUntil: new Map(),
      switches: 4,
      lastReason: 'RATE_LIMIT',
      lastSwitchAt: 12345,
    }],
  ]);

  registerOpsRoutes(mockCtx, {
    buildRuntime: () => ({ breaker: cb, poolByRef: new Map() }),
    latencyHistogram: null,
    lastTestCache: null,
    ensureSandboxRunner: () => null,
    poolState,
    getRotationDisabled: () => false,
    setRotationDisabled: () => {},
    circuitBreaker: cb,
  });

  const resetRoute = routes.find((r) => r.path === '/dsh-key-rotation/reset');
  assert.ok(resetRoute, 'Reset route must be registered');

  let writtenStatus = null;
  let writtenBody = null;
  const mockRes = {
    writeHead(status) { writtenStatus = status; },
    end(body) { writtenBody = JSON.parse(body); },
  };

  class MockReq extends EventEmitter {
    constructor() {
      super();
      this.method = 'POST';
      this.socket = { remoteAddress: '127.0.0.1' };
      this.headers = {};
    }
  }

  const req = new MockReq();
  const handlerPromise = resetRoute.handler(req, mockRes);
  req.emit('data', JSON.stringify({ provider: 'openai' }));
  req.emit('end');

  await handlerPromise;
  assert.equal(writtenStatus, 200);
  assert.equal(writtenBody.ok, true);
  assert.equal(writtenBody.provider, 'openai');
  assert.equal(writtenBody.cleared, 1);
  assert.equal(writtenBody.circuitReset, true);

  // Verify pool state was cleared
  const st = poolState.get('openai');
  assert.equal(st.failedUntil.size, 0);
  assert.equal(st.failCounts.size, 0);
  assert.equal(st.switches, 0);

  // Verify circuit was closed
  assert.equal(cb.state('openai'), 'closed');
});

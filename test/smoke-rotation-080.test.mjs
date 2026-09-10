// test/smoke-rotation-080.test.mjs — e2e-ish smoke: 429 => switch (#269)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRotate } from '../lib/rotate.js';
import { CircuitBreaker } from '../lib/circuit-breaker.js';
import { recordFailure } from '../lib/pool.js';

function makePool(refs) {
  return {
    base: 'smoke-prov',
    refs,
    weights: refs.map(() => 1),
    weightedRefs: refs,
    state: {
      failedUntil: new Map(),
      failCounts: new Map(),
      switches: 0,
      events: [],
      lastUsed: refs[0],
    },
    cooldownMs: 50,
  };
}

test('smoke: first key 429 then second succeeds', async () => {
  const pool = makePool(['K1', 'K2']);
  let calls = 0;
  const picked = [];
  const dispatchStorage = {
    run(store, fn) {
      // pick next healthy
      const now = Date.now();
      let ref = pool.refs.find((r) => (pool.state.failedUntil.get(r) ?? 0) <= now);
      store.pickedRef = ref;
      picked.push(ref);
      calls++;
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
            yield { type: 'text-delta', text: 'ok' };
            yield { type: 'finish', reason: { kind: 'stop' }, usage: {} };
          }
        })();
      },
  };
  const ctx = { get: (name) => (name === 'llm' ? llm : undefined) };
  const breaker = new CircuitBreaker({ threshold: 10, openMs: 1000, halfOpenProbes: 1 });
  const rotate = createRotate({
    ctx,
    dispatchStorage,
    buildRuntime: () => ({
      switchCodes: new Set(['RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'AUTH']),
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
  for await (const c of rotate({ provider: 'smoke-prov', model: 'm' }, pool)) chunks.push(c);
  const text = chunks.filter((c) => c.type === 'text-delta');
  assert.equal(text.length, 1);
  assert.equal(text[0].text, 'ok');
  assert.ok(picked.includes('K1'));
  assert.ok(picked.includes('K2'));
  assert.ok((pool.state.failedUntil.get('K1') ?? 0) > Date.now() - 1);
  assert.equal(breaker.state('smoke-prov'), 'closed');
});

test('smoke: circuit open skips dispatch', async () => {
  const pool = makePool(['K1']);
  const breaker = new CircuitBreaker({ threshold: 1, openMs: 10_000, halfOpenProbes: 1 });
  breaker.onFailure('smoke-prov'); // open immediately
  let dispatched = 0;
  const rotate = createRotate({
    ctx: { get: (name) => (name === 'llm' ? { stream: () => { dispatched++; return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })(); } } : undefined) },
    dispatchStorage: { run: (_s, fn) => fn() },
    buildRuntime: () => ({ switchCodes: new Set(['RATE_LIMIT']), cooldownMs: 50, switchNotify: false, concurrencyLimit: 0, cascade: [] }),
    pushEvent: () => {}, notifySwitch: () => {}, notifyExhaustion: () => {}, recordLatency: () => {},
    concurrencyTracker: { isEnabled: () => false },
    MARKER: '__rot',
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    setRotateStartMs: () => {},
    circuitBreaker: breaker,
  });
  const out = [];
  for await (const c of rotate({ provider: 'smoke-prov' }, pool)) out.push(c);
  assert.equal(dispatched, 0);
  assert.equal(out[0]?.reason?.failure?.code, 'CIRCUIT_OPEN');
});

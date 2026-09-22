import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CircuitBreaker } from '../lib/circuit-breaker.js';
import { createRotate } from '../lib/rotate.js';
import { pushEvent } from '../lib/notify-events.js';

function clock(opts = {}) {
  let t = 0;
  const breaker = new CircuitBreaker({ threshold: 2, openMs: 100, now: () => t, ...opts });
  return { breaker, at: (value) => { t = value; } };
}
function open(b) { for (let n = 0; n < b.threshold; n++) b.onFailure('demo'); }
const finish = (kind = 'stop', code, message = 'failure') => ({ type: 'finish', reason: { kind, ...(code ? { failure: { code, message } } : {}) } });
const collect = async (stream) => { const chunks = []; for await (const c of stream) chunks.push(c); return chunks; };
function harness(chunks, options = {}) {
  const { breaker, at } = clock();
  if (options.halfOpen) { open(breaker); at(100); }
  const pool = { base: options.base ?? 'demo', refs: ['DUMMY_KEY'], state: { failedUntil: new Map(), failCounts: new Map([['DUMMY_KEY', 2]]), events: [], pointer: 0, lastUsed: 'DUMMY_KEY' } };
  let calls = 0;
  const runtime = { switchCodes: ['QUOTA', 'TRANSPORT', 'TIMEOUT'], cooldownMs: 1000, concurrencyLimit: 0, ...options.runtime };
  const rotate = createRotate({
    ctx: { get: () => ({ stream: () => { calls++; return (async function* () { for (const item of chunks) { if (item instanceof Error) throw item; yield item; } })(); } }) },
    dispatchStorage: new AsyncLocalStorage(), buildRuntime: () => runtime, pushEvent,
    notifySwitch: () => {}, notifyExhaustion: () => {}, recordLatency: () => {},
    concurrencyTracker: { isEnabled: () => false }, MARKER: '__test', finishError: (code, message) => finish('error', code, message),
    setRotateStartMs: () => {}, circuitBreaker: breaker, now: () => 100,
  });
  return { breaker, pool, at, calls: () => calls, stream: () => rotate({ provider: 'demo' }, pool) };
}

test('closed failures reach the threshold and success resets them', () => {
  const { breaker: b } = clock(); b.onFailure('demo'); assert.equal(b.state('demo'), 'closed'); b.onSuccess('demo'); assert.equal(b.snapshot().demo.fails, 0); open(b); assert.equal(b.canRequest('demo'), false);
});
test('first half-open request consumes the single configured probe', () => {
  const { breaker: b, at } = clock(); open(b); at(100); assert.equal(b.canRequest('demo'), true); assert.equal(b.canRequest('demo'), false);
});
test('half-open budget allows exactly N probes, not N plus one', () => {
  const { breaker: b, at } = clock({ halfOpenProbes: 3 }); open(b); at(100);
  assert.deepEqual([b.canRequest('demo'), b.canRequest('demo'), b.canRequest('demo'), b.canRequest('demo')], [true, true, true, false]);
});
test('late failures while open do not slide the recovery window', () => {
  const { breaker: b, at } = clock(); open(b); at(80); b.onFailure('demo'); assert.equal(b.snapshot().demo.openedAt, 0); assert.equal(b.snapshot().demo.fails, 2); at(100); assert.equal(b.canRequest('demo'), true);
});
test('snapshot preserves a valid openedAt timestamp of zero', () => {
  const { breaker: b } = clock(); open(b); assert.equal(b.snapshot().demo.openedAt, 0);
});
test('a failed half-open probe starts a new full cooldown', () => {
  const { breaker: b, at } = clock(); open(b); at(100); assert.ok(b.canRequest('demo')); b.onFailure('demo'); at(199); assert.equal(b.canRequest('demo'), false); at(200); assert.equal(b.canRequest('demo'), true);
});
test('permits release cancelled probes without pretending they succeeded', () => {
  const { breaker: b, at } = clock(); open(b); at(100); const p = b.acquire('demo'); assert.ok(p); assert.equal(b.acquire('demo'), null); p.release(); assert.equal(b.state('demo'), 'half_open'); assert.ok(b.acquire('demo'));
});
test('permit settlement is idempotent', () => {
  const { breaker: b } = clock(); const p = b.acquire('demo'); p.failure(); p.failure(); p.success(); p.release(); assert.equal(b.snapshot().demo.fails, 1);
});
test('a still-running probe is not silently replaced just because time passed', () => {
  const { breaker: b, at } = clock(); open(b); at(100); const p = b.acquire('demo'); at(100000); assert.equal(b.acquire('demo'), null); p.release(); assert.ok(b.acquire('demo'));
});
test('late success from before opening cannot close the new circuit', () => {
  const { breaker: b } = clock(); const slow = b.acquire('demo'); open(b); slow.success(); assert.equal(b.state('demo'), 'open');
});
test('releasing an old permit cannot release a newer probe', () => {
  const { breaker: b, at } = clock(); const slow = b.acquire('demo'); open(b); at(100); const probe = b.acquire('demo'); slow.release(); assert.equal(b.acquire('demo'), null); probe.release(); assert.ok(b.acquire('demo'));
});
test('reset invalidates outstanding permits', () => {
  const { breaker: b } = clock(); const old = b.acquire('demo'); b.reset('demo'); const fresh = b.acquire('demo'); old.failure(); assert.equal(b.snapshot().demo.fails, 0); fresh.failure(); assert.equal(b.snapshot().demo.fails, 1);
});
test('restored half-open snapshots have no phantom in-flight probes', () => {
  const { breaker: b } = clock(); b.restore({ demo: { state: 'half_open', fails: 2, openedAt: 0 } }); assert.equal(b.canRequest('demo'), true); assert.equal(b.canRequest('demo'), false);
});
test('late startup restore preserves already-observed live breaker state', () => {
  const { breaker: b } = clock(); b.onSuccess('demo'); b.restore({ demo: { state: 'open', fails: 5, openedAt: 0 }, other: { state: 'open', fails: 5, openedAt: 0 } }, { preserveExisting: true }); assert.equal(b.state('demo'), 'closed'); assert.equal(b.state('other'), 'open');
});
test('configuration changes actual threshold, cooldown and probe budget', () => {
  const { breaker: b, at } = clock(); b.configure({ threshold: 1, openMs: 500, halfOpenProbes: 2 }); b.onFailure('demo'); at(100); assert.equal(b.canRequest('demo'), false); at(500); assert.ok(b.canRequest('demo')); assert.ok(b.canRequest('demo')); assert.equal(b.canRequest('demo'), false);
});
test('large millisecond configuration does not wrap through 32-bit coercion', () => {
  const { breaker: b } = clock({ openMs: 3_000_000_000 }); assert.equal(b.openMs, 3_000_000_000);
});
test('different providers remain independent', () => {
  const { breaker: b } = clock(); open(b); assert.equal(b.canRequest('other'), true); assert.equal(b.canRequest('demo'), false);
});
test('non-switchable error finish neither records success nor closes a half-open circuit', async () => {
  const h = harness([finish('error', 'BAD_REQUEST')], { halfOpen: true }); const out = await collect(h.stream()); assert.equal(out.at(-1).reason.failure.code, 'BAD_REQUEST'); assert.equal(h.pool.state.failCounts.get('DUMMY_KEY'), 2); assert.equal(h.pool.state.lastSuccessAt?.has('DUMMY_KEY') ?? false, false); assert.equal(h.breaker.state('demo'), 'half_open'); assert.ok(h.breaker.canRequest('demo'));
});
test('aborted finish releases probe without recording key success', async () => {
  const h = harness([finish('aborted')], { halfOpen: true }); await collect(h.stream()); assert.equal(h.pool.state.failCounts.get('DUMMY_KEY'), 2); assert.equal(h.breaker.state('demo'), 'half_open'); assert.ok(h.breaker.canRequest('demo'));
});
test('mid-stream error is penalized but never replayed', async () => {
  const h = harness([{ type: 'text-delta', text: 'partial' }, finish('error', 'TRANSPORT')], { halfOpen: true }); const out = await collect(h.stream()); assert.equal(out.at(-1).reason.failure.code, 'TRANSPORT'); assert.equal(h.calls(), 1); assert.equal(h.breaker.state('demo'), 'open'); assert.equal(h.pool.state.lastSuccessAt?.size ?? 0, 0);
});
test('mid-stream thrown transport error is penalized but never replayed', async () => {
  const h = harness([{ type: 'reasoning-delta', text: 'partial' }, Object.assign(new Error('socket hang up'), { code: 'TRANSPORT' })], { halfOpen: true }); await collect(h.stream()); assert.equal(h.calls(), 1); assert.equal(h.breaker.state('demo'), 'open');
});
test('consumer cancellation releases its half-open permit and does not fake success', async () => {
  const h = harness([{ type: 'text-delta', text: 'partial' }], { halfOpen: true }); const it = h.stream(); await it.next(); await it.return(); assert.equal(h.breaker.state('demo'), 'half_open'); assert.equal(h.pool.state.failCounts.get('DUMMY_KEY'), 2); assert.ok(h.breaker.canRequest('demo')); assert.equal(h.breaker.canRequest('demo'), false);
});
test('empty EOF releases a probe instead of leaving the provider stuck', async () => {
  const h = harness([], { halfOpen: true }); await collect(h.stream()); assert.ok(h.breaker.canRequest('demo')); assert.equal(h.breaker.canRequest('demo'), false);
});
test('clean content EOF records success and closes the half-open circuit', async () => {
  const h = harness([{ type: 'text-delta', text: 'ok' }], { halfOpen: true }); await collect(h.stream()); assert.equal(h.breaker.state('demo'), 'closed'); assert.equal(h.pool.state.failCounts.size, 0);
});
test('success is committed before yielding its terminal chunk', async () => {
  const h = harness([finish('tool-calls')], { halfOpen: true }); const it = h.stream(); assert.equal((await it.next()).value.reason.kind, 'tool-calls'); await it.return(); assert.equal(h.breaker.state('demo'), 'closed');
});
test('local iterator errors release a probe without making a key healthy', async () => {
  const h = harness([new TypeError('local parser broke')], { halfOpen: true }); await collect(h.stream()); assert.equal(h.pool.state.failCounts.get('DUMMY_KEY'), 2); assert.equal(h.breaker.state('demo'), 'half_open'); assert.ok(h.breaker.canRequest('demo')); assert.equal(h.breaker.canRequest('demo'), false);
});
test('disabled breaker neither blocks dispatch nor changes its state', async () => {
  const h = harness([finish('error', 'QUOTA')], { runtime: { circuitBreakerEnabled: false } }); open(h.breaker); const before = h.breaker.snapshot(); await collect(h.stream()); assert.equal(h.calls(), 1); assert.deepEqual(h.breaker.snapshot(), before);
});
test('per-model pools record failure against the same provider used by admission', async () => {
  const h = harness([finish('error', 'QUOTA')], { base: 'demo::model', halfOpen: true }); await collect(h.stream()); assert.equal(h.breaker.state('demo'), 'open'); assert.equal(Object.hasOwn(h.breaker.snapshot(), 'demo::model'), false);
});
test('one rotate call stops dispatching as soon as provider threshold is reached', async () => {
  const h = harness([finish('error', 'TRANSPORT')]); h.pool.refs = Array.from({ length: 10 }, (_, n) => `DUMMY_${n}`); const out = await collect(h.stream()); assert.equal(h.calls(), 2); assert.equal(out.at(-1).reason.failure.code, 'CIRCUIT_OPEN');
});

// Exercise apply()/settings/hook wiring, not just the breaker class in isolation.
async function hostHarness(initial) {
  const plugin = await import(`../lib/index.js?host=${initial.name}`);
  let config = { persistenceEnabled: false, providers: [{ provider: 'demo', keys: ['DUMMY_KEY'] }], ...initial };
  const hooks = new Map();
  const profiles = { demo: { apiKeyEnv: 'DUMMY_KEY' } };
  const settings = { get: () => ({ providers: profiles }), register: () => ({ get: () => config }) };
  let calls = 0;
  const ctx = {
    webServer: { register: () => () => {} },
    get: (name) => name === 'settings' ? settings : name === 'llm' ? { stream: async function* () {
      calls++; plugin.getRuntime().poolByRef.get('DUMMY_KEY').state.lastUsed = 'DUMMY_KEY';
      yield finish('error', 'QUOTA');
    } } : null,
    effect: (fn, label) => {
      if (label === 'dsh-key-rotation: llm/stream' || label === 'dsh-key-rotation: agent/request-error') fn();
    },
    on: (name, fn) => { hooks.set(name, fn); return () => {}; },
    inject: (_, fn) => fn(ctx),
  };
  plugin.apply(ctx, config);
  return {
    run: () => collect(hooks.get('llm/stream')({ provider: 'demo' }, () => { throw new Error('unexpected bypass'); })),
    error: () => hooks.get('agent/request-error')({ provider: 'demo', failure: { code: 'QUOTA', message: 'quota exhausted' } }, () => null),
    update: (changes) => { config = { ...config, ...changes }; }, calls: () => calls,
  };
}
test('apply wires configured threshold into the breaker actually used for dispatch', async () => {
  const h = await hostHarness({ name: 'threshold', circuitBreakerThreshold: 1 });
  assert.equal((await h.run()).at(-1).reason.failure.code, 'QUOTA');
  assert.equal((await h.run()).at(-1).reason.failure.code, 'CIRCUIT_OPEN');
  assert.equal(h.calls(), 1);
});
test('disabled agent hook does not poison the circuit later re-enabled through settings', async () => {
  const h = await hostHarness({ name: 'disabled-agent', circuitBreakerEnabled: false, circuitBreakerThreshold: 1 });
  for (let n = 0; n < 6; n++) await h.error();
  h.update({ circuitBreakerEnabled: true });
  assert.equal((await h.run()).at(-1).reason.failure.code, 'QUOTA');
  assert.equal((await h.run()).at(-1).reason.failure.code, 'CIRCUIT_OPEN');
  assert.equal(h.calls(), 1);
});

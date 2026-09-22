import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { StatePersistence } from '../lib/persistence.js';
import { pushEvent } from '../lib/notify-events.js';
import { createRotate } from '../lib/rotate.js';
import { CircuitBreaker } from '../lib/circuit-breaker.js';
import { buildPoolItem } from '../lib/pool-builder.js';

const NOW = 1790049754447;
const RESET = 1790121600000;
const snap = (pools) => ({ version: 1, pools });
const saved = (extra = {}) => ({ failedUntil: {}, pointer: 0, lastUsed: null, ...extra });
function restored(extra = {}) {
  const states = new Map();
  StatePersistence.restorePools(states, snap({ demo: saved(extra) }));
  return states;
}
function poolFrom(states) {
  return buildPoolItem({ base: 'demo', keys: ['DUMMY_KEY'], poolCooldown: 60000, makeState: () => states.get('demo') });
}
const finish = (kind, code, message) => ({ type: 'finish', reason: { kind, ...(code ? { failure: { code, message } } : {}) } });
function harness(pool, failures, breaker = new CircuitBreaker({ now: () => NOW })) {
  let calls = 0;
  const runtime = { switchCodes: ['QUOTA', 'TRANSPORT', 'TIMEOUT'], cooldownMs: 60000, concurrencyLimit: 0, quotaResetWindow: { type: 'midnight_utc', hour: 0 } };
  const rotate = createRotate({
    ctx: { get: () => ({ stream: async function* () { const value = failures[calls++]; pool.state.lastUsed = 'DUMMY_KEY'; yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }; yield value; } }) },
    dispatchStorage: new AsyncLocalStorage(), buildRuntime: () => runtime, pushEvent,
    notifySwitch: () => {}, notifyExhaustion: () => {}, recordLatency: () => {},
    concurrencyTracker: { isEnabled: () => false }, MARKER: '__test',
    finishError: (code, message) => finish('error', code, message), setRotateStartMs: () => {},
    circuitBreaker: breaker, now: () => NOW,
  });
  return { run: async () => { const chunks = []; for await (const c of rotate({ provider: 'demo' }, pool)) chunks.push(c); return chunks; }, breaker, calls: () => calls };
}

test('restores all runtime maps and event ring, not only serialized fields', () => {
  const state = restored().get('demo');
  for (const name of ['failedUntil', 'failCounts', 'authFailCounts', 'brokenUntil', 'costPerKey', 'lastUsedAt', 'usageCounts', 'byModel', 'usageDays', 'quotaWindows', 'costDays']) assert.ok(state[name] instanceof Map, name);
  assert.deepEqual(state.events, []);
});
test('keeps persisted cooldown/cursor while creating transient fields', () => {
  const state = restored({ failedUntil: { DUMMY_KEY: RESET }, pointer: 2, lastUsed: 'DUMMY_KEY' }).get('demo');
  assert.equal(state.failedUntil.get('DUMMY_KEY'), RESET); assert.equal(state.pointer, 2); assert.equal(state.lastUsed, 'DUMMY_KEY');
  assert.doesNotThrow(() => pushEvent({ state }, 'DUMMY_KEY', 'QUOTA', 60000));
});
test('restored pools do not share their maps or event buffers', () => {
  const states = new Map(); StatePersistence.restorePools(states, snap({ a: saved(), b: saved() }));
  pushEvent({ state: states.get('a') }, 'A', 'QUOTA', 1);
  states.get('a').failCounts.set('A', 1);
  assert.deepEqual(states.get('b').events, []); assert.equal(states.get('b').failCounts.size, 0);
});
test('hydrates an already-built but idle pool in place', () => {
  const state = { failedUntil: new Map(), pointer: 0, lastUsed: null, events: [] };
  const states = new Map([['demo', state]]); const pool = poolFrom(states); const cooldowns = state.failedUntil;
  StatePersistence.restorePools(states, snap({ demo: saved({ failedUntil: { DUMMY_KEY: RESET }, pointer: 2, lastUsed: 'OLD' }) }));
  assert.equal(states.get('demo'), pool.state); assert.equal(state.failedUntil, cooldowns);
  assert.equal(state.failedUntil.get('DUMMY_KEY'), RESET); assert.equal(state.pointer, 2); assert.ok(state.failCounts instanceof Map);
});
test('a late startup restore cannot undo a live success or cursor', () => {
  const state = { failedUntil: new Map(), pointer: 1, lastUsed: 'LIVE', lastUsedAt: new Map([['LIVE', NOW]]), events: [] };
  const states = new Map([['demo', state]]);
  StatePersistence.restorePools(states, snap({ demo: saved({ failedUntil: { LIVE: RESET }, pointer: 0, lastUsed: 'OLD' }) }));
  assert.equal(states.get('demo'), state); assert.equal(state.failedUntil.size, 0); assert.equal(state.pointer, 1); assert.equal(state.lastUsed, 'LIVE');
});
test('a late restore cannot replace a newer live penalty', () => {
  const state = { failedUntil: new Map([['DUMMY_KEY', RESET + 1000]]), pointer: 0, lastUsed: null };
  const states = new Map([['demo', state]]);
  StatePersistence.restorePools(states, snap({ demo: saved({ failedUntil: { DUMMY_KEY: NOW } }) }));
  assert.equal(state.failedUntil.get('DUMMY_KEY'), RESET + 1000); assert.ok(Array.isArray(state.events));
});
test('legacy partial event state remains bounded and does not throw', () => {
  const pool = { state: {} }; for (let i = 0; i < 60; i++) pushEvent(pool, `K${i}`, 'QUOTA', i);
  assert.equal(pool.state.events.length, 50); assert.equal(pool.state.events[0].ref, 'K10');
});
test('an existing valid event buffer is retained', () => {
  const events = []; const pool = { state: { events } }; pushEvent(pool, 'K', 'TIMEOUT', 10);
  assert.equal(pool.state.events, events); assert.equal(events[0].reason, 'TIMEOUT');
});
test('malformed persisted entries are ignored without constructing array pools', () => {
  const states = new Map(); assert.equal(StatePersistence.restorePools(states, snap([])), 0);
  assert.equal(StatePersistence.restorePools(states, snap({ bad: [], absent: null, valid: saved({ pointer: -1, failedUntil: { good: RESET, bad: '1' } }) })), 1);
  assert.equal(states.get('valid').pointer, 0); assert.deepEqual([...states.get('valid').failedUntil], [['good', RESET]]);
});
test('serialization does not persist transient events, counters or credentials', () => {
  const states = restored(); const pool = poolFrom(states); pushEvent(pool, 'DUMMY_KEY', 'QUOTA', 1);
  const encoded = StatePersistence.serialize({ poolState: states });
  assert.deepEqual(Object.keys(encoded.pools.demo).sort(), ['failedUntil', 'lastUsed', 'pointer']);
  assert.equal(JSON.stringify(encoded).includes('events'), false);
});
test('restored QUOTA failure keeps original error AND calendar penalty instead of a push TypeError', async () => {
  const pool = poolFrom(restored()); const original = finish('error', 'QUOTA', 'quota exhausted');
  const h = harness(pool, [original]); const chunks = await h.run();
  assert.deepEqual(chunks.at(-1), original); assert.equal(pool.state.failedUntil.get('DUMMY_KEY'), RESET);
  assert.equal(pool.state.events[0].reason, 'QUOTA'); assert.equal(h.breaker.snapshot().demo.fails, 1);
});
test('five real quota failures still open the circuit; fix does not disable protection', async () => {
  const pool = poolFrom(restored()); const original = finish('error', 'QUOTA', 'quota exhausted');
  const h = harness(pool, Array(5).fill(original));
  for (let i = 0; i < 5; i++) assert.deepEqual((await h.run()).at(-1), original);
  assert.equal((await h.run()).at(-1).reason.failure.code, 'CIRCUIT_OPEN'); assert.equal(h.calls(), 5);
  assert.equal(pool.state.events.length, 5); assert.equal(h.breaker.snapshot().demo.fails, 5);
});
test('intermittent successful tool calls remain successful between real failures', async () => {
  const pool = poolFrom(restored()); const original = finish('error', 'QUOTA', 'quota exhausted'); const ok = finish('tool-calls');
  const h = harness(pool, [original, ok, original]);
  assert.deepEqual((await h.run()).at(-1), original); assert.deepEqual((await h.run()).at(-1), ok);
  assert.equal(h.breaker.snapshot().demo.fails, 0); assert.deepEqual((await h.run()).at(-1), original);
});
test('non-quota failures retain their original message and short cooldown', async () => {
  const pool = poolFrom(restored()); const original = finish('error', 'TIMEOUT', 'upstream timeout');
  const h = harness(pool, [original]); assert.deepEqual((await h.run()).at(-1), original);
  assert.ok(pool.state.failedUntil.get('DUMMY_KEY') < NOW + 12000); assert.notEqual(pool.state.failedUntil.get('DUMMY_KEY'), RESET);
});

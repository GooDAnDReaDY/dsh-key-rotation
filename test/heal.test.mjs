// test/heal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healIdleCooldowns } from '../lib/heal.js';

function makePool(base, refs, options = {}) {
  const now = options.now || Date.now();
  const fu = new Map();
  const lu = new Map();
  for (const r of refs) {
    if (options.failedUntil && options.failedUntil[r] !== undefined) fu.set(r, options.failedUntil[r]);
    if (options.lastUsed && options.lastUsed[r] !== undefined) lu.set(r, options.lastUsed[r]);
  }
  const pool = {
    base,
    refs,
    state: { failedUntil: fu, lastUsed: lu, events: [] },
  };
  return pool;
}

test('healIdleCooldowns: removes only refs that are expired AND idle AND ever-used', () => {
  const now = 1_000_000;
  const pool = makePool('openrouter', ['A', 'B', 'C'], {
    now,
    failedUntil: { A: now - 1, B: now + 1000, C: now - 1 }, // A,C expired, B still active
    lastUsed:    { A: now - 7200_000, B: now - 7200_000, C: now - 60_000 }, // A,B idle 2h; C idle 1m
  });
  const healed = healIdleCooldowns([pool], 3600_000, now);
  assert.equal(healed.length, 1);
  assert.equal(healed[0].ref, 'A');
  assert.equal(pool.state.failedUntil.has('A'), false);
  assert.equal(pool.state.failedUntil.has('B'), true, 'B still active cooldown');
  assert.equal(pool.state.failedUntil.has('C'), true, 'C used recently');
  // event pushed
  assert.equal(pool.state.events.length, 1);
  assert.equal(pool.state.events[0].type, 'heal');
  assert.equal(pool.state.events[0].reason, 'self-heal');
});

test('healIdleCooldowns: no-op when pool is undefined or empty', () => {
  const healed1 = healIdleCooldowns([], 1000, 0);
  const healed2 = healIdleCooldowns(null, 1000, 0);
  const healed3 = healIdleCooldowns(undefined, 1000, 0);
  assert.deepEqual(healed1, []);
  assert.deepEqual(healed2, []);
  assert.deepEqual(healed3, []);
});

test('healIdleCooldowns: no-op when idleMs is invalid', () => {
  const pool = makePool('openrouter', ['A'], {
    failedUntil: { A: 0 },
    lastUsed: { A: 0 },
  });
  assert.deepEqual(healIdleCooldowns([pool], 0, 1), []);
  assert.deepEqual(healIdleCooldowns([pool], -100, 1), []);
  assert.deepEqual(healIdleCooldowns([pool], NaN, 1), []);
});

test('healIdleCooldowns: skips ref without lastUsed (never used → no signal)', () => {
  const now = 1_000_000;
  const pool = makePool('openrouter', ['A'], {
    failedUntil: { A: now - 1 },
    lastUsed: {}, // A never used
  });
  const healed = healIdleCooldowns([pool], 1000, now);
  assert.equal(healed.length, 0);
  assert.equal(pool.state.failedUntil.has('A'), true);
});

test('healIdleCooldowns: skips ref whose cooldown is still in the future', () => {
  const now = 1_000_000;
  const pool = makePool('openrouter', ['A'], {
    failedUntil: { A: now + 5000 },
    lastUsed:    { A: now - 7200_000 },
  });
  const healed = healIdleCooldowns([pool], 3600_000, now);
  assert.equal(healed.length, 0);
  assert.equal(pool.state.failedUntil.has('A'), true);
});

test('healIdleCooldowns: skips ref that is still actively used', () => {
  const now = 1_000_000;
  const pool = makePool('openrouter', ['A'], {
    failedUntil: { A: now - 1 },
    lastUsed:    { A: now - 60_000 },
  });
  const healed = healIdleCooldowns([pool], 3600_000, now);
  assert.equal(healed.length, 0);
});

test('healIdleCooldowns: multiple pools processed; only affected entries reported', () => {
  const now = 1_000_000;
  const a = makePool('a', ['x'], { failedUntil: { x: now - 1 }, lastUsed: { x: now - 7200_000 } });
  const b = makePool('b', ['y'], { failedUntil: { y: now - 1 }, lastUsed: { y: now - 7200_000 } });
  const c = makePool('c', ['z'], { failedUntil: { z: now + 1 }, lastUsed: { z: now - 7200_000 } });
  const healed = healIdleCooldowns([a, b, c], 3600_000, now);
  assert.equal(healed.length, 2);
  assert.equal(a.state.failedUntil.size, 0);
  assert.equal(b.state.failedUntil.size, 0);
  assert.equal(c.state.failedUntil.size, 1);
});

test('healIdleCooldowns: events cap to 50', () => {
  const now = 1_000_000;
  const fu = {};
  const lu = {};
  for (let i = 0; i < 60; i++) {
    fu[`k${i}`] = now - 1;
    lu[`k${i}`] = now - 7200_000;
  }
  const pool = makePool('p', Object.keys(fu), { failedUntil: fu, lastUsed: lu });
  for (let i = 0; i < 50; i++) pool.state.events.push({ at: now - 1000, ref: `prev${i}`, reason: 'pre', cooldownMs: 60_000, type: 'fail' });
  const healed = healIdleCooldowns([pool], 3600_000, now);
  assert.equal(healed.length, 60);
  assert.equal(pool.state.events.length, 50);
  // last event must be one of the new heal events
  assert.equal(pool.state.events[49].type, 'heal');
});

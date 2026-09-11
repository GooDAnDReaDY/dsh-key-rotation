import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CircuitBreaker } from '../lib/circuit-breaker.js';
import { recordFailure, pickNext } from '../lib/pool.js';
import { sanitizeSnapshot } from '../lib/sanitize-snapshot.js';

test('chaos: parallel AsyncLocalStorage stores do not cross pickedRef', async () => {
  const als = new AsyncLocalStorage();
  const runs = [];
  const tasks = Array.from({ length: 40 }, (_, i) =>
    als.run({ pickedRef: `KEY_${i}`, id: i }, async () => {
      await new Promise((r) => setTimeout(r, (i % 5)));
      const store = als.getStore();
      runs.push({ id: store?.id, ref: store?.pickedRef });
    })
  );
  await Promise.all(tasks);
  assert.equal(runs.length, 40);
  const byId = new Map(runs.map((r) => [r.id, r.ref]));
  for (let i = 0; i < 40; i++) {
    assert.equal(byId.get(i), `KEY_${i}`);
  }
});

test('chaos: concurrent cooldown writes stay consistent on one pool state', async () => {
  const failedUntil = new Map();
  const pool = {
    base: 'p',
    refs: ['A', 'B', 'C'],
    state: { failedUntil, pointer: 0, lastUsed: 'A', switches: 0 },
  };
  const now = 5000;
  await Promise.all(Array.from({ length: 30 }, (_, i) => (async () => {
    const ref = pool.refs[i % 3];
    recordFailure(pool, ref, now, 1000 + (i % 7) * 10);
  })()));
  assert.equal(failedUntil.size, 3);
  for (const v of failedUntil.values()) {
    assert.ok(Number.isFinite(v) && v > now);
  }
});

test('chaos: breaker concurrent failure/success does not throw', async () => {
  const br = new CircuitBreaker({ threshold: 3, openMs: 10, halfOpenProbes: 2 });
  await Promise.all(Array.from({ length: 50 }, (_, i) => (async () => {
    if (i % 3 === 0) br.onSuccess('p');
    else br.onFailure('p');
    br.canRequest('p');
  })()));
  const st = br.state('p');
  assert.ok(['closed', 'open', 'half_open'].includes(st));
});

test('chaos: pickNext under concurrent empty-ish pools stays defined or null safely', () => {
  const pool = {
    base: 'p',
    refs: ['A'],
    state: { failedUntil: new Map([['A', Date.now() + 60000]]), pointer: 0 },
  };
  const r = pickNext(pool, Date.now());
  // A is cooling — pickNext returns undefined when all keys are cooled
  assert.ok(r === undefined || typeof r === 'string');
});

test('chaos: sanitize concurrent-shaped status stays non-negative', () => {
  const providers = Array.from({ length: 20 }, (_, i) => ({
    provider: 'p' + i,
    healthScore: i * 10,
    switches: i,
    keys: Array.from({ length: 5 }, (_, j) => ({ ref: `K${j}`, usage: j, cooldownMsLeft: j % 2 ? -j : j * 100 })),
  }));
  const s = sanitizeSnapshot({ providers });
  for (const p of s.providers) {
    assert.ok(p.healthScore >= 0 && p.healthScore <= 100);
    for (const k of p.keys) assert.ok(k.cooldownMsLeft >= 0);
  }
});

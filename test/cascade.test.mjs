// test/cascade.test.mjs — issue #194 cascade failover
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCascadeFallback, hasHealthyKey } from '../lib/cascade.js';

function makePool(refs, opts = {}) {
  const now = opts.now || Date.now();
  const failedUntil = new Map();
  const state = { failedUntil, events: [], lastUsed: undefined };
  if (opts.failedUntil) for (const [k, v] of Object.entries(opts.failedUntil)) failedUntil.set(k, v);
  const expiresAt = opts.expiresAt || {};
  return { base: opts.base || 'test', refs, state, expiresAt };
}

test('pickCascadeFallback: returns first healthy fallback', () => {
  const poolA = makePool(['A1'], { failedUntil: { A1: Date.now() + 60000 } });
  const poolB = makePool(['B1']);
  const cfg = { cascade: [{ provider: 'b' }] };
  const pools = new Map([['a', poolA], ['b', poolB]]);
  const fb = pickCascadeFallback('a', cfg, pools);
  assert.ok(fb);
  assert.equal(fb.provider, 'b');
});

test('pickCascadeFallback: skips saturated fallback', () => {
  const poolA = makePool(['A1'], { failedUntil: { A1: Date.now() + 60000 } });
  const poolB = makePool(['B1'], { failedUntil: { B1: Date.now() + 60000 } });
  const cfg = { cascade: [{ provider: 'b' }] };
  const pools = new Map([['a', poolA], ['b', poolB]]);
  assert.equal(pickCascadeFallback('a', cfg, pools), null);
});

test('pickCascadeFallback: skips self-reference', () => {
  const poolA = makePool(['A1']);
  const cfg = { cascade: [{ provider: 'a' }] };
  const pools = new Map([['a', poolA]]);
  assert.equal(pickCascadeFallback('a', cfg, pools), null);
});

test('pickCascadeFallback: skips unknown providers', () => {
  const poolA = makePool(['A1']);
  const cfg = { cascade: [{ provider: 'nonexistent' }] };
  const pools = new Map([['a', poolA]]);
  assert.equal(pickCascadeFallback('a', cfg, pools), null);
});

test('pickCascadeFallback: empty cascade returns null', () => {
  const poolA = makePool(['A1']);
  assert.equal(pickCascadeFallback('a', {}, new Map([['a', poolA]])), null);
  assert.equal(pickCascadeFallback('a', null, new Map()), null);
});

test('hasHealthyKey: true for healthy pool', () => {
  const pool = makePool(['A1']);
  assert.equal(hasHealthyKey(pool), true);
});

test('hasHealthyKey: false when all in cooldown', () => {
  const pool = makePool(['A1', 'A2'], { failedUntil: { A1: Date.now() + 60000, A2: Date.now() + 60000 } });
  assert.equal(hasHealthyKey(pool), false);
});

test('hasHealthyKey: null/empty pool', () => {
  assert.equal(hasHealthyKey(null), false);
  assert.equal(hasHealthyKey({ refs: [] }), false);
});

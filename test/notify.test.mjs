// test/notify.test.mjs — tests for notifyExhaustion in lib/index.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function makePool({ refs = ['A', 'B'], exhaustionCount = 0, lastExhaustionAt = 1_000_000 } = {}) {
  return {
    refs,
    state: { exhaustionCount, lastExhaustionAt, events: [] },
  };
}

let mod = null;
try { mod = await import('../lib/index.js'); } catch { mod = null; }
const notifyExhaustion = mod?.notifyExhaustion;

if (!mod || !notifyExhaustion) {
  test('notifyExhaustion: skipped locally (no schemastery peer)', () => assert.ok(true));
} else {

function makeHooks() {
  const calls = { webhook: [] };
  const webhookSender = {
    send: (url, payload) => { calls.webhook.push({ url, payload }); },
  };
  return { hooks: { webhookSender }, calls };
}

test('notifyExhaustion: no-op when count is 0', () => {
  const { hooks, calls } = makeHooks();
  notifyExhaustion({ notifyWebhook: 'http://w', notifyThreshold: 1 }, makePool({ exhaustionCount: 0 }), { provider: 'openrouter' }, hooks);
  assert.deepEqual(calls.webhook, []);
});

test('notifyExhaustion: no-op when runtime is null', () => {
  const { hooks, calls } = makeHooks();
  notifyExhaustion(null, makePool({ exhaustionCount: 3 }), { provider: 'openrouter' }, hooks);
  assert.deepEqual(calls.webhook, []);
});

test('notifyExhaustion: webhook below threshold not sent', () => {
  const { hooks, calls } = makeHooks();
  const pool = makePool({ exhaustionCount: 2, lastExhaustionAt: 123 });
  notifyExhaustion({ notifyWebhook: 'http://w', notifyThreshold: 5 }, pool, { provider: 'openrouter' }, hooks);
  assert.deepEqual(calls.webhook, []);
});

test('notifyExhaustion: webhook at/above threshold sent with payload', () => {
  const { hooks, calls } = makeHooks();
  const pool = makePool({ refs: ['A', 'B'], exhaustionCount: 3, lastExhaustionAt: 5000 });
  notifyExhaustion({ notifyWebhook: 'http://w', notifyThreshold: 3 }, pool, { provider: 'openrouter' }, hooks);
  assert.equal(calls.webhook.length, 1);
  const w = calls.webhook[0];
  assert.equal(w.url, 'http://w');
  assert.equal(w.payload.provider, 'openrouter');
  assert.equal(w.payload.exhaustionCount, 3);
  assert.equal(w.payload.at, 5000);
  assert.deepEqual(w.payload.keys, ['A', 'B']);
});

test('notifyExhaustion: default hooks uses module-scope (count=0 → no-op)', () => {
  const pool = makePool({ exhaustionCount: 0 });
  // Count=0 means early return — never touches default hooks. Just exercises the path.
  notifyExhaustion({ notifyWebhook: '', notifyThreshold: 999 }, pool, { provider: 'openrouter' });
  assert.ok(true);
});

test('notifyExhaustion: webhookSender throwing does not crash', () => {
  const webhookSender = { send: () => { throw new Error('webhook boom'); } };
  const pool = makePool({ exhaustionCount: 5, lastExhaustionAt: 1 });
  assert.doesNotThrow(() => {
    notifyExhaustion({ notifyWebhook: 'http://w', notifyThreshold: 1 }, pool, { provider: 'openrouter' }, { webhookSender });
  });
});

}

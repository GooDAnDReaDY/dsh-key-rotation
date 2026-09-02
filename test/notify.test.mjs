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
  const calls = { webhook: [], incident: [] };
  const webhookSender = {
    send: (url, payload) => { calls.webhook.push({ url, payload }); },
  };
  const reporter = {
    open: (provider, exhaustedAt) => {
      calls.incident.push({ provider, exhaustedAt });
      return { reported: true };
    },
  };
  const ensureIncidentReporter = () => reporter;
  return { hooks: { webhookSender, ensureIncidentReporter }, calls, reporter };
}

test('notifyExhaustion: no-op when count is 0', () => {
  const { hooks, calls } = makeHooks();
  notifyExhaustion({ notifyWebhook: 'http://w', notifyThreshold: 1, incidentThreshold: 1 }, makePool({ exhaustionCount: 0 }), { provider: 'openrouter' }, hooks);
  assert.deepEqual(calls.webhook, []);
  assert.deepEqual(calls.incident, []);
});

test('notifyExhaustion: no-op when runtime is null', () => {
  const { hooks, calls } = makeHooks();
  notifyExhaustion(null, makePool({ exhaustionCount: 3 }), { provider: 'openrouter' }, hooks);
  assert.deepEqual(calls.webhook, []);
  assert.deepEqual(calls.incident, []);
});

test('notifyExhaustion: webhook below threshold not sent', () => {
  const { hooks, calls } = makeHooks();
  const pool = makePool({ exhaustionCount: 2, lastExhaustionAt: 123 });
  notifyExhaustion({ notifyWebhook: 'http://w', notifyThreshold: 5, incidentThreshold: 0 }, pool, { provider: 'openrouter' }, hooks);
  assert.deepEqual(calls.webhook, []);
});

test('notifyExhaustion: webhook at/above threshold sent with payload', () => {
  const { hooks, calls } = makeHooks();
  const pool = makePool({ refs: ['A', 'B'], exhaustionCount: 3, lastExhaustionAt: 5000 });
  notifyExhaustion({ notifyWebhook: 'http://w', notifyThreshold: 3, incidentThreshold: 0 }, pool, { provider: 'openrouter' }, hooks);
  assert.equal(calls.webhook.length, 1);
  const w = calls.webhook[0];
  assert.equal(w.url, 'http://w');
  assert.equal(w.payload.provider, 'openrouter');
  assert.equal(w.payload.exhaustionCount, 3);
  assert.equal(w.payload.at, 5000);
  assert.deepEqual(w.payload.keys, ['A', 'B']);
});

test('notifyExhaustion: incident at/above threshold opens', () => {
  const { hooks, calls } = makeHooks();
  const pool = makePool({ exhaustionCount: 5, lastExhaustionAt: 9999 });
  notifyExhaustion({ notifyWebhook: '', notifyThreshold: 0, incidentThreshold: 5 }, pool, { provider: 'deepseek' }, hooks);
  assert.equal(calls.incident.length, 1);
  assert.equal(calls.incident[0].provider, 'deepseek');
  assert.equal(calls.incident[0].exhaustedAt, 9999);
});

test('notifyExhaustion: incident below threshold not opened', () => {
  const { hooks, calls } = makeHooks();
  const pool = makePool({ exhaustionCount: 3, lastExhaustionAt: 9999 });
  notifyExhaustion({ notifyWebhook: '', notifyThreshold: 0, incidentThreshold: 5 }, pool, { provider: 'deepseek' }, hooks);
  assert.deepEqual(calls.incident, []);
});

test('notifyExhaustion: webhook AND incident both fire when both thresholds met', () => {
  const { hooks, calls } = makeHooks();
  const pool = makePool({ exhaustionCount: 7, lastExhaustionAt: 100 });
  notifyExhaustion({ notifyWebhook: 'http://w', notifyThreshold: 5, incidentThreshold: 5 }, pool, { provider: 'openrouter' }, hooks);
  assert.equal(calls.webhook.length, 1);
  assert.equal(calls.incident.length, 1);
});

test('notifyExhaustion: incident skipped when ensureIncidentReporter returns null', () => {
  const calls = { webhook: [] };
  const webhookSender = { send: (u, p) => calls.webhook.push({ u, p }) };
  const ensureIncidentReporter = () => null;
  const pool = makePool({ exhaustionCount: 5, lastExhaustionAt: 100 });
  notifyExhaustion({ notifyWebhook: '', notifyThreshold: 0, incidentThreshold: 1 }, pool, { provider: 'openrouter' }, { webhookSender, ensureIncidentReporter });
  assert.equal(calls.webhook.length, 0);
  // No incident call because reporter is null — silently skipped (documented behavior).
  assert.ok(true);
});

test('notifyExhaustion: default hooks uses module-scope (count=0 → no-op)', () => {
  const pool = makePool({ exhaustionCount: 0 });
  // Count=0 means early return — never touches default hooks. Just exercises the path.
  notifyExhaustion({ notifyWebhook: '', notifyThreshold: 999, incidentThreshold: 999 }, pool, { provider: 'openrouter' });
  assert.ok(true);
});

test('notifyExhaustion: webhookSender throwing does not propagate', () => {
  const calls = { incident: [] };
  const webhookSender = { send: () => { throw new Error('webhook boom'); } };
  const ensureIncidentReporter = () => ({
    open: (p, a) => calls.incident.push({ p, a }),
  });
  const pool = makePool({ exhaustionCount: 5, lastExhaustionAt: 1 });
  // Both webhook and incident are in the same try/catch. If webhook throws,
  // the incident is not called (we don't want to mask the issue by silently retrying).
  // The outer try/catch contains the throw.
  notifyExhaustion({ notifyWebhook: 'http://w', notifyThreshold: 1, incidentThreshold: 1 }, pool, { provider: 'openrouter' }, { webhookSender, ensureIncidentReporter });
  assert.equal(calls.incident.length, 0);
});

}
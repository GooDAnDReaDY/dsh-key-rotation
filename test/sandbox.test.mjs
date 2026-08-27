// test/sandbox.test.mjs — unit tests for sandbox.js (no harness, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LastTestCache, SandboxRunner, PROBE_MODELS_TIMEOUT_MS } from '../lib/sandbox.js';

function fixedFetch(impl) {
  return async () => impl();
}

test('LastTestCache: set/get/snapshot', () => {
  const c = new LastTestCache();
  c.set('A', { ok: true, code: 'ok', latencyMs: 10 });
  c.set('B', { ok: false, code: 'auth', latencyMs: 5 });
  assert.equal(c.get('A').ok, true);
  assert.equal(c.get('missing'), undefined);
  const snap = c.snapshot();
  assert.equal(Object.keys(snap).length, 2);
  assert.equal(snap.B.code, 'auth');
});

test('LastTestCache: re-set evicts prior entry (LRU-ish, FIFO on overflow)', () => {
  const c = new LastTestCache(2);
  c.set('A', { ok: true, code: 'ok', latencyMs: 1 });
  c.set('A', { ok: true, code: 'ok', latencyMs: 2 });
  assert.equal(c.size, 1);
  c.set('B', { ok: true, code: 'ok', latencyMs: 3 });
  c.set('C', { ok: true, code: 'ok', latencyMs: 4 });
  // A should be evicted (oldest insertion was A, replaced once, but Eviction is FIFO across set()-calls)
  // After A re-set, the insertion order is [B, A_replaced, C] in some impls.
  // Our impl evicts the FIRST map key after size exceeds max. After ops: A re-set (A moved to end),
  // then B (after A), then C. Order: A (last from re-set), B, C. Pop first → C size>2 pops nothing
  // wait — after 3 sets size=2? max=2 so the loop evicts one. Set A re-set: A in map size=1.
  // Set B: size=2. Set C: size=3→evict oldest (A)→size=2. So C and B remain; A is gone.
  assert.equal(c.get('A'), undefined);
  assert.notEqual(c.get('B'), undefined);
  assert.notEqual(c.get('C'), undefined);
});

test('LastTestCache: clear empties the map', () => {
  const c = new LastTestCache();
  c.set('A', { ok: true, code: 'ok', latencyMs: 1 });
  c.clear();
  assert.equal(c.size, 0);
});

test('SandboxRunner: requires fetchImpl and resolveBaseUrl', () => {
  assert.throws(() => new SandboxRunner({}), /fetchImpl required/);
  assert.throws(() => new SandboxRunner({ fetchImpl: () => {} }), /resolveBaseUrl required/);
});

test('SandboxRunner.probeModels: ok 200 + counts models', async () => {
  const r = new SandboxRunner({
    fetchImpl: fixedFetch(async () => ({ status: 200, json: async () => ({ data: [{ id: 'a' }, { id: 'b' }] }) })),
    resolveBaseUrl: () => 'https://api.example.com/v1',
  });
  const out = await r.probeModels('PROVIDER', 'sk-123');
  assert.equal(out.ok, true);
  assert.equal(out.code, 'ok');
  assert.equal(out.modelsCount, 2);
  assert.ok(out.latencyMs >= 0);
});

test('SandboxRunner.probeModels: 401 → auth', async () => {
  const r = new SandboxRunner({
    fetchImpl: fixedFetch(async () => ({ status: 401 })),
    resolveBaseUrl: () => 'https://api.example.com/v1',
  });
  const out = await r.probeModels('REF', 'sk-123');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'auth');
});

test('SandboxRunner.probeModels: 404 → not-found', async () => {
  const r = new SandboxRunner({
    fetchImpl: fixedFetch(async () => ({ status: 404 })),
    resolveBaseUrl: () => 'https://api.example.com/v1',
  });
  const out = await r.probeModels('REF', 'sk-123');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'not-found');
});

test('SandboxRunner.probeModels: 429 → rate-limit', async () => {
  const r = new SandboxRunner({
    fetchImpl: fixedFetch(async () => ({ status: 429 })),
    resolveBaseUrl: () => 'https://api.example.com/v1',
  });
  const out = await r.probeModels('REF', 'sk-123');
  assert.equal(out.code, 'rate-limit');
});

test('SandboxRunner.probeModels: 500 retried once, then server', async () => {
  let calls = 0;
  const r = new SandboxRunner({
    fetchImpl: fixedFetch(async () => { calls += 1; return { status: calls === 1 ? 500 : 500 }; }),
    resolveBaseUrl: () => 'https://api.example.com/v1',
  });
  const out = await r.probeModels('REF', 'sk-123');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'server');
  assert.equal(calls, 2, 'one retry on 5xx');
});

test('SandboxRunner.probeModels: 500 then 200 → ok', async () => {
  let calls = 0;
  const r = new SandboxRunner({
    fetchImpl: fixedFetch(async () => { calls += 1; return { status: calls === 1 ? 500 : 200, json: async () => ({ data: [] }) }; }),
    resolveBaseUrl: () => 'https://api.example.com/v1',
  });
  const out = await r.probeModels('REF', 'sk-123');
  assert.equal(out.ok, true);
  assert.equal(out.modelsCount, 0);
});

test('SandboxRunner.probeModels: missing key → no-credential', async () => {
  const r = new SandboxRunner({
    fetchImpl: async () => { throw new Error('should not be called'); },
    resolveBaseUrl: () => 'https://api.example.com/v1',
  });
  const out = await r.probeModels('REF', '');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'no-credential');
});

test('SandboxRunner.probeModels: no baseUrl → no-baseurl', async () => {
  const r = new SandboxRunner({
    fetchImpl: async () => { throw new Error('should not be called'); },
    resolveBaseUrl: () => null,
  });
  const out = await r.probeModels('REF', 'sk-123');
  assert.equal(out.code, 'no-baseurl');
});

test('SandboxRunner.probeModels: AbortError → timeout', async () => {
  const r = new SandboxRunner({
    fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
    resolveBaseUrl: () => 'https://api.example.com/v1',
  });
  const out = await r.probeModels('REF', 'sk-123');
  assert.equal(out.code, 'timeout');
  assert.ok(out.latencyMs >= 0);
});

test('SandboxRunner.probeModels: network error → network', async () => {
  const r = new SandboxRunner({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    resolveBaseUrl: () => 'https://api.example.com/v1',
  });
  const out = await r.probeModels('REF', 'sk-123');
  assert.equal(out.code, 'network');
});

test('SandboxRunner.probeChat: returns not-implemented (hook)', async () => {
  const r = new SandboxRunner({
    fetchImpl: async () => { throw new Error('should not be called'); },
    resolveBaseUrl: () => 'https://api.example.com/v1',
  });
  const out = await r.probeChat('REF', 'sk');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'not-implemented');
});

test('timeout constant exported and sane', () => {
  assert.equal(typeof PROBE_MODELS_TIMEOUT_MS, 'number');
  assert.ok(PROBE_MODELS_TIMEOUT_MS > 0);
});

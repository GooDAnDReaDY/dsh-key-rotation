import test from 'node:test';
import assert from 'node:assert/strict';
import { handleConfigBridge, readJson } from '../lib/http-bridge.js';
import { registerTelemetryRoutes } from '../lib/ops-telemetry.js';
import { registerKeyRoutes } from '../lib/ops-keys.js';
import { isLoopbackAddress, isTrustedBridgeRequest } from '../lib/pool.js';
import { buildPoolItem } from '../lib/pool-builder.js';
import { createConfigReader, createProviderProfilesReader } from '../lib/config-compat.js';
import { setupAutoUnbreakEffect, setupIdleHealEffect } from '../lib/lifecycle.js';
import { PassThrough } from 'node:stream';
import { memoryHost, invokeRoute, deferred } from './support/client-runtime.mjs';

function routes(host) {
  const table = new Map(), disposers = [];
  const ctx = { get: name => name === 'settings' ? host.settings : undefined,
    effect(fn) { const off = fn(); if (off) disposers.push(off); },
    webServer: { register({ path, handler }) { table.set(path, handler); return () => table.delete(path); } } };
  registerTelemetryRoutes(ctx, { buildRuntime: () => ({ poolByRef: new Map() }) });
  registerKeyRoutes(ctx, { poolState: new Map(), buildRuntime: () => ({}) });
  table.set('/dsh-key-rotation/config', (req, res) => handleConfigBridge(ctx, req, res, () => new Set()));
  return table;
}
const patch = (value = 90000, revision = 10) => ({ ops: [{ op: 'set', path: ['cooldownMs'], value }], expectedRevision: revision });

test('config bridge uses one atomic mutation and does not restate a redacted token', async () => {
  const host = memoryHost({ webhookActionToken: 'private-test' });
  const handler = routes(host).get('/dsh-key-rotation/config');
  const result = await invokeRoute(handler, { method: 'PUT', body: patch() });
  assert.equal(result.status, 200); assert.equal(host.user.webhookActionToken, 'private-test');
  assert.equal(host.writes.length, 1); assert.equal(host.writes[0].kind, 'mutate');
  assert.equal((await result.json()).value.webhookActionToken, undefined);
});

for (const [name, body] of [
  ['missing revision', { ops: patch().ops }], ['fractional revision', patch(2, 1.5)],
  ['negative revision', patch(2, -1)], ['unsafe revision', patch(2, Number.MAX_SAFE_INTEGER + 1)],
  ['root replacement', { ops: [{ op: 'set', path: [], value: {} }], expectedRevision: 10 }],
  ['unsafe path', { ops: [{ op: 'set', path: ['__proto__', 'polluted'], value: true }], expectedRevision: 10 }],
  ['ambiguous payload', { ...patch(), section: { cooldownMs: 9 } }],
  ['invalid operation', { ops: [{ op: 'delete', path: ['cooldownMs'] }], expectedRevision: 10 }],
  ['null section', { section: null, expectedRevision: 10 }],
  ['bad JSON', '{bad'],
]) {
  test(`config rejects ${name} without any write`, async () => {
    const host = memoryHost();
    const result = await invokeRoute(routes(host).get('/dsh-key-rotation/config'), { method: 'PUT', body });
    assert.equal(result.status, 400, await result.text()); assert.equal(host.writes.length, 0);
  });
}

test('legacy section payload remains accepted as a patch, not a secret-destructive replace', async () => {
  const host = memoryHost({ webhookActionToken: 'private-test' });
  const result = await invokeRoute(routes(host).get('/dsh-key-rotation/config'), { method: 'PUT', body: { section: { cooldownMs: 90000 }, expectedRevision: 10 } });
  assert.equal(result.status, 200); assert.equal(host.user.webhookActionToken, 'private-test');
});

test('read-only and stale writes fail without deleting the previous section', async () => {
  const host = memoryHost({ webhookActionToken: 'private-test' });
  const handler = routes(host).get('/dsh-key-rotation/config');
  host.writable = false;
  assert.equal((await invokeRoute(handler, { method: 'PUT', body: patch() })).status, 400);
  host.writable = true; host.publish({ cooldownMs: 75000 });
  assert.equal((await invokeRoute(handler, { method: 'PUT', body: patch() })).status, 409);
  assert.equal(host.user.cooldownMs, 75000); assert.equal(host.user.webhookActionToken, 'private-test');
});

test('missing atomic Host API fails closed and never silently uses replace', async () => {
  const host = memoryHost(); host.settings.mutate = undefined;
  const response = await invokeRoute(routes(host).get('/dsh-key-rotation/config'), { method: 'PUT', body: patch() });
  assert.equal(response.status, 400); assert.equal(host.writes.length, 0);
});

test('explicit DELETE retains its documented reset semantics', async () => {
  const host = memoryHost({ cooldownMs: 75000 });
  const response = await invokeRoute(routes(host).get('/dsh-key-rotation/config'), { method: 'DELETE' });
  assert.equal(response.status, 200); assert.equal(host.writes[0].kind, 'replace');
});

test('snapshot export/import round trip preserves hidden token and honors revision conflicts', async () => {
  const host = memoryHost({ webhookActionToken: 'private-test' });
  const handler = routes(host).get('/dsh-key-rotation/snapshot');
  const data = await (await invokeRoute(handler)).json();
  assert.equal(data.snapshot.webhookActionToken, '');
  data.snapshot.cooldownMs = 75000;
  assert.equal((await invokeRoute(handler, { method: 'POST', body: { snapshot: data.snapshot, expectedRevision: 10 } })).status, 200);
  assert.equal(host.user.webhookActionToken, 'private-test');
  assert.equal((await invokeRoute(handler, { method: 'POST', body: { snapshot: { cooldownMs: 80000 }, expectedRevision: 10 } })).status, 409);
  assert.equal(host.user.cooldownMs, 75000);
});

test('provider URL import mutates only providers and preserves hidden token', async t => {
  const host = memoryHost({ webhookActionToken: 'private-test' });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => [{ provider: 'a', keys: ['KEY_A'] }] }));
  const response = await invokeRoute(routes(host).get('/dsh-key-rotation/import'), { method: 'POST', body: { url: 'https://example.test/pools.json', expectedRevision: 10 } });
  assert.equal(response.status, 200, await response.text());
  assert.equal(host.user.webhookActionToken, 'private-test');
  assert.deepEqual(host.writes[0].payload.map(op => op.path), [['providers']]);
});

test('malformed provider import fails atomically', async t => {
  const host = memoryHost();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => [{ provider: 'a', keys: ['KEY_A'] }, { provider: 'b', keys: [null] }] }));
  const response = await invokeRoute(routes(host).get('/dsh-key-rotation/import'), { method: 'POST', body: { url: 'https://example.test/pools.json' } });
  assert.equal(response.status, 400); assert.equal(host.writes.length, 0);
});

test('bounded body reader rejects an oversized or interrupted request', async () => {
  const oversized = new PassThrough(); const result = readJson(oversized, 5);
  oversized.end('123456'); await assert.rejects(result, error => error.status === 413);
  const stopped = new PassThrough(); const rejected = readJson(stopped);
  stopped.emit('aborted'); await assert.rejects(rejected, /aborted/i);
});

test('loopback origin validation accepts bracketed IPv6 and rejects cross-site/non-loopback', () => {
  assert.equal(isTrustedBridgeRequest({ socket: { remoteAddress: '::1' }, headers: { host: '[::1]:3000', origin: 'http://[::1]:3000' } }), true);
  for (const ip of ['127.example.test', '127.999.0.1', '127.', '192.168.1.1']) assert.equal(isLoopbackAddress(ip), false);
  assert.equal(isTrustedBridgeRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3000', origin: 'http://localhost:3000', 'sec-fetch-site': 'cross-site' } }), false);
});

test('runtime pool filtering preserves positional metadata, normalizes refs and caps pathological weights', () => {
  const pool = buildPoolItem({ base: 'a', keys: ['', ' KEY_A ', 'bad-ref', 'KEY_B', 'KEY_A'], weights: [8, 3, 8, Infinity, 99], expiresAt: [1, 10000, 3, 20000, 8], makeState: () => ({}) });
  assert.deepEqual(pool.refs, ['KEY_A', 'KEY_B']); assert.deepEqual(pool.weights, [3, 1]);
  assert.deepEqual(pool.expiresAt, { KEY_A: 10000, KEY_B: 20000 });
  assert.equal(buildPoolItem({ keys: ['KEY'], weights: [1e12], makeState: () => ({}) }).weightedRefs.length, 1000);
});

test('volatile configuration unwrapping retains identity until a field actually changes', () => {
  let cooldown = 60000;
  const read = createConfigReader({ cooldownMs: { get: () => cooldown }, providers: [] });
  const before = read(); assert.strictEqual(before, read());
  cooldown = 75000; assert.notStrictEqual(read(), before); assert.equal(read().cooldownMs, 75000);
});

test('modern provider profile lookup caches descriptors and refreshes on document invalidation', () => {
  let callback, calls = 0, key = 'A';
  const reader = createProviderProfilesReader({ effect: fn => fn(), on: (_name, cb) => { callback = cb; return () => {}; }, get: () => settings }, 'llm-pi-ai');
  const settings = { describe() { calls++; return [{ ns: 'llm-pi-ai', value: { providers: { a: { apiKeyEnv: key } } } }]; } };
  assert.equal(reader().a.apiKeyEnv, 'A'); reader(); assert.equal(calls, 1);
  key = 'B'; callback(); assert.equal(reader().a.apiKeyEnv, 'B'); assert.equal(calls, 2);
});

test('auto-unbreak interval can be enabled/changed/disabled live and cannot restart after disposal', async () => {
  let config = { selfHealingIntervalMinutes: 0 }; const callbacks = new Map(), timers = new Map(); let id = 0, cleanup;
  const ctx = { effect(fn) { cleanup = fn(); }, on(name, cb) { callbacks.set(name, cb); return () => callbacks.delete(name); } };
  setupAutoUnbreakEffect(ctx, () => config, () => ({ pools: [] }), () => ({}), {}, { setInterval(fn, delay) { const handle = ++id; timers.set(handle, { fn, delay }); return handle; }, clearInterval(handle) { timers.delete(handle); } });
  assert.equal(timers.size, 0);
  config = { selfHealingIntervalMinutes: 2 }; callbacks.get('settings/document-updated')(); await Promise.resolve();
  assert.equal([...timers.values()][0].delay, 120000);
  config = { selfHealingIntervalMinutes: 3 }; callbacks.get('loader/volatile-update')(); await Promise.resolve();
  assert.equal(timers.size, 1); assert.equal([...timers.values()][0].delay, 180000);
  config = { selfHealingIntervalMinutes: 0 }; callbacks.get('settings/document-updated')(); await Promise.resolve(); assert.equal(timers.size, 0);
  callbacks.get('settings/document-updated')(); cleanup(); await Promise.resolve(); assert.equal(timers.size, 0); assert.equal(callbacks.size, 0);
});

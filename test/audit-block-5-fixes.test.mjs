import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { LatencyHistogram } from '../lib/histogram.js';
import { autoUnbreakBrokenKeys } from '../lib/heal.js';
import { AlertDebouncer } from '../lib/webhook.js';
import { createRotate } from '../lib/rotate.js';
import { initializePoolState } from '../lib/pool-state.js';

test('Audit Block 5 - #426: LatencyHistogram reconfigure and custom window', () => {
  const h = new LatencyHistogram({ window: 10 });
  assert.equal(h.window, 10);
  for (let i = 1; i <= 20; i++) {
    h.record('key1', i * 10);
  }
  const snap10 = h.snapshot('key1');
  assert.equal(snap10.count, 10);

  h.reconfigure({ window: 200 });
  assert.equal(h.window, 200);
  for (let i = 1; i <= 20; i++) {
    h.record('key2', i * 10);
  }
  const snap200 = h.snapshot('key2');
  assert.equal(snap200.count, 20);
});

test('Audit Block 5 - #427: Recoverable brokenUntil vs permanent REVOKED in autoUnbreakBrokenKeys', async () => {
  const pool = {
    base: 'openai',
    refs: ['k1', 'k2', 'k3'],
    state: initializePoolState(),
  };
  pool.state.revokedRefs = new Set(['k3']);
  pool.state.brokenUntil.set('k1', Date.now() + 600000);
  pool.state.brokenUntil.set('k3', Date.now() + 600000);

  const probed = [];
  const results = await autoUnbreakBrokenKeys([pool], async (ref) => {
    probed.push(ref);
    return { ok: true };
  });

  assert.deepEqual(probed, ['k1']);
  assert.equal(results.length, 1);
  assert.equal(results[0].ref, 'k1');
  assert.equal(results[0].ok, true);
  assert.equal(pool.state.brokenUntil.has('k1'), false);
});

test('Audit Block 5 - #427: rotate sets recoverable brokenUntil quarantine after 3 consecutive non-auth failures', async () => {
  const rotate = createRotate({
    ctx: { get: () => ({ stream: () => { throw new Error('upstream failure'); } }) },
    dispatchStorage: new AsyncLocalStorage(),
    buildRuntime: () => ({ switchCodes: ['TRANSPORT'], cooldownMs: 0, concurrencyLimit: 0 }),
    pushEvent: () => {},
    finishError: (code, message) => new Error(code + ': ' + message),
    now: () => Date.now(),
    setRotateStartMs: () => {},
    notifyExhaustion: () => {},
  });

  const pool = {
    base: 'anthropic',
    refs: ['k1'],
    state: initializePoolState(),
  };
  pool.state.failCounts.set('k1', 2);
  pool.state.lastUsed = 'k1';

  const opt = { provider: 'anthropic', maxRetries: 0 };
  try {
    for await (const _ of rotate(opt, pool)) {}
  } catch (_) {}

  assert.equal(pool.state.revokedRefs?.has('k1') ?? false, false);
  assert.ok((pool.state.brokenUntil.get('k1') ?? 0) > Date.now());
});

test('Audit Block 5 - #428: AlertDebouncer aggregates rapid alert events into digest payload', async () => {
  const sent = [];
  const fakeSender = {
    async send(url, payload) {
      sent.push({ url, payload });
      return { sent: true };
    },
  };

  const debouncer = new AlertDebouncer({ sender: fakeSender, debounceMs: 50 });
  debouncer.enqueue('https://example.com/hook', { provider: 'openai', key: 'k1', type: 'switch' });
  debouncer.enqueue('https://example.com/hook', { provider: 'anthropic', key: 'k2', type: 'exhaustion' });

  await debouncer.flush('https://example.com/hook');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://example.com/hook');
  assert.equal(sent[0].payload.digest, true);
  assert.equal(sent[0].payload.incidentCount, 2);
  assert.equal(sent[0].payload.events.length, 2);
});

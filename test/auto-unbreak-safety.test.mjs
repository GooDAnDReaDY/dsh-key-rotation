import test from 'node:test';
import assert from 'node:assert/strict';
import { setupAutoUnbreakEffect } from '../lib/lifecycle.js';
import { autoUnbreakBrokenKeys } from '../lib/heal.js';
import { SandboxRunner } from '../lib/sandbox.js';

const BAD = 'AUDIT_BAD_KEY';
const GOOD = 'AUDIT_GOOD_KEY';
const makePool = () => ({ base: 'demo', refs: [BAD, GOOD], state: {
  brokenUntil: new Map([[BAD, Date.now() + 3600000]]),
  failedUntil: new Map([[BAD, Date.now() + 3600000]]),
  failCounts: new Map([[BAD, 3]]), authFailCounts: new Map([[BAD, 3]]), events: [],
} });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Executes the shipped credentials.resolve wrapper, not a reimplementation.
async function patchedHost(label, values) {
  const plugin = await import(`../lib/index.js?auto-unbreak=${label}`);
  const credentials = { async resolve(ref) { assert.equal(this, credentials); return values.has(ref) ? { value: values.get(ref) } : undefined; } };
  const config = { providers: [{ provider: 'demo', keys: [BAD, GOOD] }], persistenceEnabled: false, selfHealCooldown: false };
  const settings = { get: () => ({ providers: { demo: { apiKeyEnv: BAD } } }), register: () => ({ get: () => config }) };
  const ctx = {
    webServer: { register: () => () => {} },
    credentials,
    get: name => name === 'credentials' ? credentials : name === 'settings' ? settings : null,
    effect: (fn, label) => { if (label === 'dsh-key-rotation: patch credentials.resolve') return fn(); },
    inject: (_, fn) => fn(ctx),
  };
  plugin.apply(ctx, config);
  const pool = plugin.getRuntime().poolByRef.get(BAD);
  const fixture = makePool();
  for (const field of ['brokenUntil', 'failedUntil', 'failCounts', 'authFailCounts']) pool.state[field] = fixture.state[field];
  return { ctx, credentials, pool };
}

function effectHarness(t, { ctx, pool = makePool(), fetchImpl, runner, config = { selfHealingIntervalMinutes: 30 } } = {}) {
  let tick, dispose;
  const calls = [];
  const creds = { async resolve(ref) { assert.equal(this, creds); return { value: ref === BAD ? 'dummy-bad' : 'dummy-good' }; } };
  ctx ??= { credentials: creds, get: () => creds };
  t.mock.method(globalThis, 'setInterval', callback => { tick = callback; return { unref() {} }; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const sandbox = runner ?? new SandboxRunner({ resolveBaseUrl: async () => 'https://fixture.invalid/v1', fetchImpl: async (url, options) => {
    calls.push({ url, auth: options.headers.authorization });
    if (fetchImpl) return fetchImpl(url, options);
    return { status: options.headers.authorization === 'Bearer dummy-good' ? 200 : 401, json: async () => ({ data: [] }) };
  } });
  setupAutoUnbreakEffect({ ...ctx, effect: fn => { dispose = fn(); return dispose; } }, () => config, () => ({ pools: [pool] }), () => sandbox);
  return { pool, calls, tick: () => tick?.(), dispose: () => dispose?.(), config };
}

test('auto-unbreak probes the quarantined key, not the healthy key chosen by real rotation', async t => {
  const h = await patchedHost('wrong-key', new Map([[BAD, 'dummy-bad'], [GOOD, 'dummy-good']]));
  const e = effectHarness(t, h);
  await e.tick();
  assert.deepEqual(e.calls.map(c => c.auth), ['Bearer dummy-bad']);
  assert.equal(h.pool.state.brokenUntil.has(BAD), true);
  assert.equal(h.pool.state.failedUntil.has(BAD), true);
  assert.equal(h.pool.state.pointer, 0);
  assert.equal(h.pool.state.usageCounts.size, 0);
  assert.equal(h.pool.state.events.length, 0);
});

test('a repaired exact key heals without rotating or charging request counters', async t => {
  const h = await patchedHost('repaired-key', new Map([[BAD, 'dummy-good'], [GOOD, 'dummy-bad']]));
  const e = effectHarness(t, h);
  await e.tick();
  assert.equal(e.calls[0].auth, 'Bearer dummy-good');
  for (const field of ['brokenUntil', 'failedUntil', 'failCounts', 'authFailCounts']) assert.equal(h.pool.state[field].has(BAD), false);
  assert.equal(h.pool.state.pointer, 0);
  assert.equal(h.pool.state.usageCounts.size, 0);
  assert.equal(h.pool.state.events.at(-1).reason, 'auto-unbreak');
});

test('unpatched legacy credential service still uses its exact resolver with correct this', async t => {
  const e = effectHarness(t);
  await e.tick();
  assert.equal(e.calls[0].auth, 'Bearer dummy-bad');
  assert.equal(e.pool.state.brokenUntil.has(BAD), true);
});

test('get-only credential context is supported', async t => {
  const credentials = { resolve: async () => ({ value: 'dummy-good' }) };
  const e = effectHarness(t, { ctx: { get: () => credentials } });
  await e.tick();
  assert.equal(e.calls.length, 1);
  assert.equal(e.pool.state.brokenUntil.has(BAD), false);
});

test('exact environment fallback never substitutes another pool key', async t => {
  const old = process.env[BAD]; process.env[BAD] = 'dummy-good';
  t.after(() => { if (old === undefined) delete process.env[BAD]; else process.env[BAD] = old; });
  const credentials = { resolve: async () => undefined };
  const e = effectHarness(t, { ctx: { credentials, get: () => credentials } });
  await e.tick();
  assert.equal(e.calls[0].auth, 'Bearer dummy-good');
  assert.equal(e.pool.state.brokenUntil.has(BAD), false);
});

test('missing credentials do not send a probe or clear quarantine', async t => {
  const credentials = { resolve: async () => undefined };
  const e = effectHarness(t, { ctx: { credentials, get: () => credentials } });
  await e.tick();
  assert.equal(e.calls.length, 0);
  assert.equal(e.pool.state.brokenUntil.has(BAD), true);
});

test('a resolver exception does not fall through to rotated credentials', async t => {
  let rotated = 0;
  const credentials = { __dshKeyRotationOriginalResolve: async () => { throw new Error('fixture vault unavailable'); }, resolve: async () => { rotated++; return { value: 'dummy-good' }; } };
  const e = effectHarness(t, { ctx: { credentials, get: () => credentials } });
  await e.tick();
  assert.equal(rotated, 0);
  assert.equal(e.calls.length, 0);
  assert.equal(e.pool.state.brokenUntil.has(BAD), true);
});

test('disabled healing starts no timer', t => {
  const e = effectHarness(t, { config: { selfHealingIntervalMinutes: 0 } });
  assert.equal(e.tick(), undefined);
  assert.equal(e.calls.length, 0);
});

test('overlapping timer ticks do not duplicate an in-flight probe', async t => {
  const entered = deferred(), done = deferred();
  const e = effectHarness(t, { fetchImpl: async () => { entered.resolve(); await done.promise; return { status: 401 }; } });
  const first = e.tick(); await entered.promise;
  const second = e.tick();
  await new Promise(resolve => setImmediate(resolve));
  done.resolve(); await Promise.all([first, second]);
  assert.equal(e.calls.length, 1);
  await e.tick();
  assert.equal(e.calls.length, 2, 'failed sweep must release its running guard');
});

for (const action of ['dispose', 'disable']) {
  test(`${action} during a pending probe prevents late healing and new probes`, async t => {
    const entered = deferred(), done = deferred();
    const e = effectHarness(t, { fetchImpl: async () => { entered.resolve(); await done.promise; return { status: 200, json: async () => ({ data: [] }) }; } });
    const pending = e.tick(); await entered.promise;
    if (action === 'dispose') e.dispose(); else e.config.selfHealingIntervalMinutes = 0;
    done.resolve(); await pending;
    assert.equal(e.pool.state.brokenUntil.has(BAD), true);
    assert.equal(e.pool.state.events.length, 0);
    await e.tick();
    assert.equal(e.calls.length, 1);
  });
}

for (const field of ['brokenUntil', 'failedUntil', 'failCounts', 'authFailCounts']) {
  test(`stale probe cannot clear a newer ${field} value`, async () => {
    const pool = makePool();
    const result = await autoUnbreakBrokenKeys([pool], async () => {
      pool.state[field].set(BAD, pool.state[field].get(BAD) + 1);
      return { ok: true };
    });
    assert.equal(pool.state.brokenUntil.has(BAD), true);
    assert.equal(pool.state.failedUntil.has(BAD), true);
    assert.equal(pool.state.events.length, 0);
    assert.deepEqual(result, []);
  });
}

test('replacing state while probing preserves replacement quarantine', async () => {
  const pool = makePool();
  await autoUnbreakBrokenKeys([pool], async () => { pool.state = makePool().state; return { ok: true }; });
  assert.equal(pool.state.failedUntil.has(BAD), true);
  assert.equal(pool.state.events.length, 0);
});

test('replacing a quarantine map invalidates a pending observation even with equal values', async () => {
  const pool = makePool();
  await autoUnbreakBrokenKeys([pool], async () => { pool.state.brokenUntil = new Map(pool.state.brokenUntil); return { ok: true }; });
  assert.equal(pool.state.brokenUntil.has(BAD), true);
  assert.equal(pool.state.failedUntil.has(BAD), true);
});

test('valid successful probe clears only the matching key and keeps the event ring bounded', async () => {
  const pool = makePool();
  pool.state.brokenUntil.set(GOOD, Date.now() + 3600000);
  pool.state.events = Array.from({ length: 50 }, (_, at) => ({ at }));
  const out = await autoUnbreakBrokenKeys([pool], async ref => ({ ok: ref === BAD }));
  assert.deepEqual(out.map(r => r.ok), [true, false]);
  assert.equal(pool.state.brokenUntil.has(BAD), false);
  assert.equal(pool.state.brokenUntil.has(GOOD), true);
  assert.equal(pool.state.events.length, 50);
});

test('failed and thrown probes preserve all penalty fields', async () => {
  for (const probe of [async () => ({ ok: false }), async () => { throw new Error('fixture failure'); }]) {
    const pool = makePool();
    const out = await autoUnbreakBrokenKeys([pool], probe);
    assert.equal(out[0].ok, false);
    for (const field of ['brokenUntil', 'failedUntil', 'failCounts', 'authFailCounts']) assert.equal(pool.state[field].has(BAD), true);
    assert.equal(pool.state.events.length, 0);
  }
});

test('expired quarantine does not trigger a background request', async () => {
  const pool = makePool(); pool.state.brokenUntil.set(BAD, 1);
  let calls = 0;
  assert.deepEqual(await autoUnbreakBrokenKeys([pool], async () => { calls++; return { ok: true }; }, 2), []);
  assert.equal(calls, 0);
});

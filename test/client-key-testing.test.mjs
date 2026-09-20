import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import vm from 'node:vm';
import { registerTestRoutes } from '../lib/ops-test.js';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const exportMarker = "    module.exports = { apply, inject: ['slots', 'locale', 'settingsScope'] };";
assert.equal(source.split(exportMarker).length, 2);
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.children, predicate)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree == null || tree === false) return '';
  return typeof tree === 'object' ? text(tree.children) : String(tree);
}

// Run the entire shipped bundle. A test-only export gives access to its settings
// component; the production API is unchanged. This limited hook driver runs
// render/click transitions, NOT effects, polling, or a full React lifecycle.
function loadSettings(fetchImpl, providers = [{ provider: 'example', keys: ['KEY_A', 'KEY_B'] }]) {
  const value = { providers, switchCodes: [] };
  const snapshot = { status: 'ready', value, revision: 1 };
  const scope = { getSnapshot: () => snapshot, subscribe: () => () => {} };
  let cursor = 0;
  const state = [];
  const React = {
    Component: class {},
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) {
        let next = typeof initial === 'function' ? initial() : initial;
        if (next?.status === 'loading' && Array.isArray(next.providers)) {
          next = { ...snapshot, error: '', providers: providers.map((p) => ({ id: p.provider, name: p.provider })) };
        }
        state[index] = next;
      }
      return [state[index], (next) => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = { current: initial };
      return state[index];
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useEffect() {},
  };
  const calls = [];
  const context = {
    window: { __ModuleLoader__: { load(definition) {
      definition.factory((name) => {
        if (name === 'react') return React;
        throw new Error('Optional module unavailable: ' + name);
      });
    } } },
    fetch: (url, options) => {
      assert.equal(url, '/dsh-key-rotation/test');
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      calls.push(body);
      return fetchImpl(body, calls.length);
    },
    console,
  };
  vm.runInNewContext(source.replace(exportMarker, '    globalThis.testSection = KeyRotationSection;\n' + exportMarker), context, { filename: 'lib/client.js' });
  assert.equal(typeof context.testSection, 'function');
  let tree;
  const ui = {
    calls,
    render() {
      cursor = 0;
      tree = context.testSection({ ctx: { settingsScope: { bind: () => scope } } });
      return tree;
    },
    row(index) { return nodes(tree, (n) => n.props.className === 'krot-key')[index]; },
    single(index = 0) { return nodes(ui.row(index), (n) => n.type === 'button' && n.props.key === 't')[0]; },
    bulk(index = 0) { return nodes(tree, (n) => n.type === 'button' && n.props.title === 'Test all keys')[index]; },
    result(index = 0) { return nodes(ui.row(index), (n) => n.props.key === 'tr')[0]; },
  };
  ui.render();
  assert.ok(ui.single());
  assert.ok(ui.bulk());
  return ui;
}

for (const code of ['auth', 'no-baseurl', 'not-found', 'rate-limit', 'timeout', 'network']) {
  test(`bulk and individual tests preserve live ${code} failures`, async () => {
    const ui = loadSettings(async (body) => response(body.probe === 'models' ? { ok: false, code } : { ok: true }));
    ui.single().props.onClick();
    await settle();
    ui.render();
    assert.match(text(ui.result()), /✕/);
    ui.bulk().props.onClick();
    await settle();
    ui.render();
    assert.equal(ui.calls.length, 3);
    assert.ok(ui.calls.every((body) => body.probe === 'models'), 'all requests must be real probes');
    for (let index = 0; index < 2; index++) {
      assert.match(text(ui.result(index)), /✕/);
      assert.ok(text(ui.result(index)).includes(code));
      assert.ok(ui.result(index).props.title.includes(code));
    }
  });
}

test('successful probes retain model count and latency in both modes', async () => {
  const ui = loadSettings(async () => response({ ok: true, code: 'ok', modelsCount: 7, latencyMs: 12 }));
  ui.single().props.onClick();
  await settle();
  ui.render();
  assert.equal(text(ui.result()), '7m');
  ui.bulk().props.onClick();
  await settle();
  ui.render();
  for (let index = 0; index < 2; index++) {
    assert.equal(text(ui.result(index)), '7m');
    assert.match(ui.result(index).props.title, /12ms/);
  }
});

test('bulk clears old results, reports progress and never runs probes in parallel', async () => {
  const gates = [];
  let gated = false;
  const ui = loadSettings(() => {
    if (!gated) return Promise.resolve(response({ ok: true }));
    const gate = deferred(); gates.push(gate); return gate.promise;
  });
  ui.bulk().props.onClick();
  await settle();
  ui.render();
  assert.ok(ui.result(0));
  assert.ok(ui.result(1));
  gated = true;
  ui.bulk().props.onClick();
  ui.render();
  assert.equal(gates.length, 1, 'start just the first request');
  assert.equal(ui.result(0), undefined);
  assert.equal(ui.result(1), undefined);
  assert.equal(ui.single(0).props.disabled, true);
  assert.equal(ui.single(1).props.disabled, true);
  gates[0].resolve(response({ ok: false, code: 'auth' }));
  await settle();
  ui.render();
  assert.equal(gates.length, 2);
  assert.match(text(ui.result(0)), /auth/);
  assert.equal(ui.result(1), undefined);
  assert.match(text(ui.bulk()), /1.*2/);
  gates[1].resolve(response({ ok: true, modelsCount: 2 }));
  await settle();
  ui.render();
  assert.equal(text(ui.result(1)), '2m');
  assert.equal(ui.bulk().props.disabled, false);
  assert.equal(ui.single().props.disabled, false);
});

test('synchronous repeated clicks and cross-provider clicks cannot overlap a run', async () => {
  const gate = deferred();
  const ui = loadSettings(() => gate.promise, [
    { provider: 'example', keys: ['KEY_A'] }, { provider: 'other', keys: ['KEY_B'] },
  ]);
  const single = ui.single().props.onClick;
  const bulkOther = ui.bulk(1).props.onClick;
  single(); single(); bulkOther();
  assert.equal(ui.calls.length, 1);
  ui.render();
  assert.equal(ui.bulk(0).props.disabled, true);
  assert.equal(ui.bulk(1).props.disabled, true);
  assert.equal(ui.single(1).props.disabled, true);
  gate.resolve(response({ ok: false, code: 'auth' }));
  await settle();
  ui.render();
  ui.bulk(1).props.onClick();
  await settle();
  ui.render();
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.calls[1].ref, 'KEY_B');
});

test('50-key pool uses exactly one in-flight request, not Promise.all bursts', async () => {
  let active = 0, maximum = 0;
  const keys = Array.from({ length: 50 }, (_, index) => 'KEY_' + index);
  const ui = loadSettings(async () => {
    active++; maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
    return response({ ok: false, code: 'rate-limit' });
  }, [{ provider: 'example', keys }]);
  ui.bulk().props.onClick();
  await settle();
  assert.equal(ui.calls.length, 50);
  assert.equal(maximum, 1);
  assert.deepEqual(ui.calls.map((body) => body.ref), keys);
  assert.ok(ui.calls.every((body) => body.probe === 'models'));
});

for (const [name, failure, expected] of [
  ['HTTP error with misleading success body', async () => response({ ok: true }, 503), /http-503/],
  ['bridge error', async () => response({ error: { code: 'forbidden', message: 'local only' } }, 403), /forbidden/],
  ['malformed success envelope', async () => response({ something: true }), /invalid-response/],
  ['null success envelope', async () => response(null), /invalid-response/],
  ['JSON parse error', async () => ({ ok: true, status: 200, json: async () => { throw new Error('Invalid JSON'); } }), /Invalid JSON/],
  ['transport rejection', async () => { throw new Error('fetch failed'); }, /fetch failed/],
]) {
  test(`${name} remains a failure and does not stop the next key`, async () => {
    const ui = loadSettings((body) => body.ref === 'KEY_A' ? failure() : Promise.resolve(response({ ok: true, modelsCount: 3 })));
    ui.bulk().props.onClick();
    await settle();
    ui.render();
    assert.match(text(ui.result(0)), /✕/);
    assert.match(ui.result(0).props.title, expected);
    assert.equal(text(ui.result(1)), '3m');
    assert.equal(ui.bulk().props.disabled, false);
    ui.single(1).props.onClick();
    await settle();
    assert.equal(ui.calls.length, 3, 'the run lock must have been released');
  });
}

test('bulk ignores blank refs and probes duplicate refs just once', async () => {
  const ui = loadSettings(async () => response({ ok: true }), [{ provider: 'example', keys: ['KEY_A', '', '  ', 'KEY_A', 'KEY_B'] }]);
  ui.bulk().props.onClick();
  await settle();
  assert.deepEqual(ui.calls.map((body) => body.ref), ['KEY_A', 'KEY_B']);
});

test('all-blank pool performs no request and never gets stuck busy', async () => {
  const ui = loadSettings(async () => { throw new Error('must not fetch'); }, [{ provider: 'example', keys: ['', '  '] }]);
  ui.bulk().props.onClick();
  await settle();
  ui.render();
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.bulk().props.disabled, false);
});

// Exercise the real backend route with an in-memory request/response and a fake
// sandbox. No host, TCP listener, credentials file or upstream API is touched.
function routeFixture(probeResult, present = true) {
  const routes = new Map();
  const calls = [];
  const cache = new Map();
  const keyState = {
    failedUntil: new Map([['KEY_A', 123], ['KEY_B', 456]]),
    failCounts: new Map([['KEY_A', 2]]), authFailCounts: new Map([['KEY_A', 2]]),
    brokenUntil: new Map([['KEY_A', 789]]),
  };
  const credentials = {
    resolve: async () => { throw new Error('rotation wrapper must be bypassed'); },
    __dshKeyRotationOriginalResolve: async () => present ? { value: 'dummy-test-value' } : undefined,
    describe: async () => ({ source: 'test' }),
  };
  registerTestRoutes({
    effect: (fn) => fn(),
    webServer: { register: (route) => { routes.set(route.path, route.handler); } },
    get: (name) => name === 'credentials' ? credentials : undefined,
  }, {
    lastTestCache: cache, poolState: new Map([['example', keyState]]),
    ensureSandboxRunner: () => ({ probeModels: async (ref, value) => { calls.push({ ref, value }); return probeResult; } }),
  });
  return {
    calls, cache, keyState,
    async request(body, remoteAddress = '127.0.0.1') {
      const req = Readable.from([JSON.stringify(body)]);
      req.method = 'POST'; req.headers = {}; req.socket = { remoteAddress };
      let status, data;
      await routes.get('/dsh-key-rotation/test')(req, {
        writeHead: (code) => { status = code; },
        end: (raw) => { data = JSON.parse(raw); },
      });
      return { status, data };
    },
  };
}

test('route proves presence success is not live authentication success', async () => {
  const fixture = routeFixture({ ok: false, code: 'auth', latencyMs: 3 });
  const live = await fixture.request({ ref: 'KEY_A', probe: 'models' });
  assert.equal(live.data.ok, false);
  assert.equal(live.data.code, 'auth');
  assert.equal(fixture.calls.length, 1);
  const presence = await fixture.request({ ref: 'KEY_A' });
  assert.equal(presence.data.ok, true);
  assert.equal(fixture.calls.length, 1, 'presence check must not contact provider');
  assert.equal(fixture.cache.get('KEY_A').ok, false, 'presence must not replace the probe cache');
  assert.equal(fixture.keyState.failedUntil.get('KEY_A'), 123, 'failed probe must not clear quarantine');
});

test('live success probes exact credential and clears only that key quarantine', async () => {
  const fixture = routeFixture({ ok: true, code: 'ok', modelsCount: 4, latencyMs: 2 });
  const result = await fixture.request({ ref: 'KEY_A', probe: 'models' });
  assert.equal(result.data.modelsCount, 4);
  assert.deepEqual(fixture.calls, [{ ref: 'KEY_A', value: 'dummy-test-value' }]);
  for (const field of ['failedUntil', 'failCounts', 'authFailCounts', 'brokenUntil']) assert.equal(fixture.keyState[field].has('KEY_A'), false);
  assert.equal(fixture.keyState.failedUntil.get('KEY_B'), 456);
  assert.equal(fixture.cache.get('KEY_A').ok, true);
  assert.ok(fixture.cache.get('KEY_A').at > 0);
});

test('pre-save value validation stays offline and missing credentials stay errors', async () => {
  const fixture = routeFixture({ ok: true }, false);
  const missing = await fixture.request({ ref: 'KEY_A', probe: 'models' });
  assert.equal(missing.data.code, 'no-credential');
  const presave = await fixture.request({ ref: 'KEY_A', value: 'dummy-new-value' });
  assert.equal(presave.data.ok, true);
  assert.equal(presave.data.source, 'pre-save');
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.cache.size, 0);
});

test('test route still rejects non-local clients without resolving or probing keys', async () => {
  const fixture = routeFixture({ ok: true });
  const result = await fixture.request({ ref: 'KEY_A', probe: 'models' }, '203.0.113.2');
  assert.equal(result.status, 403);
  assert.equal(fixture.calls.length, 0);
});

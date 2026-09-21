import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const marker = "    module.exports = { apply, inject: ['slots', 'locale', 'settingsScope'] };";
assert.equal(source.split(marker).length, 2);
const configPath = '/dsh-key-rotation/config';
const value = { providers: [{ provider: 'sensenova', keys: ['KEY_A'] }], switchCodes: [] };
const ready = (revision = 7) => ({ status: 'ready', value, revision });
const catalog = [{ id: 'sensenova', name: 'SenseNova' }];
const response = (body = { providers: catalog, value, revision: 1 }, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((n) => nodes(n, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.children, predicate)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  return tree == null || tree === false ? '' : typeof tree === 'object' ? text(tree.children) : String(tree);
}

// Execute the real component, including its effects and initial state. This
// deliberately small hook driver is NOT React: subscriptions are notified via
// setSnapshot(), nested child components/DOM are not mounted. CI additionally
// smoke-tests the unmodified component with real React/test-renderer.
function mount(getConfig = async () => response(), initialSnapshot = ready()) {
  let snapshot = initialSnapshot, cursor = 0, dirty = true, tree, hookCount, disposed = false;
  const slots = [], pending = [], calls = [], timers = new Map(), events = new Map();
  let timerId = 0;
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));
  const React = {
    Component: class {},
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, (next) => {
        assert.equal(disposed, false, 'no updates after unmount');
        const v = typeof next === 'function' ? next(slots[i].value) : next;
        if (!Object.is(v, slots[i].value)) { slots[i].value = v; dirty = true; }
      }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useMemo(fn, deps) {
      const i = cursor++;
      if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { value: fn(), deps };
      return slots[i].value;
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useSyncExternalStore(_subscribe, getSnapshot) { cursor++; return getSnapshot(); },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || changed(slots[i].deps, deps)) {
        const previous = slots[i]; slots[i] = { deps, cleanup: previous?.cleanup };
        pending.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  const scope = { getSnapshot: () => snapshot, subscribe: () => () => {} };
  const props = { ctx: { settingsScope: { bind: () => scope } } };
  const context = {
    window: { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: (name) => events.delete(name),
      __ModuleLoader__: { load(definition) { definition.factory((name) => {
        if (name === 'react') return React;
        throw new Error('Optional module not supplied');
      }); } } },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === configPath) return getConfig(options);
      if (url === '/dsh-key-rotation/test') return response({ ok: false, code: 'auth' });
      if (url === '/dsh-key-rotation/status') return response({ providers: [] });
      if (url === '/dsh-key-rotation/sandbox-cache') return response({});
      throw new Error('Unexpected request: ' + url);
    },
    AbortController,
    setInterval: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id),
    console,
  };
  vm.runInNewContext(source.replace(marker, '    globalThis.Section = KeyRotationSection;\n' + marker), context);
  function render() {
    let turns = 0;
    while (dirty) {
      assert.ok(++turns < 40, 'effects must settle without a render loop');
      dirty = false; cursor = 0; tree = context.Section(props);
      if (hookCount !== undefined) assert.equal(cursor, hookCount, 'hook order/count must not change');
      hookCount = cursor;
      for (const effect of pending.splice(0)) effect();
    }
  }
  const ui = {
    calls, events, timers,
    render,
    async flush() { for (let i = 0; i < 3; i++) { await new Promise(setImmediate); render(); } },
    setSnapshot(next) { snapshot = next; dirty = true; render(); },
    option: () => nodes(tree, (n) => n.type === 'option' && n.props.value === 'sensenova')[0],
    rows: () => nodes(tree, (n) => n.props.className === 'krot-key'),
    buttons: (title) => nodes(tree, (n) => n.type === 'button' && n.props.title === title),
    allText: () => text(tree),
    retry() { const button = nodes(tree, (n) => n.type === 'button' && text(n) === 'Retry')[0]; assert.ok(button); button.props.onClick(); render(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); disposed = true; },
  };
  render();
  return ui;
}

test('already-ready scope still loads the registered provider catalog', async () => {
  const ui = mount();
  await ui.flush();
  assert.equal(ui.calls.filter((c) => c.url === configPath).length, 1, 'ready scope must still fetch catalog');
  assert.equal(text(ui.option()), 'SenseNova — sensenova');
  assert.equal(ui.rows().length, 1);
  ui.unmount();
});

test('pending catalog is unknown, not an unregistered verdict', async () => {
  const gate = deferred();
  const ui = mount(() => gate.promise);
  assert.doesNotMatch(text(ui.option()), /not registered/);
  assert.match(text(ui.option()), /Loading/);
  gate.resolve(response()); await ui.flush();
  assert.match(text(ui.option()), /SenseNova/);
  ui.unmount();
});

for (const [name, result] of [
  ['HTTP 503', () => response({ providers: [] }, 503)],
  ['transport error', () => Promise.reject(new Error('offline'))],
  ['malformed catalog', () => response({ value })],
  ['malformed provider', () => response({ providers: [{ name: 'SenseNova' }] })],
]) {
  test(`${name}: keep settings editable, avoid false absence, allow retry`, async () => {
    let failed = true;
    const ui = mount(() => failed ? result() : response());
    await ui.flush();
    assert.equal(ui.rows().length, 1);
    assert.doesNotMatch(text(ui.option()), /not registered/);
    assert.match(ui.allText(), /Provider list unavailable/);
    failed = false; ui.retry(); await ui.flush();
    assert.equal(text(ui.option()), 'SenseNova — sensenova');
    ui.unmount();
  });
}

test('a successful empty catalog still identifies truly absent routes', async () => {
  const ui = mount(async () => response({ providers: [] }));
  await ui.flush();
  assert.match(text(ui.option()), /not registered/);
  ui.unmount();
});

test('late catalog response cannot overwrite settingsScope or unsaved keys', async () => {
  const gate = deferred();
  const ui = mount(() => gate.promise);
  ui.buttons('Add API key')[0].props.onClick(); ui.render();
  assert.equal(ui.rows().length, 2);
  ui.setSnapshot(ready(15));
  gate.resolve(response({ providers: catalog, value: { providers: [] }, revision: 1 }));
  await ui.flush();
  assert.equal(ui.rows().length, 2);
  assert.equal(text(ui.option()), 'SenseNova — sensenova');
  ui.unmount();
});

for (const rejects of [false, true]) {
  test(`pending-to-ready scope ignores late fallback ${rejects ? 'failure' : 'snapshot'}`, async () => {
    const fallback = deferred();
    const ui = mount((options) => options.signal ? Promise.resolve(response()) : fallback.promise, { status: 'loading' });
    ui.setSnapshot(ready(15));
    if (rejects) fallback.reject(new Error('late error'));
    else fallback.resolve(response({ providers: [], value: { providers: [] }, revision: 1 }));
    await ui.flush();
    assert.equal(ui.rows().length, 1, 'late fallback must not replace the ready settings or hide the editor');
    assert.equal(text(ui.option()), 'SenseNova — sensenova');
    ui.unmount();
  });
}

test('fallback configuration still works when settingsScope is not ready', async () => {
  const ui = mount(async () => response(), { status: 'loading' });
  await ui.flush();
  assert.equal(ui.rows().length, 1);
  assert.equal(text(ui.option()), 'SenseNova — sensenova');
  ui.unmount();
});

test('focus refresh ignores an older catalog response arriving out of order', async () => {
  const old = deferred(), latest = deferred(); let n = 0;
  const ui = mount(() => ++n === 1 ? old.promise : latest.promise);
  assert.equal(typeof ui.events.get('focus'), 'function');
  ui.events.get('focus')();
  latest.resolve(response()); await ui.flush();
  old.resolve(response({ providers: [] })); await ui.flush();
  assert.equal(text(ui.option()), 'SenseNova — sensenova');
  ui.unmount();
});

test('unmount aborts catalog work and removes polling/focus listeners', async () => {
  const gate = deferred();
  const ui = mount(() => gate.promise);
  const request = ui.calls.find((c) => c.url === configPath);
  assert.ok(request?.options.signal);
  ui.unmount();
  assert.equal(request.options.signal.aborted, true);
  assert.equal(ui.events.size, 0);
  assert.equal(ui.timers.size, 0);
  gate.resolve(response()); await new Promise(setImmediate);
});

test('single and bulk buttons still request real probes with visible errors', async () => {
  const ui = mount(); await ui.flush();
  ui.buttons('Test')[0].props.onClick(); await ui.flush();
  ui.buttons('Test all keys')[0].props.onClick(); await ui.flush();
  const tests = ui.calls.filter((c) => c.url === '/dsh-key-rotation/test');
  assert.equal(tests.length, 2);
  for (const call of tests) assert.deepEqual(JSON.parse(call.options.body), { ref: 'KEY_A', probe: 'models' });
  assert.match(ui.allText(), /auth/);
  ui.unmount();
});

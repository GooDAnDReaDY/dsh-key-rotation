import test from 'node:test';
import assert from 'node:assert/strict';
import { clientRuntime, memoryHost, browserScope, deferred, act } from './support/client-runtime.mjs';

async function page(t, options) { const rt = await clientRuntime(options); t.after(() => rt.dispose()); await rt.mount(); return rt; }

test('modern-only services activate the client without legacy settingsScope', async t => {
  const rt = await page(t, { kind: 'modern', strict: true });
  assert.ok(rt.button('save'));
});

test('legacy save preserves a secret that was never sent to the browser', async t => {
  const host = memoryHost({ webhookActionToken: 'fixture-private-token' });
  const rt = await page(t, { host });
  await rt.edit('cooldown', '120000');
  await rt.click('save');
  assert.equal(host.user.webhookActionToken, 'fixture-private-token');
  assert.equal(host.user.cooldownMs, 120000);
});

test('Discard returns to a usable form when the scope was already ready', async t => {
  const rt = await page(t);
  await rt.edit('cooldown', '120000');
  await rt.click('discard');
  assert.ok(rt.button('save'), 'form must not remain Loading');
  assert.equal(rt.input('cooldown').props.value, '60000');
});

test('conflict keeps the draft visible and offers a working Discard', async t => {
  const rt = await page(t);
  await rt.edit('cooldown', '120000');
  await rt.publish({ cooldownMs: 30000 });
  await rt.click('save');
  assert.equal(rt.host.user.cooldownMs, 30000);
  assert.ok(rt.button('discard'), 'save error must not replace the entire form');
  assert.equal(rt.input('cooldown').props.value, '120000');
  await rt.click('discard');
  assert.equal(rt.input('cooldown').props.value, '30000');
});

test('one changed field does not freeze other inherited/default fields', async t => {
  const rt = await page(t);
  await rt.edit('cooldown', '120000');
  await rt.click('save');
  const write = rt.host.writes.at(-1);
  assert.equal(write.kind, 'mutate');
  assert.deepEqual(write.payload, [{ op: 'set', path: ['cooldownMs'], value: 120000 }]);
});

test('closing and reopening the page does not bind a legacy scope per mount', async t => {
  const rt = await page(t);
  await rt.unmount(); await rt.mount();
  await rt.unmount(); await rt.mount();
  assert.equal(rt.binds, 1);
});

test('a live snapshot cannot visually unlock an in-flight save', async t => {
  const rt = await page(t);
  await rt.edit('cooldown', '120000');
  rt.host.hold = deferred();
  await rt.click('save');
  await rt.publish({ cooldownMs: 45000 });
  assert.equal(rt.button('save').props.disabled, true);
  await act(async () => { rt.host.hold.resolve(); });
});

test('snapshot import stages changes instead of writing behind a dirty draft', async t => {
  const rt = await page(t);
  await rt.edit('cooldown', '120000');
  await rt.importFile('snapshotImport', JSON.stringify({ cooldownMs: 90000, webhookActionToken: '' }));
  assert.equal(rt.requests.filter(req => req.method !== 'GET').length, 0);
  assert.equal(rt.input('cooldown').props.value, '90000');
});

test('a filtered provider row edits its original provider, not index zero', async t => {
  const host = memoryHost({ providers: [{ provider: 'a', keys: ['A_KEY'], weights: [1] }, { provider: 'b', keys: ['B_KEY'], weights: [2] }] });
  const rt = await page(t, { host });
  await act(async () => { rt.root.findAllByType('input').find(x => x.props.placeholder === 'Search providers…').props.onChange({ target: { value: 'b' } }); });
  await act(async () => { rt.root.findAllByType('input').find(x => x.props.type === 'number').props.onChange({ target: { value: '7' } }); });
  await rt.click('save');
  assert.deepEqual(host.user.providers.map(p => p.weights[0]), [1, 7]);
});

test('modern refusal is an error, not permission to replay through a second transport', async t => {
  const host = memoryHost();
  const scope = browserScope(host);
  scope.returnValue = false;
  const rt = await page(t, { host, scope, kind: 'both' });
  await rt.edit('cooldown', '120000');
  await rt.click('save');
  assert.equal(host.writes.length, 0);
  assert.equal(rt.input('cooldown').props.value, '120000');
});

test('no settings service gives unavailable, then late legacy provision activates the existing page', async t => {
  const rt = await page(t, { kind: 'none', strict: true });
  assert.match(JSON.stringify(rt.rendered), /unavailableTitle/);
  assert.equal(rt.requests.filter(r => r.url === '/dsh-key-rotation/config').length, 0);
  await rt.provide('settingsScope', { bind: () => rt.scope });
  assert.ok(rt.button('save'));
});

for (const kind of ['legacy', 'modern']) {
  test(`${kind} unavailable/memory scope never attempts a local bridge settings write`, async t => {
    const host = memoryHost(); const scope = browserScope(host);
    scope.publish({ mode: 'memory', status: 'unavailable', value: undefined, writable: false });
    const rt = await page(t, { host, scope, kind });
    assert.match(JSON.stringify(rt.rendered), /unavailableTitle/);
    assert.equal(rt.requests.filter(r => r.url === '/dsh-key-rotation/config').length, 0);
  });
}

test('read-only snapshot disables editing and follows writable changes without a new revision', async t => {
  const host = memoryHost(); host.writable = false;
  const rt = await page(t, { host });
  assert.equal(rt.button('save').props.disabled, true);
  await rt.edit('cooldown', '123000');
  assert.equal(rt.input('cooldown').props.value, '60000');
  await act(async () => rt.scope.publish({ writable: true })); host.writable = true;
  await rt.edit('cooldown', '123000'); await rt.click('save');
  assert.equal(host.user.cooldownMs, 123000);
});

test('modern undefined settlement is not treated as successful acceptance', async t => {
  const host = memoryHost(); const scope = browserScope(host); scope.returnValue = undefined;
  const rt = await page(t, { host, scope, kind: 'modern' });
  await rt.edit('cooldown', '123000'); await rt.click('save');
  assert.equal(host.writes.length, 0); assert.equal(rt.input('cooldown').props.value, '123000');
  assert.match(JSON.stringify(rt.rendered), /saveRefused/);
});

test('invalid HTTP success response preserves the draft instead of reporting success', async t => {
  const rt = await page(t, { fetchOverride(url, init) {
    if (init.method === 'PUT') return { ok: true, status: 200, json: async () => ({}) };
  } });
  await rt.edit('cooldown', '123000'); await rt.click('save');
  assert.equal(rt.input('cooldown').props.value, '123000');
  assert.equal(rt.button('save').props.disabled, false);
  assert.match(JSON.stringify(rt.rendered), /saveUnconfirmed/);
});

test('failed GET can be retried and never accepts an unavailable namespace as a blank form', async t => {
  let fail = true;
  const host = memoryHost(); const scope = browserScope(host); scope.publish({ status: 'loading', value: undefined });
  const rt = await page(t, { host, scope, fetchOverride(url, init) {
    if (url === '/dsh-key-rotation/config' && !init.method && fail) return Promise.reject(new Error('offline'));
  } });
  assert.ok(rt.button('retry'));
  fail = false; await rt.click('retry');
  assert.ok(rt.button('save'));
});

test('late GET cannot roll back a newer live snapshot', async t => {
  const host = memoryHost(); const scope = browserScope(host);
  scope.publish({ status: 'loading', value: undefined });
  const held = deferred();
  const rt = await page(t, { host, scope, fetchOverride(url, init) {
    if (url === '/dsh-key-rotation/config' && !init.method) return held.promise;
  } });
  await rt.publish({ cooldownMs: 75000 });
  await act(async () => held.resolve({ ok: true, status: 200, json: async () => ({ available: true, writable: true, value: { cooldownMs: 1000 }, revision: 1, providers: [] }) }));
  assert.equal(rt.input('cooldown').props.value, '75000');
});

test('timeout unlocks save but a late acceptance cannot clear the retained draft', async t => {
  const host = memoryHost(); const scope = browserScope(host); const held = deferred();
  scope.mutate = () => held.promise;
  const rt = await page(t, { host, scope, kind: 'modern' });
  await rt.edit('cooldown', '123000'); await rt.click('save');
  assert.equal(rt.button('save').props.disabled, true);
  await rt.fireTimers(15000);
  assert.equal(rt.button('save').props.disabled, false);
  await act(async () => held.resolve(true));
  assert.equal(rt.input('cooldown').props.value, '123000');
  assert.match(JSON.stringify(rt.rendered), /saveUnconfirmed/);
});

test('double click and edit handlers are guarded before React commits disabled controls', async t => {
  const rt = await page(t); rt.host.hold = deferred();
  await rt.edit('cooldown', '123000');
  const save = rt.button('save').props.onClick, change = rt.input('cooldown').props.onChange;
  await act(async () => { save(); save(); change({ target: { value: '999999' } }); });
  assert.equal(rt.host.writes.length, 1);
  await act(async () => rt.host.hold.resolve());
  assert.equal(rt.host.user.cooldownMs, 123000);
});

test('reverting a draft releases its original fence before a new edit', async t => {
  const rt = await page(t);
  await rt.edit('cooldown', '123000'); await rt.edit('cooldown', '60000');
  await rt.publish({ cooldownMs: 75000 }); await rt.edit('cooldown', '100000'); await rt.click('save');
  assert.equal(rt.host.user.cooldownMs, 100000);
  assert.equal(rt.host.writes.at(-1).expected, 11);
});

test('batch provider removal really removes selected entries without Array.has', async t => {
  const rt = await page(t, { host: memoryHost({ providers: [{ provider: 'a', keys: ['A_KEY'] }, { provider: 'b', keys: ['B_KEY'] }] }) });
  await act(async () => rt.root.findAllByType('input').filter(x => x.props['aria-label'])[0].props.onChange({ target: { checked: true } }));
  await rt.click('bulkRemove');
  const button = rt.root.findByProps({ role: 'dialog' }).findAllByType('button').find(x => x.children.join('') === 'tr:bulkRemove');
  await act(async () => button.props.onClick());
  await rt.click('save');
  assert.deepEqual(rt.host.user.providers.map(p => p.provider), ['b']);
});

test('key move preserves weights and expirations by credential identity', async t => {
  const rt = await page(t, { host: memoryHost({ providers: [{ provider: 'a', keys: ['A_KEY', 'B_KEY'], weights: [2, 9], expiresAt: [100000, 200000] }] }) });
  await act(async () => rt.root.findAllByType('button').find(x => x.children.join('') === '↓').props.onClick());
  await rt.click('save');
  const p = rt.host.user.providers[0];
  assert.deepEqual(p.keys, ['B_KEY', 'A_KEY']); assert.deepEqual(p.weights, [9, 2]); assert.deepEqual(p.expiresAt, [200000, 100000]);
});

test('remove and Undo restore both key and positional metadata; removing the last key leaves Add key reachable', async t => {
  const rt = await page(t, { host: memoryHost({ providers: [{ provider: 'a', keys: ['A_KEY'], weights: [9], expiresAt: [200000] }] }) });
  await act(async () => rt.root.findAllByType('button').find(x => x.props.title === 'tr:removeKey').props.onClick());
  assert.ok(rt.button('addKey'));
  await rt.click('undo'); await rt.click('save');
  assert.deepEqual(rt.host.user.providers[0], { provider: 'a', keys: ['A_KEY'], weights: [9], expiresAt: [200000] });
});

test('malformed imported JSON does not alter an existing draft and releases import lock', async t => {
  const rt = await page(t);
  await rt.edit('cooldown', '123000'); await rt.importFile('snapshotImport', '{invalid');
  assert.equal(rt.input('cooldown').props.value, '123000');
  assert.equal(rt.button('save').props.disabled, false);
  await rt.click('save'); assert.equal(rt.host.user.cooldownMs, 123000);
});

test('unsafe or invalid provider import cannot persist a partially edited configuration', async t => {
  const rt = await page(t);
  await rt.importFile('importPools', JSON.stringify([{ provider: 'a', keys: ['not a credential ref'] }]));
  await rt.click('save');
  assert.equal(rt.host.writes.length, 0);
  assert.match(JSON.stringify(rt.rendered), /credential reference/);
});

test('typed secret remains attached to its key after reordering, not to the former row index', async t => {
  const rt = await page(t, { host: memoryHost({ providers: [{ provider: 'a', keys: ['A_KEY', 'B_KEY'] }] }) });
  await act(async () => rt.root.findAllByType('input').find(x => x.props.type === 'password').props.onChange({ target: { value: 'dummy-unsaved-secret' } }));
  await act(async () => rt.root.findAllByType('button').find(x => x.children.join('') === '↓').props.onClick());
  assert.deepEqual(rt.root.findAllByType('input').filter(x => x.props.type === 'password').map(x => x.props.value), ['', 'dummy-unsaved-secret']);
});

test('read-only transition still leaves Discard outside the disabled edit controls', async t => {
  const rt = await page(t); await rt.edit('cooldown', '123000');
  await act(async () => rt.scope.publish({ writable: false }));
  const discard = rt.button('discard');
  let node = discard; while (node) { assert.notEqual(node.type === 'fieldset' && node.props.disabled, true); node = node.parent; }
  await rt.click('discard'); assert.equal(rt.input('cooldown').props.value, '60000');
});

test('malformed snapshot provider structure cannot crash the settings page', async t => {
  const rt = await page(t); await rt.edit('cooldown', '123000');
  await rt.importFile('snapshotImport', JSON.stringify({ providers: [{ provider: 'a', keys: {} }] }));
  assert.ok(rt.button('discard')); assert.equal(rt.input('cooldown').props.value, '123000');
  assert.equal(rt.host.writes.length, 0);
});

test('credential save finishing cannot erase text typed after that save started', async t => {
  const held = deferred();
  const rt = await page(t, { host: memoryHost({ providers: [{ provider: 'a', keys: ['KEY_A'] }] }), fetchOverride(url, init) {
    if (url === '/dsh-key-rotation/test') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url === '/dsh-key-rotation/key') return held.promise;
  } });
  const password = () => rt.root.findAllByType('input').find(x => x.props.type === 'password');
  await act(async () => password().props.onChange({ target: { value: 'first-dummy-value' } }));
  await act(async () => { rt.root.findAllByType('button').find(x => x.props.title === 'tr:keySave').props.onClick(); });
  await act(async () => password().props.onChange({ target: { value: 'second-dummy-value' } }));
  await act(async () => held.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  assert.equal(password().props.value, 'second-dummy-value');
});

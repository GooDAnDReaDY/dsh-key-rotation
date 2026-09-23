import test from 'node:test';
import assert from 'node:assert/strict';
import { realCoreFixture } from './support/real-core.mjs';
import { invokeRoute } from './support/client-runtime.mjs';

const version = process.env.DSH_TEST_CORE_VERSION;
const coreDir = process.env.DSH_TEST_CORE_DIR;
const options = { skip: !(version && coreDir) && 'Run the pinned DSH core matrix to exercise real Host persistence' };

test(`real DSH ${version}: config route writes through Host validation, preserves secrets and survives restart`, options, async t => {
  const f = await realCoreFixture(coreDir, version); t.after(() => f.dispose());
  const before = f.descriptor();
  assert.ok(before, 'The actual core must expose the plugin configuration, not just mount its JS');
  assert.equal(before.value.cooldownMs, 60000);
  assert.equal(before.value.webhookActionToken, undefined);
  const response = await invokeRoute(f.routes.get('/dsh-key-rotation/config'), {
    method: 'PUT', body: { ops: [{ op: 'set', path: ['cooldownMs'], value: 90000 }], expectedRevision: before.revision },
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(f.descriptor(false).value.webhookActionToken, 'fixture-only-private-token');
  assert.equal(f.plugin.getRuntime().cooldownMs, 90000, 'The running consumer must observe the write');
  assert.match(f.persisted, /90000/);
  const conflict = await invokeRoute(f.routes.get('/dsh-key-rotation/config'), {
    method: 'PUT', body: { ops: [{ op: 'set', path: ['cooldownMs'], value: 100000 }], expectedRevision: before.revision },
  });
  assert.equal(conflict.status, 409);
  assert.equal(f.plugin.getRuntime().cooldownMs, 90000);
  await f.restart();
  assert.equal(f.descriptor().value.cooldownMs, 90000);
  assert.equal(f.descriptor(false).value.webhookActionToken, 'fixture-only-private-token');
});

test(`real DSH ${version}: snapshot import preserves private token and rejects invalid fields atomically`, options, async t => {
  const f = await realCoreFixture(coreDir, version); t.after(() => f.dispose());
  const snapshot = f.routes.get('/dsh-key-rotation/snapshot');
  const success = await invokeRoute(snapshot, { method: 'POST', body: { snapshot: { cooldownMs: 120000, webhookActionToken: '' } } });
  assert.equal(success.status, 200, await success.text());
  assert.equal(f.descriptor(false).value.webhookActionToken, 'fixture-only-private-token');
  const saved = f.persisted;
  const rejected = await invokeRoute(f.routes.get('/dsh-key-rotation/config'), {
    method: 'PUT', body: { ops: [{ op: 'set', path: ['cooldownMs'], value: 'not-a-number' }], expectedRevision: f.descriptor().revision },
  });
  assert.equal(rejected.status, 400);
  assert.equal(f.persisted, saved);
});

test(`real Cordis in DSH ${version}: client optional injection, late services and teardown`, options, async t => {
  const { createRequire } = await import('node:module');
  const { resolve } = await import('node:path');
  const req = createRequire(resolve(coreDir, 'package.json'));
  const { Context } = await import(req.resolve('@deepseek-ai/cordis'));
  const { clientRuntime, browserScope, memoryHost } = await import('./support/client-runtime.mjs');
  const host = memoryHost();
  const rt = await clientRuntime({ kind: 'none', Context, host }); t.after(() => rt.dispose());
  await rt.mount();
  assert.match(JSON.stringify(rt.rendered), /unavailableTitle/);
  await rt.provide('configForms', { get: () => rt.scope });
  assert.ok(rt.button('save'));
  await rt.edit('cooldown', '80000');
  await rt.provide('configForms', undefined);
  assert.match(JSON.stringify(rt.rendered), /unavailableTitle/);
  const replacement = browserScope(host); t.after(() => replacement.dispose());
  await rt.provide('configForms', { get: () => replacement });
  await rt.click('save');
  assert.equal(host.writes.length, 0, 'An old draft must not cross a service replacement');
  await rt.click('discard');
  await rt.edit('cooldown', '85000'); await rt.click('save');
  assert.equal(host.user.cooldownMs, 85000);
});

test(`real Cordis in DSH ${version}: legacy binding is owned once and disposed with its provider`, options, async t => {
  const { createRequire } = await import('node:module'); const { resolve } = await import('node:path');
  const req = createRequire(resolve(coreDir, 'package.json'));
  const { Context, Service } = await import(req.resolve('@deepseek-ai/cordis'));
  const { clientRuntime, browserScope, memoryHost, act } = await import('./support/client-runtime.mjs');
  const host = memoryHost(); let binds = 0, disposed = 0;
  const rt = await clientRuntime({ kind: 'none', Context, host }); t.after(() => rt.dispose());
  class Binder extends Service {
    constructor(ctx) { super(ctx, 'settingsScope'); }
    bind() {
      binds++; const scope = browserScope(host, { legacy: true });
      this.ctx.effect(() => () => { disposed++; scope.dispose(); });
      return scope;
    }
  }
  const provider = rt.ctx.plugin(Binder);
  await provider.await(); await rt.ctx.fiber.await();
  await rt.mount(); await rt.unmount(); await rt.mount();
  assert.equal(binds, 1); assert.equal(disposed, 0);
  await act(async () => { await provider.dispose(); await rt.ctx.fiber.await(); });
  assert.equal(disposed, 1); assert.match(JSON.stringify(rt.rendered), /unavailableTitle/);
});

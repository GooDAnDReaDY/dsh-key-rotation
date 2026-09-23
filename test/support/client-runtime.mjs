import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { handleConfigBridge } from '../../lib/http-bridge.js';

export { act };
export const clone = (value) => structuredClone(value);
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// A deliberately small Host fixture. Refusals throw on the Host face; the old
// browser SettingsScope below swallows those refusals, exactly as the released
// 0.1.5/0.1.6 contract does. No production controller code is copied here.
export function memoryHost(initial = {}) {
  let user = { cooldownMs: 60000, providers: [], ...clone(initial) };
  let revision = 10;
  const listeners = new Set();
  const writes = [];
  const redacted = () => {
    const value = clone(user);
    delete value.webhookActionToken;
    return value;
  };
  const host = {
    writes, writable: true, available: true, hold: null,
    get revision() { return revision; },
    get user() { return clone(user); },
    snapshot() { return { status: host.available ? 'ready' : 'unavailable', value: host.available ? redacted() : undefined, revision, writable: host.writable, mode: 'host' }; },
    publish(patch = {}) { user = { ...user, ...clone(patch) }; revision++; for (const fn of listeners) fn(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    settings: {
      get writable() { return host.writable; },
      get hasDocument() { return true; },
      documentPath: '/test/settings.yml',
      describe(options) {
        if (!host.available) return [];
        return [{ ns: 'dsh-key-rotation', value: options?.redactSecrets ? redacted() : clone(user), user: options?.redactSecrets ? redacted() : clone(user), base: {}, revision, secrets: [{ path: ['webhookActionToken'], present: Boolean(user.webhookActionToken) }] }];
      },
      async replace(ns, section, expected) {
        return write('replace', ns, section, expected, () => clone(section));
      },
      async mutate(ns, ops, expected) {
        return write('mutate', ns, ops, expected, () => {
          const next = clone(user);
          for (const op of ops) {
            let target = next;
            for (const key of op.path.slice(0, -1)) target = target[key] ??= {};
            const key = op.path.at(-1);
            if (op.op === 'unset') delete target[key];
            else target[key] = clone(op.value);
          }
          return next;
        });
      },
    },
  };
  async function write(kind, ns, payload, expected, apply) {
    writes.push({ kind, ns, payload: clone(payload), expected });
    if (host.hold) await host.hold.promise;
    if (!host.available) throw new Error('namespace unavailable');
    if (!host.writable) throw new Error('read-only settings');
    if (expected !== undefined && expected !== revision) {
      throw Object.assign(new Error('changed elsewhere; discard or reload'), { code: 'SETTINGS_CONFLICT', expected, actual: revision });
    }
    user = apply(); revision++;
    for (const fn of listeners) fn();
  }
  return host;
}

export function browserScope(host, { legacy = false } = {}) {
  let snapshot = host.snapshot();
  const listeners = new Set();
  let disposed = false;
  const off = host.subscribe(() => {
    snapshot = host.snapshot();
    for (const fn of listeners) fn();
  });
  const scope = {
    calls: [], returnValue: 'automatic',
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async mutate(ops, revision) {
      scope.calls.push({ ops: clone(ops), revision });
      if (scope.returnValue instanceof Error) throw scope.returnValue;
      if (scope.returnValue !== 'automatic') return scope.returnValue;
      if (disposed || snapshot.mode === 'memory') return legacy ? undefined : false;
      try { await host.settings.mutate('dsh-key-rotation', ops, revision); }
      catch (error) {
        snapshot = host.snapshot(); for (const fn of listeners) fn();
        return legacy ? undefined : false;
      }
      return legacy ? undefined : true;
    },
    set(field, value) { return scope.mutate([{ op: 'set', path: [field], value }]); },
    publish(value) { snapshot = { ...snapshot, ...value }; for (const fn of listeners) fn(); },
    dispose() { disposed = true; off(); listeners.clear(); },
    get listenerCount() { return listeners.size; },
  };
  return scope;
}

export async function invokeRoute(handler, { method = 'GET', body, headers = {}, address = '127.0.0.1', url = '/dsh-key-rotation/config' } = {}) {
  const request = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
  Object.assign(request, { method, url, headers: { host: 'localhost:3000', origin: 'http://localhost:3000', ...headers }, socket: { remoteAddress: address } });
  let status = 200, text = '';
  const ended = deferred();
  await handler(request, { writeHead(code) { status = code; }, end(value = '') { text += value; ended.resolve(); } });
  await ended.promise;
  return { status, ok: status >= 200 && status < 300, text: async () => text, json: async () => JSON.parse(text) };
}

export async function clientRuntime({ kind = 'legacy', host = memoryHost(), strict = false, bypassActivation = false, fetchOverride, slots = ['plugins.row.config', 'plugins.bundle.config', 'settings.plugin.item', 'plugins.item'], scope: providedScope, Context: RealContext } = {}) {
  const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');
  const registrations = [], effects = [], serviceWaiters = [], timers = new Map();
  let timerId = 0, factory, root, binds = 0;
  const scope = providedScope ?? browserScope(host, { legacy: kind === 'legacy' });
  const scopeInstances = [];
  const requests = [];
  const elements = [];
  const document = {
    visibilityState: 'hidden', activeElement: null,
    head: { appendChild(el) { elements.push(el); }, append(el) { elements.push(el); } },
    body: { appendChild() {}, append() {} },
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement(tag) { return { tagName: tag, dataset: {}, style: {}, setAttribute() {}, getAttribute() {}, appendChild() {}, remove() {}, click() {} }; },
    addEventListener() {}, removeEventListener() {},
  };
  const sandbox = {
    React, console, document, navigator: { languages: ['en'] },
    AbortController, AbortSignal, URL, Blob, Error, TypeError, Promise, structuredClone, queueMicrotask,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearInterval(id) { timers.delete(id); },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    FileReader: class {
      readAsText(file) { Promise.resolve(file.text()).then(text => { this.result = text; this.onload?.(); }, error => { this.error = error; this.onerror?.(); }); }
    },
    window: { __ModuleLoader__: { load(reg) { factory = reg.factory; } }, addEventListener() {}, removeEventListener() {}, location: { hostname: 'localhost', origin: 'http://localhost:3000' } },
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      requests.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal });
      const override = fetchOverride?.(url, init);
      if (override !== undefined) return override;
      if (url === '/dsh-key-rotation/config') {
        return invokeRoute((req, res) => handleConfigBridge({ get: name => name === 'settings' ? host.settings : name === 'llm' ? { listProviders: () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } : undefined }, req, res, () => new Set()), { method, body: init.body });
      }
      return { ok: true, status: 200, json: async () => ({ currentVersion: '0.8.19', providers: [] }) };
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' });
  const plugin = factory(name => {
    if (name === 'react') return React;
    throw new Error('unprovided module: ' + name);
  });
  const localeSnapshot = { active: 'en' };
  const services = {
    locale: { getSnapshot: () => localeSnapshot, subscribe: () => () => {}, register: () => () => {}, bind: () => key => key },
    slots: {
      inject(name, cb) { if (slots.includes(name)) { const off = cb(); if (typeof off === 'function') effects.push(off); } return () => {}; },
      register(options, component) { const row = { options, component }; registrations.push(row); return () => { const i = registrations.indexOf(row); if (i >= 0) registrations.splice(i, 1); }; },
    },
  };
  function binder() {
    binds++;
    const bound = binds === 1 ? scope : browserScope(host, { legacy: true });
    scopeInstances.push(bound); effects.push(() => bound.dispose());
    return bound;
  }
  if (kind === 'legacy' || kind === 'both') services.settingsScope = { bind: binder };
  if (kind === 'modern' || kind === 'both') services.configForms = { get: () => scope };
  const createContext = (declared = plugin.inject ?? []) => new Proxy({
    get(name) { return services[name]; },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup); return () => cleanup?.(); },
    on: () => () => {},
    inject(names, cb) {
      const waiter = { names, cb, active: false };
      serviceWaiters.push(waiter);
      activate(waiter);
      return () => { waiter.active = false; };
    },
  }, {
    get(target, name) {
      if (name in target) return target[name];
      if (strict && !declared.includes(name)) throw new Error('undeclared service property ' + String(name));
      return services[name];
    },
  });
  function activate(waiter) {
    if (waiter.active || !waiter.names.every(name => services[name])) return;
    waiter.active = true;
    const cleanup = waiter.cb(createContext(waiter.names));
    if (typeof cleanup === 'function') effects.push(cleanup);
  }
  let ctx = createContext();
  const missing = (plugin.inject ?? []).filter(name => !services[name]);
  if (missing.length && !bypassActivation) throw new Error('plugin activation blocked by: ' + missing.join(', '));
  const serviceDisposers = new Map();
  if (RealContext) {
    ctx = new RealContext();
    for (const [name, service] of Object.entries(services)) serviceDisposers.set(name, ctx.provide(name, service));
    await ctx.plugin(plugin).await();
    await ctx.fiber.await();
  } else plugin.apply(ctx);
  function row() {
    const found = registrations.find(x => x.options.name === 'plugins.row.config') ?? registrations.find(x => x.options.name === 'settings.plugin.item') ?? registrations[0];
    if (!found) throw new Error('no registered settings page');
    return found;
  }
  const runtime = {
    host, scope, plugin, ctx, registrations, requests, timers,
    get root() { return root?.root; },
    get binds() { return binds; },
    get rendered() { return root?.toJSON(); },
    async mount() { const r = row(); await act(async () => { root = Renderer.create(React.createElement(r.component, { view: 'page', t: key => 'tr:' + key, ...(r.options.inject?.() ?? {}) })); }); },
    async unmount() { await act(async () => { root?.unmount(); root = undefined; }); },
    async dispose() { await runtime.unmount(); if (RealContext) await ctx.fiber.dispose(); for (const cleanup of effects.splice(0).reverse()) await cleanup(); scope.dispose(); },
    button(label) { return root.root.findAllByType('button').find(node => node.children.join('') === 'tr:' + label); },
    input(label) { const field = root.root.findAllByType('label').find(node => node.findAllByType('span').some(span => span.children.join('') === 'tr:' + label)); return field?.findAllByType('input')[0]; },
    async click(label) { const button = runtime.button(label); if (!button) throw new Error('button missing: ' + label); await act(async () => { button.props.onClick(); }); },
    async edit(label, value) { const input = runtime.input(label); if (!input) throw new Error('input missing: ' + label); await act(async () => { input.props.onChange({ target: { value } }); }); },
    async publish(patch) { await act(async () => { host.publish(patch); }); },
    async provide(name, service) { await act(async () => {
      if (RealContext) { serviceDisposers.get(name)?.(); await ctx.fiber.await(); }
      services[name] = service;
      if (RealContext) { if (service) serviceDisposers.set(name, ctx.provide(name, service)); await ctx.fiber.await(); }
      else for (const waiter of serviceWaiters) activate(waiter);
    }); },
    async fireTimers(ms) { await act(async () => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } }); },
    async importFile(label, text) {
      const field = root.root.findAllByType('label').find(node => node.children.some(child => child === 'tr:' + label));
      if (!field) throw new Error('file control missing: ' + label);
      await act(async () => { field.findByType('input').props.onChange({ target: { files: [{ text: async () => text }], value: 'file.json' } }); });
    },
  };
  return runtime;
}

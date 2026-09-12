// test/client-factory-import.test.mjs — Ensure browser client factory imports cleanly without ReferenceErrors (#285).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('client: module factory imports cleanly and defines inject and apply', () => {
  const clientPath = path.resolve(__dirname, '../lib/client.js');
  const code = fs.readFileSync(clientPath, 'utf8');

  let loadedConfig = null;
  const fakeWindow = {
    __ModuleLoader__: {
      load: (cfg) => {
        loadedConfig = cfg;
      },
    },
  };

  const ctx = vm.createContext({
    window: fakeWindow,
    document: {
      createElement: () => ({ dataset: {}, setAttribute: () => {}, textContent: '' }),
      getElementById: () => null,
      head: { appendChild: () => {} },
      body: { appendChild: () => {}, removeChild: () => {} },
    },
    console,
    setTimeout,
    clearTimeout,
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    Blob: class {},
    FileReader: class {},
  });

  vm.runInContext(code, ctx);
  assert.ok(loadedConfig, 'window.__ModuleLoader__.load must be called');
  assert.equal(loadedConfig.id, '@goodandready/dsh-key-rotation');
  assert.equal(typeof loadedConfig.factory, 'function');

  const mockReact = {
    createElement: () => ({}),
    useMemo: (fn) => fn(),
    useState: (init) => [init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
    useSyncExternalStore: () => ({}),
    Component: class {},
  };

  const mockRequire = (mod) => {
    if (mod === 'react') return mockReact;
    if (mod === 'cordis') return {};
    return {};
  };

  // Factory execution must NOT throw any ReferenceError (e.g. t is not defined)
  const exports = loadedConfig.factory(mockRequire);
  assert.ok(exports, 'Factory must return module.exports');
  assert.equal(typeof exports.apply, 'function');
  assert.ok(Array.isArray(exports.inject));
  assert.ok(exports.inject.includes('slots'));
  assert.ok(exports.inject.includes('locale'));
  assert.ok(exports.inject.includes('settingsScope'));

  // Test apply(mockCtx)
  const registeredSlots = [];
  const mockCordisCtx = {
    effect: (fn) => fn(),
    get: (name) => {
      if (name === 'slots') return { inject: (slot, comp) => registeredSlots.push({ slot, comp }) };
      if (name === 'locale') return { register: () => {}, getSnapshot: () => ({ active: 'en' }) };
      if (name === 'settingsScope') return { bind: () => ({}) };
      return {};
    },
    slots: { inject: (slot, comp) => registeredSlots.push({ slot, comp }) },
    locale: { register: () => {}, getSnapshot: () => ({ active: 'en' }) },
    settingsScope: { bind: () => ({}) },
  };

  exports.apply(mockCordisCtx);
  assert.ok(registeredSlots.length > 0, 'apply() must register slots');
});

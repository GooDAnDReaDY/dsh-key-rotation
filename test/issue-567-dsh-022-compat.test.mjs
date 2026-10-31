// test/issue-567-dsh-022-compat.test.mjs — Regression test for #567 / GitHub #27
// Verifies compatibility with both DSH 0.2.1 and DSH 0.2.2 (strict Cordis sibling service isolation).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import semver from 'semver';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../lib/index.js';
import { STATUS_PATH } from '../lib/ops-paths.js';
const CONFIG_PATH = '/dsh-key-rotation/config';

function createStrictCordisProxy(injectedServices = ['llm'], providedServices = {}) {
  const base = {
    logger: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }),
    on: () => () => {},
    effect: (fn) => {
      const cleanup = fn?.();
      return typeof cleanup === 'function' ? cleanup : () => {};
    },
    get: (name) => providedServices[name],
    inject: (deps, callback) => {
      const allPresent = deps.every((d) => providedServices[d] !== undefined);
      if (allPresent) {
        const childCtx = createStrictCordisProxy([...injectedServices, ...deps], providedServices);
        callback(childCtx);
      }
    },
  };
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === 'symbol') return undefined;
      if (injectedServices.includes(prop)) {
        return providedServices[prop];
      }
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
  });
}

test('Issue #567 / GitHub #27: activates in real Cordis when webServer is provided by a sibling plugin', async () => {
  const root = new Context();
  const registeredRoutes = new Map();

  // Sibling plugin provides llm
  root.plugin({
    name: 'mock-llm-provider',
    apply(ctx) {
      ctx.provide('llm', {
        listProviders: () => [{ id: 'openai', name: 'OpenAI' }],
        listConfigurableProviders: () => [],
        stream: async function* () {},
      });
    },
  });

  // Sibling plugin provides webServer (not on root fiber!)
  root.plugin({
    name: 'mock-web-server-provider',
    apply(ctx) {
      ctx.provide('webServer', {
        register(route) {
          registeredRoutes.set(route.path, route.handler);
          return () => registeredRoutes.delete(route.path);
        },
      });
    },
  });

  const fiber = root.plugin(plugin, {
    persistenceEnabled: false,
    selfHealingIntervalMinutes: 0,
    providers: [{ provider: 'openai', keys: ['KEY_1', 'KEY_2'] }],
  });

  await fiber.await();
  await root.fiber.await();
  // Give child ctx.inject(['webServer']) fiber a microtask turn to settle
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(fiber.state, 2, 'Plugin fiber must reach ACTIVE (state === 2) without throwing');
  assert.ok(registeredRoutes.has(STATUS_PATH), 'Status route must be registered via dynamic inject');
  assert.ok(registeredRoutes.has(CONFIG_PATH), 'Config bridge route must be registered');
  assert.ok(registeredRoutes.has('/api/dsh-key-rotation/update'), 'Plugin updater route must be registered');

  await root.fiber.dispose();
});

test('Issue #567 / GitHub #27: strict Cordis 0.2.2 proxy never throws "cannot get property without inject"', () => {
  const registeredPaths = [];
  const strictWithWeb = createStrictCordisProxy(['llm'], {
    llm: { stream: () => {} },
    webServer: {
      register(route) {
        registeredPaths.push(route.path);
        return () => {};
      },
    },
  });

  assert.doesNotThrow(() => {
    plugin.apply(strictWithWeb, {
      persistenceEnabled: false,
      selfHealingIntervalMinutes: 0,
      providers: [{ provider: 'openai', keys: ['K1', 'K2'] }],
    });
  });
  assert.ok(registeredPaths.includes(STATUS_PATH), 'Routes must register under strict proxy');

  // Headless mode (no webServer, no credentials) under strict proxy must also not throw
  const strictHeadless = createStrictCordisProxy(['llm'], {
    llm: { stream: () => {} },
  });
  assert.doesNotThrow(() => {
    plugin.apply(strictHeadless, {
      persistenceEnabled: false,
      selfHealingIntervalMinutes: 0,
      providers: [{ provider: 'openai', keys: ['K1'] }],
    });
  });
});

test('Issue #567: peerDependencies compatible with both DSH 0.2.1 and DSH 0.2.2', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const llmRange = pkg.peerDependencies['@deepseek-ai/dsh-llm'];
  const cordisRange = pkg.peerDependencies['@deepseek-ai/cordis'];
  const schemaRange = pkg.peerDependencies['@deepseek-ai/schemastery'];

  for (const v of ['0.1.7-rc.2', '0.2.0-rc.1', '0.2.0', '0.2.1-alpha.2', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.1', '0.2.2-alpha.1', '0.2.2-alpha.2', '0.2.2-rc.1', '0.2.2']) {
    assert.ok(semver.satisfies(v, llmRange, { includePrerelease: true }), `dsh-llm range must admit ${v} (includePrerelease)`);
    assert.ok(semver.satisfies(v, llmRange), `dsh-llm range must admit ${v} (standard npm/pnpm)`);
  }

  for (const v of ['4.0.4', '4.0.5', '4.0.6-alpha.1', '4.0.6']) {
    assert.ok(semver.satisfies(v, cordisRange, { includePrerelease: true }), `cordis range must admit ${v}`);
    assert.ok(semver.satisfies(v, cordisRange), `cordis range must admit ${v} (standard npm/pnpm)`);
  }

  for (const v of ['3.18.4', '3.18.5', '3.18.6-alpha.1', '3.18.6']) {
    assert.ok(semver.satisfies(v, schemaRange, { includePrerelease: true }), `schemastery range must admit ${v}`);
    assert.ok(semver.satisfies(v, schemaRange), `schemastery range must admit ${v} (standard npm/pnpm)`);
  }
});

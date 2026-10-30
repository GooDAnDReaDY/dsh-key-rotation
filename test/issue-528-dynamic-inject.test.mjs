import test from 'node:test';
import assert from 'node:assert/strict';
import { inject, apply } from '../lib/index.js';

test('issue #528 - minimal required inject is llm', () => {
  assert.deepEqual(inject, ['llm']);
});

test('issue #528 - apply operates gracefully in headless mode without webServer or credentials', () => {
  const registeredListeners = new Map();
  const injectedCallbacks = new Map();

  const fakeCtx = {
    on(event, handler) {
      registeredListeners.set(event, handler);
      return () => registeredListeners.delete(event);
    },
    effect(fn) {
      return fn?.();
    },
    get(name) {
      return null;
    },
    inject(deps, callback) {
      const key = deps.sort().join(',');
      injectedCallbacks.set(key, callback);
    },
  };

  // apply must not throw even if webServer, credentials, and settings are absent
  assert.doesNotThrow(() => {
    apply(fakeCtx, {
      providers: [{ provider: 'openai', keys: ['K1'] }],
    });
  });

  // llm/stream listener is registered
  assert.ok(registeredListeners.has('llm/stream'));

  // webServer is wired through dynamic inject when not present on ctx
  assert.ok(injectedCallbacks.has('webServer'));

  // Simulate late mounting of webServer
  const registeredRoutes = [];
  const fakeWebCtx = {
    webServer: {
      register(r) {
        registeredRoutes.push(r);
        return () => {};
      },
    },
    effect(fn) { return fn?.(); },
    on() {},
    get() { return null; },
  };

  const webCallback = injectedCallbacks.get('webServer');
  webCallback(fakeWebCtx);
  assert.ok(registeredRoutes.length > 0, 'Routes should be registered on dynamic webServer mount');
});

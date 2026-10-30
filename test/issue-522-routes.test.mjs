import test from 'node:test';
import assert from 'node:assert/strict';
import * as routesIndex from '../lib/routes/index.js';
import * as legacyOpsRoutes from '../lib/routes-ops.js';
import * as opsPaths from '../lib/ops-paths.js';
import * as routesPaths from '../lib/routes/paths.js';

test('issue #522 - routes directory structure and exports', () => {
  // 1. Verify index exports registerOpsRoutes and legacy facade matches
  assert.equal(typeof routesIndex.registerOpsRoutes, 'function');
  assert.equal(typeof legacyOpsRoutes.registerOpsRoutes, 'function');

  // 2. Verify submodules export route registrars
  assert.equal(typeof routesIndex.registerKeyRoutes, 'function');
  assert.equal(typeof routesIndex.registerStatusRoutes, 'function');
  assert.equal(typeof routesIndex.registerBalanceRoutes, 'function');
  assert.equal(typeof routesIndex.registerMetricsRoutes, 'function');
  assert.equal(typeof routesIndex.registerTelemetryRoutes, 'function');
  assert.equal(typeof routesIndex.registerTestRoutes, 'function');
  assert.equal(typeof routesIndex.registerWebhookActionRoute, 'function');
  assert.equal(typeof routesIndex.registerConfigIoRoutes, 'function');
  assert.equal(typeof routesIndex.registerQuickActionRoutes, 'function');

  // 3. Verify paths facade matches
  assert.equal(opsPaths.KEY_PATH, routesPaths.KEY_PATH);
  assert.equal(opsPaths.STATUS_PATH, routesPaths.STATUS_PATH);
  assert.equal(opsPaths.METRICS_PATH, routesPaths.METRICS_PATH);
  assert.equal(opsPaths.BALANCE_PATH, routesPaths.BALANCE_PATH);
  assert.equal(opsPaths.TEST_PATH, routesPaths.TEST_PATH);
  assert.equal(opsPaths.QUICK_ACTION_PATH, routesPaths.QUICK_ACTION_PATH);
});

test('issue #522 - registerOpsRoutes registers all endpoints on webServer', () => {
  const registered = [];
  const fakeWebServer = {
    register(route) {
      registered.push(route);
      return () => {};
    },
  };
  const fakeCtx = {
    webServer: fakeWebServer,
    effect(fn) { return fn?.(); },
    on() {},
    get() { return null; },
  };

  routesIndex.registerOpsRoutes(fakeCtx, {
    pools: new Map(),
    getCloneIds: () => [],
    diagBuffer: { toArray: () => [] },
  });

  assert.ok(registered.length >= 8, `Expected at least 8 registered routes, got ${registered.length}`);

  const paths = registered.map((r) => r.path);
  assert.ok(paths.includes(routesPaths.KEY_PATH));
  assert.ok(paths.includes(routesPaths.STATUS_PATH));
  assert.ok(paths.includes(routesPaths.METRICS_PATH));
  assert.ok(paths.includes(routesPaths.BALANCE_PATH));
  assert.ok(paths.includes(routesPaths.TEST_PATH));
  assert.ok(paths.includes(routesPaths.WEBHOOK_ACTION_PATH));
  assert.ok(paths.includes(routesPaths.QUICK_ACTION_PATH));
});

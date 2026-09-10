// test/settings-card-081.test.mjs — #273 settings card must stay mounted
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');

test('client has ErrorBoundary around settings section (#273)', () => {
  assert.match(client, /class KeyRotationErrorBoundary/);
  assert.match(client, /KeyRotationErrorBoundary/);
  assert.match(client, /krot-card-body/);
  // card body must wrap section with boundary
  assert.match(client, /KeyRotationErrorBoundary,\s*null,\s*h\(KeyRotationSection/);
});

test('settingsScope getSnapshot is cached for useSyncExternalStore (#273)', () => {
  assert.match(client, /getScopeSnapshot/);
  assert.match(client, /scopeCacheRef/);
  assert.match(client, /useSyncExternalStore/);
});

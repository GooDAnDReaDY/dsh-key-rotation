// test/client-updater-section-scope.test.mjs — regression for #2
// "Settings UI fails to render: UpdaterSection is not defined (v0.8.13)".
// h(UpdaterSection, { t }) is evaluated inside KeyRotationSection, which lives
// at factory scope. In v0.8.13 UpdaterSection was declared inside apply(ctx),
// so the reference threw ReferenceError and the whole settings card failed to
// render. These static assertions pin the corrected structure, in the same
// spirit as settings-card-081.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');

test('UpdaterSection is declared before KeyRotationSection and outside apply(ctx) (#2)', () => {
  const updater = client.indexOf('function UpdaterSection');
  const keyRotation = client.indexOf('function KeyRotationSection');
  const apply = client.indexOf('function apply(ctx)');
  assert.ok(updater >= 0, 'UpdaterSection declaration exists');
  assert.ok(keyRotation > updater, 'UpdaterSection is declared before KeyRotationSection');
  assert.ok(apply > updater, 'UpdaterSection is declared outside apply(ctx)');
  assert.equal(client.match(/function UpdaterSection/g).length, 1, 'exactly one declaration');
});

test('exactly one call site renders UpdaterSection (#2)', () => {
  assert.equal(client.match(/h\(UpdaterSection/g).length, 1);
});

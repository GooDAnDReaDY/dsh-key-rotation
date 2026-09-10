// test/settings-solo-275.test.mjs — #275 card-only settings, no sidebar section
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'lib/http-bridge.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'lib/index.js'), 'utf8');
const rotate = fs.readFileSync(path.join(root, 'lib/rotate.js'), 'utf8');

test('no settings.section registration (#275)', () => {
  assert.doesNotMatch(client, /name:\s*'settings\.section'/);
  assert.match(client, /settings\.plugin\.item/);
});

test('no bare ctx.llm property access (#275)', () => {
  assert.doesNotMatch(bridge, /ctx\.llm\./);
  assert.doesNotMatch(rotate, /ctx\.llm\./);
});

test('settings service via get (#275)', () => {
  assert.match(index, /sctx\.get\('settings'\)/);
});

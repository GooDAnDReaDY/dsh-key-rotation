import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const SECRET = 'sk-leak-canary-DO-NOT-PUBLISH-7z9Xq2vR4mK8pL3wY6jT1bN5hC0sA';

test('server source: no full secret value placeholder is hardcoded', () => {
  const idx = readFileSync(join(root, 'lib/index.js'), 'utf8');
  assert.ok(!idx.includes(SECRET), 'lib/index.js contains the canary secret');
});

test('status route: only the trailing KEY_TAIL_CHARS characters of a key may travel to the browser', () => {
  const idx = readFileSync(join(root, 'lib/index.js'), 'utf8');
  const start = idx.indexOf('const STATUS_PATH');
  assert.ok(start >= 0, 'STATUS_PATH constant not found');
  const handler = idx.indexOf('handler: async (req, res) => {', start);
  assert.ok(handler >= 0, 'status handler not found');
  const end = idx.indexOf("'dsh-key-rotation: status route'", handler);
  const slice = idx.slice(handler, end > 0 ? end : undefined);
  assert.ok(slice.includes('keyTail(hit.value)'),
    'status handler does not truncate key value via keyTail()');
  assert.ok(!slice.includes('value: hit.value'),
    'status handler leaks the full key value into the JSON payload');
});

test('key route: PUT/DELETE response never includes the stored value', () => {
  const idx = readFileSync(join(root, 'lib/index.js'), 'utf8');
  const start = idx.indexOf('const KEY_PATH');
  const handler = idx.indexOf('handler: async (req, res) => {', start);
  const end = idx.indexOf("'dsh-key-rotation: key route'", handler);
  const slice = idx.slice(handler, end > 0 ? end : undefined);
  assert.ok(slice.includes('tail: keyTail(value)'),
    'PUT success branch does not expose only the key tail');
  assert.ok(!/value:\s*value/.test(slice),
    'PUT success branch echoes the raw key value');
});

test('README / docs: no real API key strings published', () => {
  const shipped = [
    'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE',
    'lib/index.js', 'lib/client.js', 'lib/pool.js',
  ];
  const keyPattern = /(sk-[A-Za-z0-9]{16,})|(sk_live_[A-Za-z0-9]{16,})|(AKIA[0-9A-Z]{12,})/g;
  for (const f of shipped) {
    const body = readFileSync(join(root, f), 'utf8');
    const matches = body.match(keyPattern) || [];
    assert.deepEqual(matches, [], 'shipped file ' + f + ' contains a key-shaped string');
  }
});

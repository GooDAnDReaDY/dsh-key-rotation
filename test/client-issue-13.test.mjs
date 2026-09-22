import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPoolItem } from '../lib/pool-builder.js';
import fs from 'node:fs';

test('Issue #13: buildPoolItem filters out empty, whitespace-only and invalid env ref names', () => {
  const pool = buildPoolItem({
    base: 'test-prov',
    keys: ['', '   ', 'bad-hyphen-name', '123_starts_with_number', 'VALID_KEY_1', 'KEY_TWO'],
    makeState: () => ({}),
  });

  assert.ok(pool, 'Pool item should be created');
  assert.deepEqual(pool.refs, ['VALID_KEY_1', 'KEY_TWO'], 'Invalid and empty refs must be filtered out');
});

test('Issue #13: client validateBeforeSave extracts server error message', () => {
  const clientSrc = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  // Check that validateBeforeSave normalizes data.error.message
  assert.match(clientSrc, /resData\s*=\s*!r\.ok\s*&&\s*data\.error/);
  // Check that saveSecret reads vres.message ?? vres.error?.message
  assert.match(clientSrc, /const msg = vres\.message \?\? vres\.error\?\.message \?\? 'validation failed'/);
});

// test/state-init.test.mjs — regression tests for issue #187
// Stale state from older plugin version must not crash rotate().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

let mod = null;
try { mod = await import('../lib/index.js'); } catch { mod = null; }

test('Issue #187: notifyExhaustion is exported', (t) => {
  if (!mod) { t.skip('skipped locally (no schemastery peer)'); return; }
  assert.equal(typeof mod.notifyExhaustion, 'function');
});

test('Issue #187: lazy-init guards in switchable branch exist (regression guard)', () => {
  assert.match(SRC, /if \(!pool\.state\.authFailCounts\) pool\.state\.authFailCounts = new Map\(\)/);
  assert.match(SRC, /if \(!pool\.state\.brokenUntil\) pool\.state\.brokenUntil = new Map\(\)/);
  assert.match(SRC, /if \(!pool\.state\.costPerKey\) pool\.state\.costPerKey = new Map\(\)/);
});

test('Issue #187: makeState init includes all required Map fields (regression)', () => {
  // ponytail: makeState body is multiline. Use a loose regex.
  const m = SRC.match(/st = \{\s*([\s\S]+?)\};\s*poolState\.set\(base, st\)/);
  assert.ok(m, 'makeState body must be found');
  const fields = m[1];
  for (const f of [
    'failedUntil', 'failCounts', 'authFailCounts', 'brokenUntil',
    'costPerKey', 'lastUsedAt', 'usageCounts', 'byModel', 'usageDays', 'quotaWindows',
  ]) {
    assert.ok(fields.includes(f), `field ${f} must be initialized in makeState`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const clientSrc = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');

test('client.js has no Cyrillic in string literals', () => {
  // strip comments
  const noComments = clientSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const cyr = noComments.match(/['"`][^'"`]*[Ѐ-ӿ][^'"`]*['"`]/g);
  assert.equal(cyr, null, `Cyrallic literals found: ${JSON.stringify(cyr)}`);
});

test('modal a11y attributes present', () => {
  assert.match(clientSrc, /role:\s*'dialog'/);
  assert.match(clientSrc, /'aria-modal':\s*'true'/);
  assert.match(clientSrc, /Escape/);
  assert.match(clientSrc, /focusables/);
});

test('card states present', () => {
  assert.match(clientSrc, /emptyTitle/);
  assert.match(clientSrc, /unavailableTitle/);
  assert.match(clientSrc, /errorTitle/);
  assert.match(clientSrc, /role:\s*'status'/);
});

test('bulk remove goes through confirm modal', () => {
  assert.match(clientSrc, /bulkRemove/);
  assert.match(clientSrc, /confirmBulkRemoveTitle/);
});

test('hardcoded UI English bulk strings routed through t()', () => {
  assert.ok(!clientSrc.includes("placeholder: 'Bulk cooldown ms'"));
  assert.ok(!clientSrc.includes("btn('Apply to selected'"));
});

test('en dict includes new keys', () => {
  for (const k of ['emptyTitle', 'bulkRemove', 'loadChartAria', 'retry', 'modalClose']) {
    assert.ok(clientSrc.includes(k + ':'), `missing locale key ${k}`);
  }
});

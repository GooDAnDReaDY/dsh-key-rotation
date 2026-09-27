import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientSrc = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf-8');

test('client.js includes parseBulkKeys helper and Sparkline component', () => {
  assert.match(clientSrc, /function parseBulkKeys\(text\)/);
  assert.match(clientSrc, /function Sparkline\(/);
});

test('client.js defines bulkImport and pauseKey localization tokens in en and zh', () => {
  assert.match(clientSrc, /bulkImport:\s*'Bulk Import'/);
  assert.match(clientSrc, /keyPaused:\s*'Paused'/);
  assert.match(clientSrc, /bulkImport:\s*'批量导入'/);
  assert.match(clientSrc, /keyPaused:\s*'已暂停'/);
});

test('client.js renders pause toggle button and bulk import trigger', () => {
  assert.match(clientSrc, /key:\s*'pause-btn'/);
  assert.match(clientSrc, /togglePauseKey\(pIndex,\s*kIndex\)/);
  assert.match(clientSrc, /applyBulkImport\(pIndex\)/);
  assert.match(clientSrc, /sparklineTraffic/);
});

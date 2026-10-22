// test/issue-514-i18n-zh-simulator.test.mjs — #514 full en/zh locale key parity
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const localesSrc = fs.readFileSync(path.join(root, 'lib/client-src/10-locales.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');

const SIMULATOR_KEYS = [
  'simulatorTitle',
  'simulatorDesc',
  'simulatorRun',
  'simulatorRunning',
  'simulatorSelectProvider',
  'simulatorSelectModel',
  'simulatorMaxAttempts',
  'simulatorEvent',
  'simulatorEventSuccess',
  'simulatorEventRateLimit',
  'simulatorEventServer500',
  'simulatorResults',
  'simulatorNoResults',
];

test('issue #514: all simulator keys exist in zh dictionary in 10-locales.js and client.js', () => {
  for (const key of SIMULATOR_KEYS) {
    const zhRegex = new RegExp(`const zh = [\\s\\S]*?${key}:`);
    assert.match(localesSrc, zhRegex, `Missing ${key} in zh dictionary in 10-locales.js`);
    assert.match(client, zhRegex, `Missing ${key} in zh dictionary in client.js`);
  }
});

test('issue #514: strict key parity between en and zh dictionaries in 10-locales.js', () => {
  const lines = localesSrc.split('\n');
  let inEn = false;
  let inZh = false;
  const enKeys = new Set();
  const zhKeys = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('const en = {')) {
      inEn = true;
      inZh = false;
      continue;
    } else if (trimmed.startsWith('const zh = {')) {
      inEn = false;
      inZh = true;
      continue;
    } else if (trimmed === '};') {
      inEn = false;
      inZh = false;
      continue;
    }

    const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*:/);
    if (match) {
      const key = match[1];
      if (inEn) enKeys.add(key);
      else if (inZh) zhKeys.add(key);
    }
  }

  assert.ok(enKeys.size >= 240, `Expected at least 240 en keys, got ${enKeys.size}`);
  assert.ok(zhKeys.size >= 240, `Expected at least 240 zh keys, got ${zhKeys.size}`);

  const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
  const extraInZh = [...zhKeys].filter((k) => !enKeys.has(k));

  assert.deepEqual(missingInZh, [], `Keys present in en but missing in zh: ${missingInZh.join(', ')}`);
  assert.deepEqual(extraInZh, [], `Keys present in zh but missing in en: ${extraInZh.join(', ')}`);
});

test('issue #514: 10-locales.js file size standard (<600 lines)', () => {
  const lineCount = localesSrc.split('\n').length;
  assert.ok(lineCount < 600, `lib/client-src/10-locales.js has ${lineCount} lines, expected < 600`);
});

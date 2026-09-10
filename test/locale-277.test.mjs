// test/locale-277.test.mjs — #277 en-only source locale, navigator.languages fallback
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');

test('registers English dictionary only (#277)', () => {
  assert.match(client, /ctx\.locale\.register\(NS,\s*\{\s*en\s*\}\)/);
  assert.doesNotMatch(client, /const ru = \{/);
  assert.doesNotMatch(client, /const zh = \{/);
  assert.doesNotMatch(client, /locale === 'ru'/);
});

test('active locale falls back via navigator.languages then en (#277)', () => {
  assert.match(client, /navigator\.languages/);
  assert.match(client, /return 'en';/);
  assert.doesNotMatch(client, /navigator\.language\s*\|\|\s*''\)\)\.slice/);
});

test('uses props.t via resolveT, no private ru/zh fork (#277)', () => {
  assert.match(client, /function resolveT\(props\)/);
  assert.match(client, /typeof props\.t === 'function'/);
});

test('no hardcoded Russian UI strings in client.js (#277)', () => {
  assert.doesNotMatch(client, /Пулы ротации/);
  assert.doesNotMatch(client, /Сохранить ключ/);
  assert.doesNotMatch(client, /Задержка после сбоя/);
});

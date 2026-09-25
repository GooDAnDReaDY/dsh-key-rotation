import test from 'node:test';
import assert from 'node:assert/strict';
import { keyTail, KEY_TAIL_CHARS, KEY_TAIL_PLACEHOLDER } from '../lib/pool.js';

test('keyTail: short key returns placeholder *** (#355)', () => {
  assert.equal(keyTail('ab'), KEY_TAIL_PLACEHOLDER);
  assert.equal(keyTail(''), '');
});

test('keyTail: key shorter or equal to KEY_TAIL_CHARS returns placeholder ***', () => {
  for (let i = 1; i <= KEY_TAIL_CHARS; i++) {
    const s = 'x'.repeat(i);
    assert.equal(keyTail(s), KEY_TAIL_PLACEHOLDER);
  }
});

test('keyTail: boundary test for lengths 0 through 8 (#355 acceptance)', () => {
  // Length 0: empty string
  assert.equal(keyTail(''), '');
  // Length 1..5: masked placeholder
  assert.equal(keyTail('1'), '***');
  assert.equal(keyTail('12'), '***');
  assert.equal(keyTail('123'), '***');
  assert.equal(keyTail('1234'), '***');
  assert.equal(keyTail('12345'), '***');
  // Length 6..8: last 5 chars
  assert.equal(keyTail('123456'), '23456');
  assert.equal(keyTail('1234567'), '34567');
  assert.equal(keyTail('12345678'), '45678');
});

test('keyTail: long key returns the trailing KEY_TAIL_CHARS characters only', () => {
  // 20 chars + 'XYZW' = 24 chars total; last KEY_TAIL_CHARS=5 must be 'aXYZW'.
  const key = 'a'.repeat(20) + 'XYZW';
  const out = keyTail(key);
  assert.equal(out.length, KEY_TAIL_CHARS);
  assert.equal(out, 'aXYZW');
  // The earlier part of the key must NOT appear in the tail.
  assert.ok(!out.startsWith('aaaaa'));
});

test('keyTail: exactly KEY_TAIL_CHARS+1 chars returns only the last KEY_TAIL_CHARS', () => {
  const key = 'abcdef';  // 6 chars, KEY_TAIL_CHARS=5
  assert.equal(keyTail(key), 'bcdef');
});

test('keyTail: non-string input returns empty string', () => {
  assert.equal(keyTail(undefined), '');
  assert.equal(keyTail(null), '');
  assert.equal(keyTail(42), '');
  assert.equal(keyTail({}), '');
});

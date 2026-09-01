import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExpiry } from '../lib/pool.js';

test('parseExpiry: timestamp number', () => {
  assert.equal(parseExpiry(1700000000000), 1700000000000);
});
test('parseExpiry: ISO string', () => {
  const ts = Date.parse('2026-01-01');
  assert.equal(parseExpiry('2026-01-01'), ts);
});
test('parseExpiry: invalid returns undefined', () => {
  assert.equal(parseExpiry(null), undefined);
  assert.equal(parseExpiry(undefined), undefined);
  assert.equal(parseExpiry(''), undefined);
  assert.equal(parseExpiry('not-a-date'), undefined);
});

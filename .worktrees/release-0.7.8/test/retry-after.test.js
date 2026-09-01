import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRetryAfter } from '../lib/pool.js';

test('parseRetryAfter: seconds', () => {
  assert.equal(parseRetryAfter('60'), 60000);
  assert.equal(parseRetryAfter('Retry-After: 120'), 120000);
  assert.equal(parseRetryAfter('retry-after: 0'), 0);
});

test('parseRetryAfter: seconds inside message', () => {
  assert.equal(parseRetryAfter('429 Too Many Requests, Retry-After: 60'), 60000);
});

test('parseRetryAfter: HTTP-date', () => {
  const future = new Date(Date.now() + 60000).toUTCString();
  const ms = parseRetryAfter(future);
  assert.ok(ms !== undefined && ms > 50000 && ms < 70000);
});

test('parseRetryAfter: invalid returns undefined', () => {
  assert.equal(parseRetryAfter(''), undefined);
  assert.equal(parseRetryAfter('not a date'), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
});

test('parseRetryAfter: respects Retry-After header with date', () => {
  const future = new Date(Date.now() + 120000).toUTCString();
  assert.equal(parseRetryAfter(`Retry-After: ${future}`) !== undefined, true);
});

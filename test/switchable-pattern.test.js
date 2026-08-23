import test from 'node:test';
import assert from 'node:assert/strict';
import { SWITCHABLE_MESSAGE_PATTERN, DEFAULT_SWITCH_CODES } from '../lib/pool.js';

// This suite pins the behaviour of SWITCHABLE_MESSAGE_PATTERN. Issue #14 was a
// case-sensitivity bug: each sub-regex carried /i but the outer
// `new RegExp(joined_source)` was built without flags, so the final regex was
// case-sensitive. Fixed by passing 'i' to the outer RegExp. The assertions here
// assert the corrected, case-insensitive behaviour.

test('SWITCHABLE_MESSAGE_PATTERN: matches lowercase quota phrases', () => {
  assert.match('quota exceeded', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('usage limit reached for account', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('rate limit reached', SWITCHABLE_MESSAGE_PATTERN);
});

test('SWITCHABLE_MESSAGE_PATTERN: matches Capitalised quota phrases', () => {
  assert.match('RateLimit reached, retry after 30s', SWITCHABLE_MESSAGE_PATTERN);
});

test('SWITCHABLE_MESSAGE_PATTERN: matches HTTP status codes (digits are case-invariant)', () => {
  assert.match('Upstream returned 429', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('Bad Gateway 502', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('Server 503', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('401 unauthorized', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('403 Forbidden', SWITCHABLE_MESSAGE_PATTERN);
});

test('SWITCHABLE_MESSAGE_PATTERN: matches ECONN-prefixed tokens', () => {
  assert.match('ECONNRESET', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('ECONNREFUSED', SWITCHABLE_MESSAGE_PATTERN);
});

test('SWITCHABLE_MESSAGE_PATTERN: matches lowercase network words', () => {
  assert.match('connection refused', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('socket hang up', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('fetch failed', SWITCHABLE_MESSAGE_PATTERN);
});

test('SWITCHABLE_MESSAGE_PATTERN: matches Capitalised network words (issue #14 fix)', () => {
  assert.match('Connection reset by peer', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('Socket hang up', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('Other side closed', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('Stream ended before any chunks', SWITCHABLE_MESSAGE_PATTERN);
});

test('SWITCHABLE_MESSAGE_PATTERN: matches lowercase timeout phrases', () => {
  assert.match('request timed out', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('timeout while reading', SWITCHABLE_MESSAGE_PATTERN);
});

test('SWITCHABLE_MESSAGE_PATTERN: matches Capitalised timeout phrases (issue #14 fix)', () => {
  assert.match('Request timed out', SWITCHABLE_MESSAGE_PATTERN);
});

test('SWITCHABLE_MESSAGE_PATTERN: matches lowercase billing/quota idioms', () => {
  assert.match('out of credits', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('insufficient balance', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('billing issue', SWITCHABLE_MESSAGE_PATTERN);
});

test('SWITCHABLE_MESSAGE_PATTERN: matches Capitalised auth phrases (issue #14 fix)', () => {
  assert.match('Invalid API key provided', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('API key expired', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('Out of credits', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('Insufficient balance', SWITCHABLE_MESSAGE_PATTERN);
});

test('SWITCHABLE_MESSAGE_PATTERN: does NOT match unrelated messages', () => {
  assert.doesNotMatch('Hello, world', SWITCHABLE_MESSAGE_PATTERN);
  assert.doesNotMatch('completed successfully', SWITCHABLE_MESSAGE_PATTERN);
  assert.doesNotMatch('model not found: foo', SWITCHABLE_MESSAGE_PATTERN);
  assert.doesNotMatch('Upstream returned 400', SWITCHABLE_MESSAGE_PATTERN);
  assert.doesNotMatch('Not found 404', SWITCHABLE_MESSAGE_PATTERN);
});

test('DEFAULT_SWITCH_CODES: covers the seven documented failure codes plus AUTH', () => {
  assert.deepEqual([...DEFAULT_SWITCH_CODES].sort(), [
    'AUTH', 'EMPTY_RESPONSE', 'QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'UNKNOWN_MODEL',
  ]);
});

test('SWITCHABLE_MESSAGE_PATTERN: regression guard — regex is case-insensitive (issue #14)', () => {
  // The outer `new RegExp(joined, 'i')` must keep the case-insensitive flag.
  assert.equal(SWITCHABLE_MESSAGE_PATTERN.flags.includes('i'), true,
    'expected case-insensitive regex per issue #14 fix');
});

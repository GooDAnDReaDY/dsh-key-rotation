import test from 'node:test';
import assert from 'node:assert/strict';
import { SWITCHABLE_MESSAGE_PATTERN, DEFAULT_SWITCH_CODES } from '../lib/pool.js';

// NOTE: this suite documents the CURRENT behaviour of v0.5.x. Issue #14 tracks
// a known case-sensitivity bug in SWITCHABLE_MESSAGE_PATTERN: each sub-regex has
// the `/i` flag, but the outer `new RegExp(joined_source)` is built without
// flags, so the final regex is case-sensitive. The assertions below pin down
// the present behaviour; once #14 is fixed, the case-mismatch assertions here
// must be flipped.

test('SWITCHABLE_MESSAGE_PATTERN: matches lowercase quota phrases', () => {
  assert.match('quota exceeded', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('usage limit reached for account', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('rate limit reached', SWITCHABLE_MESSAGE_PATTERN);
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

test('SWITCHABLE_MESSAGE_PATTERN: matches lowercase timeout phrases', () => {
  assert.match('request timed out', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('timeout while reading', SWITCHABLE_MESSAGE_PATTERN);
});

test('SWITCHABLE_MESSAGE_PATTERN: matches lowercase billing/quota idioms', () => {
  assert.match('out of credits', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('insufficient balance', SWITCHABLE_MESSAGE_PATTERN);
  assert.match('billing issue', SWITCHABLE_MESSAGE_PATTERN);
});

test('SWITCHABLE_MESSAGE_PATTERN: KNOWN BUG (issue #14) does NOT match Capitalised messages', () => {
  // The sub-regexes carry /i, but the outer `new RegExp(joined_source)` drops
  // the flags. Until #14 is fixed, capitalised versions of these phrases do
  // NOT trigger rotation in production. These tests guard the bug.
  assert.doesNotMatch('Connection reset by peer', SWITCHABLE_MESSAGE_PATTERN);
  assert.doesNotMatch('Other side closed', SWITCHABLE_MESSAGE_PATTERN);
  assert.doesNotMatch('Stream ended before any chunks', SWITCHABLE_MESSAGE_PATTERN);
  assert.doesNotMatch('Out of credits', SWITCHABLE_MESSAGE_PATTERN);
  assert.doesNotMatch('Insufficient balance', SWITCHABLE_MESSAGE_PATTERN);
  assert.doesNotMatch('Invalid API key provided', SWITCHABLE_MESSAGE_PATTERN);
  assert.doesNotMatch('API key expired', SWITCHABLE_MESSAGE_PATTERN);
});

test('SWITCHABLE_MESSAGE_PATTERN: does NOT match unrelated messages', () => {
  assert.doesNotMatch('Hello, world', SWITCHABLE_MESSAGE_PATTERN);
  assert.doesNotMatch('completed successfully', SWITCHABLE_MESSAGE_PATTERN);
  assert.doesNotMatch('model not found: foo', SWITCHABLE_MESSAGE_PATTERN);
  // '400' alone is not in the pattern; only 401/403/429/5xx trigger rotation.
  assert.doesNotMatch('Upstream returned 400', SWITCHABLE_MESSAGE_PATTERN);
  // '404' is similarly out of scope.
  assert.doesNotMatch('Not found 404', SWITCHABLE_MESSAGE_PATTERN);
});

test('DEFAULT_SWITCH_CODES: covers the seven documented failure codes plus AUTH', () => {
  assert.deepEqual([...DEFAULT_SWITCH_CODES].sort(), [
    'AUTH', 'EMPTY_RESPONSE', 'QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'UNKNOWN_MODEL',
  ]);
});

test('SWITCHABLE_MESSAGE_PATTERN: regression guard for #14 fix path', () => {
  // After #14 is fixed (outer `new RegExp(joined, 'i')`), this test will pass
  // and the previous test (`KNOWN BUG (issue #14) does NOT match...`) must
  // be inverted. Until then, this test asserts the bug is still present by
  // checking the `.flags` property of the compiled regex.
  assert.equal(SWITCHABLE_MESSAGE_PATTERN.flags.includes('i'), false,
    'expected case-sensitive regex per issue #14; flip this assertion when the fix lands');
});

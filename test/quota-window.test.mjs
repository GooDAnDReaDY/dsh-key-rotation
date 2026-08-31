// test/quota-window.test.mjs — issue #197 calendar quota reset
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextQuotaReset, isBlockedUntilReset } from '../lib/quota-window.js';

test('nextQuotaReset: midnight_utc — next UTC midnight', () => {
  // Set to 2026-08-31 10:00:00 UTC
  const now = Date.UTC(2026, 7, 31, 10, 0, 0);
  const next = nextQuotaReset({ type: 'midnight_utc' }, now);
  const expected = Date.UTC(2026, 8, 1, 0, 0, 0);  // Sep 1 00:00 UTC
  assert.equal(next, expected);
});

test('nextQuotaReset: midnight_utc — same day if before reset hour', () => {
  const now = Date.UTC(2026, 7, 31, 5, 0, 0);
  const next = nextQuotaReset({ type: 'midnight_utc', hour: 8 }, now);
  assert.equal(next, Date.UTC(2026, 7, 31, 8, 0, 0));
});

test('nextQuotaReset: midnight_pst — approx UTC-8', () => {
  const now = Date.UTC(2026, 7, 31, 20, 0, 0);  // 12:00 PST
  const next = nextQuotaReset({ type: 'midnight_pst' }, now);
  assert.ok(next > now, 'next reset should be in future');
});

test('nextQuotaReset: rolling_24h — next hour boundary', () => {
  const now = Date.UTC(2026, 7, 31, 10, 30, 0);
  const next = nextQuotaReset({ type: 'rolling_24h' }, now);
  assert.ok(next > now);
  // Next reset should be within 25 hours
  assert.ok(next - now <= 25 * 3600_000);
});

test('nextQuotaReset: unknown type returns null', () => {
  assert.equal(nextQuotaReset({ type: 'bogus' }), null);
  assert.equal(nextQuotaReset(null), null);
});

test('isBlockedUntilReset: true when failedUntil >= resetAt', () => {
  assert.equal(isBlockedUntilReset(2000, 1000), true);
});

test('isBlockedUntilReset: false when failedUntil < resetAt', () => {
  assert.equal(isBlockedUntilReset(500, 1000), false);
});

test('isBlockedUntilReset: false for invalid failedUntil', () => {
  assert.equal(isBlockedUntilReset(NaN, 1000), false);
  assert.equal(isBlockedUntilReset(undefined, 1000), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketAllow, bucketHit, bucketRetryMs, bucketSweep, bucketInfo } from '../lib/bucket.js';

test('bucket: disabled when limit <= 0', () => {
  const w = new Map();
  for (let i = 0; i < 100; i++) assert.equal(bucketAllow(w, 'K', 0, 1000), true);
});

test('bucket: allows up to limit, then blocks within window', () => {
  const w = new Map();
  for (let i = 0; i < 3; i++) assert.equal(bucketAllow(w, 'K', 3, 1000 + i), true, `hit ${i}`);
  assert.equal(bucketAllow(w, 'K', 3, 1500), false);
});

test('bucket: window slides - old hits expire', () => {
  const w = new Map();
  for (let i = 0; i < 3; i++) bucketAllow(w, 'K', 3, 1000 + i);
  assert.equal(bucketAllow(w, 'K', 3, 1000 + 59999), false);
  assert.equal(bucketAllow(w, 'K', 3, 1000 + 60001), true);
});

test('bucket: per-ref isolation', () => {
  const w = new Map();
  bucketAllow(w, 'A', 1, 1000);
  assert.equal(bucketAllow(w, 'A', 1, 1001), false);
  assert.equal(bucketAllow(w, 'B', 1, 1001), true);
});

test('bucketHit records without checking', () => {
  const w = new Map();
  bucketHit(w, 'K', 1000);
  assert.equal(bucketAllow(w, 'K', 1, 1001), false);
});

test('bucketRetryMs reports wait time', () => {
  const w = new Map();
  bucketAllow(w, 'K', 1, 1000);
  assert.equal(bucketRetryMs(w, 'K', 1, 1500), 59500);
  assert.equal(bucketRetryMs(w, 'K', 1, 61000), 0);
});

test('bucketSweep drops dead refs', () => {
  const w = new Map();
  bucketHit(w, 'A', 1000);
  bucketHit(w, 'B', 1000);
  bucketSweep(w, new Set(['A']));
  assert.ok(w.has('A'));
  assert.ok(!w.has('B'));
});

test('bucketInfo: safe when windows never initialized (#210)', () => {
  assert.deepEqual(bucketInfo(undefined, 'K', 5, 1000), { used: 0, remaining: 5, resetMs: 0 });
  assert.equal(bucketInfo(undefined, 'K', 0, 1000), null);
});

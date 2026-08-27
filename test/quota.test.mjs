
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaStore } from '../lib/quota.js';

test('QuotaStore: set/get/snapshot', () => {
  const q = new QuotaStore();
  q.set('A', { remaining: 100, limit: 1000, reset: 1737370000, at: Date.now() });
  q.set('B', { remaining: 50, limit: 500 });
  const a = q.get('A');
  assert.equal(a.remaining, 100);
  assert.equal(a.limit, 1000);
  assert.ok(a.at > 0);
  const snap = q.snapshot();
  assert.equal(Object.keys(snap).length, 2);
  assert.equal(snap.B.remaining, 50);
});

test('QuotaStore: ignores invalid', () => {
  const q = new QuotaStore();
  q.set('', {});
  q.set('A', null);
  q.set('A', 'garbage');
  q.set('A', 42);
  assert.equal(q.size, 0);
});

test('QuotaStore: null fields preserved', () => {
  const q = new QuotaStore();
  q.set('A', { remaining: 5 });
  assert.equal(q.get('A').remaining, 5);
  assert.equal(q.get('A').limit, null);
  assert.equal(q.get('A').reset, null);
});

test('QuotaStore: clear by ref or all', () => {
  const q = new QuotaStore();
  q.set('A', { remaining: 10, limit: 100 });
  q.set('B', { remaining: 20, limit: 200 });
  q.clear('A');
  assert.equal(q.get('A'), undefined);
  assert.equal(q.get('B').remaining, 20);
  q.clear();
  assert.equal(q.size, 0);
});

test('QuotaStore: snapshot of empty store returns empty object', () => {
  const q = new QuotaStore();
  assert.deepEqual(q.snapshot(), {});
  assert.equal(q.size, 0);
});

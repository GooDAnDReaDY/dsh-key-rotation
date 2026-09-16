import test from 'node:test';
import assert from 'node:assert/strict';
import { bestEffort } from '../lib/best-effort.js';

test('bestEffort: returns value and does not throw', () => {
  assert.equal(bestEffort('ok', () => 42), 42);
});

test('bestEffort: swallows sync error and returns undefined', () => {
  assert.equal(bestEffort('sync', () => { throw new Error('x'); }), undefined);
});

test('bestEffort: swallows async rejection', async () => {
  const v = await bestEffort('async', async () => { throw new Error('y'); });
  assert.equal(v, undefined);
});

test('bestEffort: passes async value through', async () => {
  const v = await bestEffort('async-ok', async () => 'z');
  assert.equal(v, 'z');
});

test('bestEffort: logger failure is ignored', () => {
  const logger = { debug() { throw new Error('logger down'); } };
  assert.equal(bestEffort('log-fail', () => { throw new Error('e'); }, logger), undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickNext, applyCooldown, isValidRef } from '../lib/pool.js';

const freshPool = (refs, pointer = 0) => ({
  refs,
  state: { failedUntil: new Map(), pointer },
});

test('pickNext: empty pool returns undefined', () => {
  assert.equal(pickNext(freshPool([]), 0), undefined);
});

test('pickNext: all-healthy pool returns the ref at pointer', () => {
  const p = freshPool(['A', 'B', 'C'], 0);
  assert.equal(pickNext(p, 0), 'A');
});

test('pickNext: skips refs currently in cooldown', () => {
  const p = freshPool(['A', 'B', 'C'], 0);
  p.state.failedUntil.set('A', 1000);
  assert.equal(pickNext(p, 500), 'B');
});

test('pickNext: cooldown already expired is skipped as not-failed', () => {
  const p = freshPool(['A', 'B', 'C'], 0);
  p.state.failedUntil.set('A', 1000);
  assert.equal(pickNext(p, 2000), 'A');
});

test('pickNext: all keys cooling -> returns undefined', () => {
  const p = freshPool(['A', 'B', 'C'], 0);
  p.state.failedUntil.set('A', 5000);
  p.state.failedUntil.set('B', 5000);
  p.state.failedUntil.set('C', 5000);
  assert.equal(pickNext(p, 1000), undefined);
});

test('pickNext: wraps around at end of pool', () => {
  const p = freshPool(['A', 'B', 'C'], 2);
  assert.equal(pickNext(p, 0), 'C');
});

test('applyCooldown: records the failed ref with now + cooldownMs', () => {
  const p = freshPool(['A', 'B']);
  const next = applyCooldown(p, 'A', 60000, 1000);
  assert.equal(next.state.failedUntil.get('A'), 61000);
  assert.equal(p.state.failedUntil.get('A'), undefined, 'input not mutated');
});

test('applyCooldown: preserves existing cooldown entries', () => {
  const p = freshPool(['A', 'B']);
  p.state.failedUntil.set('B', 999);
  const next = applyCooldown(p, 'A', 60000, 1000);
  assert.equal(next.state.failedUntil.get('A'), 61000);
  assert.equal(next.state.failedUntil.get('B'), 999);
});

test('isValidRef: accepts env-name-shaped strings', () => {
  assert.equal(isValidRef('A'), true);
  assert.equal(isValidRef('OPENCODE_GO_API_KEY'), true);
  assert.equal(isValidRef('FOO_2'), true);
  assert.equal(isValidRef('_X1'), true);
});

test('isValidRef: rejects empty, leading-digit, punctuation, paths', () => {
  assert.equal(isValidRef(''), false);
  assert.equal(isValidRef('1FOO'), false);
  assert.equal(isValidRef('FOO BAR'), false);
  assert.equal(isValidRef('FOO-BAR'), false);
  assert.equal(isValidRef('FOO/BAR'), false);
  assert.equal(isValidRef(undefined), false);
  assert.equal(isValidRef(null), false);
  assert.equal(isValidRef(42), false);
});

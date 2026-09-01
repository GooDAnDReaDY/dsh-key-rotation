import test from 'node:test';
import assert from 'node:assert/strict';
import { expiringSoon, shouldNotifyDaily, costForDay, budgetVerdict } from '../lib/maintenance.js';

const DAY = 86400000;
const NOW = 1000000;

test('expiringSoon: only keys inside the warn horizon', () => {
  const pool = { expiresAt: {
    A: NOW + 3 * DAY,   // inside 7d
    B: NOW + 30 * DAY,  // outside
    C: NOW - 1,         // already expired -> ignored
  } };
  const list = expiringSoon(pool, 7, NOW);
  assert.equal(list.length, 1);
  assert.equal(list[0].ref, 'A');
  assert.equal(list[0].expiresInDays, 3);
});

test('expiringSoon: sorted by soonest; warnDays=0 clamps horizon to 1 day', () => {
  const pool = { expiresAt: { B: NOW + 0.5 * DAY, A: NOW + 2 * DAY } };
  assert.deepEqual(expiringSoon(pool, 7, NOW).map((x) => x.ref), ['B', 'A']);
  // warnDays=0 -> horizon is 1 day: only B qualifies
  assert.deepEqual(expiringSoon(pool, 0, NOW).map((x) => x.ref), ['B']);
});

test('shouldNotifyDaily dedupes within a day', () => {
  const m = new Map();
  assert.equal(shouldNotifyDaily(m, 'K', NOW), true);
  assert.equal(shouldNotifyDaily(m, 'K', NOW + 3600000), false);
  assert.equal(shouldNotifyDaily(m, 'K', NOW + DAY + 1), true);
});

test('costForDay sums today across refs', () => {
  const cd = new Map([
    ['A', new Map([['2026-09-01', 1.5]])],
    ['B', new Map([['2026-09-01', 0.5], ['2026-09-02', 9]])],
  ]);
  assert.equal(costForDay(cd, '2026-09-01'), 2);
  assert.equal(costForDay(cd, '2026-09-02'), 9);
  assert.equal(costForDay(cd, '2026-09-03'), 0);
});

test('budgetVerdict thresholds', () => {
  assert.equal(budgetVerdict(1.5, 2).warn, false);     // 75% -> no
  assert.equal(budgetVerdict(1.7, 2).warn, true);      // 85% -> warn
  assert.equal(budgetVerdict(2.1, 2).exceeded, true);  // >100%
  assert.equal(budgetVerdict(10, 0).warn, false);      // off
  const v = budgetVerdict(1, 2);
  assert.equal(v.ratio, 0.5);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { compactUsage } from '../lib/usage-report.js';

test('compactUsage: purges dates older than 30 days and keeps recent ones', () => {
  const now = Date.parse('2026-09-02T12:00:00Z');
  const pool = {
    refs: ['k1'],
    state: {
      usageDays: new Map([
        ['k1', new Map([
          ['2026-09-02', 10], // today -> keep
          ['2026-08-20', 25], // 13 days ago -> keep
          ['2026-08-05', 40], // 28 days ago -> keep
          ['2026-07-20', 50], // 44 days ago -> purge
          ['2026-06-01', 99], // 93 days ago -> purge
        ])],
      ]),
      costDays: new Map([
        ['k1', new Map([
          ['2026-09-02', 0.5],
          ['2026-06-01', 4.2],
        ])],
      ]),
    },
  };

  const purged = compactUsage(pool, 30, now);
  assert.equal(purged, 2);

  const k1Days = pool.state.usageDays.get('k1');
  assert.equal(k1Days.has('2026-09-02'), true);
  assert.equal(k1Days.has('2026-08-20'), true);
  assert.equal(k1Days.has('2026-08-05'), true);
  assert.equal(k1Days.has('2026-07-20'), false);
  assert.equal(k1Days.has('2026-06-01'), false);

  const k1Costs = pool.state.costDays.get('k1');
  assert.equal(k1Costs.has('2026-09-02'), true);
  assert.equal(k1Costs.has('2026-06-01'), false);
});
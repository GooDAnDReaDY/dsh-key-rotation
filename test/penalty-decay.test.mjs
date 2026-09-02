import test from 'node:test';
import assert from 'node:assert/strict';
import { decayPenalties, recordSuccess } from '../lib/pool.js';

test('decayPenalties: decays failCounts after 1 hour of stable operation', () => {
  const pool = {
    refs: ['k1'],
    state: {
      failCounts: new Map([['k1', 3]]),
      lastSuccessAt: new Map([['k1', 1000]]),
    },
  };

  // 30 mins later: no decay yet
  const d1 = decayPenalties(pool, 1000 + 1800_000, 3600_000);
  assert.equal(d1, 0);
  assert.equal(pool.state.failCounts.get('k1'), 3);

  // 65 mins later: 1 level decayed (3 -> 2)
  const d2 = decayPenalties(pool, 1000 + 3900_000, 3600_000);
  assert.equal(d2, 1);
  assert.equal(pool.state.failCounts.get('k1'), 2);

  // Another 65 mins later: another level decayed (2 -> 1)
  const d3 = decayPenalties(pool, 1000 + 3900_000 + 3900_000, 3600_000);
  assert.equal(d3, 1);
  assert.equal(pool.state.failCounts.get('k1'), 1);

  // Another 65 mins later: decayed completely (1 -> 0, key deleted from map)
  const d4 = decayPenalties(pool, 1000 + 3900_000 * 3, 3600_000);
  assert.equal(d4, 1);
  assert.equal(pool.state.failCounts.has('k1'), false);
});

test('recordSuccess: records lastSuccessAt timestamp', () => {
  const pool = {
    refs: ['k1'],
    state: {
      failedUntil: new Map([['k1', 5000]]),
      failCounts: new Map([['k1', 2]]),
    },
  };
  recordSuccess(pool, 'k1', 12345);
  assert.equal(pool.state.failedUntil.has('k1'), false);
  assert.equal(pool.state.failCounts.has('k1'), false);
  assert.equal(pool.state.lastSuccessAt.get('k1'), 12345);
});
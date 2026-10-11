import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateRouting } from '../lib/simulator.js';

test('Issue #462: Offline Routing Simulator', async (t) => {
  await t.test('simulates healthy pool picking first candidate', () => {
    const pool = {
      base: 'mock-provider',
      refs: ['key-1', 'key-2', 'key-3'],
      state: { failedUntil: new Map(), failCounts: new Map() },
    };
    const res = simulateRouting({ pool });
    assert.equal(res.outcome, 'SUCCESS');
    assert.equal(res.selectedRef, 'key-1');
    assert.equal(res.attempts, 1);
    assert.ok(res.trace.steps.length >= 2);
  });

  await t.test('simulates failover when first key fails', () => {
    const pool = {
      base: 'mock-provider',
      refs: ['key-1', 'key-2', 'key-3'],
      state: { failedUntil: new Map(), failCounts: new Map() },
    };
    const events = [
      { ref: 'key-1', error: { code: 'RATE_LIMIT', message: '429 Quota Exceeded' } }
    ];
    const res = simulateRouting({ pool, events });
    assert.equal(res.outcome, 'SUCCESS');
    assert.equal(res.selectedRef, 'key-2');
    assert.equal(res.attempts, 2);
    assert.ok(res.trace.steps.some((s) => s.ref === 'key-1' && s.decision === 'FAILED'));
  });

  await t.test('simulates cross-provider cascade when pool is exhausted', () => {
    const poolA = {
      base: 'primary',
      refs: ['key-a'],
      state: { failedUntil: new Map([['key-a', Date.now() + 60000]]) },
    };
    const poolB = {
      base: 'fallback',
      refs: ['key-b'],
      state: { failedUntil: new Map() },
    };
    const runtime = {
      cascade: [{ provider: 'fallback' }],
      providerToPool: { fallback: poolB },
    };
    const res = simulateRouting({ pool: poolA, runtime });
    assert.equal(res.outcome, 'CASCADE_TRIGGERED');
    assert.equal(res.selectedRef, 'fallback');
  });

  await t.test('simulates maxAttempts budget constraint (#464 integration)', () => {
    const pool = {
      base: 'mock-provider',
      refs: ['key-1', 'key-2', 'key-3'],
      state: { failedUntil: new Map() },
    };
    const events = [
      { attempt: 1, error: { code: '500', message: 'Server error' } },
      { attempt: 2, error: { code: '500', message: 'Server error' } },
    ];
    const res = simulateRouting({ pool, events, maxAttempts: 2 });
    assert.equal(res.outcome, 'BUDGET_ATTEMPTS_EXCEEDED');
    assert.equal(res.attempts, 2);
  });
});

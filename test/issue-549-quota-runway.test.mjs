// test/issue-549-quota-runway.test.mjs — Test suite for QuotaRunway & predictive rate-limiting avoidance (#549).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateRunway,
  QuotaRunway,
  clampPercent,
} from '../lib/quota-runway.js';
import { sortAttemptList } from '../lib/pool-selection.js';

describe('Issue #549: Predictive Quota Runway Model', () => {
  describe('estimateRunway calculations', () => {
    it('calculates burn rate and flags exhaustsBeforeReset when consumption exceeds time to reset', () => {
      const now = 100000;
      const durationMs = 60000; // 1-minute window
      const resetsAtMs = now + 30000; // 30 seconds until reset

      // Window started at resetsAtMs - durationMs = 130000 - 60000 = 70000.
      // Elapsed = now - 70000 = 30000 ms.
      // Used 80% in 30000 ms -> burn rate = 80 / 30000 %/ms.
      // Remaining 20% will take: 20 / (80/30000) = 7500 ms.
      // Time to reset is 30000 ms.
      // 7500 ms < 30000 ms -> Will exhaust in 7.5s before window resets in 30s!
      const estimate = estimateRunway(
        { percentUsed: 80, resetsAt: resetsAtMs },
        durationMs,
        now,
      );

      assert.ok(estimate);
      assert.equal(estimate.exhaustsBeforeReset, true);
      assert.equal(Math.round(estimate.etaMs), 7500);
      assert.ok(estimate.burnRatePerSec > 0);
    });

    it('flags safe (exhaustsBeforeReset = false) when burn rate is gentle', () => {
      const now = 100000;
      const durationMs = 60000;
      const resetsAtMs = now + 10000; // 10s until reset

      // Elapsed = 50000 ms. Used 10% -> remaining 90% takes 450s >> 10s
      const estimate = estimateRunway(
        { percentUsed: 10, resetsAt: resetsAtMs },
        durationMs,
        now,
      );

      assert.ok(estimate);
      assert.equal(estimate.exhaustsBeforeReset, false);
      assert.ok(estimate.etaMs > (resetsAtMs - now));
    });

    it('returns etaMs = 0 and exhaustsBeforeReset = true when used >= 100%', () => {
      const estimate = estimateRunway(
        { percentUsed: 100, resetsAt: Date.now() + 10000 },
        60000,
      );
      assert.ok(estimate);
      assert.equal(estimate.etaMs, 0);
      assert.equal(estimate.exhaustsBeforeReset, true);
    });

    it('returns null if window resetsAt has already passed', () => {
      const past = Date.now() - 5000;
      const estimate = estimateRunway({ percentUsed: 50, resetsAt: past }, 60000);
      assert.equal(estimate, null);
    });
  });

  describe('QuotaRunway class & rate tracking', () => {
    it('tracks usage and detects keys heading for exhaustion', () => {
      const runway = new QuotaRunway();
      const now = 1000000;

      // Update limits for key-alpha: limit 1000, remaining 100 (90% used), reset in 30s (duration 60s)
      runway.updateLimits('key-alpha', {
        limit: 1000,
        remaining: 100,
        resetsAt: now + 30000,
        durationMs: 60000,
      }, now);

      // Update limits for key-beta: limit 1000, remaining 850 (15% used), reset in 30s (duration 60s)
      runway.updateLimits('key-beta', {
        limit: 1000,
        remaining: 850,
        resetsAt: now + 30000,
        durationMs: 60000,
      }, now);

      assert.equal(runway.isExhaustingBeforeReset('key-alpha', now), true);
      assert.equal(runway.isExhaustingBeforeReset('key-beta', now), false);
    });
  });

  describe('sortAttemptList integration with QuotaRunway (#549)', () => {
    it('preemptively deprioritizes exhausting key in favor of healthy key', () => {
      const runway = new QuotaRunway();
      const now = 500000;

      // key-exhausting: 95% used, will exhaust in 2s, resets in 30s
      runway.updateLimits('key-exhausting', {
        limit: 100,
        remaining: 5,
        resetsAt: now + 30000,
        durationMs: 60000,
      }, now);

      // key-healthy: 10% used, safe
      runway.updateLimits('key-healthy', {
        limit: 100,
        remaining: 90,
        resetsAt: now + 30000,
        durationMs: 60000,
      }, now);

      // In initial list, key-exhausting is FIRST
      const refs = ['key-exhausting', 'key-healthy'];

      // Without runway: order is unchanged
      const raw = sortAttemptList(refs, 'round-robin');
      assert.deepEqual(raw, ['key-exhausting', 'key-healthy']);

      // With runway: healthy key is moved to front to avoid 429!
      const sorted = sortAttemptList(refs, 'round-robin', {
        quotaRunway: runway,
        now,
      });

      assert.deepEqual(sorted, ['key-healthy', 'key-exhausting']);
    });

    it('preserves sticky order if preferred key is healthy', () => {
      const runway = new QuotaRunway();
      const now = 500000;

      runway.updateLimits('key-sticky', {
        limit: 100,
        remaining: 80,
        resetsAt: now + 30000,
        durationMs: 60000,
      }, now);

      const refs = ['key-other', 'key-sticky'];
      const sorted = sortAttemptList(refs, 'sticky', {
        sessionSticky: 'key-sticky',
        quotaRunway: runway,
        now,
      });

      assert.equal(sorted[0], 'key-sticky');
    });

    it('deprioritizes sticky key if it is exhausting before reset', () => {
      const runway = new QuotaRunway();
      const now = 500000;

      // Sticky key is on verge of 429
      runway.updateLimits('key-sticky', {
        limit: 100,
        remaining: 2,
        resetsAt: now + 30000,
        durationMs: 60000,
      }, now);

      // Alternative key is healthy
      runway.updateLimits('key-healthy', {
        limit: 100,
        remaining: 90,
        resetsAt: now + 30000,
        durationMs: 60000,
      }, now);

      const refs = ['key-healthy', 'key-sticky'];
      const sorted = sortAttemptList(refs, 'sticky', {
        sessionSticky: 'key-sticky',
        quotaRunway: runway,
        now,
      });

      // Healthy key comes first!
      assert.equal(sorted[0], 'key-healthy');
      assert.equal(sorted[1], 'key-sticky');
    });
  });
});

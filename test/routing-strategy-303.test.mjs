import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortAttemptList } from '../lib/pool.js';

test('sortAttemptList: round-robin preserves original list order', () => {
  const refs = ['k1', 'k2', 'k3'];
  const res = sortAttemptList(refs, 'round-robin');
  assert.deepEqual(res, ['k1', 'k2', 'k3']);
});

test('sortAttemptList: least-loaded orders by active concurrency count', () => {
  const refs = ['k1', 'k2', 'k3'];
  const tracker = {
    getActive: (ref) => {
      if (ref === 'k1') return 5;
      if (ref === 'k2') return 1;
      if (ref === 'k3') return 3;
      return 0;
    },
  };

  const res = sortAttemptList(refs, 'least-loaded', { concurrencyTracker: tracker });
  assert.deepEqual(res, ['k2', 'k3', 'k1']);
});

test('sortAttemptList: lowest-latency orders by p95 latency', () => {
  const refs = ['k-slow', 'k-fast', 'k-medium'];
  const histogram = {
    snapshot: (ref) => {
      if (ref === 'k-slow') return { p95: 1200 };
      if (ref === 'k-fast') return { p95: 150 };
      if (ref === 'k-medium') return { p95: 450 };
      return null;
    },
  };

  const res = sortAttemptList(refs, 'lowest-latency', { latencyHistogram: histogram });
  assert.deepEqual(res, ['k-fast', 'k-medium', 'k-slow']);
});

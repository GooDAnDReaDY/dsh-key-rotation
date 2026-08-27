// test/histogram.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LatencyHistogram, LATENCY_DEFAULT_WINDOW } from '../lib/histogram.js';

test('LatencyHistogram: ignores invalid sample', () => {
  const h = new LatencyHistogram();
  h.record('', 100);
  h.record('A', NaN);
  h.record('A', -1);
  assert.equal(h.size, 0);
  assert.equal(h.snapshot('A').count, 0);
});

test('LatencyHistogram: basic snapshot with one ref', () => {
  const h = new LatencyHistogram();
  h.record('A', 100);
  h.record('A', 200);
  h.record('A', 300);
  const s = h.snapshot('A');
  assert.equal(s.count, 3);
  // ponytail: percentile = sorted[floor((n-1)*p)] — explicit numpy 'lower' style.
  // For n=3: p50=floor(1*0.5)=1 → sorted[1]=200; p95=floor(1*0.95)=1 → 200; p99=floor(1*0.99)=1 → 200.
  assert.equal(s.p50, 200);
  assert.equal(s.p95, 200);
  assert.equal(s.p99, 200);
  assert.ok(s.lastAt > 0);
});

test('LatencyHistogram: ring buffer wraps at window size', () => {
  const h = new LatencyHistogram({ window: 5 });
  for (let i = 1; i <= 7; i++) h.record('A', i * 100);
  // After 7 records into a 5-slot ring: sorted = [300,400,500,600,700]
  const s = h.snapshot('A');
  assert.equal(s.count, 5);
  // p50: floor(4*0.5) = 2 → 500
  assert.equal(s.p50, 500);
  // p95: floor(4*0.95) = 3 → 600
  assert.equal(s.p95, 600);
  // p99: floor(4*0.99) = 3 → 600
  assert.equal(s.p99, 600);
});

test('LatencyHistogram: percentiles with sorted non-uniform samples (n=10)', () => {
  const h = new LatencyHistogram({ window: 100 });
  const data = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  for (const v of data) h.record('A', v);
  const s = h.snapshot('A');
  assert.equal(s.count, 10);
  // p50: floor(9*0.5) = 4 → sorted[4] = 50
  assert.equal(s.p50, 50);
  // p95: floor(9*0.95) = 8 → sorted[8] = 90
  assert.equal(s.p95, 90);
  // p99: floor(9*0.99) = 8 → sorted[8] = 90
  assert.equal(s.p99, 90);
});

test('LatencyHistogram: snapshotAll returns map for multiple refs', () => {
  const h = new LatencyHistogram();
  h.record('A', 100);
  h.record('B', 200);
  h.record('B', 250);
  const all = h.snapshotAll();
  assert.equal(Object.keys(all).length, 2);
  assert.equal(all.A.count, 1);
  assert.equal(all.B.count, 2);
});

test('LatencyHistogram: clear by ref or all', () => {
  const h = new LatencyHistogram();
  h.record('A', 100);
  h.record('B', 200);
  h.clear('A');
  assert.equal(h.snapshot('A').count, 0);
  assert.equal(h.snapshot('B').count, 1);
  h.clear();
  assert.equal(h.size, 0);
});

test('LatencyHistogram: invalid window falls back to default', () => {
  const h1 = new LatencyHistogram({ window: 0 });
  const h2 = new LatencyHistogram({ window: -5 });
  const h3 = new LatencyHistogram({ window: NaN });
  for (let i = 0; i < LATENCY_DEFAULT_WINDOW + 5; i++) {
    h1.record('A', i);
    h2.record('A', i);
    h3.record('A', i);
  }
  // All three should default to LATENCY_DEFAULT_WINDOW (200)
  assert.equal(h1.snapshot('A').count, LATENCY_DEFAULT_WINDOW);
  assert.equal(h2.snapshot('A').count, LATENCY_DEFAULT_WINDOW);
  assert.equal(h3.snapshot('A').count, LATENCY_DEFAULT_WINDOW);
});

test('LatencyHistogram: snapshot of unknown ref returns count=0 with null lastAt', () => {
  const h = new LatencyHistogram();
  const s = h.snapshot('X');
  assert.equal(s.count, 0);
  assert.equal(s.lastAt, null);
});

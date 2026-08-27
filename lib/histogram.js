// histogram.js — per-ref latency ring buffer + percentile.
// ponytail: ring buffer of fixed size, sort-on-read for percentile, no libraries.

export const LATENCY_DEFAULT_WINDOW = 200;

export class LatencyHistogram {
  constructor({ window = LATENCY_DEFAULT_WINDOW } = {}) {
    const w = Number.isFinite(window) && window > 0 ? Math.floor(window) : LATENCY_DEFAULT_WINDOW;
    this._window = w;
    this._buffers = new Map(); // ref -> Float64Array of size w, plus index/count
    this._lastAt = new Map();  // ref -> epochMs of last sample
  }

  record(ref, ms) {
    if (!ref || !Number.isFinite(ms) || ms < 0) return;
    let entry = this._buffers.get(ref);
    if (!entry) {
      entry = { buf: new Float64Array(this._window), head: 0, count: 0 };
      this._buffers.set(ref, entry);
    }
    entry.buf[entry.head] = ms;
    entry.head = (entry.head + 1) % this._window;
    if (entry.count < this._window) entry.count += 1;
    this._lastAt.set(ref, Date.now());
  }

  // Returns p50/p95/p99 in milliseconds, plus count and lastAt. Sorted copy.
  snapshot(ref) {
    const entry = this._buffers.get(ref);
    const lastAt = this._lastAt.get(ref);
    if (!entry || entry.count === 0) {
      return { count: 0, lastAt: lastAt || null };
    }
    const arr = entry.buf.subarray(0, entry.count);
    const sorted = Array.from(arr).sort((a, b) => a - b);
    const n = sorted.length;
    return {
      count: n,
      lastAt: lastAt || null,
      p50: sorted[Math.min(n - 1, Math.floor((n - 1) * 0.5))],
      p95: sorted[Math.min(n - 1, Math.floor((n - 1) * 0.95))],
      p99: sorted[Math.min(n - 1, Math.floor((n - 1) * 0.99))],
    };
  }

  // Returns { [ref]: snapshot }
  snapshotAll() {
    const out = {};
    for (const ref of this._buffers.keys()) out[ref] = this.snapshot(ref);
    return out;
  }

  clear(ref) {
    if (ref) {
      this._buffers.delete(ref);
      this._lastAt.delete(ref);
    } else {
      this._buffers.clear();
      this._lastAt.clear();
    }
  }

  get size() {
    return this._buffers.size;
  }
}

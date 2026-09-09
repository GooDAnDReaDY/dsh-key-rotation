// lib/clock.js — monotonic process clock for durations (#261).
// performance.timeOrigin + performance.now() tracks process time and does not
// jump when NTP adjusts the wall clock. Wall clock remains for display/cron.

const hasPerformance = typeof performance !== 'undefined'
  && typeof performance.now === 'function'
  && Number.isFinite(performance.timeOrigin);

/** Wall-clock epoch ms (Date.now). Use only for display / calendar buckets. */
export function nowWall() {
  return Date.now();
}

/**
 * Monotonic-in-process epoch ms. Stable under NTP steps for the process lifetime.
 * Falls back to Date.now() if performance is unavailable.
 */
export function nowMono() {
  if (!hasPerformance) return Date.now();
  return performance.timeOrigin + performance.now();
}

/** Default clock injectable into pure helpers. */
export const defaultClock = { nowWall, nowMono };

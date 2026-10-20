// lib/key-drain.js — Managed key draining and graceful replacement (#463, #502).
// Allows draining an old key ref (no new dispatches assigned) while letting
// in-flight active streams complete cleanly before permanent removal.

const drainingKeys = new Map(); // ref -> { provider, startedAt, inFlightCount }

export function markKeyDraining(ref, provider = '') {
  if (!ref) return false;
  drainingKeys.set(ref, {
    ref,
    provider,
    startedAt: Date.now(),
  });
  return true;
}

export function isKeyDraining(ref) {
  if (!ref) return false;
  return drainingKeys.has(ref);
}

export function cancelKeyDrain(ref) {
  if (!ref) return false;
  return drainingKeys.delete(ref);
}

export function getDrainingStatus(ref, concurrencyTracker) {
  if (!ref || !drainingKeys.has(ref)) return null;
  const entry = drainingKeys.get(ref);
  const inFlight = concurrencyTracker && typeof concurrencyTracker.getActive === 'function'
    ? concurrencyTracker.getActive(ref)
    : (concurrencyTracker && typeof concurrencyTracker.getInFlight === 'function'
      ? concurrencyTracker.getInFlight(ref)
      : 0);

  return {
    ref,
    provider: entry.provider,
    startedAt: entry.startedAt,
    elapsedMs: Date.now() - entry.startedAt,
    inFlight,
    canComplete: inFlight === 0,
  };
}

export function getAllDrainingKeys(concurrencyTracker) {
  const result = [];
  for (const ref of drainingKeys.keys()) {
    result.push(getDrainingStatus(ref, concurrencyTracker));
  }
  return result;
}

export function clearAllDraining() {
  drainingKeys.clear();
}

// lib/key-drain.js — Managed key draining and graceful replacement (#463, #502, #544).
// Allows draining an old key ref (no new dispatches assigned) while letting
// in-flight active streams complete cleanly before permanent removal.
// KeyDrainManager provides instance-level isolation (#544).

export class KeyDrainManager {
  constructor() {
    this.drainingKeys = new Map(); // ref -> { provider, startedAt, inFlightCount }
  }

  markKeyDraining(ref, provider = '') {
    if (!ref) return false;
    this.drainingKeys.set(ref, {
      ref,
      provider,
      startedAt: Date.now(),
    });
    return true;
  }

  isKeyDraining(ref) {
    if (!ref) return false;
    return this.drainingKeys.has(ref);
  }

  cancelKeyDrain(ref) {
    if (!ref) return false;
    return this.drainingKeys.delete(ref);
  }

  getDrainingStatus(ref, concurrencyTracker) {
    if (!ref || !this.drainingKeys.has(ref)) return null;
    const entry = this.drainingKeys.get(ref);
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

  getAllDrainingKeys(concurrencyTracker) {
    const result = [];
    for (const ref of this.drainingKeys.keys()) {
      result.push(this.getDrainingStatus(ref, concurrencyTracker));
    }
    return result;
  }

  clearAllDraining() {
    this.drainingKeys.clear();
  }
}

const defaultDrainManager = new KeyDrainManager();

export function markKeyDraining(ref, provider = '', manager = null) {
  return (manager || defaultDrainManager).markKeyDraining(ref, provider);
}

export function isKeyDraining(ref, manager = null) {
  return (manager || defaultDrainManager).isKeyDraining(ref);
}

export function cancelKeyDrain(ref, manager = null) {
  return (manager || defaultDrainManager).cancelKeyDrain(ref);
}

export function getDrainingStatus(ref, concurrencyTracker, manager = null) {
  return (manager || defaultDrainManager).getDrainingStatus(ref, concurrencyTracker);
}

export function getAllDrainingKeys(concurrencyTracker, manager = null) {
  return (manager || defaultDrainManager).getAllDrainingKeys(concurrencyTracker);
}

export function clearAllDraining(manager = null) {
  if (manager) {
    manager.clearAllDraining();
  } else {
    defaultDrainManager.clearAllDraining();
  }
}

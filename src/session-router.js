// lib/session-router.js — Bounded SessionRouter with LRU eviction and proactive unsticking (#548).
// Prevents unbounded memory growth and unpins sessions from failed/cooldown keys.

export const MAX_SESSIONS = 1000;
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class SessionRouter {
  /**
   * @param {{
   *   maxSessions?: number,
   *   sessionTtlMs?: number,
   *   now?: () => number,
   * }} [options]
   */
  constructor(options = {}) {
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    // sessionId -> { keyRef: string, assignedAt: number, lastUsedAt: number }
    this.sessions = new Map();
  }

  /**
   * Evict sessions older than TTL and prune LRU entries if capacity exceeded.
   *
   * @param {number} [currentTime]
   * @returns {number} count of evicted sessions
   */
  prune(currentTime = this.now()) {
    let evicted = 0;
    // 1. Evict by TTL
    for (const [id, entry] of this.sessions.entries()) {
      if (currentTime - entry.lastUsedAt > this.sessionTtlMs) {
        this.sessions.delete(id);
        evicted++;
      }
    }

    // 2. Evict least-recently used if size exceeds maxSessions
    while (this.sessions.size > this.maxSessions) {
      let oldestId = null;
      let oldestTime = Infinity;
      for (const [id, entry] of this.sessions.entries()) {
        if (entry.lastUsedAt < oldestTime) {
          oldestTime = entry.lastUsedAt;
          oldestId = id;
        }
      }
      if (oldestId !== null) {
        this.sessions.delete(oldestId);
        evicted++;
      } else {
        break;
      }
    }

    return evicted;
  }

  /**
   * Count how many active sessions are currently assigned to each key.
   *
   * @param {number} [currentTime]
   * @returns {Map<string, number>}
   */
  getKeyAssignmentCounts(currentTime = this.now()) {
    const counts = new Map();
    for (const entry of this.sessions.values()) {
      if (currentTime - entry.lastUsedAt <= this.sessionTtlMs) {
        counts.set(entry.keyRef, (counts.get(entry.keyRef) ?? 0) + 1);
      }
    }
    return counts;
  }

  /**
   * Select candidate key with the least active sessions assigned (Least-Used Initial Assignment).
   *
   * @param {string[]} availableRefs List of candidate key refs
   * @param {number} [currentTime]
   * @returns {string|null}
   */
  selectLeastUsedKey(availableRefs, currentTime = this.now()) {
    if (!Array.isArray(availableRefs) || availableRefs.length === 0) return null;
    if (availableRefs.length === 1) return availableRefs[0];

    const counts = this.getKeyAssignmentCounts(currentTime);
    let minKey = availableRefs[0];
    let minCount = counts.get(minKey) ?? 0;

    for (let i = 1; i < availableRefs.length; i++) {
      const key = availableRefs[i];
      const count = counts.get(key) ?? 0;
      if (count < minCount) {
        minCount = count;
        minKey = key;
      }
    }

    return minKey;
  }

  /**
   * Resolve pinned key for a session or allocate via Least-Used Initial Assignment.
   *
   * @param {string} sessionId
   * @param {string[]} availableRefs Candidate keys currently healthy/available
   * @param {{ preferKey?: string }} [options]
   * @returns {{ keyRef: string, isReassigned: boolean, reason: string } | null}
   */
  resolveSessionKey(sessionId, availableRefs, options = {}) {
    if (!sessionId || !Array.isArray(availableRefs) || availableRefs.length === 0) {
      const fallback = availableRefs?.[0] ?? null;
      return fallback ? { keyRef: fallback, isReassigned: false, reason: 'ad_hoc' } : null;
    }

    const t = this.now();
    let existing = this.sessions.get(sessionId);

    // Check TTL
    if (existing && (t - existing.lastUsedAt > this.sessionTtlMs)) {
      this.sessions.delete(sessionId);
      existing = null;
    }

    // If session is already pinned to an available key:
    if (existing && availableRefs.includes(existing.keyRef)) {
      existing.lastUsedAt = t;
      return { keyRef: existing.keyRef, isReassigned: false, reason: 'sticky_pinned' };
    }

    // Prune before adding new entry
    if (!existing && this.sessions.size >= this.maxSessions) {
      this.prune(t);
    }

    // Select candidate: prefer explicit key or least-used
    let chosen = options.preferKey && availableRefs.includes(options.preferKey)
      ? options.preferKey
      : this.selectLeastUsedKey(availableRefs, t);

    if (!chosen) chosen = availableRefs[0];

    const wasReassigned = Boolean(existing);
    this.sessions.set(sessionId, {
      keyRef: chosen,
      assignedAt: existing ? existing.assignedAt : t,
      lastUsedAt: t,
    });

    return {
      keyRef: chosen,
      isReassigned: wasReassigned,
      reason: wasReassigned ? 'mid_session_failover' : 'new_session_assigned',
    };
  }

  /**
   * Pin or update session sticky assignment explicitly.
   *
   * @param {string} sessionId
   * @param {string} keyRef
   */
  setSession(sessionId, keyRef) {
    if (!sessionId || !keyRef) return;
    const t = this.now();
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      keyRef,
      assignedAt: existing ? existing.assignedAt : t,
      lastUsedAt: t,
    });
    if (this.sessions.size > this.maxSessions) {
      this.prune(t);
    }
  }

  /**
   * Get pinned key for a session if still valid.
   *
   * @param {string} sessionId
   * @returns {string|null}
   */
  getSession(sessionId) {
    if (!sessionId) return null;
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    const t = this.now();
    if (t - entry.lastUsedAt > this.sessionTtlMs) {
      this.sessions.delete(sessionId);
      return null;
    }
    return entry.keyRef;
  }

  /**
   * Unstick a specific session (e.g. after a failure or manual unpin).
   *
   * @param {string} sessionId
   * @returns {boolean} true if session was present and removed
   */
  unstick(sessionId) {
    if (!sessionId) return false;
    return this.sessions.delete(sessionId);
  }

  /**
   * Proactively unstick all sessions pinned to a failed / cooling key (#548).
   *
   * @param {string} keyRef Failed key ref
   * @returns {number} count of sessions unpinned
   */
  unstickKey(keyRef) {
    if (!keyRef) return 0;
    let count = 0;
    for (const [id, entry] of this.sessions.entries()) {
      if (entry.keyRef === keyRef) {
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Return router diagnostics.
   */
  getStatus() {
    const t = this.now();
    const counts = this.getKeyAssignmentCounts(t);
    return {
      activeSessionsCount: this.sessions.size,
      maxSessions: this.maxSessions,
      sessionTtlMs: this.sessionTtlMs,
      keyAssignments: Object.fromEntries(counts.entries()),
    };
  }

  /**
   * Reset all sessions (useful for tests).
   */
  reset() {
    this.sessions.clear();
  }
}

// Global default router instance for convenience
export const defaultSessionRouter = new SessionRouter();

/**
 * Helper to unstick all sessions pinned to keyRef across router or default instance (#548).
 * @param {string|object} keyRefOrRouter
 * @param {string} [keyRef]
 * @returns {number}
 */
export function unstickFailedKey(keyRefOrRouter, keyRef) {
  if (typeof keyRefOrRouter === 'string') {
    return defaultSessionRouter.unstickKey(keyRefOrRouter);
  }
  if (keyRefOrRouter instanceof SessionRouter) {
    return keyRefOrRouter.unstickKey(keyRef);
  }
  return defaultSessionRouter.unstickKey(keyRef);
}


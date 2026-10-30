// lib/pool-selection.js — pool selection, sticky sessions, attempt sorting and budget metrics (#512, #548).
// Extracted from lib/pool.js to enforce < 600 line modularity standard.

import {
  SessionRouter,
  defaultSessionRouter,
  MAX_SESSIONS,
  SESSION_TTL_MS,
} from './session-router.js';

export {
  SessionRouter,
  defaultSessionRouter,
  MAX_SESSIONS,
  SESSION_TTL_MS,
};

export const MAX_SESSION_STICKY_ENTRIES = MAX_SESSIONS;

/**
 * Get or initialize the SessionRouter on pool.state or fallback to default.
 * @param {object} [pool]
 * @returns {SessionRouter}
 */
export function getOrCreateSessionRouter(pool) {
  if (!pool?.state) return defaultSessionRouter;
  if (!pool.state.sessionRouter) {
    pool.state.sessionRouter = new SessionRouter({
      maxSessions: MAX_SESSIONS,
      sessionTtlMs: SESSION_TTL_MS,
    });
  }
  return pool.state.sessionRouter;
}

export function setSessionSticky(pool, sessionId, candidate) {
  if (!sessionId || !candidate) return;
  const router = getOrCreateSessionRouter(pool);
  router.setSession(sessionId, candidate);
  if (pool?.state) {
    if (!(pool.state.sessionSticky instanceof Map)) {
      pool.state.sessionSticky = new Map();
    }
    if (pool.state.sessionSticky.has(sessionId)) {
      pool.state.sessionSticky.delete(sessionId);
    } else if (pool.state.sessionSticky.size >= MAX_SESSION_STICKY_ENTRIES) {
      const oldest = pool.state.sessionSticky.keys().next().value;
      if (oldest !== undefined) pool.state.sessionSticky.delete(oldest);
    }
    pool.state.sessionSticky.set(sessionId, candidate);
  }
}

export function getSessionSticky(pool, sessionId) {
  if (!sessionId) return null;
  const router = getOrCreateSessionRouter(pool);
  const fromRouter = router.getSession(sessionId);
  if (fromRouter) return fromRouter;
  return pool?.state?.sessionSticky?.get?.(sessionId) ?? null;
}

export function clearSessionSticky(pool, sessionId) {
  if (!sessionId) return;
  const router = getOrCreateSessionRouter(pool);
  router.unstick(sessionId);
  if (pool?.state?.sessionSticky) {
    pool.state.sessionSticky.delete(sessionId);
  }
}

/**
 * Proactively unstick all sessions pinned to a cooling or failed key (#548).
 * @param {object} pool
 * @param {string} keyRef
 * @returns {number}
 */
export function unstickFailedKey(pool, keyRef) {
  if (!keyRef) return 0;
  const router = getOrCreateSessionRouter(pool);
  const count = router.unstickKey(keyRef);
  if (pool?.state?.sessionSticky) {
    for (const [sId, ref] of pool.state.sessionSticky.entries()) {
      if (ref === keyRef) {
        pool.state.sessionSticky.delete(sId);
      }
    }
  }
  return count;
}

/** Pick a key pool for a (provider, model) pair. */
export function selectPool(modelPoolByProvider, providerToPool, provider, model) {
  const byModel = modelPoolByProvider && modelPoolByProvider.get(provider);
  const base = providerToPool && providerToPool.get(provider);
  if (!byModel || !model) return base ?? null;
  if (byModel.has(model)) return byModel.get(model);
  let best = null;
  for (const key of byModel.keys()) {
    if (model.startsWith(key) && key.length > (best ? best.length : 0)) best = key;
  }
  return (best ? byModel.get(best) : base) ?? null;
}

/**
 * Sort candidate refs according to pool routing strategy.
 * Returns a new array; does not mutate input.
 */
export function sortAttemptList(refs, strategy = 'round-robin', deps = {}) {
  if (!Array.isArray(refs) || refs.length <= 1) return (refs ?? []).slice();
  const list = refs.slice();
  if (strategy === 'sticky') {
    const router = getOrCreateSessionRouter(deps.pool);
    let chosenKey = null;

    if (deps.sessionId) {
      const resolved = router.resolveSessionKey(deps.sessionId, list);
      if (resolved && resolved.keyRef) {
        chosenKey = resolved.keyRef;
        if (deps.pool) setSessionSticky(deps.pool, deps.sessionId, chosenKey);
      }
    }

    const last = chosenKey ||
      deps.sessionSticky ||
      (deps.sessionId && (deps.pool?.state?.sessionSticky?.get?.(deps.sessionId) || deps.sessionStickyMap?.get?.(deps.sessionId))) ||
      deps.lastUsed ||
      (deps.pool && deps.pool.state && deps.pool.state.lastUsed);

    if (last && list.includes(last)) {
      const idx = list.indexOf(last);
      if (idx > 0) {
        list.splice(idx, 1);
        list.unshift(last);
      }
    }
    return list;
  }
  if (strategy === 'tier-priority') {
    const tiers = deps.tiers || (deps.pool && deps.pool.tiers) || {};
    return list.sort((a, b) => {
      const ta = (tiers[a] && Number(tiers[a]) >= 1) ? Number(tiers[a]) : 1;
      const tb = (tiers[b] && Number(tiers[b]) >= 1) ? Number(tiers[b]) : 1;
      return ta - tb;
    });
  }
  if (strategy === 'least-loaded' && deps.concurrencyTracker && typeof deps.concurrencyTracker.getActive === 'function') {
    const weights = deps.weights || (deps.pool && deps.pool.weightsMap) || {};
    return list.sort((a, b) => {
      const ca = deps.concurrencyTracker.getActive(a) ?? 0;
      const cb = deps.concurrencyTracker.getActive(b) ?? 0;
      const wa = (weights[a] && Number(weights[a]) > 0) ? Number(weights[a]) : 1;
      const wb = (weights[b] && Number(weights[b]) > 0) ? Number(weights[b]) : 1;
      const scoreA = ca / wa;
      const scoreB = cb / wb;
      if (scoreA !== scoreB) return scoreA - scoreB;
      return ca - cb;
    });
  }
  if (strategy === 'lowest-latency' && deps.latencyHistogram && typeof deps.latencyHistogram.snapshot === 'function') {
    return list.sort((a, b) => {
      const sa = deps.latencyHistogram.snapshot(a);
      const sb = deps.latencyHistogram.snapshot(b);
      const la = (sa && Number.isFinite(sa.p95)) ? sa.p95 : ((sa && Number.isFinite(sa.avg)) ? sa.avg : 500);
      const lb = (sb && Number.isFinite(sb.p95)) ? sb.p95 : ((sb && Number.isFinite(sb.avg)) ? sb.avg : 500);
      return la - lb;
    });
  }
  return list;
}

/**
 * Keys of pool whose expiresAt falls within the next warnDays.
 * Returns [{ ref, expiresInDays, expiresAt }], soonest first.
 */
export function expiringSoon(pool, warnDays = 7, now = Date.now()) {
  if (!pool || !pool.expiresAt) return [];
  const DAY_MS = 86400000;
  const horizon = now + Math.max(1, warnDays) * DAY_MS;
  return Object.entries(pool.expiresAt)
    .filter(([, at]) => at > now && at <= horizon)
    .map(([ref, at]) => ({ ref, expiresAt: at, expiresInDays: Math.max(0, Math.floor((at - now) / DAY_MS)) }))
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

/** Dedupe: true when a day-level notification for key is due. */
export function shouldNotifyDaily(lastNotified, key, now = Date.now()) {
  const DAY_MS = 86400000;
  if (!lastNotified.has(key)) {
    lastNotified.set(key, now);
    return true;
  }
  const last = lastNotified.get(key);
  if (now - last < DAY_MS) return false;
  lastNotified.set(key, now);
  return true;
}

/** Total spend of a pool on ISO day day (defaults to today) across costDays Map<ref, Map<day, cost>>. */
export function costForDay(costDays, day) {
  const d = day ?? new Date().toISOString().slice(0, 10);
  let total = 0;
  for (const perRef of (costDays?.values() ?? [])) {
    total += perRef.get(d) ?? 0;
  }
  return total;
}

/** Total spend over the last 7 ISO days ending today. */
export function costForWeek(costDays, now = Date.now()) {
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    total += costForDay(costDays, d);
  }
  return total;
}

/** Budget verdict for a pool: { spend, budget, ratio, warn, exceeded }. */
export function budgetVerdict(spend, budget) {
  if (!budget || budget <= 0) return { spend, budget: 0, ratio: 0, warn: false, exceeded: false };
  const ratio = spend / budget;
  return { spend, budget, ratio, warn: ratio >= 0.8, exceeded: ratio >= 1 };
}


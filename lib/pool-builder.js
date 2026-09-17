// lib/pool-builder.js — provider & per-model pool assembly and cleanup
import { bucketSweep } from './bucket.js';

export function parseExpiry(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v.length > 0) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

export function buildPoolItem({
  base,
  keys,
  weights,
  poolCooldown,
  poolMax,
  expiresAt,
  poolStrategy,
  poolGuard,
  rpmLimit,
  makeState,
}) {
  const refs = (keys ?? []).filter((ref) => typeof ref === 'string' && ref.length > 0);
  if (refs.length === 0) return null;
  const w = Array.isArray(weights) ? weights : [];
  const weightedRefs = [];
  for (let i = 0; i < refs.length; i++) {
    const ww = typeof w[i] === 'number' && w[i] > 0 ? Math.floor(w[i]) : 1;
    for (let k = 0; k < ww; k++) weightedRefs.push(refs[i]);
  }
  const parsedExpiry = {};
  if (Array.isArray(expiresAt)) {
    for (let i = 0; i < refs.length; i++) {
      const exp = parseExpiry(expiresAt[i]);
      if (exp !== undefined) parsedExpiry[refs[i]] = exp;
    }
  }
  return {
    base,
    refs,
    weights: refs.map((_, i) => (typeof w[i] === 'number' && w[i] > 0 ? Math.floor(w[i]) : 1)),
    weightedRefs: weightedRefs.length > 0 ? weightedRefs : refs,
    state: makeState(base),
    cooldownMs: poolCooldown,
    maxCooldownMs: poolMax,
    expiresAt: parsedExpiry,
    rpmLimit,
    routingStrategy: poolStrategy,
    proactiveRateLimitGuard: poolGuard,
  };
}

export function cleanupRemovedProviders({
  cfg,
  poolState,
  poolByRef,
  providerToPool,
  expectedClones,
  moduleBreaker,
  lowHealthNotifiedAt,
  budgetNotifiedAt,
}) {
  // auto-cleanup: remove poolState for providers that are now empty or removed
  for (const key of [...poolState.keys()]) {
    if (![...poolByRef.values()].some((p) => p.base === key)) {
      poolState.delete(key);
      lowHealthNotifiedAt?.delete?.(key);
      budgetNotifiedAt?.delete?.(key + ':budget');
    }
  }
  // #192: drop RPM windows for refs that no longer belong to any pool
  for (const st of poolState.values()) {
    if (st.rpmWindows) bucketSweep(st.rpmWindows, new Set(poolByRef.keys()));
  }
  // drop breaker entries for removed providers
  if (moduleBreaker) {
    for (const key of Object.keys(moduleBreaker.snapshot())) {
      if (![...providerToPool.keys()].includes(key) && !expectedClones.has(key)) {
        const still = (cfg.providers ?? []).some((p) => p.provider === key);
        if (!still) moduleBreaker.reset(key);
      }
    }
  }
}

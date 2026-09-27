// cascade.js — cross-provider failover cascade (issues #194, #364).
// ponytail: minimal — pick fallback provider with model mapping from config.

export const CASCADE_MAX_DEPTH = 3;

function isKeyPaused(pool, ref) {
  if (!pool || !ref) return false;
  if (pool.pausedRefs instanceof Set) return pool.pausedRefs.has(ref);
  if (Array.isArray(pool.pausedRefs)) return pool.pausedRefs.includes(ref);
  return false;
}

export function pickCascadeFallback(provider, cfg, pools, currentModel) {
  const list = Array.isArray(cfg && cfg.cascade) ? cfg.cascade : [];
  for (const entry of list) {
    const fb = typeof entry === 'string' ? { provider: entry } : entry;
    if (!fb || !fb.provider || fb.provider === provider) continue;
    const pool = pools instanceof Map ? pools.get(fb.provider) : (pools ? pools[fb.provider] : null);
    if (!pool) continue;
    const now = Date.now();
    let healthy = 0;
    for (const ref of pool.refs) {
      if (isKeyPaused(pool, ref)) continue;
      const failedUntil = (pool.state && pool.state.failedUntil && pool.state.failedUntil.get(ref)) || 0;
      if (failedUntil > now) continue;
      const exp = pool.expiresAt ? pool.expiresAt[ref] : undefined;
      if (exp !== undefined && now >= exp) continue;
      healthy += 1;
    }
    if (healthy === 0) continue;
    const mappedModel = (fb.modelMapping && currentModel && fb.modelMapping[currentModel]) || fb.model || currentModel || null;
    return { provider: fb.provider, pool, model: mappedModel };
  }
  return null;
}

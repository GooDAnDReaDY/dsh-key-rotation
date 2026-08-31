// cascade.js — cross-provider failover cascade (issue #194).
// ponytail: minimal — pick fallback provider from a RegionMap-like config.

export const CASCADE_MAX_DEPTH = 1;

export function pickCascadeFallback(provider, cfg, pools) {
  const list = Array.isArray(cfg && cfg.cascade) ? cfg.cascade : [];
  for (const entry of list) {
    const fb = typeof entry === 'string' ? { provider: entry } : entry;
    if (!fb || !fb.provider || fb.provider === provider) continue;
    const pool = pools instanceof Map ? pools.get(fb.provider) : (pools ? pools[fb.provider] : null);
    if (!pool) continue;
    const now = Date.now();
    let healthy = 0;
    for (const ref of pool.refs) {
      const failedUntil = (pool.state && pool.state.failedUntil && pool.state.failedUntil.get(ref)) || 0;
      if (failedUntil > now) continue;
      const exp = pool.expiresAt ? pool.expiresAt[ref] : undefined;
      if (exp !== undefined && now >= exp) continue;
      healthy += 1;
    }
    if (healthy === 0) continue;
    return { provider: fb.provider, pool, model: fb.model || null };
  }
  return null;
}

export function hasHealthyKey(pool, now) {
  now = now || Date.now();
  if (!pool || !Array.isArray(pool.refs)) return false;
  for (const ref of pool.refs) {
    const failedUntil = (pool.state && pool.state.failedUntil && pool.state.failedUntil.get(ref)) || 0;
    if (failedUntil > now) continue;
    const exp = pool.expiresAt ? pool.expiresAt[ref] : undefined;
    if (exp !== undefined && now >= exp) continue;
    return true;
  }
  return false;
}

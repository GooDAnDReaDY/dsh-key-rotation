// cascade.js — cross-provider failover cascade (issues #194, #364, #376, #414).
// ponytail: minimal — pick fallback provider with model mapping from config.
import { isKeyPaused, isKeyRevoked, selectPool } from './pool.js';
import { isModelQuotaAvailable, hasModelQuotaConfig } from './model-quota.js';

export const CASCADE_MAX_DEPTH = 3;

export function pickCascadeFallback(provider, cfg, pools, currentModel, modelPoolByProvider, circuitBreaker) {
  const list = Array.isArray(cfg && cfg.cascade) ? cfg.cascade : [];
  const modelPools = modelPoolByProvider || cfg?.modelPoolByProvider || cfg?.index?.modelPoolByProvider || null;
  const provPools = pools || cfg?.providerToPool || cfg?.index?.providerToPool || null;

  for (const entry of list) {
    const fb = typeof entry === 'string' ? { provider: entry } : entry;
    if (!fb || !fb.provider || fb.provider === provider) continue;

    const breaker = circuitBreaker || cfg?.circuitBreaker || null;
    if (breaker) {
      if (typeof breaker.isAvailable === 'function') {
        if (!breaker.isAvailable(fb.provider)) continue;
      } else if (typeof breaker.canRequest === 'function') {
        if (!breaker.canRequest(fb.provider)) continue;
      }
    }

    const mappedModel = (fb.modelMapping && currentModel && fb.modelMapping[currentModel]) || fb.model || currentModel || null;
    let pool = null;
    if (modelPools && mappedModel) {
      pool = selectPool(modelPools, provPools, fb.provider, mappedModel);
    }
    if (!pool && provPools) {
      pool = provPools instanceof Map ? provPools.get(fb.provider) : (provPools ? provPools[fb.provider] : null);
    }
    if (!pool) continue;

    const now = Date.now();
    let healthy = 0;
    for (const ref of pool.refs) {
      if (isKeyPaused(pool, ref) || isKeyRevoked(pool, ref)) continue;
      const failedUntil = (pool.state && pool.state.failedUntil && pool.state.failedUntil.get(ref)) || 0;
      if (failedUntil > now) continue;
      const exp = pool.expiresAt ? pool.expiresAt[ref] : (pool.basePool?.expiresAt ? pool.basePool.expiresAt[ref] : undefined);
      if (exp !== undefined && now >= exp) continue;
      if (hasModelQuotaConfig(pool) && !isModelQuotaAvailable(pool, ref, now)) continue;
      healthy += 1;
    }
    if (healthy === 0) continue;
    return { provider: fb.provider, pool, model: mappedModel };
  }
  return null;
}

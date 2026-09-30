// lib/pool-builder.js — provider & per-model pool assembly and cleanup
import { bucketSweep, tpmSweep } from './bucket.js';
import { isValidRef } from './pool.js';
import { normalizeModelQuotas } from './model-quota.js';
import { createPoolIndex, addProviderPools } from './pool-index.js';
import { initializePoolState } from './pool-state.js';

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
  paused,
  revoked,
  poolCooldown,
  poolMax,
  expiresAt,
  poolStrategy,
  poolGuard,
  rpmLimit,
  tpmLimit = 0,
  concurrencyLimit = 0,
  makeState,
  provider = null,
  model = null,
  quotas = null,
  quotaResetWindow = null,
}) {
  const seen = new Set();
  const indexed = (Array.isArray(keys) ? keys : []).map((key, index) => ({ ref: typeof key === 'string' ? key.trim() : '', index }))
    .filter(({ ref }) => { if (!isValidRef(ref) || seen.has(ref)) return false; seen.add(ref); return true; });
  const refs = indexed.map(item => item.ref);
  if (refs.length === 0) return null;
  const w = indexed.map(({ index }) => {
    const value = Array.isArray(weights) ? weights[index] : undefined;
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(1000, Math.floor(value))) : 1;
  });
  const weightedRefs = [];
  for (let i = 0; i < refs.length; i++) {
    const ww = typeof w[i] === 'number' && w[i] > 0 ? Math.floor(w[i]) : 1;
    for (let k = 0; k < ww; k++) weightedRefs.push(refs[i]);
  }
  const parsedExpiry = {};
  if (Array.isArray(expiresAt)) {
    for (let i = 0; i < refs.length; i++) {
      const exp = parseExpiry(expiresAt[indexed[i].index]);
      if (exp !== undefined) parsedExpiry[refs[i]] = exp;
    }
  } else if (expiresAt && typeof expiresAt === 'object') {
    for (let i = 0; i < refs.length; i++) {
      const exp = parseExpiry(expiresAt[refs[i]]);
      if (exp !== undefined) parsedExpiry[refs[i]] = exp;
    }
  }
  const parsedPaused = new Set();
  if (Array.isArray(paused)) {
    for (let i = 0; i < refs.length; i++) {
      if (paused[indexed[i].index] === true || paused.includes(refs[i])) parsedPaused.add(refs[i]);
    }
  } else if (paused instanceof Set) {
    for (let i = 0; i < refs.length; i++) {
      if (paused.has(refs[i])) parsedPaused.add(refs[i]);
    }
  }
  const parsedRevoked = new Set();
  if (Array.isArray(revoked)) {
    for (let i = 0; i < refs.length; i++) {
      if (revoked[indexed[i].index] === true || revoked.includes(refs[i])) parsedRevoked.add(refs[i]);
    }
  } else if (revoked instanceof Set) {
    for (let i = 0; i < refs.length; i++) {
      if (revoked.has(refs[i])) parsedRevoked.add(refs[i]);
    }
  }
  const weightsMap = {};
  for (let i = 0; i < refs.length; i++) {
    weightsMap[refs[i]] = typeof w[i] === 'number' && w[i] > 0 ? Math.floor(w[i]) : 1;
  }
  const normalizedQuotas = normalizeModelQuotas(quotas);
  return {
    base,
    provider,
    model,
    quotas: normalizedQuotas,
    hasModelQuota: Object.keys(normalizedQuotas).length > 0,
    quotaResetWindow,
    refs,
    weights: refs.map((_, i) => (typeof w[i] === 'number' && w[i] > 0 ? Math.floor(w[i]) : 1)),
    weightsMap,
    weightedRefs: weightedRefs.length > 0 ? weightedRefs : refs,
    pausedRefs: parsedPaused,
    revokedRefs: parsedRevoked,
    state: makeState(base),
    cooldownMs: poolCooldown,
    maxCooldownMs: poolMax,
    expiresAt: parsedExpiry,
    rpmLimit,
    tpmLimit: typeof tpmLimit === 'number' && Number.isFinite(tpmLimit) && tpmLimit > 0 ? Math.floor(tpmLimit) : 0,
    concurrencyLimit: typeof concurrencyLimit === 'number' && Number.isFinite(concurrencyLimit) && concurrencyLimit > 0 ? Math.floor(concurrencyLimit) : 0,
    routingStrategy: poolStrategy,
    proactiveRateLimitGuard: poolGuard,
  };
}

export function buildPools({ cfg = {}, poolState = new Map(), defaultState = initializePoolState } = {}) {
  const rpmLimit = cfg.rpmLimit ?? 0;
  const tpmLimit = cfg.tpmLimit ?? 0;
  const concurrencyLimit = cfg.concurrencyLimit ?? 0;
  const quotaResetWindow = cfg.quotaResetWindow ?? null;
  const poolByRef = new Map();
  const providerToPool = new Map();
  const modelPoolByProvider = new Map();
  const cloneIds = new Set();
  const index = createPoolIndex();

  const makeState = (base) => {
    let st = poolState.get(base);
    if (!st) {
      st = initializePoolState(defaultState());
      poolState.set(base, st);
    }
    return initializePoolState(st);
  };

  const buildPool = (base, keys, weights, paused, revoked, poolCooldown, poolMax, expiresAt, poolStrategy, poolGuard, meta, pRpm = rpmLimit, pTpm = tpmLimit, pConcurrency = concurrencyLimit) =>
    buildPoolItem({
      base, keys, weights, paused, revoked, poolCooldown, poolMax, expiresAt, poolStrategy, poolGuard,
      rpmLimit: pRpm, tpmLimit: pTpm, concurrencyLimit: pConcurrency, makeState, quotaResetWindow, ...meta,
    });

  for (const p of cfg.providers ?? []) {
    const poolCooldown = typeof p.cooldownMs === 'number' ? p.cooldownMs : (cfg.cooldownMs ?? 60000);
    const poolMax = typeof p.maxCooldownMs === 'number' ? p.maxCooldownMs : (cfg.maxCooldownMs ?? undefined);
    const provRpm = typeof p.rpmLimit === 'number' ? p.rpmLimit : rpmLimit;
    const provTpm = typeof p.tpmLimit === 'number' ? p.tpmLimit : tpmLimit;
    const provConcurrency = typeof p.concurrencyLimit === 'number' ? p.concurrencyLimit : concurrencyLimit;
    const pool = buildPool(p.provider, p.keys, p.weights, p.paused, p.revoked, poolCooldown, poolMax, p.expiresAt, p.routingStrategy, p.proactiveRateLimitGuard, {
      provider: p.provider,
      model: null,
    }, provRpm, provTpm, provConcurrency);
    if (pool) {
      for (const ref of pool.refs) {
        if (!poolByRef.has(ref)) poolByRef.set(ref, pool);
      }
      for (let i = 1; i < pool.refs.length; i++) cloneIds.add(`${p.provider}-${i + 1}`);
      if (!providerToPool.has(p.provider)) providerToPool.set(p.provider, pool);
    }
    const byModel = new Map();
    for (const [model, mp] of Object.entries(p.models ?? {})) {
      const modelRpm = typeof mp.rpmLimit === 'number' ? mp.rpmLimit : provRpm;
      const modelTpm = typeof mp.tpmLimit === 'number' ? mp.tpmLimit : provTpm;
      const modelConcurrency = typeof mp.concurrencyLimit === 'number' ? mp.concurrencyLimit : provConcurrency;
      const mergedPaused = new Set([
        ...(pool?.pausedRefs ?? []),
        ...(Array.isArray(mp.paused) ? mp.paused : (mp.paused instanceof Set ? [...mp.paused] : [])),
      ]);
      const mergedRevoked = new Set([
        ...(pool?.revokedRefs ?? []),
        ...(Array.isArray(mp.revoked) ? mp.revoked : (mp.revoked instanceof Set ? [...mp.revoked] : [])),
      ]);
      const modelExpiresAt = { ...(pool?.expiresAt ?? {}), ...(typeof mp.expiresAt === 'object' ? mp.expiresAt : {}) };
      const mpool = buildPool(`${p.provider}::${model}`, mp.keys, mp.weights, mergedPaused, mergedRevoked, poolCooldown, poolMax, modelExpiresAt, p.routingStrategy, p.proactiveRateLimitGuard, {
        provider: p.provider,
        model,
        quotas: mp.quotas,
      }, modelRpm, modelTpm, modelConcurrency);
      if (!mpool) continue;
      mpool.basePool = pool;
      byModel.set(model, mpool);
      for (const ref of mpool.refs) {
        if (!poolByRef.has(ref)) poolByRef.set(ref, mpool);
      }
    }
    if (byModel.size > 0) modelPoolByProvider.set(p.provider, byModel);
    addProviderPools(index, p.provider, pool, byModel);
  }

  return {
    index,
    pools: [...index.allPools.values()],
    poolByRef,
    providerToPool,
    modelPoolByProvider,
    cloneIds,
    poolState,
  };
}

export function cleanupRemovedProviders({
  cfg,
  poolState,
  poolByRef,
  pools,
  providerToPool,
  expectedClones,
  moduleBreaker,
  lowHealthNotifiedAt,
  budgetNotifiedAt,
}) {
  const live = Array.isArray(pools) ? pools : [...(pools?.values?.() ?? (poolByRef?.values?.() ? [...poolByRef.values()] : []))];
  const liveBases = new Set(live.map((p) => p.base));
  for (const key of [...poolState.keys()]) {
    if (!liveBases.has(key)) {
      poolState.delete(key);
      lowHealthNotifiedAt?.delete?.(key);
      budgetNotifiedAt?.delete?.(`${key}:budget`);
    }
  }
  const liveRefs = new Set();
  for (const pool of live) {
    if (Array.isArray(pool?.refs)) {
      for (const ref of pool.refs) liveRefs.add(ref);
    }
  }
  for (const st of poolState.values()) {
    if (st.rpmWindows) bucketSweep(st.rpmWindows, liveRefs);
    if (st.tpmWindows) tpmSweep(st.tpmWindows, liveRefs);
    if (st.tokenUsage instanceof Map) {
      for (const ref of [...st.tokenUsage.keys()]) {
        if (!liveRefs.has(ref)) st.tokenUsage.delete(ref);
      }
    }
  }
  if (moduleBreaker) {
    for (const key of Object.keys(moduleBreaker.snapshot())) {
      if (![...providerToPool.keys()].includes(key) && !expectedClones.has(key)) {
        const still = (cfg.providers ?? []).some((p) => p.provider === key);
        if (!still) moduleBreaker.reset(key);
      }
    }
  }
}

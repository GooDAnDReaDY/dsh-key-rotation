//
// Extracted from lib/index.js so the routing decisions that this feature
// depends on — request-scoped pool ownership, model token quota enforcement,
// fail-closed exhaustion, paused/revoked filtering, at-rest decryption —
// are unit-testable without the cordis runtime.
//
// The resolver decides *which* credential ref to hand to the underlying
// credentials service. It never sees or returns a secret value itself; it
// delegates to `original(ref)`.

import { bucketAllow, bucketRetryMs, tpmAllow, tpmRetryMs } from './bucket.js';
import { envValue, sortAttemptList, isKeyPaused, isKeyRevoked, isKeyBroken, costForDay, costForWeek, budgetVerdict, getSessionSticky, setSessionSticky } from './pool.js';
import { decryptSecret } from './crypto-storage.js';
import { resolveRefPool, isQuotaManagedRequest, providerOfBase, basePoolForBase } from './pool-index.js';
import {
  isModelQuotaAvailable,
  hasModelQuotaConfig,
  anyModelQuotaAvailable,
  formatModelQuotaExhaustion,
} from './model-quota.js';

/** Internal failure code for "local budgets forbid this dispatch". */
export const LOCAL_QUOTA_CODE = 'LOCAL_MODEL_QUOTA_EXHAUSTED';
export const LOCAL_POOL_EXHAUSTED_CODE = 'LOCAL_POOL_EXHAUSTED';

/**
 * Calculates aggregated daily and weekly spend across base pool and model pools for a provider without double-counting (#422).
 */
export function getProviderCost(provider, runtime, now = Date.now()) {
  const seenStates = new Set();
  let daily = 0;
  let weekly = 0;
  const pools = [];
  const basePool = runtime?.providerToPool?.get?.(provider);
  if (basePool) pools.push(basePool);
  const modelPools = runtime?.modelPoolByProvider?.get?.(provider);
  if (modelPools) {
    for (const mp of modelPools.values()) {
      if (!pools.includes(mp)) pools.push(mp);
    }
  }
  if (runtime?.index?.allPools) {
    for (const p of runtime.index.allPools) {
      if ((p.provider === provider || p.base === provider || p.base?.startsWith(provider + '::')) && !pools.includes(p)) {
        pools.push(p);
      }
    }
  }
  if (runtime?.poolByRef) {
    for (const p of runtime.poolByRef.values()) {
      if ((p.provider === provider || p.base === provider || p.base?.startsWith(provider + '::')) && !pools.includes(p)) {
        pools.push(p);
      }
    }
  }
  for (const p of pools) {
    if (p.state && !seenStates.has(p.state)) {
      seenStates.add(p.state);
      daily += costForDay(p.state.costDays);
      weekly += costForWeek(p.state.costDays, now);
    }
  }
  return { daily, weekly, pools };
}

/**
 * @param {object} deps
 * @param {() => object} deps.buildRuntime         current runtime snapshot
 * @param {() => object|undefined} deps.currentPool request-scoped pool (ALS)
 * @param {(pool: object, candidate: string, meta?: object) => void} [deps.onPicked] picked-ref hook
 * @param {object} [deps.latencyHistogram]
 * @param {object} [deps.concurrencyTracker]
 * @param {() => number} [deps.now] wall clock; injectable for tests
 * @returns {(ref: string, original: Function) => Promise<any>}
 */
export function createResolver({
  buildRuntime,
  currentPool,
  currentSession,
  currentModel,
  onPicked,
  latencyHistogram,
  concurrencyTracker,
  now = Date.now,
}) {
  return async function resolve(ref, original, resolveOpts) {
    const runtime = buildRuntime();
    // A ref may belong to several model pools at once, so the request-scoped
    // pool that rotate() actually dispatched with decides ownership. A bare
    // resolve outside rotation falls back to the global lookup.
    const requested = currentPool ? currentPool() ?? null : null;
    const model = resolveOpts?.model ?? currentModel?.() ?? requested?.model ?? null;
    const pool = resolveRefPool(runtime.index, ref, requested);
    if (!pool) {
      const res = await original(ref);
      if (res && typeof res.value === 'string') {
        return { ...res, value: decryptSecret(res.value) };
      }
      const ev = envValue(ref);
      if (ev !== undefined) return { value: decryptSecret(ev), source: 'env' };
      return res;
    }

    const at = now();

    // Provider monetary budget refusal (#422):
    const providerName = pool.provider ?? providerOfBase(pool.base);
    const budget = runtime.providerBudgets?.get?.(providerName);
    if (budget && budget.pauseOnBudget) {
      const { daily, weekly } = getProviderCost(providerName, runtime, at);
      const vDaily = budgetVerdict(daily, budget.costBudgetDaily);
      const vWeekly = budgetVerdict(weekly, budget.costBudgetWeekly);
      if (vDaily.exceeded || vWeekly.exceeded) {
        throw Object.assign(
          new Error(`dsh-key-rotation: provider "${providerName}" cost budget exceeded (daily: $${daily.toFixed(2)}/${budget.costBudgetDaily}, weekly: $${weekly.toFixed(2)}/${budget.costBudgetWeekly})`),
          { code: LOCAL_POOL_EXHAUSTED_CODE, localExhausted: true },
        );
      }
    }

    const strategy = pool.routingStrategy ?? runtime.routingStrategy ?? 'round-robin';
    const sessionId = resolveOpts?.sessionId ?? resolveOpts?.session ?? resolveOpts?.metadata?.sessionId ?? currentSession?.();
    let list = pool.weightedRefs ?? pool.refs;
    if (strategy === 'lowest-latency' || strategy === 'least-loaded' || strategy === 'sticky' || strategy === 'tier-priority') {
      list = sortAttemptList(list, strategy, {
        latencyHistogram,
        concurrencyTracker,
        weights: pool.weightsMap,
        tiers: pool.tiers,
        sessionId,
        sessionSticky: sessionId ? getSessionSticky(pool, sessionId) : null,
        lastUsed: pool.state.lastUsed,
      });
    }
    // Fail closed: when this request is managed by a model pool that has local
    // token budgets, an exhausted candidate may not be dispatched and the
    // original credential must never be used as a bypass. Decided once, before
    // the loop, so it cannot be re-evaluated mid-iteration.
    const quotaManaged = hasModelQuotaConfig(pool) && isQuotaManagedRequest(runtime.index, ref, requested);
    let start = strategy === 'round-robin' ? (pool.state.pointer ?? 0) : 0;
    if (strategy === 'sticky') {
      let preferred = null;
      if (sessionId) {
        const stick = getSessionSticky(pool, sessionId);
        if (stick && list.includes(stick)) preferred = stick;
      }
      if (!preferred && pool.state.lastUsed && list.includes(pool.state.lastUsed)) {
        preferred = pool.state.lastUsed;
      }
      const lastIdx = preferred ? list.indexOf(preferred) : -1;
      start = lastIdx >= 0 ? lastIdx : (pool.state.pointer ?? 0);
    }
    if (pool.pinnedRef && list.includes(pool.pinnedRef)) {
      const pIdx = list.indexOf(pool.pinnedRef);
      if (pIdx > 0) {
        list = list.slice();
        list.splice(pIdx, 1);
        list.unshift(pool.pinnedRef);
      }
      start = 0;
    }

    for (let i = 0; i < list.length; i++) {
      const index = (start + i) % list.length;
      const candidate = list[index];
      if (isKeyRevoked(pool, candidate)) continue;
      if (isKeyPaused(pool, candidate)) continue;
      if (isKeyBroken(pool, candidate, at)) continue;
      const until = pool.state.failedUntil.get(candidate);
      if (until !== undefined && until > at) continue;
      const candidateExp = pool.expiresAt?.[candidate] ?? pool.basePool?.expiresAt?.[candidate];
      if (candidateExp !== undefined && at >= candidateExp) continue;
      // Issue #500: skip candidate if modelCapabilities is known and does not include requested model
      if (model && pool.state.modelCapabilities) {
        const caps = pool.state.modelCapabilities.get(candidate);
        if (caps && caps.size > 0 && !caps.has(model)) continue;
      }
      // Local model token budget: a spent credential is simply not a candidate.
      if (quotaManaged && !isModelQuotaAvailable(pool, candidate, at)) continue;
      const microThrottling = pool.microThrottling ?? runtime.microThrottling ?? false;
      const microThrottleMaxMs = pool.microThrottleMaxMs ?? runtime.microThrottleMaxMs ?? 1000;

      const rpmLimit = pool.rpmLimit ?? 0;
      if (rpmLimit > 0) {
        if (!pool.state.rpmWindows) pool.state.rpmWindows = new Map();
        if (!bucketAllow(pool.state.rpmWindows, candidate, rpmLimit, at)) {
          const waitMs = bucketRetryMs(pool.state.rpmWindows, candidate, rpmLimit, at);
          if (microThrottling && waitMs > 0 && waitMs <= microThrottleMaxMs) {
            await new Promise((r) => setTimeout(r, waitMs));
            // re-check after micro-sleep
            if (!bucketAllow(pool.state.rpmWindows, candidate, rpmLimit, now())) {
              continue;
            }
          } else {
            if ((pool.state.failedUntil.get(candidate) ?? 0) < at + waitMs) {
              pool.state.failedUntil.set(candidate, at + waitMs);
            }
            continue;
          }
        }
      }
      const tpmLimit = pool.tpmLimit ?? 0;
      if (tpmLimit > 0) {
        if (!pool.state.tpmWindows) pool.state.tpmWindows = new Map();
        if (!tpmAllow(pool.state.tpmWindows, candidate, tpmLimit, at)) {
          const waitMs = tpmRetryMs(pool.state.tpmWindows, candidate, tpmLimit, at);
          if (microThrottling && waitMs > 0 && waitMs <= microThrottleMaxMs) {
            await new Promise((r) => setTimeout(r, waitMs));
            if (!tpmAllow(pool.state.tpmWindows, candidate, tpmLimit, now())) {
              continue;
            }
          } else {
            if ((pool.state.failedUntil.get(candidate) ?? 0) < at + waitMs) {
              pool.state.failedUntil.set(candidate, at + waitMs);
            }
            continue;
          }
        }
      }
      if (pool.perHour) {
        if (!pool.state.quotaWindows) pool.state.quotaWindows = new Map();
        let win = pool.state.quotaWindows.get(candidate);
        if (!win || at - win.start >= 3600000) win = { count: 0, start: at };
        if (win.count >= pool.perHour) {
          const resetAt = win.start + 3600000;
          if ((pool.state.failedUntil.get(candidate) ?? 0) < resetAt) pool.state.failedUntil.set(candidate, resetAt);
          continue;
        }
      }

      // Concurrency limit per-key check (#407):
      const concurrencyLimit = pool.concurrencyLimit ?? runtime.concurrencyLimit ?? 0;
      if (concurrencyLimit > 0 && concurrencyTracker && typeof concurrencyTracker.getActive === 'function') {
        if (concurrencyTracker.getActive(candidate, at) >= concurrencyLimit) {
          continue;
        }
      }

      // Atomically acquire concurrency permit upon candidate selection (#407):
      let acquired = false;
      if (concurrencyTracker && typeof concurrencyTracker.acquire === 'function') {
        const ok = concurrencyTracker.acquire(candidate, at, concurrencyLimit);
        if (!ok) continue;
        acquired = true;
      }

      // Advance the shared cursor at selection time: concurrent requests must
      // not all pick the same slot.
      if (strategy === 'sticky') {
        pool.state.pointer = index;
      } else {
        pool.state.pointer = (index + 1) % list.length;
      }
      try {
        const hit = await original(candidate);
        if (hit && typeof hit.value === 'string' && hit.value.length > 0) {
          settle(pool, candidate, at, onPicked, acquired ? candidate : undefined, sessionId);
          return { ...hit, value: decryptSecret(hit.value) };
        }
        // No stored credential: fall back to the launching environment, which is
        // how env-bootstrapped pools work (issue #7).
        const envVal = envValue(candidate);
        if (envVal !== undefined) {
          settle(pool, candidate, at, onPicked, acquired ? candidate : undefined, sessionId);
          return { value: decryptSecret(envVal), source: 'env' };
        }
      } catch (err) {
        if (acquired && typeof concurrencyTracker.release === 'function') {
          concurrencyTracker.release(candidate, at);
        }
        throw err;
      }
      if (acquired && typeof concurrencyTracker.release === 'function') {
        concurrencyTracker.release(candidate, at);
      }
    }

    // Every candidate was skipped. If the reason was local budget exhaustion,
    // returning original(ref) would hand out a credential the budget forbids, so
    // refuse instead of bypassing the quota. rotate() recognises this error as a
    // local refusal: it is not penalised and not classified as an upstream failure.
    if (quotaManaged && !anyModelQuotaAvailable(pool, at)) {
      throw Object.assign(
        new Error(formatModelQuotaExhaustion(pool.provider ?? providerOfBase(pool.base), pool)),
        { code: LOCAL_QUOTA_CODE, localQuota: true },
      );
    }
    throw Object.assign(
      new Error(`dsh-key-rotation: all credentials in pool "${pool.base ?? pool.provider}" are currently blocked, paused, expired, or exhausted`),
      { code: LOCAL_POOL_EXHAUSTED_CODE, localExhausted: true },
    );
  };
}

/** Record a successful credential selection on the pool and request scope. */
function settle(pool, candidate, now, onPicked, concurrencyRef, sessionId) {
  pool.state.lastUsed = candidate;
  if (sessionId) setSessionSticky(pool, sessionId, candidate);
  if (!pool.state.lastUsedAt) pool.state.lastUsedAt = new Map();
  pool.state.lastUsedAt.set(candidate, now);
  onPicked?.(pool, candidate, { concurrencyRef });
  if (!pool.state.usageCounts) pool.state.usageCounts = new Map();
  pool.state.usageCounts.set(candidate, (pool.state.usageCounts.get(candidate) ?? 0) + 1);
  if (pool.perHour) {
    if (!pool.state.quotaWindows) pool.state.quotaWindows = new Map();
    let win = pool.state.quotaWindows.get(candidate);
    if (!win || now - win.start >= 3600000) win = { count: 0, start: now };
    win.count++;
    pool.state.quotaWindows.set(candidate, win);
  }
}

/**
 * Resolves credential secret directly without requiring monkey-patching (#526).
 * Reads from credentials service safely or falls back to environment variables.
 * @param {string} candidateRef
 * @param {object} [ctx]
 * @returns {Promise<string|null>}
 */
export async function resolveKeyDirectly(candidateRef, ctx) {
  if (!candidateRef || typeof candidateRef !== 'string') return null;
  try {
    const creds = ctx?.get?.('credentials') ?? ctx?.credentials;
    if (creds) {
      if (typeof creds.get === 'function') {
        const val = await creds.get(candidateRef);
        if (val) return decryptSecret(typeof val === 'object' ? val.value : val);
      }
      if (typeof creds.resolve === 'function') {
        const orig = creds.__dshKeyRotationOriginalResolve ?? creds.resolve;
        const hit = await orig.call(creds, candidateRef);
        if (hit && typeof hit.value === 'string' && hit.value.length > 0) {
          return decryptSecret(hit.value);
        }
      }
    }
  } catch {
    /* credentials miss or access error falls through to env */
  }

  const envVal = envValue(candidateRef);
  if (envVal !== undefined && typeof envVal === 'string' && envVal.length > 0) {
    return decryptSecret(envVal);
  }

  return null;
}

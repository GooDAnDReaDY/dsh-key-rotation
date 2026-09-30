// lib/resolver.js — the credential selector behind credentials.resolve (#381).
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
import { envValue, sortAttemptList, isKeyPaused, isKeyRevoked } from './pool.js';
import { decryptSecret } from './crypto-storage.js';
import { resolveRefPool, isQuotaManagedRequest } from './pool-index.js';
import {
  isModelQuotaAvailable,
  hasModelQuotaConfig,
  anyModelQuotaAvailable,
  formatModelQuotaExhaustion,
} from './model-quota.js';

/** Internal failure code for "local budgets forbid this dispatch". */
export const LOCAL_QUOTA_CODE = 'LOCAL_MODEL_QUOTA_EXHAUSTED';

/**
 * @param {object} deps
 * @param {() => object} deps.buildRuntime         current runtime snapshot
 * @param {() => object|undefined} deps.currentPool request-scoped pool (ALS)
 * @param {(pool: object, candidate: string) => void} [deps.onPicked] picked-ref hook
 * @param {object} [deps.latencyHistogram]
 * @param {object} [deps.concurrencyTracker]
 * @param {() => number} [deps.now] wall clock; injectable for tests
 * @returns {(ref: string, original: Function) => Promise<any>}
 */
export function createResolver({
  buildRuntime,
  currentPool,
  onPicked,
  latencyHistogram,
  concurrencyTracker,
  now = Date.now,
}) {
  return async function resolve(ref, original) {
    const runtime = buildRuntime();
    // A ref may belong to several model pools at once, so the request-scoped
    // pool that rotate() actually dispatched with decides ownership. A bare
    // resolve outside rotation falls back to the global lookup.
    const requested = currentPool ? currentPool() ?? null : null;
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
    const strategy = pool.routingStrategy ?? runtime.routingStrategy ?? 'round-robin';
    let list = pool.weightedRefs ?? pool.refs;
    if (strategy === 'lowest-latency' || strategy === 'least-loaded') {
      list = sortAttemptList(list, strategy, { latencyHistogram, concurrencyTracker, weights: pool.weightsMap });
    }
    // Fail closed: when this request is managed by a model pool that has local
    // token budgets, an exhausted candidate may not be dispatched and the
    // original credential must never be used as a bypass. Decided once, before
    // the loop, so it cannot be re-evaluated mid-iteration.
    const quotaManaged = hasModelQuotaConfig(pool) && isQuotaManagedRequest(runtime.index, ref, requested);
    const start = strategy === 'round-robin' ? (pool.state.pointer ?? 0) : 0;

    for (let i = 0; i < list.length; i++) {
      const index = (start + i) % list.length;
      const candidate = list[index];
      if (isKeyRevoked(pool, candidate)) continue;
      if (isKeyPaused(pool, candidate)) continue;
      const until = pool.state.failedUntil.get(candidate);
      if (until !== undefined && until > at) continue;
      if (pool.expiresAt?.[candidate] !== undefined && at >= pool.expiresAt[candidate]) continue;
      // Local model token budget: a spent credential is simply not a candidate.
      // This is deliberately NOT recorded as a failure — the key is healthy and
      // merely out of budget — so it must never touch failedUntil / failCounts /
      // authFailCounts / brokenUntil.
      if (quotaManaged && !isModelQuotaAvailable(pool, candidate, at)) continue;
      const rpmLimit = pool.rpmLimit ?? 0;
      if (rpmLimit > 0) {
        if (!pool.state.rpmWindows) pool.state.rpmWindows = new Map();
        if (!bucketAllow(pool.state.rpmWindows, candidate, rpmLimit, at)) {
          const waitMs = bucketRetryMs(pool.state.rpmWindows, candidate, rpmLimit, at);
          if ((pool.state.failedUntil.get(candidate) ?? 0) < at + waitMs) {
            pool.state.failedUntil.set(candidate, at + waitMs);
          }
          continue;
        }
      }
      const tpmLimit = pool.tpmLimit ?? 0;
      if (tpmLimit > 0) {
        if (!pool.state.tpmWindows) pool.state.tpmWindows = new Map();
        if (!tpmAllow(pool.state.tpmWindows, candidate, tpmLimit, at)) {
          const waitMs = tpmRetryMs(pool.state.tpmWindows, candidate, tpmLimit, at);
          if ((pool.state.failedUntil.get(candidate) ?? 0) < at + waitMs) {
            pool.state.failedUntil.set(candidate, at + waitMs);
          }
          continue;
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

      // Advance the shared cursor at selection time: concurrent requests must
      // not all pick the same slot.
      pool.state.pointer = (index + 1) % list.length;
      const hit = await original(candidate);
      if (hit && typeof hit.value === 'string' && hit.value.length > 0) {
        settle(pool, candidate, at, onPicked);
        return { ...hit, value: decryptSecret(hit.value) };
      }
      // No stored credential: fall back to the launching environment, which is
      // how env-bootstrapped pools work (issue #7).
      const envVal = envValue(candidate);
      if (envVal !== undefined) {
        settle(pool, candidate, at, onPicked);
        return { value: decryptSecret(envVal), source: 'env' };
      }
    }

    // Every candidate was skipped. If the reason was local budget exhaustion,
    // returning original(ref) would hand out a credential the budget forbids, so
    // refuse instead of bypassing the quota. rotate() recognises this error as a
    // local refusal: it is not penalised and not classified as an upstream failure.
    if (quotaManaged && !anyModelQuotaAvailable(pool, at)) {
      throw Object.assign(
        new Error(formatModelQuotaExhaustion(pool.provider ?? pool.base, pool)),
        { code: LOCAL_QUOTA_CODE, localQuota: true },
      );
    }
    return original(ref);
  };
}

/** Record a successful credential selection on the pool and request scope. */
function settle(pool, candidate, now, onPicked) {
  pool.state.lastUsed = candidate;
  if (!pool.state.lastUsedAt) pool.state.lastUsedAt = new Map();
  pool.state.lastUsedAt.set(candidate, now);
  onPicked?.(pool, candidate);
  pool.state.failCounts?.delete(candidate);
  pool.state.failedUntil.delete(candidate);
  pool.state.authFailCounts?.delete(candidate);
  pool.state.brokenUntil?.delete(candidate);
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

// lib/rotate-penalty.js — Key penalty, backoff, dynamic headers, and failure tracking (#526).
import { classifyFailure } from './error-taxonomy.js';
import {
  recordFailure,
  parseRetryAfter,
  isKeyPaused,
  isKeyRevoked,
  isKeyBroken,
  clearSessionSticky,
  unstickFailedKey,
} from './pool.js';
import { extractProviderLimits } from './provider-limits-detector.js';
import { poolResetAt } from './quota-window.js';

export const LOCAL_QUOTA_CODE = 'LOCAL_MODEL_QUOTA_EXHAUSTED';

/**
 * Penalize a key upon error or upstream failure during rotation.
 */
export function penalizeKey(targetRef, errCode, errMsg, rawHeaders, {
  pool,
  options,
  sessionId,
  runtime0,
  cooldownMs,
  maxCooldownMs,
  now,
  activePermit,
  trace,
  pushEvent,
  schedulePersist,
  effectiveNotifyEarlyWarning,
  logWarn,
  buildRuntime,
}) {
  if (!targetRef) return;
  if (sessionId) clearSessionSticky(pool, sessionId);
  unstickFailedKey(pool, targetRef);
  if (errCode === LOCAL_QUOTA_CODE) return;

  let headerResetMs = null;
  if (rawHeaders) {
    const limits = (typeof rawHeaders === 'object' && rawHeaders.rpmResetMs !== undefined)
      ? rawHeaders
      : extractProviderLimits(rawHeaders);
    headerResetMs = limits?.retryAfterMs ?? limits?.rpmResetMs ?? null;
  }
  if (!headerResetMs) {
    const pRetry = parseRetryAfter(errMsg);
    if (pRetry) headerResetMs = pRetry;
  }

  const _base = pool.cooldownMs ?? cooldownMs;
  const _max = pool.maxCooldownMs ?? maxCooldownMs ?? 3600000;
  let _b = 0;
  const cls = classifyFailure({ status: Number(errCode) || 0, code: errCode, message: errMsg });

  if (headerResetMs && headerResetMs > 0) {
    const dynamicCooldownMs = Math.min(_max, Math.max(1000, Math.floor(headerResetMs) + 250));
    pool.state.failedUntil.set(targetRef, now() + dynamicCooldownMs);
    if (!pool.state.resetReasons) pool.state.resetReasons = new Map();
    pool.state.resetReasons.set(targetRef, 'header');
    if (!pool.state.headerResetTimes) pool.state.headerResetTimes = new Map();
    pool.state.headerResetTimes.set(targetRef, dynamicCooldownMs);
    _b = dynamicCooldownMs;
    pushEvent(pool, targetRef, 'HEADER_RESET', dynamicCooldownMs);
    if (logWarn) logWarn(`[dsh-key-rotation] ${options.provider}: key ${targetRef} dynamic cooldown set to ${dynamicCooldownMs}ms via upstream headers`);

    const recTimer = setTimeout(() => {
      if ((pool.state.failedUntil?.get?.(targetRef) ?? 0) <= now()) {
        pool.state.failedUntil.delete(targetRef);
        pushEvent(pool, targetRef, 'DYNAMIC_UNBREAK', 0);
      }
    }, dynamicCooldownMs + 50);
    if (typeof recTimer.unref === 'function') recTimer.unref();
  } else {
    const _effBase = _base;
    _b = recordFailure(pool, targetRef, now(), _effBase, _max, cls.soft, true);
    if (!pool.state.resetReasons) pool.state.resetReasons = new Map();
    pool.state.resetReasons.set(targetRef, 'backoff');
  }

  // #337 & #486 (GitHub #24): connect quota-window calendar reset for quota exhaustion
  // Transient rate limiting (RPM/TPM, requests/tokens per minute, concurrency)
  // must NOT be locked until midnight. Keep those on ordinary cooldowns.
  const isRateThrottling = /\b(?:rpm|tpm|requests?\s+per\s+minute|tokens?\s+per\s+minute|per[-_\s]*minute|per[-_\s]*second|concurrency|requests?\s+limit|tokens?\s+limit|traffic)\b/i.test(errMsg) ||
    (/\b(?:rate[-_\s]*limit)\b/i.test(errMsg) && !/\b(?:insufficient[_\s-]+quota|exceeded\s+(?:your\s+)?(?:current\s+)?quota|credit\s+balance|billing)\b/i.test(errMsg));

  const isQuota = !isRateThrottling && (
    (errCode === 'QUOTA' && !/\b(?:rpm|tpm|rate|traffic|throttle)\b/i.test(errMsg)) ||
    /\b(?:quota(?:\s+is)?\s+(?:exhausted|exceeded)|exceeded\s+(?:your\s+)?(?:current\s+)?quota|insufficient[_\s-]+quota|credit\s+balance|billing\s+quota|out\s+of\s+credits?)\b/i.test(errMsg)
  );
  const qWindow = pool.quotaResetWindow ?? runtime0.quotaResetWindow;
  if (isQuota && qWindow) {
    const quotaResetAt = poolResetAt(pool, qWindow, now());
    if (quotaResetAt && quotaResetAt > now()) {
      if (!pool.state.quotaWindows) pool.state.quotaWindows = new Map();
      pool.state.quotaWindows.set(targetRef, quotaResetAt);
      pool.state.failedUntil.set(targetRef, quotaResetAt);
    }
  }

  activePermit?.failure();
  trace.addStep(targetRef, 'FAILED', errCode ?? 'UNKNOWN', errMsg);
  pushEvent(pool, targetRef, errCode ?? 'UNKNOWN', _b);
  if (typeof schedulePersist === 'function') {
    try { schedulePersist(); } catch (_) { /* best-effort persistence */ }
  }
  if (runtime0.earlyWarningNotify && effectiveNotifyEarlyWarning) {
    const total = pool.refs?.length || 1;
    let available = 0;
    const at = now();
    for (const r of (pool.refs || [])) {
      if (!isKeyRevoked(pool, r) && !isKeyPaused(pool, r) && !isKeyBroken(pool, r, at) && ((pool.state?.failedUntil?.get(r) ?? 0) <= at)) {
        available++;
      }
    }
    const threshold = Number.isFinite(runtime0.earlyWarningKeyThreshold) ? runtime0.earlyWarningKeyThreshold : 0.25;
    if (total > 0 && (available / total) <= threshold) {
      effectiveNotifyEarlyWarning(runtime0, pool, {
        provider: options.provider,
        availableCount: available,
        totalCount: total,
      });
    }
  }
  if (!pool.state.authFailCounts) pool.state.authFailCounts = new Map();
  if (!pool.state.brokenUntil) pool.state.brokenUntil = new Map();
  const _cStr = String(errCode ?? '').toUpperCase();
  const _isAuth = cls.reason === 'auth' || cls.code === '401' || cls.code === '403' ||
    _cStr === 'AUTH' || _cStr === '401' || _cStr === '403' ||
    _cStr === 'PERMISSION_DENIED' || _cStr === 'UNAUTHENTICATED' ||
    /auth|unauthorized|invalid[_\s-]?api[_\s-]?key|unauthenticated|permission[_\s-]?denied/i.test(errMsg);

  if (_isAuth) {
    const _c2 = (pool.state.authFailCounts.get(targetRef) ?? 0) + 1;
    pool.state.authFailCounts.set(targetRef, _c2);
    if (!pool.state.revokedRefs) pool.state.revokedRefs = new Set();
    pool.state.revokedRefs.add(targetRef);
    if (!pool.state.pausedRefs) pool.state.pausedRefs = new Set();
    if (pool.state.pausedRefs instanceof Set) pool.state.pausedRefs.add(targetRef);
    else if (Array.isArray(pool.state.pausedRefs) && !pool.state.pausedRefs.includes(targetRef)) pool.state.pausedRefs.push(targetRef);
    if (!pool.state.pauseReasons) pool.state.pauseReasons = new Map();
    pool.state.pauseReasons.set(targetRef, 'AUTH_FAILURE_PAUSED');
    pool.state.failedUntil.set(targetRef, Infinity);
    pushEvent(pool, targetRef, 'KEY_AUTH_PAUSED', 0);
    if (logWarn) logWarn(`[dsh-key-rotation] ${options.provider}: key ${targetRef} permanently PAUSED on auth failure (${errCode})`);
    // Fan-out permanent pause across all pools sharing this physical ref (#408):
    if (typeof buildRuntime === 'function') {
      const rAll = buildRuntime();
      const candidatePools = [
        ...(Array.isArray(rAll.pools) ? rAll.pools : []),
        ...(rAll.index?.allPools ? rAll.index.allPools.values() : []),
        ...(rAll.providerToPool ? rAll.providerToPool.values() : []),
      ];
      if (rAll.modelPoolByProvider) {
        for (const map of rAll.modelPoolByProvider.values()) { if (map) candidatePools.push(...map.values()); }
      }
      const seenPools = new Set();
      for (const other of candidatePools) {
        if (!other || seenPools.has(other)) continue;
        seenPools.add(other);
        if (other === pool) continue;
        const hasRef = (Array.isArray(other.refs) && other.refs.includes(targetRef)) ||
          (other.weightsMap instanceof Map && other.weightsMap.has(targetRef));
        if (hasRef && other.state) {
          if (!other.state.revokedRefs) other.state.revokedRefs = new Set();
          other.state.revokedRefs.add(targetRef);
          if (!other.state.pausedRefs) other.state.pausedRefs = new Set();
          if (other.state.pausedRefs instanceof Set) other.state.pausedRefs.add(targetRef);
          else if (Array.isArray(other.state.pausedRefs) && !other.state.pausedRefs.includes(targetRef)) other.state.pausedRefs.push(targetRef);
          if (!other.state.pauseReasons) other.state.pauseReasons = new Map();
          other.state.pauseReasons.set(targetRef, 'AUTH_FAILURE_PAUSED');
          if (other.state.failedUntil) other.state.failedUntil.set(targetRef, Infinity);
          pushEvent(other, targetRef, 'KEY_AUTH_PAUSED', 0);
        }
      }
    }
  } else {
    pool.state.authFailCounts.delete(targetRef);
    // Soft/transient errors (TIMEOUT, 5xx, socket) do not count toward quarantine (#473).
    // recordFailure already maintains pool.state.failCounts accurately for non-soft failures.
    if (!isQuota && !cls.soft) {
      const _fc = pool.state.failCounts.get(targetRef) ?? 0;
      if (_fc >= 3 && !pool.state.brokenUntil.has(targetRef)) {
        const quarantineMs = 1800000;
        pool.state.brokenUntil.set(targetRef, Date.now() + quarantineMs);
        pushEvent(pool, targetRef, 'KEY_QUARANTINED', quarantineMs);
        if (logWarn) logWarn(`[dsh-key-rotation] ${options.provider}: key ${targetRef} put in recoverable quarantine after ${_fc} failures`);
      }
    }
  }
}

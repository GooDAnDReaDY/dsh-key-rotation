// lib/stream-metrics.js — streaming success telemetry, usage, cost and token recording (#512).
// Extracted from lib/rotate.js to enforce < 600 line modularity standard.

import { recordSuccess, setSessionSticky, recordFailure, extractRateLimit, isRateLimited } from './pool.js';
import { recordPromptCache } from './prompt-cache.js';
import { recordRequestOutcome } from './ops-analytics.js';
import { tpmRecord } from './bucket.js';
import { extractUsageTokens, consumeModelTokens } from './model-quota.js';
import { extractProviderLimits } from './provider-limits-detector.js';

export async function* preserveDispatchContext(iterable, storage, store) {
  if (!storage || typeof storage.getStore !== 'function') {
    yield* iterable;
    return;
  }
  const iterator = iterable[Symbol.asyncIterator]();
  const step = (method, arg) => storage.run(store, () => iterator[method](arg));
  try {
    while (true) {
      const next = await step('next');
      if (next.done) return next.value;
      yield next.value;
    }
  } finally {
    if (typeof iterator.return === 'function') await step('return');
  }
}

/**
 * Records success metrics, token windows, local model quota, limits and proactive pause on finished stream chunk.
 * @param {object} pool
 * @param {string} activeRef
 * @param {object} options request options (provider, model, etc.)
 * @param {object} chunk final streaming chunk with usage/metadata
 * @param {object} deps helpers and runtime configuration
 */
export function recordStreamSuccessMetrics(pool, activeRef, options, chunk, deps) {
  if (!activeRef || !pool?.state) return;

  const {
    now,
    sessionId,
    attempt,
    runtime0,
    quotaManaged,
    schedulePersist,
    logWarn,
    rawHdrs,
    pushEvent,
    quotaStore,
  } = deps;

  const nowMs = typeof now === 'function' ? now() : Date.now();
  const wallNow = Date.now();

  // 1. Record success for active key and session sticky
  recordSuccess(pool, activeRef, nowMs);
  if (sessionId) setSessionSticky(pool, sessionId, activeRef);

  // 2. Prompt cache and analytics outcome
  const usagePayload = chunk?.usage ?? chunk?.metadata?.usage;
  recordPromptCache(pool, activeRef, options.model, usagePayload, wallNow);
  recordRequestOutcome(pool, {
    ref: activeRef,
    success: true,
    attempts: attempt + 1,
    failovers: attempt,
    cascaded: Boolean(options.__isCascade),
  }, wallNow);

  // 3. TPM sliding window bucket recording
  const usedTokens = extractUsageTokens(usagePayload);
  if (usedTokens && usedTokens > 0) {
    if (!pool.state.tpmWindows) pool.state.tpmWindows = new Map();
    tpmRecord(pool.state.tpmWindows, activeRef, usedTokens, wallNow);
  }

  // 4. Local model quota consumption
  if (quotaManaged) {
    const charged = consumeModelTokens(
      pool, activeRef, usedTokens,
      runtime0.quotaResetWindow, wallNow,
    );
    if (charged) {
      if (typeof schedulePersist === 'function') {
        try { schedulePersist(); } catch (_) { /* best-effort persistence */ }
      }
      if (charged.exhausted && typeof logWarn === 'function') {
        logWarn(`[dsh-key-rotation] ${options.provider}/${options.model ?? '-'}: key ${activeRef} reached its local token budget (${charged.used}/${charged.limit}) — excluded from this model only`);
      }
    }
  }

  // 5. Provider rate limit headers detection (#503)
  if (rawHdrs) {
    const detected = extractProviderLimits(rawHdrs);
    if (detected) {
      if (!pool.state.detectedLimits) pool.state.detectedLimits = new Map();
      pool.state.detectedLimits.set(activeRef, { ...detected, at: nowMs });
    }
  }

  // 6. Proactive rate-limit guard (#115, #303)
  const guardEnabled = pool.proactiveRateLimitGuard ?? runtime0.proactiveRateLimitGuard ?? true;
  const rate = extractRateLimit(chunk?.metadata?.headers ?? chunk?.headers);
  if (guardEnabled && rate) {
    if (isRateLimited(rate, runtime0.rateLimitThreshold ?? 0.1)) {
      let cool;
      if (typeof rate.retryAfter === 'number' && rate.retryAfter > 0) {
        cool = rate.retryAfter * 1000;
      } else if (rate.reset && rate.reset > nowMs) {
        cool = rate.reset - nowMs;
      } else if (rate.reset && rate.reset > 0 && rate.reset < 86400) {
        cool = Math.round(rate.reset * 1000);
      } else {
        cool = pool.cooldownMs ?? runtime0.cooldownMs;
      }
      const maxCool = pool.maxCooldownMs ?? runtime0.maxCooldownMs;
      const effCool = Math.min(cool, maxCool ?? cool);
      recordFailure(pool, activeRef, nowMs, effCool, maxCool);
      pool.state.proactiveSwitches = (pool.state.proactiveSwitches ?? 0) + 1;
      if (typeof pushEvent === 'function') pushEvent(pool, activeRef, 'RATE_LIMIT', effCool);
      if (typeof logWarn === 'function') {
        logWarn(`[dsh-key-rotation] ${options.provider}: key ${activeRef} proactive pause (remaining ${String(rate.remaining ?? '?')}/${String(rate.limit ?? '?')}, cool ${Math.round(effCool / 1000)}s) — next request will rotate`);
      }
    }
  }

  // 7. Persist quota snapshot
  if (rate && Number.isFinite(rate.remaining) && quotaStore) {
    quotaStore.set(activeRef, { remaining: rate.remaining, limit: rate.limit, reset: rate.reset, at: nowMs });
  }
}
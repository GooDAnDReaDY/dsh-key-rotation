// lib/rotate.js — stream rotation / failover generator (#253).
// Pure wiring helper: dependencies are injected so unit tests can supply mocks.
import { nowMono } from './clock.js';
import { classifyFailure } from './error-taxonomy.js';
import {
  isSwitchableError,
  recordFailure,
  recordSuccess,
  parseRetryAfter,
  extractRateLimit,
  isRateLimited,
  isKeyPaused,
  isKeyRevoked,
  isKeyBroken,
  formatExhaustionMessage,
  sortAttemptList,
  getSessionSticky,
  setSessionSticky,
  clearSessionSticky,
} from './pool.js';
import { pickCascadeFallback, CASCADE_MAX_DEPTH } from './cascade.js';
import { createRequestBudget, BUDGET_EXHAUSTED_TIMEOUT, BUDGET_EXHAUSTED_ATTEMPTS } from './request-budget.js';
import { createSelectionTrace } from './selection-trace.js';
import { isKeyDraining } from './key-drain.js';
import { notifyEarlyWarning as defaultNotifyEarlyWarning } from './notify-events.js';
import { nextQuotaReset, poolResetAt } from './quota-window.js';
import { tpmRecord } from './bucket.js';
import {
  isModelQuotaAvailable,
  hasModelQuotaConfig,
  anyModelQuotaAvailable,
  consumeModelTokens,
  extractUsageTokens,
  formatModelQuotaExhaustion,
} from './model-quota.js';

import { LOCAL_POOL_EXHAUSTED_CODE } from './resolver.js';
import { extractProviderLimits } from './provider-limits-detector.js';

export const LOCAL_QUOTA_CODE = 'LOCAL_MODEL_QUOTA_EXHAUSTED';

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
 * Create the rotate(options, pool) async generator used by llm/stream.
 * @param {object} deps
 */
export function createRotate(deps) {
  const {
    ctx,
    dispatchStorage,
    buildRuntime,
    pushEvent,
    notifySwitch,
    notifyExhaustion,
    notifyEarlyWarning,
    recordLatency,
    latencyHistogram,
    concurrencyTracker,
    MARKER,
    finishError,
    setRotateStartMs,
    quotaStore,
    circuitBreaker,
    logger,
    schedulePersist,
    trafficSmoother,
    now = nowMono,
  } = deps;

  const effectiveNotifyEarlyWarning = notifyEarlyWarning ?? defaultNotifyEarlyWarning;
  const logWarn = (msg) => (logger?.warn ? logger.warn(msg) : null);

  function rotate(options, pool) {
    return (async function* () {
      const runtime0 = buildRuntime();
      // #464: Per-request budget (deadline and max attempts) shared across rotation and cascade
      const existingBudget = options.__requestBudget;
      const budget = existingBudget || createRequestBudget({
        maxDurationMs: options.maxDurationMs ?? pool.maxDurationMs ?? runtime0.maxDurationMs ?? 0,
        maxAttempts: options.maxAttempts ?? pool.maxAttempts ?? runtime0.maxAttempts ?? 0,
        signal: options.signal,
      });
      const isBudgetOwner = !existingBudget;

      // #461: Track key selection and failover explanation
      const trace = options.__selectionTrace || createSelectionTrace(options.requestId, {
        provider: options.provider,
        model: options.model,
      });
      const isTraceOwner = !options.__selectionTrace;
      const { switchCodes, cooldownMs, maxCooldownMs, switchNotify, rateLimitThreshold } = runtime0;
      let lastFailure = null;
      const breaker = runtime0.circuitBreakerEnabled === false ? null : circuitBreaker;
      let activePermit = null;
      const sessionId = options?.sessionId ?? options?.session ?? options?.metadata?.sessionId ?? options?.chatId ?? options?.conversationId;
      const reqStore = { pool, pickedRef: undefined, concurrencyRef: undefined, startMs: now(), sessionId, model: options.model };
      setRotateStartMs(reqStore.startMs);
      const wallNow = Date.now();
      const quotaManaged = hasModelQuotaConfig(pool);
      let attemptList = (pool.weightedRefs ?? pool.refs).slice();
      attemptList = attemptList.filter((r) => !isKeyPaused(pool, r) && !isKeyRevoked(pool, r) && !isKeyBroken(pool, r, wallNow) && !isKeyDraining(r));
      // Issue #500: filter candidate keys by confirmed model capabilities
      if (options.model && pool.state.modelCapabilities) {
        attemptList = attemptList.filter((ref) => {
          const caps = pool.state.modelCapabilities.get(ref);
          return !caps || caps.size === 0 || caps.has(options.model);
        });
      }
      if (pool.pinnedRef && attemptList.includes(pool.pinnedRef)) {
        const pIdx = attemptList.indexOf(pool.pinnedRef);
        if (pIdx > 0) {
          attemptList.splice(pIdx, 1);
          attemptList.unshift(pool.pinnedRef);
        }
      }
      if (quotaManaged) {
        attemptList = attemptList.filter((ref) => isModelQuotaAvailable(pool, ref, wallNow));
        if (attemptList.length === 0) {
          pool.state.lastExhaustionAt = now();
          pool.state.exhaustionCount = (pool.state.exhaustionCount ?? 0) + 1;
          logWarn(`[dsh-key-rotation] ${options.provider}/${options.model ?? '-'}: local model token budget exhausted for all ${pool.refs.length} key(s) — no upstream request sent`);
          const runtimeQ = buildRuntime();
          notifyExhaustion(runtimeQ, pool, { provider: options.provider });
          const maxDepth = runtimeQ.cascadeMaxDepth ?? CASCADE_MAX_DEPTH;
          const currentDepth = options.__cascadeDepth ?? (options.__isCascade ? 1 : 0);
          if (currentDepth < maxDepth && Array.isArray(runtimeQ.cascade) && runtimeQ.cascade.length > 0) {
            const fb = pickCascadeFallback(options.provider, runtimeQ, runtimeQ.providerToPool, options.model, runtimeQ.modelPoolByProvider);
            if (fb && fb.pool && fb.pool !== pool) {
              pool.state.lastReason = 'CASCADE';
              pool.state.lastSwitchAt = now();
              pool.state.cascadeCount = (pool.state.cascadeCount ?? 0) + 1;
              pushEvent(pool, reqStore.pickedRef ?? 'pool', 'CASCADE_TRIGGERED', 0);
              const innerCascade = rotate({
                ...options,
                provider: fb.provider,
                model: fb.model || options.model,
                __isCascade: true,
                __cascadeDepth: currentDepth + 1,
                __requestBudget: budget,
                __selectionTrace: trace,
              }, fb.pool);
              for await (const chunk of innerCascade) {
                yield chunk;
              }
              return;
            }
          }
          yield finishError(LOCAL_QUOTA_CODE, formatModelQuotaExhaustion(options.provider, pool));
          return;
        }
      }
      const strategy = pool.routingStrategy ?? runtime0.routingStrategy ?? 'round-robin';
      if (strategy !== 'round-robin') {
        attemptList = sortAttemptList(attemptList, strategy, {
          latencyHistogram,
          concurrencyTracker,
          weights: pool.weightsMap,
          tiers: pool.tiers,
          sessionId,
          sessionSticky: sessionId ? getSessionSticky(pool, sessionId) : null,
          lastUsed: pool.state.lastUsed,
        });
      }
      if (strategy !== 'least-loaded' && runtime0.concurrencyLimit > 0 && concurrencyTracker.isEnabled()) {
        // #193 / #365: prefer least-loaded key within limit with weights
        const available = attemptList.filter((r) => {
          if (isKeyPaused(pool, r)) return false;
          const fu = pool.state.failedUntil.get(r) ?? 0;
          if (fu > now()) return false;
          const exp = pool.expiresAt ? pool.expiresAt[r] : undefined;
          if (exp !== undefined && now() >= exp) return false;
          return true;
        });
        const preferred = concurrencyTracker.pickLeastLoaded(available, now(), pool.weightsMap);
        if (preferred && attemptList[0] !== preferred) {
          const list = attemptList.slice();
          const i = list.indexOf(preferred);
          if (i > 0) { list.splice(i, 1); list.unshift(preferred); }
          attemptList = list;
        }
      }

      const penalizeRef = (targetRef, errCode, errMsg, rawHeaders) => {
        if (!targetRef) return;
        if (sessionId) clearSessionSticky(pool, sessionId);
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
          logWarn(`[dsh-key-rotation] ${options.provider}: key ${targetRef} dynamic cooldown set to ${dynamicCooldownMs}ms via upstream headers`);

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
          logWarn(`[dsh-key-rotation] ${options.provider}: key ${targetRef} permanently PAUSED on auth failure (${errCode})`);
          // Fan-out permanent pause across all pools sharing this physical ref (#408):
          const rAll = buildRuntime();
          const candidatePools = [];
          if (Array.isArray(rAll.pools)) candidatePools.push(...rAll.pools);
          if (rAll.index?.allPools) candidatePools.push(...rAll.index.allPools.values());
          if (rAll.providerToPool) candidatePools.push(...rAll.providerToPool.values());
          if (rAll.modelPoolByProvider) {
            for (const map of rAll.modelPoolByProvider.values()) {
              if (map) candidatePools.push(...map.values());
            }
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
              logWarn(`[dsh-key-rotation] ${options.provider}: key ${targetRef} put in recoverable quarantine after ${_fc} failures`);
            }
          }
        }
      };

      for (let attempt = 0; attempt < attemptList.length; attempt++) {
        const candidateRef = attemptList[attempt];
        // #496: Traffic smoothing micro-queue
        const smoother = pool.trafficSmoother ?? runtime0.trafficSmoother ?? trafficSmoother;
        if (smoother && candidateRef) {
          const smoothRes = await smoother.acquire(candidateRef, {
            rpmLimit: pool.rpmLimit,
            burstLimit: pool.trafficSmoothingBurst,
            maxQueueWaitMs: pool.maxQueueWaitMs,
            signal: options.signal,
          });
          if (smoothRes.overflow) {
            logWarn(`[dsh-key-rotation] ${options.provider}: key ${candidateRef} micro-queue burst overflow (${smoothRes.delayMs}ms) — rotating to next candidate`);
            continue;
          }
          if (smoothRes.delayed) {
            pool.state.smoothedRequests = (pool.state.smoothedRequests ?? 0) + 1;
            pushEvent(pool, candidateRef, 'TRAFFIC_SMOOTHED', smoothRes.delayMs);
          }
        }
        // #464: Check deadline & attempt budget before dispatch
        if (!budget.canAttempt()) {
          const isTimeout = budget.isExpired();
          const code = isTimeout ? BUDGET_EXHAUSTED_TIMEOUT : BUDGET_EXHAUSTED_ATTEMPTS;
          const msg = isTimeout
            ? `[dsh-key-rotation] request deadline exceeded (${budget.maxDurationMs}ms)`
            : `[dsh-key-rotation] request attempt budget exceeded (${budget.maxAttempts} attempts)`;
          logWarn(msg);
          yield finishError(code, msg);
          if (isBudgetOwner) budget.dispose();
          return;
        }

        activePermit = breaker ? breaker.acquire(options.provider) : null;
        if (breaker && !activePermit) {
          logWarn(`[dsh-key-rotation] ${options.provider}: circuit open — trying cascade fallback`);
          const runtimeQ = buildRuntime();
          const maxDepth = runtimeQ.cascadeMaxDepth ?? CASCADE_MAX_DEPTH;
          const currentDepth = options.__cascadeDepth ?? (options.__isCascade ? 1 : 0);
          if (currentDepth < maxDepth && Array.isArray(runtimeQ.cascade) && runtimeQ.cascade.length > 0) {
            const fb = pickCascadeFallback(options.provider, runtimeQ, runtimeQ.providerToPool, options.model, runtimeQ.modelPoolByProvider, breaker);
            if (fb && fb.pool && fb.pool !== pool) {
              pool.state.lastReason = 'CASCADE';
              pool.state.lastSwitchAt = now();
              pool.state.cascadeCount = (pool.state.cascadeCount ?? 0) + 1;
              pushEvent(pool, reqStore.pickedRef ?? 'pool', 'CASCADE_TRIGGERED', 0);
              const innerCascade = rotate({
                ...options,
                provider: fb.provider,
                model: fb.model || options.model,
                __isCascade: true,
                __cascadeDepth: currentDepth + 1,
                __requestBudget: budget,
                __selectionTrace: trace,
              }, fb.pool);
              for await (const chunk of innerCascade) {
                yield chunk;
              }
              return;
            }
          }
          yield finishError('CIRCUIT_OPEN', `[dsh-key-rotation] provider '${options.provider}' circuit is open`);
          return;
        }
        try {
          let yielded = false;
          let switching = false;
          let inner;
          try {
            // #464 & #461: Record attempt & trace dispatch
            budget.recordAttempt();
            const curCandidate = reqStore.pickedRef ?? pool.state.lastUsed ?? attemptList[attempt];
            trace.addStep(curCandidate, 'DISPATCHED', 'ATTEMPT', `Attempt ${budget.getAttempts()}`);

            // mark the internal dispatch so the interceptor does not re-rotate
            inner = dispatchStorage.run(reqStore, () => {
              const llm = ctx.get('llm');
              if (!llm || typeof llm.stream !== 'function') {
                throw new Error('dsh-key-rotation: llm service unavailable');
              }
              return llm.stream({ ...options, [MARKER]: true, signal: budget.signal });
            });
          } catch (e) {
            if (e?.localQuota || e?.localExhausted || e?.code === LOCAL_QUOTA_CODE || e?.code === LOCAL_POOL_EXHAUSTED_CODE) {
              const code = e?.code ?? (e?.localQuota ? LOCAL_QUOTA_CODE : LOCAL_POOL_EXHAUSTED_CODE);
              lastFailure = finishError(code, String(e?.message ?? ''));
              logWarn(`[dsh-key-rotation] ${options.provider}/${options.model ?? '-'}: local rejection (${code}) — no upstream request sent`);
              break;
            }
            const curRef = reqStore.pickedRef ?? pool.state.lastUsed;
            penalizeRef(curRef, e?.code ?? 'TRANSPORT', String(e?.message ?? ''), e?.headers ?? e?.response?.headers ?? pool.state.detectedLimits?.get?.(curRef));
            lastFailure = finishError(e?.code ?? 'TRANSPORT',
              `dsh-key-rotation: dispatch failed: ${String(e?.message ?? e)}`);
            logWarn(`[dsh-key-rotation] ${options.provider}: key ${String(curRef ?? '?')} threw ${String(e?.code ?? e?.message ?? e)}`);
            continue;
          }

          const _pickedRef = reqStore.pickedRef ?? pool.state.lastUsed;
          try {
            for await (const chunk of preserveDispatchContext(inner, dispatchStorage, reqStore)) {
                if (!reqStore.concurrencyRef && typeof concurrencyTracker?.acquire === 'function') {
                  const fallbackRef = reqStore.pickedRef ?? _pickedRef;
                  if (fallbackRef) {
                    const ok = concurrencyTracker.acquire(fallbackRef, now(), pool.concurrencyLimit ?? runtime0.concurrencyLimit ?? 0);
                    if (ok) reqStore.concurrencyRef = fallbackRef;
                  }
                }
                // Only actual content deltas lock the stream (no more rotation).
                // Structural/metadata chunks (block-start/end, usage) do not.
                if (chunk && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta')) {
                  yielded = true;
                  yield chunk;
                  continue;
                }
                if (chunk && chunk.type === 'finish') {
                  const rawHdrs = chunk?.metadata?.headers ?? chunk?.headers ?? chunk?.reason?.failure?.headers;
                  const kind = chunk.reason?.kind;
                  const failure = chunk.reason?.failure;
                  const code = failure?.code;
                  const message = failure?.message ?? '';
                  const effectiveSwitchCodes = pool.switchCodes ?? switchCodes;
                  const switchable = !yielded && kind === 'error' && isSwitchableError(failure, effectiveSwitchCodes);
                  const activeRef = reqStore.pickedRef ?? pool.state.lastUsed;
                  if (switchable) {
                    penalizeRef(activeRef, code ?? 'UNKNOWN', message, rawHdrs ?? failure?.headers ?? pool.state.detectedLimits?.get?.(activeRef));
                    pool.state.switches = (pool.state.switches ?? 0) + 1;
                    pool.state.lastReason = String(code ?? 'UNKNOWN');
                    pool.state.lastSwitchAt = now();
                    lastFailure = chunk;
                    logWarn(`[dsh-key-rotation] ${options.provider}: key ${String(activeRef ?? '?')} failed (${String(code)} ${String(message).slice(0, 100)}) - next key`);
                    // #216: per-switch webhook (opt-in switchNotify), deduped per provider
                    if (switchNotify && activeRef) {
                      notifySwitch(runtime0, pool, {
                        provider: options.provider,
                        from: activeRef,
                        code: String(code ?? 'UNKNOWN'),
                        at: pool.state.lastSwitchAt,
                      });
                    }
                    switching = true;
                    break;
                  }
                  // Error/abort terminals are not successful responses. After a
                  // content delta we may penalize, but must never replay the request.
                  if (kind === 'error' || kind === 'aborted') {
                    if (kind === 'error' && isSwitchableError(failure, effectiveSwitchCodes)) {
                      penalizeRef(activeRef, code ?? 'UNKNOWN', message, rawHdrs ?? failure?.headers ?? pool.state.detectedLimits?.get?.(activeRef));
                    }
                    yield chunk;
                    return;
                  }
                  // cost tracking if provider returns usage.cost
                  const todayIso = activeRef ? new Date().toISOString().slice(0, 10) : undefined;
                  if (chunk.usage?.cost != null && activeRef) {
                    const c = Number(chunk.usage.cost);
                    if (!isNaN(c)) {
                      if (!pool.state.costPerKey) pool.state.costPerKey = new Map();
                      pool.state.costPerKey.set(activeRef, (pool.state.costPerKey.get(activeRef) ?? 0) + c);
                      // #208: cost per day per key (mirrors usageDays) for budget checks
                      if (!pool.state.costDays) pool.state.costDays = new Map();
                      const cMap = pool.state.costDays.get(activeRef) || new Map();
                      cMap.set(todayIso, (cMap.get(todayIso) ?? 0) + c);
                      pool.state.costDays.set(activeRef, cMap);
                    }
                  }
                  // Usage by day (#119)
                  if (activeRef) {
                    if (!pool.state.usageDays) pool.state.usageDays = new Map();
                    const dayMap = pool.state.usageDays.get(activeRef) || new Map();
                    dayMap.set(todayIso, (dayMap.get(todayIso) ?? 0) + 1);
                    pool.state.usageDays.set(activeRef, dayMap);
                  }
                  // Per-model request detail (#121)
                  if (activeRef && options.model) {
                    if (!pool.state.byModel) pool.state.byModel = new Map();
                    let byRef = pool.state.byModel.get(activeRef);
                    if (!byRef) { byRef = new Map(); pool.state.byModel.set(activeRef, byRef); }
                    byRef.set(options.model, (byRef.get(options.model) ?? 0) + 1);
                  }
                  // #336: record success for the active key upon successful stream finish
                  if (activeRef) {
                    recordSuccess(pool, activeRef, now());
                    if (sessionId) setSessionSticky(pool, sessionId, activeRef);
                  }
                  if (activeRef) {
                    const usedTokens = extractUsageTokens(chunk?.usage ?? chunk?.metadata?.usage);
                    if (usedTokens && usedTokens > 0) {
                      if (!pool.state.tpmWindows) pool.state.tpmWindows = new Map();
                      tpmRecord(pool.state.tpmWindows, activeRef, usedTokens, Date.now());
                    }
                  }
                  if (activeRef && quotaManaged) {
                    const charged = consumeModelTokens(
                      pool, activeRef, extractUsageTokens(chunk?.usage ?? chunk?.metadata?.usage),
                      runtime0.quotaResetWindow, Date.now(),
                    );
                    if (charged) {
                      if (typeof schedulePersist === 'function') {
                        try { schedulePersist(); } catch (_) { /* best-effort persistence */ }
                      }
                      if (charged.exhausted) {
                        logWarn(`[dsh-key-rotation] ${options.provider}/${options.model ?? '-'}: key ${activeRef} reached its local token budget (${charged.used}/${charged.limit}) — excluded from this model only`);
                      }
                    }
                  }

                  // Proactive rate-limit (#115, #303): if response headers say this key is near
                  // its quota or has retry-after, cool it down so the NEXT request starts on a different key.
                  // We do NOT re-run this (already successful) request — that would double-send.
                  // #503: Extract provider limits and reset headers
                  if (rawHdrs && activeRef) {
                    const detected = extractProviderLimits(rawHdrs);
                    if (detected) {
                      if (!pool.state.detectedLimits) pool.state.detectedLimits = new Map();
                      pool.state.detectedLimits.set(activeRef, { ...detected, at: now() });
                    }
                  }
                  const guardEnabled = pool.proactiveRateLimitGuard ?? runtime0.proactiveRateLimitGuard ?? true;
                  const rate = extractRateLimit(chunk?.metadata?.headers ?? chunk?.headers);
                  if (guardEnabled && rate && activeRef) {
                    if (isRateLimited(rate, rateLimitThreshold ?? 0.1)) {
                      let cool;
                      if (typeof rate.retryAfter === 'number' && rate.retryAfter > 0) {
                        cool = rate.retryAfter * 1000;
                      } else if (rate.reset && rate.reset > now()) {
                        cool = rate.reset - now();
                      } else if (rate.reset && rate.reset > 0 && rate.reset < 86400) {
                        cool = Math.round(rate.reset * 1000);
                      } else {
                        cool = pool.cooldownMs ?? cooldownMs;
                      }
                      const maxCool = pool.maxCooldownMs ?? maxCooldownMs;
                      const effCool = Math.min(cool, maxCool ?? cool);
                      recordFailure(pool, activeRef, now(), effCool, maxCool);
                      pool.state.proactiveSwitches = (pool.state.proactiveSwitches ?? 0) + 1;
                      pushEvent(pool, activeRef, 'RATE_LIMIT', effCool);
                      logWarn(`[dsh-key-rotation] ${options.provider}: key ${activeRef} proactive pause (remaining ${String(rate.remaining ?? '?')}/${String(rate.limit ?? '?')}, cool ${Math.round(effCool / 1000)}s) — next request will rotate`);
                    }
                  }
                  // #7: persist quota snapshot regardless of threshold (so dashboard widget can show it).
                  if (rate && activeRef && Number.isFinite(rate.remaining) && quotaStore) {
                    quotaStore.set(activeRef, { remaining: rate.remaining, limit: rate.limit, reset: rate.reset, at: now() });
                  }
                  recordLatency(pool, reqStore);
                  activePermit?.success();
                  if (isTraceOwner) trace.finish('SUCCESS', activeRef);
                  yield chunk;
                  return;
                }
                yield chunk;
              }
            } catch (e) {
              const effectiveSwitchCodes = pool.switchCodes ?? switchCodes;
              const activeRef = _pickedRef ?? reqStore.pickedRef ?? pool.state.lastUsed;
              if (!yielded && isSwitchableError(e, effectiveSwitchCodes)) {
                penalizeRef(activeRef, e?.code ?? 'TRANSPORT', String(e?.message ?? e), e?.headers ?? e?.response?.headers ?? pool.state.detectedLimits?.get?.(activeRef));
                pool.state.switches = (pool.state.switches ?? 0) + 1;
                pool.state.lastReason = String(e?.code ?? 'TRANSPORT');
                pool.state.lastSwitchAt = now();
                lastFailure = finishError(e?.code ?? 'TRANSPORT', String(e?.message ?? e));
                logWarn(`[dsh-key-rotation] ${options.provider}: key ${String(activeRef ?? '?')} stream threw ${String(e?.code ?? e?.message ?? e)} - failover to next key`);
                if (switchNotify && activeRef) {
                  notifySwitch(runtime0, pool, {
                    provider: options.provider,
                    from: activeRef,
                    code: String(e?.code ?? 'TRANSPORT'),
                    at: pool.state.lastSwitchAt,
                  });
                }
                continue; // Failover to next key!
              }
              if (yielded && isSwitchableError(e, effectiveSwitchCodes)) {
                penalizeRef(activeRef, e?.code ?? 'TRANSPORT', String(e?.message ?? e), e?.headers ?? e?.response?.headers ?? pool.state.detectedLimits?.get?.(activeRef));
              }
              yield finishError(e?.code ?? 'TRANSPORT', String(e?.message ?? e));
              return;
            }

            if (switching) continue; // try the next key
            if (yielded) {
              const activeRef = reqStore.pickedRef ?? _pickedRef ?? pool.state.lastUsed;
              if (activeRef) recordSuccess(pool, activeRef, now());
              recordLatency(pool, reqStore);
              activePermit?.success();
              if (isTraceOwner) trace.finish('SUCCESS', activeRef);
            } else if (isTraceOwner) {
              trace.finish('COMPLETED', reqStore.pickedRef ?? _pickedRef ?? pool.state.lastUsed);
            }
            return; // clean end — served
        } finally {
          if (reqStore.concurrencyRef) {
            concurrencyTracker?.release(reqStore.concurrencyRef);
            reqStore.concurrencyRef = null;
          }
          reqStore.pickedRef = undefined;
          // Also runs on consumer return(), abort, empty EOF and local errors.
          activePermit?.release();
        }
      }

      if (isBudgetOwner) {
        budget.dispose();
      }
      if (isTraceOwner) {
        trace.finish('TERMINATED', reqStore.pickedRef ?? pool.state.lastUsed);
      }

      // pool exhausted — all keys cooling or missing
      pool.state.lastExhaustionAt = now();
      pool.state.exhaustionCount = (pool.state.exhaustionCount ?? 0) + 1;
      logWarn(`[dsh-key-rotation] ${options.provider}: pool exhausted — all ${pool.refs.length} keys cooling`);
      const runtime = buildRuntime();
      // notify via extracted helper (see notifyExhaustion above)
      notifyExhaustion(runtime, pool, { provider: options.provider });

      // #194 / #364: cross-provider cascade failover with model mapping
      const maxDepth = runtime.cascadeMaxDepth ?? CASCADE_MAX_DEPTH;
      const currentDepth = options.__cascadeDepth ?? (options.__isCascade ? 1 : 0);
      if (currentDepth < maxDepth && Array.isArray(runtime.cascade) && runtime.cascade.length > 0) {
        const pools = runtime.providerToPool;
        const fb = pickCascadeFallback(options.provider, runtime, pools, options.model, runtime.modelPoolByProvider, circuitBreaker);
        if (fb && fb.pool && fb.pool !== pool) {
          logWarn(`[dsh-key-rotation] ${options.provider}: pool exhausted — cascading to ${fb.provider} (model: ${fb.model || options.model || 'default'})`);
          pool.state.lastReason = 'CASCADE';
          pool.state.lastSwitchAt = now();
          pool.state.cascadeCount = (pool.state.cascadeCount ?? 0) + 1;
          pushEvent(pool, reqStore.pickedRef ?? 'pool', 'CASCADE_TRIGGERED', 0);
          const innerCascade = rotate({
            ...options,
            provider: fb.provider,
            model: fb.model || options.model,
            __isCascade: true,
            __cascadeDepth: currentDepth + 1,
          }, fb.pool);
          for await (const chunk of innerCascade) {
            yield chunk;
          }
          return;
        }
      }

      const exhaustionMsg = formatExhaustionMessage(options.provider, pool);
      yield lastFailure ?? finishError('QUOTA', exhaustionMsg);
    })();
  }

  return rotate;
}

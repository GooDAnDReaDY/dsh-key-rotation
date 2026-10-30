// lib/rotate.js — stream rotation / failover generator (#253).
// Pure wiring helper: dependencies are injected so unit tests can supply mocks.
import { nowMono } from './clock.js';
import {
  isSwitchableError,
  recordSuccess,
  isKeyPaused,
  isKeyRevoked,
  isKeyBroken,
  formatExhaustionMessage,
  sortAttemptList,
  getSessionSticky,
  setSessionSticky,
} from './pool.js';
import { pickCascadeFallback, CASCADE_MAX_DEPTH } from './cascade.js';
import { createRequestBudget, BUDGET_EXHAUSTED_TIMEOUT, BUDGET_EXHAUSTED_ATTEMPTS } from './request-budget.js';
import { createSelectionTrace } from './selection-trace.js';
import { isKeyDraining } from './key-drain.js';
import { notifyEarlyWarning as defaultNotifyEarlyWarning } from './notify-events.js';
import {
  isModelQuotaAvailable,
  hasModelQuotaConfig,
  anyModelQuotaAvailable,
  formatModelQuotaExhaustion,
} from './model-quota.js';

import { LOCAL_POOL_EXHAUSTED_CODE, resolveKeyDirectly } from './resolver.js';
import { recordStreamSuccessMetrics, preserveDispatchContext } from './stream-metrics.js';
import { penalizeKey } from './rotate-penalty.js';
import { recordPromptCache } from './prompt-cache.js';
import { recordRequestOutcome, recordFailureCategory } from './ops-analytics.js';

export const LOCAL_QUOTA_CODE = 'LOCAL_MODEL_QUOTA_EXHAUSTED';

export { preserveDispatchContext } from './stream-metrics.js';

/**
 * Create the rotate(options, pool) async generator used by llm/stream.
 * @param {object} deps
 */
async function* executeCascade(rotateFn, options, pool, runtime, { budget, trace, currentDepth, maxDepth, reqStore, pushEvent, now, logWarn }, breaker) {
  if (currentDepth >= maxDepth || !Array.isArray(runtime.cascade) || runtime.cascade.length === 0) return false;
  const fb = pickCascadeFallback(options.provider, runtime, runtime.providerToPool, options.model, runtime.modelPoolByProvider, breaker);
  if (!fb || !fb.pool || fb.pool === pool) return false;
  pool.state.lastReason = 'CASCADE';
  pool.state.lastSwitchAt = now();
  pool.state.cascadeCount = (pool.state.cascadeCount ?? 0) + 1;
  pushEvent(pool, reqStore.pickedRef ?? 'pool', 'CASCADE_TRIGGERED', 0);
  if (logWarn) logWarn(`[dsh-key-rotation] ${options.provider}: cascade to ${fb.provider} (model: ${fb.model || options.model || 'default'})`);
  const inner = rotateFn({
    ...options, provider: fb.provider, model: fb.model || options.model,
    __isCascade: true, __cascadeDepth: currentDepth + 1, __requestBudget: budget, __selectionTrace: trace,
  }, fb.pool);
  for await (const chunk of inner) yield chunk;
  return true;
}

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
    keyDrainManager,
    selectionTraceStore,
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

      try {
      // #461: Track key selection and failover explanation
      const trace = options.__selectionTrace || createSelectionTrace(options.requestId, {
        provider: options.provider,
        model: options.model,
      }, selectionTraceStore);
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

      // #461: Record skipped candidates in trace before filtering
      const evaluatedRefs = new Set();
      for (const r of (pool.refs ?? [])) {
        if (evaluatedRefs.has(r)) continue;
        evaluatedRefs.add(r);
        if (isKeyPaused(pool, r)) {
          trace.addStep(r, 'SKIPPED', 'PAUSED', 'Key is marked paused');
        } else if (isKeyRevoked(pool, r)) {
          trace.addStep(r, 'SKIPPED', 'REVOKED', 'Key is revoked');
        } else if (isKeyBroken(pool, r, wallNow)) {
          trace.addStep(r, 'SKIPPED', 'BROKEN', 'Key is in broken quarantine');
        } else if (isKeyDraining(r, keyDrainManager)) {
          trace.addStep(r, 'SKIPPED', 'DRAINING', 'Key is draining active requests');
        } else {
          const fu = pool.state?.failedUntil?.get(r) ?? 0;
          if (fu > wallNow) {
            trace.addStep(r, 'SKIPPED', 'COOLDOWN', `In cooldown for ${Math.round((fu - wallNow) / 1000)}s`);
          } else if (options.model && pool.state.modelCapabilities) {
            const caps = pool.state.modelCapabilities.get(r);
            if (caps && caps.size > 0 && !caps.has(options.model)) {
              trace.addStep(r, 'SKIPPED', 'CAPABILITY_MISMATCH', `Missing capability for model ${options.model}`);
            }
          }
        }
      }

      let attemptList = (pool.weightedRefs ?? pool.refs).slice();
      attemptList = attemptList.filter((r) => !isKeyPaused(pool, r) && !isKeyRevoked(pool, r) && !isKeyBroken(pool, r, wallNow) && !isKeyDraining(r, keyDrainManager));
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
          trace.addStep(pool.pinnedRef, 'PRIORITIZED', 'PINNED', 'Key is pinned');
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
          const cascaded = yield* executeCascade(rotate, options, pool, runtimeQ, { budget, trace, currentDepth, maxDepth, reqStore, pushEvent, now, logWarn });
          if (cascaded) return;
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
        penalizeKey(targetRef, errCode, errMsg, rawHeaders, {
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
        });
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
            signal: budget.signal,
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
          const cascaded = yield* executeCascade(rotate, options, pool, runtimeQ, { budget, trace, currentDepth, maxDepth, reqStore, pushEvent, now, logWarn }, breaker);
          if (cascaded) return;
          yield finishError('CIRCUIT_OPEN', `[dsh-key-rotation] provider '${options.provider}' circuit is open`);
          return;
        }
        try {
          let yielded = false;
          let switching = false;
          let inner;
          const preTokenBuffer = [];
          try {
            // #464 & #461: Record attempt & trace dispatch
            budget.recordAttempt();
            const curCandidate = reqStore.pickedRef ?? pool.state.lastUsed ?? attemptList[attempt];
            trace.addStep(curCandidate, 'DISPATCHED', 'ATTEMPT', `Attempt ${budget.getAttempts()}`);

            // #526: Direct key resolution without relying on credentials.resolve monkey-patch
            const directSecret = await resolveKeyDirectly(curCandidate, ctx);
            const directOpts = { ...options, [MARKER]: true, signal: budget.signal, _rotationKeyRef: curCandidate };
            if (directSecret) {
              directOpts.apiKey = directSecret;
              if (!directOpts.headers) directOpts.headers = {};
              if (!directOpts.headers.Authorization && !directOpts.headers.authorization) {
                directOpts.headers.Authorization = `Bearer ${directSecret}`;
              }
            }

            inner = dispatchStorage.run(reqStore, () => {
              const llm = ctx.get('llm');
              if (!llm || typeof llm.stream !== 'function') {
                throw new Error('dsh-key-rotation: llm service unavailable');
              }
              return llm.stream(directOpts);
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
                // Pre-First-Token Failover (#527): Lock the stream only upon first content delta.
                if (chunk && isContentChunk(chunk)) {
                  if (!yielded) {
                    yielded = true;
                    for (const prev of preTokenBuffer) yield prev;
                    preTokenBuffer.length = 0;
                  }
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
                  const activeRef = reqStore.pickedRef ?? pool.state.lastUsed ?? attemptList[attempt];
                  if (switchable) {
                    preTokenBuffer.length = 0; // Discard metadata from aborted attempt (#527)
                    penalizeRef(activeRef, code ?? 'UNKNOWN', message, rawHdrs ?? failure?.headers ?? pool.state.detectedLimits?.get?.(activeRef));
                    recordFailureCategory(pool, code ?? 'UNKNOWN', message, activeRef, now());
                    pool.state.switches = (pool.state.switches ?? 0) + 1;
                    pool.state.lastReason = String(code ?? 'UNKNOWN');
                    pool.state.lastSwitchAt = now();
                    lastFailure = chunk;
                    logWarn(`[dsh-key-rotation] ${options.provider}: key ${String(activeRef ?? '?')} failed before first token (${String(code)} ${String(message).slice(0, 100)}) - failover to next key`);
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
                    if (!yielded) {
                      for (const prev of preTokenBuffer) yield prev;
                      preTokenBuffer.length = 0;
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
                  // #512: Record success metrics, tokens, local quota, limits and proactive pause
                  if (activeRef) {
                    recordStreamSuccessMetrics(pool, activeRef, options, chunk, {
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
                    });
                  }
                  recordLatency(pool, reqStore);
                  if (typeof activePermit?.success === 'function') activePermit.success();
                  if (isTraceOwner) trace.finish('SUCCESS', activeRef);
                  if (!yielded) {
                    for (const prev of preTokenBuffer) yield prev;
                    preTokenBuffer.length = 0;
                  }
                  yield chunk;
                  return;
                }
                if (yielded) {
                  yield chunk;
                } else {
                  preTokenBuffer.push(chunk);
                }
              }
            } catch (e) {
              const effectiveSwitchCodes = pool.switchCodes ?? switchCodes;
              const activeRef = _pickedRef ?? reqStore.pickedRef ?? pool.state.lastUsed ?? attemptList[attempt];
              if (!yielded && isSwitchableError(e, effectiveSwitchCodes)) {
                preTokenBuffer.length = 0; // Discard metadata from failed attempt (#527)
                penalizeRef(activeRef, e?.code ?? 'TRANSPORT', String(e?.message ?? e), e?.headers ?? e?.response?.headers ?? pool.state.detectedLimits?.get?.(activeRef));
                recordFailureCategory(pool, e?.code ?? 'TRANSPORT', String(e?.message ?? e), activeRef, now());
                pool.state.switches = (pool.state.switches ?? 0) + 1;
                pool.state.lastReason = String(e?.code ?? 'TRANSPORT');
                pool.state.lastSwitchAt = now();
                lastFailure = finishError(e?.code ?? 'TRANSPORT', String(e?.message ?? e));
                logWarn(`[dsh-key-rotation] ${options.provider}: key ${String(activeRef ?? '?')} stream threw before first token ${String(e?.code ?? e?.message ?? e)} - failover to next key`);
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
              if (!yielded) {
                for (const prev of preTokenBuffer) yield prev;
                preTokenBuffer.length = 0;
              }
              yield finishError(e?.code ?? 'TRANSPORT', String(e?.message ?? e));
              return;
            }

            if (switching) continue; // try the next key
            if (!yielded && preTokenBuffer.length > 0) {
              for (const prev of preTokenBuffer) yield prev;
              preTokenBuffer.length = 0;
            }
            if (yielded) {
              const activeRef = reqStore.pickedRef ?? _pickedRef ?? pool.state.lastUsed;
              if (activeRef) recordSuccess(pool, activeRef, now());
              recordLatency(pool, reqStore);
              if (typeof activePermit?.success === 'function') activePermit.success();
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
      const cascaded = yield* executeCascade(rotate, options, pool, runtime, { budget, trace, currentDepth, maxDepth, reqStore, pushEvent, now, logWarn }, circuitBreaker);
      if (cascaded) return;

      const exhaustionMsg = formatExhaustionMessage(options.provider, pool);
      yield lastFailure ?? finishError('QUOTA', exhaustionMsg);
      } finally {
        if (isBudgetOwner) {
          budget.dispose();
        }
      }
    })();
  }

  return rotate;
}

/**
 * Whether a chunk carries a model-visible content delta (#527).
 * @param {Record<string, unknown>} chunk
 * @returns {boolean}
 */
export function isContentChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return false;
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
    return true;
  }
  if (chunk.delta !== undefined || chunk.text !== undefined || chunk.content !== undefined || chunk.choices !== undefined) {
    return true;
  }
  if (chunk.type === 'start' || chunk.type === 'block-start' || chunk.type === 'block-stop' ||
      chunk.type === 'metadata' || chunk.type === 'response-metadata' || chunk.type === 'usage' ||
      chunk.type === 'finish') {
    return false;
  }
  return false;
}


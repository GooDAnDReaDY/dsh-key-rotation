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
  formatExhaustionMessage,
  sortAttemptList,
} from './pool.js';
import { pickCascadeFallback } from './cascade.js';
import { nextQuotaReset } from './quota-window.js';

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
    now = nowMono,
  } = deps;

  const logWarn = (msg) => (logger?.warn ? logger.warn(msg) : null);

  function rotate(options, pool) {
    return (async function* () {
      const runtime0 = buildRuntime();
      const { switchCodes, cooldownMs, maxCooldownMs, switchNotify, rateLimitThreshold } = runtime0;
      let lastFailure = null;
      const reqStore = { pool, pickedRef: undefined, startMs: now() };
      setRotateStartMs(reqStore.startMs);
      let attemptList = (pool.weightedRefs ?? pool.refs).slice();
      const strategy = pool.routingStrategy ?? runtime0.routingStrategy ?? 'round-robin';
      if (strategy !== 'round-robin') {
        attemptList = sortAttemptList(attemptList, strategy, { latencyHistogram, concurrencyTracker });
      }
      if (strategy !== 'least-loaded' && runtime0.concurrencyLimit > 0 && concurrencyTracker.isEnabled()) {
        // #193: prefer least-loaded key within limit
        const available = attemptList.filter((r) => {
          const fu = pool.state.failedUntil.get(r) ?? 0;
          if (fu > now()) return false;
          const exp = pool.expiresAt ? pool.expiresAt[r] : undefined;
          if (exp !== undefined && now() >= exp) return false;
          return true;
        });
        const preferred = concurrencyTracker.pickLeastLoaded(available);
        if (preferred && attemptList[0] !== preferred) {
          const list = attemptList.slice();
          const i = list.indexOf(preferred);
          if (i > 0) { list.splice(i, 1); list.unshift(preferred); }
          attemptList = list;
        }
      }

      const penalizeRef = (targetRef, errCode, errMsg) => {
        if (!targetRef) return;
        const _retry = parseRetryAfter(errMsg);
        const _base = pool.cooldownMs ?? cooldownMs;
        const _max = pool.maxCooldownMs ?? maxCooldownMs;
        const _effBase = _retry !== undefined ? Math.max(_base, Math.min(_retry, _max ?? _base * 8)) : _base;
        const cls = classifyFailure({ code: errCode, message: errMsg });
        const _b = recordFailure(pool, targetRef, now(), _effBase, _max, cls.soft, true);

        // #337: connect quota-window calendar reset for quota exhaustion
        const isQuota = errCode === 'QUOTA' || cls.code === 'QUOTA' || /quota|exceeded/i.test(errMsg);
        const qWindow = pool.quotaResetWindow ?? runtime0.quotaResetWindow;
        if (isQuota && qWindow) {
          const quotaResetAt = nextQuotaReset(qWindow, now());
          if (quotaResetAt && quotaResetAt > now()) {
            if (!pool.state.quotaWindows) pool.state.quotaWindows = new Map();
            pool.state.quotaWindows.set(targetRef, quotaResetAt);
            pool.state.failedUntil.set(targetRef, quotaResetAt);
          }
        }

        if (circuitBreaker) circuitBreaker.onFailure(pool.base ?? options?.provider);
        pushEvent(pool, targetRef, errCode ?? 'UNKNOWN', _b);
        if (typeof schedulePersist === 'function') {
          try { schedulePersist(); } catch (_) { /* best-effort persistence */ }
        }
        if (!pool.state.authFailCounts) pool.state.authFailCounts = new Map();
        if (!pool.state.brokenUntil) pool.state.brokenUntil = new Map();
        const _cStr = String(errCode ?? '');
        if (_cStr === 'AUTH' || /auth/i.test(errMsg)) {
          const _c2 = (pool.state.authFailCounts.get(targetRef) ?? 0) + 1;
          pool.state.authFailCounts.set(targetRef, _c2);
          if (_c2 >= 3) {
            pool.state.brokenUntil.set(targetRef, now() + 86400000 * 30);
            pool.state.failedUntil.set(targetRef, now() + 86400000 * 30);
          }
        } else {
          pool.state.authFailCounts.delete(targetRef);
        }
      };

      // #260: fail fast when provider circuit is open
      if (circuitBreaker && !circuitBreaker.canRequest(options.provider)) {
        logWarn(`[dsh-key-rotation] ${options.provider}: circuit open — skipping dispatch`);
        yield finishError('CIRCUIT_OPEN', `[dsh-key-rotation] provider '${options.provider}' circuit is open`);
        return;
      }

      for (let attempt = 0; attempt < attemptList.length; attempt++) {
        let yielded = false;
        let switching = false;
        let inner;
        try {
          // mark the internal dispatch so the interceptor does not re-rotate
          inner = dispatchStorage.run(reqStore, () => {
            const llm = ctx.get('llm');
            if (!llm || typeof llm.stream !== 'function') {
              throw new Error('dsh-key-rotation: llm service unavailable');
            }
            return llm.stream({ ...options, [MARKER]: true });
          });
        } catch (e) {
          const curRef = reqStore.pickedRef ?? pool.state.lastUsed;
          penalizeRef(curRef, e?.code ?? 'TRANSPORT', String(e?.message ?? ''));
          lastFailure = finishError(e?.code ?? 'TRANSPORT',
            `dsh-key-rotation: dispatch failed: ${String(e?.message ?? e)}`);
          logWarn(`[dsh-key-rotation] ${options.provider}: key ${String(curRef ?? '?')} threw ${String(e?.code ?? e?.message ?? e)}`);
          continue;
        }

        const _pickedRef = reqStore.pickedRef ?? pool.state.lastUsed;
        const acquired = (_pickedRef && runtime0.concurrencyLimit > 0) ? concurrencyTracker.acquire(_pickedRef) : false;
        try {
          try {
            for await (const chunk of inner) {
              // Only actual content deltas lock the stream (no more rotation).
              // Structural/metadata chunks (block-start/end, usage) do not.
              if (chunk && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta')) {
                yielded = true;
                yield chunk;
                continue;
              }
              if (chunk && chunk.type === 'finish') {
                const kind = chunk.reason?.kind;
                const failure = chunk.reason?.failure;
                const code = failure?.code;
                const message = failure?.message ?? '';
                const effectiveSwitchCodes = pool.switchCodes ?? switchCodes;
                const switchable = !yielded && kind === 'error' && isSwitchableError(failure, effectiveSwitchCodes);
                const activeRef = reqStore.pickedRef ?? pool.state.lastUsed;
                if (switchable) {
                  penalizeRef(activeRef, code ?? 'UNKNOWN', message);
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
                }

                // Proactive rate-limit (#115, #303): if response headers say this key is near
                // its quota or has retry-after, cool it down so the NEXT request starts on a different key.
                // We do NOT re-run this (already successful) request — that would double-send.
                const guardEnabled = pool.proactiveRateLimitGuard ?? runtime0.proactiveRateLimitGuard ?? true;
                const rate = extractRateLimit(chunk?.metadata?.headers ?? chunk?.headers);
                if (guardEnabled && rate && activeRef) {
                  if (isRateLimited(rate, rateLimitThreshold ?? 0.1)) {
                    let cool;
                    if (typeof rate.retryAfter === 'number' && rate.retryAfter > 0) {
                      cool = rate.retryAfter * 1000;
                    } else if (rate.reset && rate.reset > now()) {
                      cool = rate.reset - now();
                    } else {
                      cool = pool.cooldownMs ?? cooldownMs;
                    }
                    const maxCool = pool.maxCooldownMs ?? maxCooldownMs;
                    const effCool = Math.min(cool, maxCool ?? cool);
                    recordFailure(pool, activeRef, now(), effCool, maxCool);
                    pushEvent(pool, activeRef, 'RATE_LIMIT', effCool);
                    logWarn(`[dsh-key-rotation] ${options.provider}: key ${activeRef} proactive pause (remaining ${String(rate.remaining ?? '?')}/${String(rate.limit ?? '?')}, cool ${Math.round(effCool / 1000)}s) — next request will rotate`);
                  }
                }
                // #7: persist quota snapshot regardless of threshold (so dashboard widget can show it).
                if (rate && activeRef && Number.isFinite(rate.remaining) && quotaStore) {
                  quotaStore.set(activeRef, { remaining: rate.remaining, limit: rate.limit, reset: rate.reset, at: now() });
                }
                yield chunk;
                recordLatency(pool, reqStore);
                if (circuitBreaker) circuitBreaker.onSuccess(options.provider);
                return;
              }
              yield chunk;
            }
          } catch (e) {
            const effectiveSwitchCodes = pool.switchCodes ?? switchCodes;
            const activeRef = _pickedRef ?? reqStore.pickedRef ?? pool.state.lastUsed;
            if (!yielded && isSwitchableError(e, effectiveSwitchCodes)) {
              penalizeRef(activeRef, e?.code ?? 'TRANSPORT', String(e?.message ?? e));
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
            yield finishError(e?.code ?? 'TRANSPORT', String(e?.message ?? e));
            return;
          }

          if (switching) continue; // try the next key
          if (_pickedRef && yielded) {
            recordSuccess(pool, _pickedRef, now());
          }
          return; // clean end — served
        } finally {
          if (acquired && _pickedRef) {
            concurrencyTracker.release(_pickedRef);
          }
        }
      }

      // pool exhausted — all keys cooling or missing
      pool.state.lastExhaustionAt = now();
      pool.state.exhaustionCount = (pool.state.exhaustionCount ?? 0) + 1;
      logWarn(`[dsh-key-rotation] ${options.provider}: pool exhausted — all ${pool.refs.length} keys cooling`);
      const runtime = buildRuntime();
      // notify via extracted helper (see notifyExhaustion above)
      notifyExhaustion(runtime, pool, { provider: options.provider });

      // #194: cross-provider cascade failover (guarded against infinite recursion)
      if (!options.__isCascade && Array.isArray(runtime.cascade) && runtime.cascade.length > 0) {
        const pools = runtime.providerToPool;
        const fb = pickCascadeFallback(options.provider, runtime, pools);
        if (fb && fb.pool && fb.pool !== pool) {
          logWarn(`[dsh-key-rotation] ${options.provider}: pool exhausted — cascading to ${fb.provider}`);
          pool.state.lastReason = 'CASCADE';
          pool.state.lastSwitchAt = now();
          // Re-dispatch on the fallback pool (depth-1 via __isCascade guard)
          const innerCascade = rotate({ ...options, provider: fb.provider, __isCascade: true }, fb.pool);
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

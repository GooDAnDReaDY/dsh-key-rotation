// lib/rotate.js — stream rotation / failover generator (#253).
// Pure wiring helper: dependencies are injected so unit tests can supply mocks.

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
    concurrencyTracker,
    MARKER,
    finishError,
    setRotateStartMs,
  } = deps;

  function rotate(options, pool) {
    return (async function* () {
      const runtime0 = buildRuntime();
      const { switchCodes, cooldownMs, maxCooldownMs, switchNotify, rateLimitThreshold } = runtime0;
      let lastFailure = null;
      const reqStore = { pool, pickedRef: undefined, startMs: Date.now() };
      setRotateStartMs(reqStore.startMs);
      let attemptList = (pool.weightedRefs ?? pool.refs).slice();
      if (runtime0.concurrencyLimit > 0 && concurrencyTracker.isEnabled()) {
        // #193: prefer least-loaded key within limit
        const available = attemptList.filter((r) => {
          const fu = pool.state.failedUntil.get(r) ?? 0;
          if (fu > Date.now()) return false;
          const exp = pool.expiresAt ? pool.expiresAt[r] : undefined;
          if (exp !== undefined && Date.now() >= exp) return false;
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
        const _b = recordFailure(pool, targetRef, Date.now(), _effBase, _max);
        pushEvent(pool, targetRef, errCode ?? 'UNKNOWN', _b);
        if (!pool.state.authFailCounts) pool.state.authFailCounts = new Map();
        if (!pool.state.brokenUntil) pool.state.brokenUntil = new Map();
        const _cStr = String(errCode ?? '');
        if (_cStr === 'AUTH' || /auth/i.test(errMsg)) {
          const _c2 = (pool.state.authFailCounts.get(targetRef) ?? 0) + 1;
          pool.state.authFailCounts.set(targetRef, _c2);
          if (_c2 >= 3) {
            pool.state.brokenUntil.set(targetRef, Date.now() + 86400000 * 30);
            pool.state.failedUntil.set(targetRef, Date.now() + 86400000 * 30);
          }
        } else {
          pool.state.authFailCounts.delete(targetRef);
        }
      };

      for (let attempt = 0; attempt < attemptList.length; attempt++) {
        let yielded = false;
        let switching = false;
        let inner;
        try {
          // mark the internal dispatch so the interceptor does not re-rotate
          inner = dispatchStorage.run(reqStore, () => ctx.llm.stream({ ...options, [MARKER]: true }));
        } catch (e) {
          const curRef = reqStore.pickedRef ?? pool.state.lastUsed;
          penalizeRef(curRef, e?.code ?? 'TRANSPORT', String(e?.message ?? ''));
          lastFailure = finishError(e?.code ?? 'TRANSPORT',
            `dsh-key-rotation: dispatch failed: ${String(e?.message ?? e)}`);
          console.warn(`[dsh-key-rotation] ${options.provider}: key ${String(curRef ?? '?')} threw ${String(e?.code ?? e?.message ?? e)}`);
          continue;
        }

        const _pickedRef = reqStore.pickedRef ?? pool.state.lastUsed;
        if (_pickedRef && runtime0.concurrencyLimit > 0) concurrencyTracker.acquire(_pickedRef);
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
                pool.state.lastSwitchAt = Date.now();
                lastFailure = chunk;
                console.warn(`[dsh-key-rotation] ${options.provider}: key ${String(activeRef ?? '?')} failed (${String(code)} ${String(message).slice(0, 100)}) - next key`);
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
              // Proactive rate-limit (#115): if response headers say this key is near
              // its quota, cool it down so the NEXT request starts on a different key.
              // We do NOT re-run this (already successful) request — that would double-send.
              const rate = extractRateLimit(chunk?.metadata?.headers ?? chunk?.headers);
              if (rate && activeRef) {
                if (isRateLimited(rate, rateLimitThreshold ?? 0.1)) {
                  const cool = rate.reset && rate.reset > Date.now() ? (rate.reset - Date.now()) : pool.cooldownMs;
                  recordFailure(pool, activeRef, Date.now(), cool, pool.maxCooldownMs);
                  pushEvent(pool, activeRef, 'RATE_LIMIT', cool);
                  console.warn(`[dsh-key-rotation] ${options.provider}: key ${activeRef} near quota (remaining ${String(rate.remaining)}/${String(rate.limit)}) — next request will rotate`);
                }
              }
              // #7: persist quota snapshot regardless of threshold (so dashboard widget can show it).
              if (rate && activeRef && Number.isFinite(rate.remaining)) {
                quotaStore.set(activeRef, { remaining: rate.remaining, limit: rate.limit, reset: rate.reset, at: Date.now() });
              }
              yield chunk;
              recordLatency(pool, reqStore);
              return;
            }
            yield chunk;
          }
        } catch (e) {
          if (_pickedRef && runtime0.concurrencyLimit > 0) concurrencyTracker.release(_pickedRef);
          const effectiveSwitchCodes = pool.switchCodes ?? switchCodes;
          const activeRef = _pickedRef ?? reqStore.pickedRef ?? pool.state.lastUsed;
          if (!yielded && isSwitchableError(e, effectiveSwitchCodes)) {
            penalizeRef(activeRef, e?.code ?? 'TRANSPORT', String(e?.message ?? e));
            pool.state.switches = (pool.state.switches ?? 0) + 1;
            pool.state.lastReason = String(e?.code ?? 'TRANSPORT');
            pool.state.lastSwitchAt = Date.now();
            lastFailure = finishError(e?.code ?? 'TRANSPORT', String(e?.message ?? e));
            console.warn(`[dsh-key-rotation] ${options.provider}: key ${String(activeRef ?? '?')} stream threw ${String(e?.code ?? e?.message ?? e)} - failover to next key`);
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

        if (_pickedRef && runtime0.concurrencyLimit > 0) concurrencyTracker.release(_pickedRef);
        if (switching) continue; // try the next key
        return; // clean end — served
      }

      // pool exhausted — all keys cooling or missing
      pool.state.lastExhaustionAt = Date.now();
      pool.state.exhaustionCount = (pool.state.exhaustionCount ?? 0) + 1;
      console.warn(`[dsh-key-rotation] ${options.provider}: pool exhausted — all ${pool.refs.length} keys cooling`);
      const runtime = buildRuntime();
      // notify via extracted helper (see notifyExhaustion above)
      notifyExhaustion(runtime, pool, { provider: options.provider });

      // #194: cross-provider cascade failover (guarded against infinite recursion)
      if (!options.__isCascade && Array.isArray(runtime.cascade) && runtime.cascade.length > 0) {
        const pools = runtime.providerToPool;
        const fb = pickCascadeFallback(options.provider, runtime, pools);
        if (fb && fb.pool && fb.pool !== pool) {
          console.warn(`[dsh-key-rotation] ${options.provider}: pool exhausted — cascading to ${fb.provider}`);
          pool.state.lastReason = 'CASCADE';
          pool.state.lastSwitchAt = Date.now();
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

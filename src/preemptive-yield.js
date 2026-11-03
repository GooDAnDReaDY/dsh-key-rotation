// src/preemptive-yield.js — Pre-emptive Token & Request Yield before 429 (#571).
// Pure module: zero runtime dependencies, strictly < 600 lines.

export const DEFAULT_PREEMPTIVE_SAFETY_MARGIN_TOKENS = 4000;
export const DEFAULT_PREEMPTIVE_SAFETY_MARGIN_REQUESTS = 2;

/**
 * Evaluates whether a key has low remaining quota and should yield to other candidates.
 * @param {object} pool - Pool definition carrying state
 * @param {string} ref - Key reference
 * @param {object} [options]
 * @param {number} [options.now] - Current timestamp in ms
 * @param {number} [options.safetyMarginTokens]
 * @param {number} [options.safetyMarginRequests]
 * @param {boolean} [options.enabled]
 * @returns {{ yielding: boolean, reason?: string, remainingTokens?: number, remainingRequests?: number, resetInMs?: number }}
 */
export function isPreemptiveYielding(pool, ref, options = {}) {
  const enabled = options.enabled ?? pool?.preemptiveRotationEnabled ?? true;
  if (!enabled || !pool || !ref) return { yielding: false };

  const limits = pool.state?.detectedLimits?.get?.(ref);
  if (!limits) return { yielding: false };

  const now = options.now ?? Date.now();
  const recordedAt = limits.at || now;

  // Window reset calculation
  const resetMs = limits.tpmResetMs || limits.rpmResetMs || (typeof limits.resetTokens === 'number' ? limits.resetTokens * 1000 : (typeof limits.resetRequests === 'number' ? limits.resetRequests * 1000 : 0));

  if (resetMs > 0 && now >= recordedAt + resetMs) {
    // Window has already passed and refreshed upstream
    return { yielding: false };
  }

  const remainingTokens = limits.remainingTokens ?? limits.tpmRemaining;
  const remainingRequests = limits.remainingRequests ?? limits.rpmRemaining;

  const marginTokens = options.safetyMarginTokens ?? pool.preemptiveSafetyMarginTokens ?? DEFAULT_PREEMPTIVE_SAFETY_MARGIN_TOKENS;
  const marginRequests = options.safetyMarginRequests ?? pool.preemptiveSafetyMarginRequests ?? DEFAULT_PREEMPTIVE_SAFETY_MARGIN_REQUESTS;

  const lowTokens = typeof remainingTokens === 'number' && remainingTokens < marginTokens;
  const lowRequests = typeof remainingRequests === 'number' && remainingRequests <= marginRequests;

  if (lowTokens || lowRequests) {
    const resetInMs = resetMs > 0 ? Math.max(0, (recordedAt + resetMs) - now) : 0;
    return {
      yielding: true,
      reason: lowTokens ? `LOW_REMAINING_TOKENS (${remainingTokens} < ${marginTokens})` : `LOW_REMAINING_REQUESTS (${remainingRequests} <= ${marginRequests})`,
      remainingTokens,
      remainingRequests,
      resetInMs,
    };
  }

  return { yielding: false, remainingTokens, remainingRequests };
}

/**
 * Reorders candidate attempts list so that keys with ample token/request headroom
 * are attempted first, while yielding keys yield priority.
 * Gracefully degrades if all candidate keys are low on headroom.
 * @param {string[]} attemptList
 * @param {object} pool
 * @param {object} [options]
 * @returns {string[]}
 */
export function applyPreemptiveYield(attemptList, pool, options = {}) {
  if (!Array.isArray(attemptList) || attemptList.length <= 1 || !pool) {
    return (attemptList ?? []).slice();
  }

  const enabled = options.enabled ?? pool.preemptiveRotationEnabled ?? true;
  if (!enabled) return attemptList.slice();

  const now = options.now ?? Date.now();
  const ample = [];
  const yielding = [];

  for (const ref of attemptList) {
    // Pinned keys stay first if explicitly configured and not overridden
    if (ref === pool.pinnedRef && options.preservePinned !== false) {
      ample.push({ ref, info: { yielding: false } });
      continue;
    }

    const info = isPreemptiveYielding(pool, ref, { ...options, now });
    if (info.yielding) {
      yielding.push({ ref, info });
      if (options.trace && typeof options.trace.addStep === 'function') {
        options.trace.addStep(ref, 'DEPRIORITIZED', 'PREEMPTIVE_YIELD', info.reason);
      }
      if (options.pushEvent && typeof options.pushEvent === 'function') {
        options.pushEvent(pool, ref, 'PREEMPTIVE_YIELD', info);
      }
    } else {
      ample.push({ ref, info });
    }
  }

  if (yielding.length === 0) {
    return attemptList.slice();
  }

  // Record yield counter in pool state
  if (pool.state) {
    pool.state.preemptiveYields = (pool.state.preemptiveYields ?? 0) + yielding.length;
  }

  // Sort yielding keys among themselves: highest remaining tokens first, then soonest reset
  yielding.sort((a, b) => {
    const ta = a.info.remainingTokens ?? -1;
    const tb = b.info.remainingTokens ?? -1;
    if (ta !== tb) return tb - ta; // Descending tokens
    const ra = a.info.resetInMs ?? Infinity;
    const rb = b.info.resetInMs ?? Infinity;
    return ra - rb; // Ascending reset duration (soonest reset first)
  });

  if (ample.length === 0) {
    // Graceful degradation: all keys are yielding; pick the best yielding key first
    if (options.logWarn && typeof options.logWarn === 'function') {
      options.logWarn(`[dsh-key-rotation] ${pool.provider ?? '-'}: all candidate keys are yielding (low quota) — proceeding with highest remaining headroom`);
    }
    return yielding.map(y => y.ref);
  }

  return ample.map(a => a.ref).concat(yielding.map(y => y.ref));
}

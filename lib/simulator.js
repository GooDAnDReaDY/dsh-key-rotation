// lib/simulator.js — Offline rotation and cascade simulator (#462).
// Simulates key selection, failovers, cooldowns, and cross-provider cascade
// without network requests, credential resolution, token expenditure, or modifying production state.

import {
  isKeyPaused,
  isKeyRevoked,
  isKeyBroken,
  sortAttemptList,
} from './pool.js';
import { isModelQuotaAvailable, hasModelQuotaConfig } from './model-quota.js';
import { pickCascadeFallback, CASCADE_MAX_DEPTH } from './cascade.js';
import { createSelectionTrace } from './selection-trace.js';

/**
 * Runs an offline simulation of rotation and cascade.
 * @param {object} params
 * @param {object} params.pool - Simulated pool definition
 * @param {object} [params.runtime] - Simulated runtime with providerToPool, cascade, circuitBreaker
 * @param {Array<object>} [params.events] - Simulated step events
 * @param {number} [params.nowMs] - Simulated current timestamp
 * @param {string} [params.model] - Optional model identifier
 * @param {number} [params.maxAttempts] - Max allowed attempts (from #464)
 * @returns {object} Simulation trace and result
 */
export function simulateRouting(params = {}) {
  const {
    pool,
    runtime = {},
    events = [],
    nowMs = Date.now(),
    model = '',
    maxAttempts = 0,
  } = params;

  if (!pool || !Array.isArray(pool.refs)) {
    throw new Error('simulateRouting: valid pool with refs is required');
  }

  // Clone pool state into isolated mock state so real runtime is never touched
  const mockFailedUntil = new Map(pool.state?.failedUntil || []);
  const mockFailCounts = new Map(pool.state?.failCounts || []);
  const mockRevokedRefs = new Set(pool.state?.revokedRefs || []);

  const simPool = {
    ...pool,
    state: {
      failedUntil: mockFailedUntil,
      failCounts: mockFailCounts,
      revokedRefs: mockRevokedRefs,
      brokenUntil: new Map(),
    },
  };

  const trace = createSelectionTrace(`sim-${nowMs}`, {
    provider: pool.provider || pool.base || 'sim-provider',
    model,
  });

  const quotaManaged = hasModelQuotaConfig(simPool);
  let attemptList = (simPool.weightedRefs ?? simPool.refs).slice();

  // Filter paused/revoked/broken
  attemptList = attemptList.filter((r) => {
    if (isKeyPaused(simPool, r)) {
      trace.addStep(r, 'SKIPPED', 'PAUSED', 'Key is marked paused');
      return false;
    }
    if (isKeyRevoked(simPool, r)) {
      trace.addStep(r, 'SKIPPED', 'REVOKED', 'Key is revoked');
      return false;
    }
    if (isKeyBroken(simPool, r, nowMs)) {
      trace.addStep(r, 'SKIPPED', 'BROKEN', 'Key is in broken quarantine');
      return false;
    }
    const fu = simPool.state.failedUntil.get(r) ?? 0;
    if (fu > nowMs) {
      trace.addStep(r, 'SKIPPED', 'COOLDOWN', `In cooldown for ${Math.round((fu - nowMs) / 1000)}s`);
      return false;
    }
    return true;
  });

  // Prioritize pinnedRef
  if (simPool.pinnedRef && attemptList.includes(simPool.pinnedRef)) {
    const pIdx = attemptList.indexOf(simPool.pinnedRef);
    if (pIdx > 0) {
      attemptList.splice(pIdx, 1);
      attemptList.unshift(simPool.pinnedRef);
      trace.addStep(simPool.pinnedRef, 'PRIORITIZED', 'PINNED', 'Key is pinned');
    }
  }

  // Model quota filter
  if (quotaManaged) {
    attemptList = attemptList.filter((ref) => {
      const ok = isModelQuotaAvailable(simPool, ref, nowMs);
      if (!ok) {
        trace.addStep(ref, 'SKIPPED', 'QUOTA_EXHAUSTED', 'Local model token quota reached');
      }
      return ok;
    });
  }

  let attemptCount = 0;
  let finalOutcome = 'EXHAUSTED';
  let finalRef = null;

  for (let i = 0; i < attemptList.length; i++) {
    const candidate = attemptList[i];
    if (maxAttempts > 0 && attemptCount >= maxAttempts) {
      trace.addStep(candidate, 'BLOCKED', 'BUDGET_ATTEMPTS_EXCEEDED', `Max attempts (${maxAttempts}) reached`);
      finalOutcome = 'BUDGET_ATTEMPTS_EXCEEDED';
      break;
    }

    attemptCount++;
    trace.addStep(candidate, 'DISPATCHED', 'ATTEMPT', `Attempt ${attemptCount}`);

    // Check if user specified a synthetic event/error for this candidate
    const ev = events.find((e) => e.ref === candidate || e.attempt === attemptCount);
    if (ev && ev.error) {
      const errCode = ev.error.code || 'SIM_ERROR';
      const errMsg = ev.error.message || 'Simulated failure';
      trace.addStep(candidate, 'FAILED', errCode, errMsg);
      // Apply simulated cooldown
      simPool.state.failedUntil.set(candidate, nowMs + (ev.cooldownMs || 60000));
      continue;
    }

    // Success simulated!
    trace.addStep(candidate, 'SUCCESS', 'OK', 'Candidate served response');
    finalOutcome = 'SUCCESS';
    finalRef = candidate;
    break;
  }

  // Cascade check if exhausted
  if (finalOutcome === 'EXHAUSTED' && runtime.cascade && Array.isArray(runtime.cascade) && runtime.cascade.length > 0) {
    const fb = pickCascadeFallback(simPool.provider || simPool.base, runtime, runtime.providerToPool, model, runtime.modelPoolByProvider);
    if (fb && fb.pool) {
      trace.addStep(fb.provider, 'CASCADE', 'TRIGGERED', `Cascading to fallback provider ${fb.provider}`);
      finalOutcome = 'CASCADE_TRIGGERED';
      finalRef = fb.provider;
    }
  }

  const result = trace.finish(finalOutcome, finalRef);
  return {
    outcome: finalOutcome,
    selectedRef: finalRef,
    attempts: attemptCount,
    trace: result,
  };
}

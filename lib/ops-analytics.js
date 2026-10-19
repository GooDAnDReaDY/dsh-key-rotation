// lib/ops-analytics.js — 24h error breakdown, load distribution, and health index analytics (#505).
// Pure helpers with zero dependencies.

const DAY_MS = 86400000;
const MAX_RING_BUFFER = 200;

/**
 * Classifies an error code or message into canonical categories:
 * 'rateLimit' | 'server' | 'timeout' | 'quota' | 'auth' | 'other'
 */
export function classifyErrorCategory(code, message = '') {
  const c = String(code ?? '').toUpperCase();
  const m = String(message ?? '').toLowerCase();

  if (c === '429' || c.includes('RATE_LIMIT') || m.includes('rate limit') || m.includes('too many requests')) {
    return 'rateLimit';
  }
  if (/^5\d\d$/.test(c) || c === 'SERVER' || c === 'BAD_GATEWAY' || c === 'SERVICE_UNAVAILABLE' || m.includes('internal server error')) {
    return 'server';
  }
  if (c.includes('TIMEOUT') || c === 'ETIMEDOUT' || c === 'ESOCKETTIMEDOUT' || m.includes('timeout') || m.includes('timed out')) {
    return 'timeout';
  }
  if (c === 'QUOTA' || c === '402' || c.includes('QUOTA') || m.includes('quota') || m.includes('credit') || m.includes('insufficient_quota')) {
    return 'quota';
  }
  if (c === 'AUTH' || c === '401' || c === '403' || m.includes('unauthorized') || m.includes('invalid_api_key') || m.includes('forbidden')) {
    return 'auth';
  }
  return 'other';
}

function initPoolAnalytics(pool) {
  if (!pool.state.analytics24h) {
    pool.state.analytics24h = {
      requests: [], // Ring buffer of { at, ref, success, attempts, failovers, cascaded }
      errorEvents: [], // Ring buffer of { at, category, code, ref }
    };
  }
  return pool.state.analytics24h;
}

/**
 * Records a failover error encountered during key rotation.
 */
export function recordFailureCategory(pool, code, message = '', ref = '', now = Date.now()) {
  if (!pool?.state) return;
  const a = initPoolAnalytics(pool);
  const category = classifyErrorCategory(code, message);
  a.errorEvents.push({
    at: now,
    category,
    code: String(code ?? 'UNKNOWN'),
    ref: ref || pool.state.lastUsed || '',
  });
  if (a.errorEvents.length > MAX_RING_BUFFER) {
    a.errorEvents.shift();
  }
}

/**
 * Records a completed request outcome in the pool's 24h analytics buffer.
 */
export function recordRequestOutcome(pool, outcome, now = Date.now()) {
  if (!pool?.state) return;
  const a = initPoolAnalytics(pool);

  const entry = {
    at: now,
    ref: outcome.ref || pool.state.lastUsed || '',
    success: outcome.success !== false,
    attempts: Number(outcome.attempts) || 1,
    failovers: Number(outcome.failovers) || 0,
    cascaded: Boolean(outcome.cascaded),
  };

  a.requests.push(entry);
  if (a.requests.length > MAX_RING_BUFFER) {
    a.requests.shift();
  }
}

/**
 * Computes 24h analytics snapshot for the pool.
 */
export function compute24hAnalytics(pool, now = Date.now()) {
  const cutoff = now - DAY_MS;
  const a = pool?.state?.analytics24h;
  const requests = a?.requests?.filter(r => r.at >= cutoff) ?? [];
  const errorEvents = a?.errorEvents?.filter(e => e.at >= cutoff) ?? [];

  const totalRequests = requests.length;
  let firstAttemptSuccesses = 0;
  let cascades = 0;
  const keyCounts = new Map();
  const errors = {
    rateLimit: 0,
    server: 0,
    timeout: 0,
    quota: 0,
    auth: 0,
    other: 0,
  };

  for (const r of requests) {
    if (r.ref) {
      keyCounts.set(r.ref, (keyCounts.get(r.ref) ?? 0) + 1);
    }
    if (r.success && r.attempts <= 1 && r.failovers === 0) {
      firstAttemptSuccesses++;
    }
    if (r.cascaded) {
      cascades++;
    }
  }

  for (const ev of errorEvents) {
    if (ev.category && errors[ev.category] != null) {
      errors[ev.category]++;
    }
  }

  // Calculate load distribution across pool refs
  const refs = pool?.refs ?? [...keyCounts.keys()];
  const loadDistribution = refs.map(ref => {
    const count = keyCounts.get(ref) ?? 0;
    const pct = totalRequests > 0 ? Math.round((count / totalRequests) * 100) : 0;
    return { ref, count, pct };
  });

  const totalErrors = Object.values(errors).reduce((sum, n) => sum + n, 0);

  // Compute average cooldown recovery time from pool.state.events
  let cooldownTotalMs = 0;
  let cooldownCount = 0;
  const events = pool?.state?.events ?? [];
  for (const ev of events) {
    if (ev.at >= cutoff && ev.type === 'fail' && Number.isFinite(ev.cooldownMs) && ev.cooldownMs > 0) {
      cooldownTotalMs += ev.cooldownMs;
      cooldownCount++;
    }
  }
  const avgCooldownRecoveryMs = cooldownCount > 0 ? Math.round(cooldownTotalMs / cooldownCount) : 0;

  // Health index: % of requests handled without retries or failover
  const healthIndexPct = totalRequests > 0
    ? Math.round((firstAttemptSuccesses / totalRequests) * 100)
    : 100;

  return {
    totalRequests,
    firstAttemptSuccesses,
    healthIndexPct,
    loadDistribution,
    errorBreakdown: {
      ...errors,
      total: totalErrors,
    },
    cascades: Math.max(cascades, pool?.state?.cascadeCount ?? 0),
    avgCooldownRecoveryMs,
  };
}

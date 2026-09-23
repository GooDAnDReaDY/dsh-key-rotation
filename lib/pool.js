import { bestEffort } from './best-effort.js';
// lib/pool.js — pure pool arithmetic and selection logic for dsh-key-rotation.
// Isolated from cordis/dsh runtime so unit tests run in vanilla Node.js.

/** Number of characters shown in masked key tails. */
export const KEY_TAIL_CHARS = 5;

/** Mask key to show only the last KEY_TAIL_CHARS. */
export function keyTail(key) {
  if (typeof key !== 'string') return '';
  if (key.length <= KEY_TAIL_CHARS) return key;
  return key.slice(-KEY_TAIL_CHARS);
}

/** Check if an IP address is a loopback address. */
export function isLoopbackAddress(ip) {
  if (!ip || typeof ip !== 'string') return false;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  if (/^127(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(ip) && ip.split('.').every(part => Number(part) <= 255)) return true;
  return false;
}

/** Check if an incoming HTTP request is from a trusted local bridge origin. */
export function isTrustedBridgeRequest(req) {
  const remoteAddress = req?.socket?.remoteAddress;
  if (!isLoopbackAddress(remoteAddress)) return false;
  const origin = req?.headers?.origin;
  if (!origin) return true;
  if (req?.headers?.['sec-fetch-site'] === 'cross-site') return false;
  const hostHeader = req?.headers?.host;
  if (!hostHeader) return false;
  try {
    const originUrl = new URL(origin);
    if (originUrl.host !== hostHeader) return false;
    const hostname = originUrl.hostname.replace(/^\[|\]$/g, '');
    return ['http:', 'https:'].includes(originUrl.protocol) && (isLoopbackAddress(hostname) || hostname === 'localhost');
  } catch (_) {
    return false;
  }
}

/** Regex matching error phrases that warrant switching to the next key. */
export const SWITCHABLE_MESSAGE_PATTERN = new RegExp([
  /\b(?:quota|usage[\s_-]+limit|rate[\s_-]?limit)\b/i,
  /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i,
  /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i,
  /\b(?:exceeded|exhausted)[\s_-]+(?:quota|limit|budget)\b/i,
  /\bbilling\b/i,
  /\bresource[\s_-]+exhausted\b/i,
  /\bcapacity[\s_-]+(?:limit|exceeded|reached)\b/i,
  /\bfree[\s_-]+tier[\s_-]+(?:limit|exceeded)\b/i,
  /\bconcurrent[\s_-]+(?:requests?|limit)[\s_-]+exceeded\b/i,
  /\b429\b|\b5\d\d\b/i,
  /\btime(?:d)?\s*out\b|timeout/i,
  /\b(?:network|connection|socket|fetch|ECONN[A-Z]+)\b/i,
  /\bother side closed|premature close|stream ended (?:before|without)\b/i,
  /\b401\b|\b403\b/i,
  /\b(?:invalid|expired|revoked|unauthorized)[\s_-]+(?:api[\s_-]?key|token)\b/i,
  /\bapi[\s_-]?key[\s_-]+(?:is[\s_-]+)?(?:invalid|expired|revoked|unauthorized)\b/i,
  /\b(?:authentication|unauthorized|not[\s_-]+authorized)\b/i,
  /\b(?:overloaded|server[\s_-]+busy)\b/i,
].map((r) => r.source).join('|'), 'i');

/** Default switch codes used by lib/index.js. */
export const DEFAULT_SWITCH_CODES = [
  'QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
  'EMPTY_RESPONSE', 'UNKNOWN_MODEL', 'AUTH',
];

/** Soft failure codes: transient infrastructure drops where progressive exponential penalty is unwarranted. */
export const SOFT_FAILURE_CODES = new Set([
  'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', '500', '502', '503', '504',
]);

/** True if failure code or message represents a soft/transient drop. */

/** Ref name validator. Same rule lib/index.js enforces in PUT/DELETE /key. */
const REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function isValidRef(ref) {
  return typeof ref === 'string' && REF_RE.test(ref);
}

/** Apply full jitter to a duration (+- factor, e.g. +-12.5%). */
export function applyJitter(ms, factor = 0.125) {
  if (!Number.isFinite(ms) || ms <= 0) return ms;
  const spread = (Math.random() * 2 - 1) * factor; // -factor .. +factor
  return Math.max(100, Math.round(ms * (1 + spread)));
}

/** Pick the next healthy ref in a round-robin pool. */
export function pickNext(pool, now, refsCount = pool.refs.length) {
  if (refsCount === 0) return undefined;
  const start = pool.state.pointer ?? 0;
  for (let i = 0; i < refsCount; i++) {
    const index = (start + i) % refsCount;
    const candidate = pool.refs[index];
    const until = pool.state.failedUntil.get(candidate);
    if (until !== undefined && until > now) continue;
    return candidate;
  }
  return undefined; // all cooled
}

/** Apply a failed-key cooldown to pool state. Pure: returns next state shape. */
export function applyCooldown(pool, ref, cooldownMs, now = Date.now()) {
  return {
    ...pool,
    state: {
      ...pool.state,
      failedUntil: new Map(pool.state.failedUntil).set(ref, now + cooldownMs),
    },
  };
}

/**
 * Backoff calculation with soft/hard failure support.
 * failCount 1 => baseMs, 2 => baseMs*2, 3 => baseMs*4, capped at baseMs*8 (or maxMs).
 * Soft failures use a short base cooldown without exponential multiplier.
 */
export function computeBackoff(baseMs, failCount, maxMs, isSoft = false) {
  if (isSoft) {
    return Math.min(baseMs, 10000);
  }
  const cap = maxMs ?? baseMs * 8;
  if (failCount <= 1) return Math.min(baseMs, cap);
  // Bit shifts wrap/sign-flip at 32 failures. Floating-point exponentiation
  // saturates at Infinity, which the configured cap safely bounds.
  const backoff = baseMs === 0 ? 0 : baseMs * (2 ** (failCount - 1));
  return Math.min(backoff, cap);
}

/** Record a failure for `ref` in `pool.state`. */
export function recordFailure(pool, ref, now, baseMs, maxMs, isSoft = false, jitter = false) {
  if (!pool.state.failCounts) pool.state.failCounts = new Map();
  let next = pool.state.failCounts.get(ref) ?? 0;
  if (!isSoft) {
    next += 1;
    pool.state.failCounts.set(ref, next);
  }
  let backoff = computeBackoff(baseMs, next || 1, maxMs, isSoft);
  if (jitter) {
    backoff = applyJitter(backoff);
  }
  pool.state.failedUntil.set(ref, now + backoff);
  return backoff;
}

/** Record a success for `ref`. */
export function recordSuccess(pool, ref, now = Date.now()) {
  if (pool.state.failCounts) pool.state.failCounts.delete(ref);
  pool.state.failedUntil.delete(ref);
  if (!pool.state.lastSuccessAt) pool.state.lastSuccessAt = new Map();
  pool.state.lastSuccessAt.set(ref, now);
}

/** Decay penalty failCounts for stable keys that haven't failed in decayIntervalMs. */
export function decayPenalties(pool, now = Date.now(), decayIntervalMs = 3600_000) {
  if (!pool?.state?.failCounts || !pool?.state?.lastSuccessAt) return 0;
  let decayed = 0;
  for (const [ref, count] of [...pool.state.failCounts.entries()]) {
    if (count <= 0) {
      pool.state.failCounts.delete(ref);
      continue;
    }
    const lastOk = pool.state.lastSuccessAt.get(ref);
    if (lastOk && now - lastOk >= decayIntervalMs) {
      const next = count - 1;
      if (next <= 0) {
        pool.state.failCounts.delete(ref);
      } else {
        pool.state.failCounts.set(ref, next);
      }
      pool.state.lastSuccessAt.set(ref, now);
      decayed++;
    }
  }
  return decayed;
}

/** Return env value for ref if present in process.env, else undefined. */
export function envValue(ref) {
  const v = typeof process !== 'undefined' ? process.env?.[ref] : undefined;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Sweep expired cooldown entries and prune stale deleted refs from poolState. Returns count of cleared refs. */
export function sweepExpired(poolState, now = Date.now(), activeRefs = null) {
  let cleared = 0;
  const activeSet = activeRefs ? new Set(activeRefs) : null;
  for (const st of poolState.values()) {
    // #338: decay penalty failCounts for stable keys in maintenance sweep
    decayPenalties({ state: st }, now);
    for (const [ref, until] of [...st.failedUntil.entries()]) {
      if (until <= now) {
        st.failedUntil.delete(ref);
        st.failCounts?.delete(ref);
        st.quotaWindows?.delete(ref);
        cleared++;
      }
    }
    // Prune stale entries for keys no longer in active configuration
    if (activeSet) {
      for (const map of [st.failedUntil, st.failCounts, st.authFailCounts, st.brokenUntil, st.costPerKey, st.lastUsedAt, st.usageCounts, st.byModel, st.usageDays, st.quotaWindows, st.rpmWindows, st.probedAt]) {
        if (map && typeof map.keys === 'function') {
          for (const k of [...map.keys()]) {
            if (!activeSet.has(k)) map.delete(k);
          }
        }
      }
    }
  }
  return cleared;
}

/** Parse Retry-After value from a header string or message. */
export function parseRetryAfter(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const m = value.match(/retry-after\s*[:=]\s*(.+)/i);
  const raw = m ? m[1].trim().split(/[\n\r;]/)[0].trim() : value.trim();
  if (/^\d+$/.test(raw)) {
    const sec = Number(raw);
    if (sec >= 0 && sec <= 86400 * 7) return sec * 1000;
  }
  const ts = Date.parse(raw);
  if (!Number.isNaN(ts)) {
    const diff = ts - Date.now();
    if (diff > 0 && diff < 86400 * 7 * 1000) return diff;
  }
  return undefined;
}

/** Pick a key pool for a (provider, model) pair. */
export function selectPool(modelPoolByProvider, providerToPool, provider, model) {
  const byModel = modelPoolByProvider && modelPoolByProvider.get(provider);
  const base = providerToPool && providerToPool.get(provider);
  if (!byModel || !model) return base ?? null;
  if (byModel.has(model)) return byModel.get(model);
  let best = null;
  for (const key of byModel.keys()) {
    if (model.startsWith(key) && key.length > (best ? best.length : 0)) best = key;
  }
  return (best ? byModel.get(best) : base) ?? null;
}

/** Parse an expiry value (timestamp ms or ISO date string) to epoch ms. */
export function parseExpiry(v) {
  if (typeof v === 'number' && v > 0) return v;
  if (typeof v === 'string' && v.length > 0) { const ts = Date.parse(v); return Number.isNaN(ts) ? undefined : ts; }
  return undefined;
}

/** Compute a 0..100 health score for a pool based on its runtime state. */
export function computeHealthScore(state) {
  if (!state || typeof state !== 'object') return 100;
  const switches = state.switches ?? 0;
  const exhaustions = state.exhaustionCount ?? 0;
  const broken = state.brokenUntil ? state.brokenUntil.size : 0;
  return Math.max(0, Math.min(100, 100 - (switches * 5) - (exhaustions * 10) - (broken * 15)));
}

/** Extract rate-limit info from an object that may carry response headers. */
export function extractRateLimit(headers) {
  if (!headers || typeof headers !== 'object') return null;
  let remaining, limit, reset, retryAfter;
  for (const k in headers) {
    const lower = k.toLowerCase();
    const v = headers[k];
    if (v == null) continue;
    if (lower === 'retry-after') {
      const num = Number(v);
      if (Number.isFinite(num) && num >= 0) {
        retryAfter = Math.ceil(num);
      } else {
        const parsed = Date.parse(v);
        if (!Number.isNaN(parsed)) {
          retryAfter = Math.max(0, Math.ceil((parsed - Date.now()) / 1000));
        }
      }
    } else if (
      lower === 'x-ratelimit-remaining' ||
      lower === 'x-ratelimit-remaining-requests' ||
      lower === 'anthropic-ratelimit-requests-remaining' ||
      lower === 'openai-ratelimit-remaining-requests' ||
      lower === 'ratelimit-remaining'
    ) {
      const n = Number(String(v));
      if (Number.isFinite(n)) remaining = n;
    } else if (
      (lower === 'x-ratelimit-remaining-tokens' || lower === 'anthropic-ratelimit-tokens-remaining') &&
      remaining === undefined
    ) {
      const n = Number(String(v));
      if (Number.isFinite(n)) remaining = n;
    } else if (
      lower === 'x-ratelimit-limit' ||
      lower === 'x-ratelimit-limit-requests' ||
      lower === 'anthropic-ratelimit-requests-limit' ||
      lower === 'openai-ratelimit-limit-requests' ||
      lower === 'ratelimit-limit'
    ) {
      const n = Number(String(v));
      if (Number.isFinite(n)) limit = n;
    } else if (
      lower === 'x-ratelimit-reset' ||
      lower === 'x-ratelimit-reset-requests' ||
      lower === 'anthropic-ratelimit-requests-reset' ||
      lower === 'ratelimit-reset'
    ) {
      const n = Number(String(v));
      if (Number.isFinite(n)) {
        reset = n;
      } else {
        const parsed = Date.parse(v);
        if (!Number.isNaN(parsed)) reset = parsed;
      }
    }
  }
  if (remaining === undefined && limit === undefined && retryAfter === undefined && reset === undefined) return null;
  const out = { remaining, limit, reset };
  if (retryAfter !== undefined) out.retryAfter = retryAfter;
  return out;
}

/** True if remaining is below the given threshold fraction of limit (e.g. 0.1) or retry-after is active. */
export function isRateLimited(rate, threshold = 0.1) {
  if (!rate) return false;
  if (typeof rate.retryAfter === 'number' && rate.retryAfter > 0) return true;
  if (rate.remaining !== undefined && rate.remaining <= 1) return true;
  if (rate.limit && rate.limit > 0 && rate.remaining !== undefined) {
    return rate.remaining < rate.limit * threshold;
  }
  if (rate.remaining !== undefined) return rate.remaining <= 0;
  return false;
}

/**
 * Sort or prioritize an attempt list of refs according to routing strategy.
 * Strategies:
 * - 'round-robin': preserves order
 * - 'least-loaded': keys with lowest active concurrency count first
 * - 'lowest-latency': keys with lowest p95 (or avg) latency first; unsampled keys neutral
 */
export function sortAttemptList(refs, strategy = 'round-robin', deps = {}) {
  if (!Array.isArray(refs) || refs.length <= 1) return (refs ?? []).slice();
  const list = refs.slice();
  if (strategy === 'least-loaded' && deps.concurrencyTracker && typeof deps.concurrencyTracker.getActive === 'function') {
    return list.sort((a, b) => {
      const ca = deps.concurrencyTracker.getActive(a) ?? 0;
      const cb = deps.concurrencyTracker.getActive(b) ?? 0;
      return ca - cb;
    });
  }
  if (strategy === 'lowest-latency' && deps.latencyHistogram && typeof deps.latencyHistogram.snapshot === 'function') {
    return list.sort((a, b) => {
      const sa = deps.latencyHistogram.snapshot(a);
      const sb = deps.latencyHistogram.snapshot(b);
      const la = (sa && Number.isFinite(sa.p95)) ? sa.p95 : ((sa && Number.isFinite(sa.avg)) ? sa.avg : 500);
      const lb = (sb && Number.isFinite(sb.p95)) ? sb.p95 : ((sb && Number.isFinite(sb.avg)) ? sb.avg : 500);
      return la - lb;
    });
  }
  return list;
}

/**
 * Unified check whether an error or payload represents a switchable failure.
 * Prioritizes explicit HTTP status codes and gRPC codes before text matching.
 */
export function isSwitchableError(failureOrPayload, switchCodes = new Set(DEFAULT_SWITCH_CODES)) {
  if (!failureOrPayload) return false;
  // Runtime switch codes arrive as an array (cfg.switchCodes is a schema array,
  // and DEFAULT_SWITCH_CODES is exported as an array); normalize before .has().
  if (!(switchCodes instanceof Set)) switchCodes = new Set(Array.isArray(switchCodes) ? switchCodes : DEFAULT_SWITCH_CODES);
  const failure = failureOrPayload.failure ?? failureOrPayload;
  const status = Number(failure.status ?? failure.statusCode ?? failure.httpStatus ?? 0);
  const code = String(failure.code ?? failure.reason ?? '').toUpperCase();
  const message = String(failure.message ?? failureOrPayload.message ?? '');

  // 1. Direct HTTP status codes (#267: also 408/425 transient)
  if ((status === 429 || status === 408 || status === 425) && (switchCodes.has('RATE_LIMIT') || switchCodes.has('QUOTA') || switchCodes.has('429') || switchCodes.has('TIMEOUT') || switchCodes.has(String(status)))) return true;
  if ((status === 401 || status === 403) && (switchCodes.has('AUTH') || switchCodes.has('401'))) return true;
  if ((status >= 500 && status <= 504) && (switchCodes.has('SERVER') || switchCodes.has(String(status)))) return true;

  // 2. Standard gRPC / cloud error codes
  if (code === 'RESOURCE_EXHAUSTED' && (switchCodes.has('QUOTA') || switchCodes.has('RATE_LIMIT'))) return true;
  if ((code === 'UNAVAILABLE' || code === 'INTERNAL') && switchCodes.has('SERVER')) return true;
  if (code === 'DEADLINE_EXCEEDED' && switchCodes.has('TIMEOUT')) return true;
  if ((code === 'UNAUTHENTICATED' || code === 'PERMISSION_DENIED') && switchCodes.has('AUTH')) return true;

  // 3. Named switch code matching
  if (code && switchCodes.has(code)) return true;

  // 4. Fallback text pattern matching
  return SWITCHABLE_MESSAGE_PATTERN.test(message);
}

/**
 * Format an informative user-facing exhaustion message with recovery countdown.
 */
export function formatExhaustionMessage(provider, pool, now = Date.now()) {
  const list = pool.refs ?? [];
  const total = list.length;
  let minWaitMs = Infinity;
  if (pool.state && pool.state.failedUntil) {
    for (const ref of list) {
      const until = pool.state.failedUntil.get(ref) ?? 0;
      if (until > now) {
        const wait = until - now;
        if (wait < minWaitMs) minWaitMs = wait;
      }
    }
  }
  const sec = Number.isFinite(minWaitMs) && minWaitMs > 0 ? Math.ceil(minWaitMs / 1000) : 60;
  return `[dsh-key-rotation] All ${total} keys for provider '${provider}' are temporarily exhausted. Next key recovers in ~${sec}s.`;
}


/**
 * Keys of pool whose expiresAt falls within the next warnDays.
 * Returns [{ ref, expiresInDays, expiresAt }], soonest first.
 */
export function expiringSoon(pool, warnDays = 7, now = Date.now()) {
  if (!pool || !pool.expiresAt) return [];
  const DAY_MS = 86400000;
  const horizon = now + Math.max(1, warnDays) * DAY_MS;
  return Object.entries(pool.expiresAt)
    .filter(([, at]) => at > now && at <= horizon)
    .map(([ref, at]) => ({ ref, expiresAt: at, expiresInDays: Math.max(0, Math.floor((at - now) / DAY_MS)) }))
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

/** Dedupe: true when a day-level notification for key is due. */
export function shouldNotifyDaily(lastNotified, key, now = Date.now()) {
  const DAY_MS = 86400000;
  if (!lastNotified.has(key)) {
    lastNotified.set(key, now);
    return true;
  }
  const last = lastNotified.get(key);
  if (now - last < DAY_MS) return false;
  lastNotified.set(key, now);
  return true;
}

/** Total spend of a pool on ISO day day (defaults to today) across costDays Map<ref, Map<day, cost>>. */
export function costForDay(costDays, day) {
  const d = day ?? new Date().toISOString().slice(0, 10);
  let total = 0;
  for (const perRef of (costDays?.values() ?? [])) {
    total += perRef.get(d) ?? 0;
  }
  return total;
}

/** Total spend over the last 7 ISO days ending today. */
export function costForWeek(costDays, now = Date.now()) {
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    total += costForDay(costDays, d);
  }
  return total;
}

/** Budget verdict for a pool: { spend, budget, ratio, warn, exceeded }. */
export function budgetVerdict(spend, budget) {
  if (!budget || budget <= 0) return { spend, budget: 0, ratio: 0, warn: false, exceeded: false };
  const ratio = spend / budget;
  return { spend, budget, ratio, warn: ratio >= 0.8, exceeded: ratio >= 1 };
}


/** Safely reset a provider's circuit breaker to closed state. */
export function resetCircuitForProvider(circuitBreaker, provider) {
  if (!circuitBreaker || !provider) return false;
  const ok = bestEffort('resetCircuitForProvider', () => {
    if (typeof circuitBreaker.reset === 'function') {
      circuitBreaker.reset(provider);
      return true;
    }
    if (typeof circuitBreaker.onSuccess === 'function') {
      circuitBreaker.onSuccess(provider);
      return true;
    }
    return false;
  });
  return ok === true;
}

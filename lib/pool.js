import { resetModelQuotaIfNeeded } from './model-quota.js';
import { decryptSecret } from './crypto-storage.js';
import { bestEffort } from './best-effort.js';
// lib/pool.js — pure pool arithmetic and selection logic for dsh-key-rotation.
// Isolated from cordis/dsh runtime so unit tests run in vanilla Node.js.

/** Number of characters shown in masked key tails. */
export const KEY_TAIL_CHARS = 5;

/** Fixed placeholder for short credentials (len <= KEY_TAIL_CHARS) to prevent disclosure (#355). */
export const KEY_TAIL_PLACEHOLDER = '***';

/** Mask key to show only the last KEY_TAIL_CHARS; returns placeholder for short keys (#355). */
export function keyTail(key) {
  if (typeof key !== 'string' || key.length === 0) return '';
  const plain = decryptSecret(key);
  if (plain.length <= KEY_TAIL_CHARS) return KEY_TAIL_PLACEHOLDER;
  return plain.slice(-KEY_TAIL_CHARS);
}

/** Check if an IP address is a loopback address. */
export function isLoopbackAddress(ip) {
  if (!ip || typeof ip !== 'string') return false;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  if (/^127(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(ip) && ip.split('.').every(part => Number(part) <= 255)) return true;
  return false;
}

/** Strip an optional :port and IPv6 brackets from a Host header value. */
function hostNameOf(hostHeader) {
  return String(hostHeader).replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

/** Check if an incoming HTTP request is from a trusted local bridge origin (#353 fail-closed, #378 method-aware). */
export function isTrustedBridgeRequest(req) {
  const remoteAddress = req?.socket?.remoteAddress;
  if (!isLoopbackAddress(remoteAddress)) return false;
  if (req?.headers?.['sec-fetch-site'] === 'cross-site') return false;
  const hostHeader = req?.headers?.host;
  if (!hostHeader) return false;
  const hostName = hostNameOf(hostHeader);
  if (!(isLoopbackAddress(hostName) || hostName === 'localhost')) return false;

  const origin = req?.headers?.origin;
  if (origin === undefined) {
    // Official Desktop build forwards requests via forwardWebRequest which strips Origin (#465 / GitHub #22).
    // Real browsers unconditionally send Origin on cross-origin mutations, so an absent Origin cannot originate
    // from a malicious website. Peer address and Host header are already verified loopback above.
    return true;
  }
  if (!origin) return false; // Explicit empty string or null-like falsy
  try {
    const originUrl = new URL(origin);
    // Official Desktop build shell origin
    if (originUrl.protocol === 'dsh-app:' && (originUrl.host === 'app' || originUrl.hostname === 'app')) {
      return true;
    }
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
export function isSoftFailureCode(code) {
  if (!code) return false;
  return SOFT_FAILURE_CODES.has(String(code).toUpperCase());
}

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
export function sweepExpired(poolState, now = Date.now(), activeRefs = null, quotaResetWindow = null) {
  let cleared = 0;
  const activeSet = activeRefs ? new Set(activeRefs) : null;
  for (const st of poolState.values()) {
    // #338: decay penalty failCounts for stable keys in maintenance sweep
    decayPenalties({ state: st }, now);
    for (const [ref, until] of [...st.failedUntil.entries()]) {
      if (until <= now) {
        st.failedUntil.delete(ref);
        st.quotaWindows?.delete(ref);
        cleared++;
      }
    }
    // Local model token budgets roll over on their own wall-clock window, never
    // on a cooldown. Recomputing the boundary here keeps a long-lived idle pool
    // from carrying an expired resetAt until its next request.
    if (st.tokenUsage instanceof Map && quotaResetWindow) {
      for (const ref of [...st.tokenUsage.keys()]) {
        resetModelQuotaIfNeeded({ state: st, quotaResetWindow }, ref, quotaResetWindow, now);
      }
    }
    // Prune stale entries for keys no longer in active configuration
    if (activeSet) {
      for (const map of [st.failedUntil, st.failCounts, st.authFailCounts, st.brokenUntil, st.costPerKey, st.lastUsedAt, st.usageCounts, st.byModel, st.usageDays, st.quotaWindows, st.rpmWindows, st.probedAt, st.tokenUsage]) {
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


/** Parse duration strings (e.g. '1.5s', '500ms', '2m', '1h'), numbers, or ISO dates into seconds. */
export function parseDurationToSeconds(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return null;
    return v;
  }
  if (!v || typeof v !== 'string') return null;
  const s = v.trim();
  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h|d)?$/i);
  if (m) {
    const val = parseFloat(m[1]);
    const unit = (m[2] || 's').toLowerCase();
    if (unit === 'ms') return val / 1000;
    if (unit === 's') return val;
    if (unit === 'm') return val * 60;
    if (unit === 'h') return val * 3600;
    if (unit === 'd') return val * 86400;
  }
  const dt = Date.parse(s);
  if (!Number.isNaN(dt)) {
    return Math.max(0, (dt - Date.now()) / 1000);
  }
  return null;
}

/** Check if a key reference is in maintenance/paused mode. */
export function isKeyPaused(pool, ref) {
  if (!pool || !ref) return false;
  if (pool.pausedRefs instanceof Set && pool.pausedRefs.has(ref)) return true;
  if (Array.isArray(pool.pausedRefs) && pool.pausedRefs.includes(ref)) return true;
  if (pool.state && pool.state.pausedRefs instanceof Set && pool.state.pausedRefs.has(ref)) return true;
  if (pool.state && Array.isArray(pool.state.pausedRefs) && pool.state.pausedRefs.includes(ref)) return true;
  if (pool.basePool) return isKeyPaused(pool.basePool, ref);
  return false;
}

/** Extract rate-limit info from an object that may carry response headers. */
export function extractRateLimit(headers) {
  if (!headers || typeof headers !== 'object') return null;
  let remaining, limit, reset, resetMs, retryAfter;
  for (const k in headers) {
    const lower = k.toLowerCase();
    const v = headers[k];
    if (v == null) continue;
    if (lower === 'retry-after') {
      const dur = parseDurationToSeconds(v);
      if (dur !== null) retryAfter = Math.ceil(dur);
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
      (lower === 'x-ratelimit-remaining-tokens' || lower === 'anthropic-ratelimit-tokens-remaining' || lower === 'openai-ratelimit-remaining-tokens') &&
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
      lower === 'x-ratelimit-reset-tokens' ||
      lower === 'anthropic-ratelimit-requests-reset' ||
      lower === 'anthropic-ratelimit-tokens-reset' ||
      lower === 'ratelimit-reset'
    ) {
      const dur = parseDurationToSeconds(v);
      if (dur !== null) {
        if (dur > 1000000000) {
          const epochMs = dur > 100000000000 ? dur : dur * 1000;
          reset = dur;
          resetMs = Math.max(0, epochMs - Date.now());
        } else {
          reset = dur;
          resetMs = Math.max(0, Math.round(dur * 1000));
        }
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
    const weights = deps.weights || (deps.pool && deps.pool.weightsMap) || {};
    return list.sort((a, b) => {
      const ca = deps.concurrencyTracker.getActive(a) ?? 0;
      const cb = deps.concurrencyTracker.getActive(b) ?? 0;
      const wa = (weights[a] && Number(weights[a]) > 0) ? Number(weights[a]) : 1;
      const wb = (weights[b] && Number(weights[b]) > 0) ? Number(weights[b]) : 1;
      const scoreA = ca / wa;
      const scoreB = cb / wb;
      if (scoreA !== scoreB) return scoreA - scoreB;
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
/** Raw socket-level codes the taxonomy maps to TRANSPORT (see classifyFailure). */
const SOCKET_TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
  'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * Codes isSwitchableError/classifyFailure recognize. Once a failure
 * carries one of these, the operator's switchCodes verdict is final and the
 * message-regex fallback must not run (it would resurrect excluded codes).
 */
const RECOGNIZED_SWITCH_CODES = new Set([
  'QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE',
  'UNKNOWN_MODEL', 'AUTH', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL',
  'DEADLINE_EXCEEDED', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'ABORTED',
  'LOCAL_POOL_EXHAUSTED', 'LOCAL_MODEL_QUOTA_EXHAUSTED', 'CIRCUIT_OPEN',
  '429', '401', '403', '408', '425', '500', '502', '503', '504',
]);

export function isSwitchableError(failureOrPayload, switchCodes = new Set(DEFAULT_SWITCH_CODES)) {
  if (!failureOrPayload) return false;
  // Runtime switch codes arrive as an array (cfg.switchCodes is a schema array,
  // and DEFAULT_SWITCH_CODES is exported as an array); normalize before .has().
  if (!(switchCodes instanceof Set)) switchCodes = new Set(Array.isArray(switchCodes) ? switchCodes : DEFAULT_SWITCH_CODES);
  const failure = failureOrPayload.failure ?? failureOrPayload;
  const status = Number(failure.status ?? failure.statusCode ?? failure.httpStatus ?? 0);
  let code = String(failure.code ?? failure.reason ?? '').toUpperCase();
  if (code && SOCKET_TRANSPORT_CODES.has(code)) code = 'TRANSPORT';
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

  // 4. Fallback text pattern matching — switchCodes is the operator's
  // explicit contract for which failures rotate keys. Once the failure has a
  // recognized code, that decision is final: message sniffing must not
  // resurrect codes the operator deliberately excluded (e.g. TIMEOUT).
  if (code && RECOGNIZED_SWITCH_CODES.has(code)) return false;
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

/** Check if a key reference is permanently revoked due to auth/401 failure (#369). */
export function isKeyRevoked(pool, ref) {
  if (!pool || !ref) return false;
  if (pool.revokedRefs instanceof Set && pool.revokedRefs.has(ref)) return true;
  if (Array.isArray(pool.revokedRefs) && pool.revokedRefs.includes(ref)) return true;
  if (pool.state && pool.state.revokedRefs instanceof Set && pool.state.revokedRefs.has(ref)) return true;
  if (pool.state && Array.isArray(pool.state.revokedRefs) && pool.state.revokedRefs.includes(ref)) return true;
  if (pool.basePool) return isKeyRevoked(pool.basePool, ref);
  return false;
}

/** Check if a key reference is in active recoverable or permanent quarantine (#427). */
export function isKeyBroken(pool, ref, now = Date.now()) {
  if (!pool || !ref) return false;
  const bu = pool.state?.brokenUntil?.get(ref);
  if (bu !== undefined && bu > now) return true;
  if (pool.basePool) return isKeyBroken(pool.basePool, ref, now);
  return false;
}

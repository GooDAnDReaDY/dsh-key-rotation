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
  if (ip.startsWith('127.')) return true;
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
    return isLoopbackAddress(originUrl.hostname) || originUrl.hostname === 'localhost';
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
  /\b429\b|\b5\d\d\b/i,
  /\btime(?:d)?\s*out\b|timeout/i,
  /\b(?:network|connection|socket|fetch|ECONN[A-Z]+)\b/i,
  /\bother side closed|premature close|stream ended (?:before|without)\b/i,
  /\b401\b|\b403\b/i,
  /\b(?:invalid|expired|revoked|unauthorized)[\s_-]+(?:api[\s_-]?key|token)\b/i,
  /\bapi[\s_-]?key[\s_-]+(?:is[\s_-]+)?(?:invalid|expired|revoked|unauthorized)\b/i,
  /\b(?:authentication|unauthorized|not[\s_-]+authorized)\b/i,
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
export function isSoftFailure(code, message = '') {
  if (code && SOFT_FAILURE_CODES.has(String(code).toUpperCase())) return true;
  if (/502|503|504|timeout|econnreset|econnrefused|socket hang up/i.test(message)) return true;
  return false;
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
  const backoff = baseMs * (1 << (failCount - 1)); // 2^(n-1)
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

/** Sweep expired cooldown entries from poolState. Returns count of cleared refs. */
export function sweepExpired(poolState, now = Date.now()) {
  let cleared = 0;
  for (const st of poolState.values()) {
    for (const [ref, until] of [...st.failedUntil.entries()]) {
      if (until <= now) {
        st.failedUntil.delete(ref);
        st.failCounts?.delete(ref);
        cleared++;
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
  const get = (name) => {
    const v = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
    if (v === undefined || v === null) return undefined;
    return Number(String(v));
  };
  const remaining = get('X-RateLimit-Remaining');
  const limit = get('X-RateLimit-Limit');
  const reset = get('X-RateLimit-Reset');
  if (remaining === undefined && limit === undefined) return null;
  return { remaining, limit, reset };
}

/** True if remaining is below the given threshold fraction of limit (e.g. 0.1). */
export function isRateLimited(rate, threshold = 0.1) {
  if (!rate) return false;
  if (rate.remaining === undefined) return false;
  if (rate.limit && rate.limit > 0) return rate.remaining < rate.limit * threshold;
  return rate.remaining <= 0;
}
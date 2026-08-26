// Pure helpers for the key-rotation plugin. Kept free of DSH runtime
// dependencies so they can be unit-tested under `node --test` without
// `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` being installed.
// Anything that talks to `ctx` stays in lib/index.js.

/** Number of trailing characters of a key shown in the UI for disambiguation. */
export const KEY_TAIL_CHARS = 5;

/** Returns the last KEY_TAIL_CHARS characters of a key, or the whole key if shorter. */
export function keyTail(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.length <= KEY_TAIL_CHARS ? value : value.slice(-KEY_TAIL_CHARS);
}

/** True if a socket remoteAddress is a loopback (v4 / v6). */
export function isLoopbackAddress(address) {
  if (address === undefined || address === null) return false;
  if (address === '127.0.0.1' || address === '::1') return true;
  if (typeof address === 'string' && address.startsWith('::ffff:')) {
    return address.slice(7) === '127.0.0.1';
  }
  return false;
}

/** True if a request is both loopback and same-origin (sec-fetch-site guard). */
export function isTrustedBridgeRequest(request) {
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) return false;
  if (request?.headers?.['sec-fetch-site'] === 'cross-site') return false;
  const origin = request?.headers?.origin;
  if (origin === undefined) return true; // no Origin header (loopback tool) is allowed
  try {
    const host = request?.headers?.host;
    if (host === undefined) return false;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Compiled once at module load. Matches error messages that should rotate the key
 *  even when the structured failure code is not in `switchCodes`.
 *  Mirrors SWITCHABLE_MESSAGE_PATTERN in lib/index.js exactly. */
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

/** Default switch codes used by lib/index.js. Kept here so tests assert against
 *  the same list the runtime ships. */
export const DEFAULT_SWITCH_CODES = [
  'QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
  'EMPTY_RESPONSE', 'UNKNOWN_MODEL', 'AUTH',
];

/** Ref name validator. Same rule lib/index.js enforces in PUT/DELETE /key. */
const REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function isValidRef(ref) {
  return typeof ref === 'string' && REF_RE.test(ref);
}

/**
 * Pick the next healthy ref in a round-robin pool.
 *
 * @param {{ refs: string[], state: { failedUntil: Map<string, number>, pointer: number } }} pool
 * @param {number} now - epoch milliseconds (injectable for tests)
 * @param {number} refsCount - for tests: number of refs to consider (defaults to pool.refs.length)
 * @returns {string|undefined} the ref to use, or undefined if pool has no refs
 *
 * Mirrors the inline logic in the credentials.resolve patch in lib/index.js.
 * Exported here for unit tests; not used at runtime to avoid duplicating logic.
 */
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

/** Apply a failed-key cooldown to pool state. Pure: returns next state shape,
 *  does not mutate input. Runtime in lib/index.js mutates in place; tests use
 *  this helper to construct expected snapshots. */
export function applyCooldown(pool, ref, cooldownMs, now = Date.now()) {
  return {
    ...pool,
    state: {
      ...pool.state,
      failedUntil: new Map(pool.state.failedUntil).set(ref, now + cooldownMs),
    },
  };
}

/** Exponential backoff for a repeatedly failing key.
 *  failCount 1 => baseMs, 2 => baseMs*2, 3 => baseMs*4, capped at baseMs*8 (or maxMs).
 *  Pure and easily unit-tested. */
export function computeBackoff(baseMs, failCount, maxMs) {
  const cap = maxMs ?? baseMs * 8;
  if (failCount <= 1) return Math.min(baseMs, cap);
  const backoff = baseMs * (1 << (failCount - 1)); // 2^(n-1)
  return Math.min(backoff, cap);
}

/** Record a failure for `ref` in `pool.state`, applying exponential backoff.
 *  Mutates pool.state.failedUntil and pool.state.failCounts. Returns the backoff used. */
export function recordFailure(pool, ref, now, baseMs, maxMs) {
  if (!pool.state.failCounts) pool.state.failCounts = new Map();
  const prev = pool.state.failCounts.get(ref) ?? 0;
  const next = prev + 1;
  pool.state.failCounts.set(ref, next);
  const backoff = computeBackoff(baseMs, next, maxMs);
  pool.state.failedUntil.set(ref, now + backoff);
  return backoff;
}

/** Record a success for `ref` — clears its cooldown and resets its fail count. */
export function recordSuccess(pool, ref) {
  if (pool.state.failCounts) pool.state.failCounts.delete(ref);
  pool.state.failedUntil.delete(ref);
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

/** Parse Retry-After value from a header string or message.
 *  Supports seconds ("60", "Retry-After: 60") and HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT").
 *  Returns milliseconds or undefined if not parseable. */
export function parseRetryAfter(value) {
  if (typeof value !== 'string' || !value) return undefined;
  // Try to extract "Retry-After: <val>" from a larger message
  const m = value.match(/retry-after\s*[:=]\s*(.+)/i);
  const raw = m ? m[1].trim().split(/[\n\r;]/)[0].trim() : value.trim();
  // Seconds
  if (/^\d+$/.test(raw)) {
    const sec = Number(raw);
    if (sec >= 0 && sec <= 86400 * 7) return sec * 1000;
  }
  // HTTP-date
  const ts = Date.parse(raw);
  if (!Number.isNaN(ts)) {
    const diff = ts - Date.now();
    if (diff > 0 && diff < 86400 * 7 * 1000) return diff;
  }
  return undefined;
}

/** Pick a key pool for a (provider, model) pair. Model sub-pools win over the
 *  provider base pool; falls back to the base pool when no sub-pool matches. */
export function selectPool(modelPoolByProvider, providerToPool, provider, model) {
  const byModel = modelPoolByProvider && modelPoolByProvider.get(provider);
  return (byModel && byModel.get(model)) || (providerToPool && providerToPool.get(provider)) || null;
}

/** Parse an expiry value (timestamp ms or ISO date string) to epoch ms. */
export function parseExpiry(v) {
  if (typeof v === 'number' && v > 0) return v;
  if (typeof v === 'string' && v.length > 0) { const ts = Date.parse(v); return Number.isNaN(ts) ? undefined : ts; }
  return undefined;
}

/** Compute a 0..100 health score for a pool based on its runtime state.
 *  Deductions: switches * 5, exhaustions * 10, broken keys * 15. */
export function computeHealthScore(state) {
  if (!state || typeof state !== 'object') return 100;
  const switches = state.switches ?? 0;
  const exhaustions = state.exhaustionCount ?? 0;
  const broken = state.brokenUntil ? state.brokenUntil.size : 0;
  return Math.max(0, Math.min(100, 100 - (switches * 5) - (exhaustions * 10) - (broken * 15)));
}

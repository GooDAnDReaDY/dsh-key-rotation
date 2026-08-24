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

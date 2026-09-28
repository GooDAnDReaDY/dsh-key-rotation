// lib/model-quota.js — locally configured per-(provider × model × credential)
// token budgets: Provider × Credential Key × Model × Token Quota.
//
// Deliberately separate from lib/quota.js (QuotaStore), which mirrors
// *provider-reported* rate-limit headers (x-ratelimit-remaining, retry-after).
// A model token quota is a local budget: "this credential may spend at most N
// tokens on this model pool within the current reset window".
//
// State lives inside the model pool itself (`pool.state.tokenUsage`), and a pool
// is keyed by `provider::model`, so Key × Model isolation is structural: the
// Sonnet pool and the Opus pool never read each other's counters. No composite
// `KEY::model` global key is needed or used.
//
// Everything here is a pure function over pool state: no network, no disk, no
// timers, no implicit clock (callers pass `now`), so `node --test` can exercise
// it directly. Reads never mutate; only `consumeModelTokens()` /
// `resetModelQuotaIfNeeded()` write, and both normalise the entry first.
//
// Timekeeping: `resetAt` is a wall-clock epoch timestamp computed by
// nextQuotaReset() from lib/quota-window.js. Calendar maths must never use the
// monotonic process clock — that is for cooldowns and durations only.

import { nextQuotaReset } from './quota-window.js';

/** Keys that must never be used as a credential ref (prototype pollution guard). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Used when quotaResetWindow is missing or unknown: a plain 24h budget window. */
export const FALLBACK_WINDOW_MS = 86400000;

/** Failure-free token count: a non-negative finite integer, else null. */
function toTokenCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * A usable token limit: a finite number greater than zero.
 * Numeric strings are accepted because a legacy host can hand the raw YAML
 * section to apply() without running it through Schemastery first.
 * Missing, null, non-numeric and non-positive values all mean "no local limit".
 */
function toLimit(value) {
  let n = value;
  if (typeof n === 'string') {
    if (!n.trim()) return null;
    n = Number(n);
  }
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Normalize a `models.<model>.quotas` config object into a frozen lookup.
 *
 * Accepts the documented `{ REF: { tokenLimit: N } }` and the shorthand
 * `{ REF: N }`. Entries without a positive finite limit are dropped, which is
 * what keeps "no quota configured" behaviourally identical to the pre-quota
 * plugin — a missing quota is never read as a zero budget.
 * A null-prototype object keeps a ref literally named `__proto__` harmless.
 */
export function normalizeModelQuotas(quotas) {
  const out = Object.create(null);
  if (!quotas || typeof quotas !== 'object') return Object.freeze(out);
  for (const [ref, value] of Object.entries(quotas)) {
    if (typeof ref !== 'string' || ref.length === 0 || UNSAFE_KEYS.has(ref)) continue;
    const raw = value && typeof value === 'object' ? value.tokenLimit : value;
    const limit = toLimit(raw);
    if (limit === null) continue;
    out[ref] = Object.freeze({ tokenLimit: limit });
  }
  return Object.freeze(out);
}

/** True when this pool carries at least one usable local token quota. */
export function hasModelQuotaConfig(pool) {
  if (!pool) return false;
  if (typeof pool.hasModelQuota === 'boolean') return pool.hasModelQuota;
  const q = pool.quotas;
  return Boolean(q && Object.keys(q).length > 0);
}

/** Configured token limit for `ref` in `pool`, or null when unlimited. */
export function getModelTokenLimit(pool, ref) {
  if (!pool || typeof ref !== 'string' || ref.length === 0) return null;
  const quota = pool.quotas?.[ref];
  if (!quota) return null;
  return toLimit(quota.tokenLimit ?? quota);
}

/** Wall-clock end of the current quota window (always > now). */
function nextResetAt(quotaResetWindow, now) {
  let at = null;
  try {
    at = nextQuotaReset(quotaResetWindow, now);
  } catch (_) {
    at = null;
  }
  return Number.isFinite(at) && at > now ? Math.floor(at) : now + FALLBACK_WINDOW_MS;
}

/** Live tokenUsage map, or null when `create` is false and none exists yet. */
function usageMap(pool, create) {
  if (!pool.state) {
    if (!create) return null;
    pool.state = {};
  }
  const map = pool.state.tokenUsage;
  if (map instanceof Map) return map;
  if (!create) return null;
  const fresh = new Map();
  pool.state.tokenUsage = fresh;
  return fresh;
}

/**
 * Normalized usage view for `ref` — the single place lazy reset happens.
 *
 * A stored entry that is missing, malformed, or past its `resetAt` reads as
 * `{ used: 0, nextResetAt }`; otherwise its recorded values are returned as-is.
 *
 * `now` is intentionally required: reads must not consult an implicit clock.
 * An omitted `now` degrades to "treat the stored window as still open" rather
 * than throwing, so a mistaken call site cannot silently clear a budget.
 * @returns {{used: number, resetAt: number, stored: boolean}}
 */
function readQuota(pool, ref, quotaResetWindow, now) {
  const blank = { used: 0, resetAt: null, open: false, stored: false };
  if (!(pool?.state?.tokenUsage instanceof Map)) return blank;
  const entry = pool.state.tokenUsage.get(ref);
  if (!entry || typeof entry !== 'object') return blank;
  const used = toTokenCount(entry.used);
  const resetAt = toTokenCount(entry.resetAt);
  if (used === null || resetAt === null || resetAt <= 0) return blank;
  if (Number.isFinite(now) && now >= resetAt) {
    // Window elapsed: report zero, and hand back the next boundary lazily.
    return { used: 0, resetAt: nextResetAt(quotaResetWindow ?? pool.quotaResetWindow, now), open: true, stored: false };
  }
  return { used, resetAt, open: true, stored: true };
}

/** Tokens consumed by `ref` in `pool` during the current window (0 = none/unlimited). */
export function getModelTokenUsage(pool, ref, now) {
  if (getModelTokenLimit(pool, ref) === null) return 0;
  return readQuota(pool, ref, undefined, now).used;
}

/** Remaining tokens, or null when the credential is unlimited in this pool. */
export function getModelTokenRemaining(pool, ref, now) {
  const limit = getModelTokenLimit(pool, ref);
  if (limit === null) return null;
  return Math.max(0, limit - readQuota(pool, ref, undefined, now).used);
}

/**
 * Quota status for one credential in one model pool (status/health APIs).
 * @returns {{configured: true, limit: number, used: number, remaining: number,
 *            resetAt: number, exhausted: boolean}|null} null when unlimited
 */
export function getModelQuotaStatus(pool, ref, now) {
  const limit = getModelTokenLimit(pool, ref);
  if (limit === null) return null;
  const quota = readQuota(pool, ref, undefined, now);
  const at = quota.resetAt ?? (Number.isFinite(now) ? nextResetAt(pool?.quotaResetWindow, now) : 0);
  return {
    configured: true,
    limit,
    used: quota.used,
    remaining: Math.max(0, limit - quota.used),
    resetAt: at,
    exhausted: quota.used >= limit,
  };
}

/**
 * Can this credential receive a new request for this pool right now?
 *
 * `used < limit` stays available, so the final request is allowed to overshoot
 * the limit — this version has no reservation system, so a bounded concurrent
 * overshoot is accepted behaviour rather than a bug.
 */
export function isModelQuotaAvailable(pool, ref, now) {
  const limit = getModelTokenLimit(pool, ref);
  if (limit === null) return true;
  return readQuota(pool, ref, undefined, now).used < limit;
}

/** True when at least one ref of `pool` still has local quota left. */
export function anyModelQuotaAvailable(pool, now) {
  return filterQuotaEligible(pool, pool?.refs ?? [], now).length > 0;
}

/**
 * Keep only refs not blocked by a local token quota. Pools without any quota
 * config return an unchanged copy, so the no-quota hot path stays allocation light.
 */
export function filterQuotaEligible(pool, refs, now) {
  const list = Array.isArray(refs) ? refs : [];
  if (!hasModelQuotaConfig(pool)) return list.slice();
  return list.filter((ref) => isModelQuotaAvailable(pool, ref, now));
}

/**
 * Clear the counter when its window has elapsed. Safe on a cold pool (no-op).
 * `isModelQuotaAvailable` / `getModelQuotaStatus` already reset lazily on read;
 * this is the explicit maintenance-sweep entry point.
 * @returns {boolean} true when a counter was actually cleared
 */
export function resetModelQuotaIfNeeded(pool, ref, quotaResetWindow, now) {
  const map = usageMap(pool, false);
  if (!map) return false;
  const entry = map.get(ref);
  if (!entry || typeof entry !== 'object') return false;
  const resetAt = toTokenCount(entry.resetAt);
  if (resetAt === null || resetAt <= 0 || !Number.isFinite(now) || now < resetAt) return false;
  entry.used = 0;
  entry.resetAt = nextResetAt(quotaResetWindow ?? pool.quotaResetWindow, now);
  return true;
}

/**
 * Charge `tokens` to `ref` in `pool` and return the resulting status.
 *
 * Only successful, usage-reporting requests call this. Unlimited credentials and
 * non-positive / invalid token counts are no-ops, so usage is never fabricated
 * and a request without a usage payload can never exhaust a budget.
 * A first write normalises the entry, which is where lazy initialisation and
 * lazy reset both happen (no per-key timers anywhere).
 * @returns {object|null} resulting quota status, or null when nothing was charged
 */
export function consumeModelTokens(pool, ref, tokens, quotaResetWindow, now) {
  const limit = getModelTokenLimit(pool, ref);
  if (limit === null) return null;
  const count = toTokenCount(tokens);
  if (count === null || count <= 0) return null;
  const window = quotaResetWindow ?? pool.quotaResetWindow;
  const current = readQuota(pool, ref, window, now);
  const resetAt = current.resetAt ?? (Number.isFinite(now) ? nextResetAt(window, now) : 0);
  const used = Math.min(Number.MAX_SAFE_INTEGER, current.used + count);
  usageMap(pool, true).set(ref, { used, resetAt });
  return {
    configured: true,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetAt,
    exhausted: used >= limit,
  };
}

/** Token keys understood, in priority order (an explicit total wins). */
const TOTAL_KEYS = ['total_tokens', 'totalTokens'];
const PAIR_KEYS = [
  ['input_tokens', 'output_tokens'],
  ['inputTokens', 'outputTokens'],
  ['prompt_tokens', 'completion_tokens'],
  ['promptTokens', 'completionTokens'],
];

/**
 * Extract a billable token count from a provider usage payload.
 *
 * Priority: explicit total > input + output > prompt + completion.
 * Non-finite, negative, null and non-numeric values are ignored, so a malformed
 * payload can never poison pool state with NaN or a negative counter, and a
 * payload with no recognised field returns null ("no data") rather than 0
 * ("measured zero") — the distinction that keeps unmeasured requests from
 * marking a key exhausted.
 * @returns {number|null} non-negative integer, or null when no data is present
 */
export function extractUsageTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  for (const key of TOTAL_KEYS) {
    const total = toTokenCount(usage[key]);
    if (total !== null) return total;
  }
  for (const [a, b] of PAIR_KEYS) {
    const va = toTokenCount(usage[a]);
    const vb = toTokenCount(usage[b]);
    if (va === null && vb === null) continue;
    return (va ?? 0) + (vb ?? 0);
  }
  return null;
}

/**
 * Message used when a model pool cannot dispatch because every credential has
 * spent its local budget. Deliberately avoids upstream-error phrasing and
 * numeric HTTP codes so this is never re-classified as a provider failure.
 */
export function formatModelQuotaExhaustion(provider, pool) {
  const total = (pool?.refs ?? []).length;
  return `[dsh-key-rotation] All ${total} keys for '${provider}' have reached their local token budget for this window; no upstream request was sent.`;
}

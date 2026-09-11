// lib/sanitize-snapshot.js — clamp/repair runtime snapshots before they leave the host (#288).
// Guards the settings card and ops APIs against NaN, negative remaining times,
// and inconsistent counters after clock jumps or empty-pool edge cases.

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNonNegative(value) {
  const n = toFiniteNumber(value, 0);
  return n < 0 ? 0 : n;
}

function clampRemaining(value, nowMs) {
  const n = toFiniteNumber(value, 0);
  if (n <= 0) return 0;
  // If the absolute timestamp is in the past relative to now, remaining is 0.
  if (n > 1e12 && n <= nowMs) return 0;
  // Cooldown remaining should not exceed ~7 days.
  if (n < 1e12 && n > 7 * 86400000) return 7 * 86400000;
  return n;
}

/**
 * Sanitize a per-key status entry.
 * @param {object} key
 * @param {number} now
 */
export function sanitizeKeyStatus(key, now = Date.now()) {
  if (!key || typeof key !== 'object') return null;
  return {
    ...key,
    present: Boolean(key.present),
    active: Boolean(key.active),
    cooldownMsLeft: clampRemaining(key.cooldownMsLeft, now),
    usage: clampNonNegative(key.usage),
    failures: clampNonNegative(key.failures),
    weight: clampNonNegative(key.weight || 1) || 1,
    rpm: key.rpm && typeof key.rpm === 'object'
      ? {
          ...key.rpm,
          used: clampNonNegative(key.rpm.used),
          remaining: clampNonNegative(key.rpm.remaining),
          limit: clampNonNegative(key.rpm.limit),
        }
      : key.rpm,
  };
}

/**
 * Sanitize a full status snapshot ({ providers: [...], ... }).
 * Never mutates the input.
 */
export function sanitizeSnapshot(snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== 'object') return { providers: [] };
  const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
  return {
    ...snapshot,
    providers: providers.map((p) => {
      if (!p || typeof p !== 'object') return p;
      const keys = Array.isArray(p.keys) ? p.keys : [];
      return {
        ...p,
        switches: clampNonNegative(p.switches),
        totalUsage: p.totalUsage == null ? p.totalUsage : clampNonNegative(p.totalUsage),
        healthScore: p.healthScore == null
          ? p.healthScore
          : Math.max(0, Math.min(100, toFiniteNumber(p.healthScore, 0))),
        lastSwitchAt: p.lastSwitchAt == null ? null : (Number.isFinite(Number(p.lastSwitchAt)) ? Number(p.lastSwitchAt) : null),
        lastExhaustionAt: p.lastExhaustionAt == null ? null : (Number.isFinite(Number(p.lastExhaustionAt)) ? Number(p.lastExhaustionAt) : null),
        todayCost: p.todayCost == null ? p.todayCost : clampNonNegative(p.todayCost),
        weeklyCost: p.weeklyCost == null ? p.weeklyCost : clampNonNegative(p.weeklyCost),
        budgetDaily: p.budgetDaily == null ? p.budgetDaily : clampNonNegative(p.budgetDaily),
        budgetWeekly: p.budgetWeekly == null ? p.budgetWeekly : clampNonNegative(p.budgetWeekly),
        p95: p.p95 == null ? null : clampNonNegative(p.p95),
        keys: keys.map((k) => sanitizeKeyStatus(k, now)).filter(Boolean),
      };
    }),
  };
}

export default sanitizeSnapshot;

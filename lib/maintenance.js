// lib/maintenance.js - pure helpers for #207 (expiry pre-warning) and
// #208 (cost budget). No I/O; the timers in index.js call these and decide
// whether to send webhooks.

const DAY_MS = 86400000;

/**
 * #207: keys of `pool` whose expiresAt falls within the next `warnDays`.
 * Returns [{ ref, expiresInDays, expiresAt }], soonest first.
 */
export function expiringSoon(pool, warnDays, now = Date.now()) {
  if (!pool || !pool.expiresAt) return [];
  const horizon = now + Math.max(1, warnDays ?? 7) * DAY_MS;
  return Object.entries(pool.expiresAt)
    .filter(([, at]) => at > now && at <= horizon)
    .map(([ref, at]) => ({ ref, expiresAt: at, expiresInDays: Math.max(0, Math.floor((at - now) / DAY_MS)) }))
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

/** #207 dedupe: true when a day-level notification for `key` is due. */
export function shouldNotifyDaily(lastNotified, key, now = Date.now()) {
  if (!lastNotified.has(key)) {
    lastNotified.set(key, now);
    return true;
  }
  const last = lastNotified.get(key);
  if (now - last < DAY_MS) return false;
  lastNotified.set(key, now);
  return true;
}

/**
 * #208: total spend of a pool on ISO day `day` (defaults to today)
 * across costDays Map<ref, Map<day, cost>>.
 */
export function costForDay(costDays, day) {
  const d = day ?? new Date().toISOString().slice(0, 10);
  let total = 0;
  for (const perRef of (costDays?.values() ?? [])) {
    total += perRef.get(d) ?? 0;
  }
  return total;
}

/** #208: total spend over the last 7 ISO days ending today. */
export function costForWeek(costDays, now = Date.now()) {
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    total += costForDay(costDays, d);
  }
  return total;
}

/**
 * #208 budget verdict for a pool: { spend, budget, ratio, warn, exceeded }.
 * budget <= 0 -> never warn.
 */
export function budgetVerdict(spend, budget) {
  if (!budget || budget <= 0) return { spend, budget: 0, ratio: 0, warn: false, exceeded: false };
  const ratio = spend / budget;
  // warn from 80%, exceeded at 100%
  return { spend, budget, ratio, warn: ratio >= 0.8, exceeded: ratio >= 1 };
}

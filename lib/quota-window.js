// quota-window.js — calendar-based quota reset windows (issue #197).

export const QUOTA_WINDOW_TYPES = ['midnight_utc', 'midnight_pst', 'rolling_24h'];

export function nextQuotaReset(quotaResetWindow, now) {
  now = now || Date.now();
  if (!quotaResetWindow || typeof quotaResetWindow !== 'object') return null;
  const type = quotaResetWindow.type;
  const hour = Number.isFinite(quotaResetWindow.hour) ? quotaResetWindow.hour : 0;

  if (type === 'rolling_24h') {
    const d = new Date(now);
    d.setUTCHours(d.getUTCHours() + 24, 0, 0, 0);
    return d.getTime();
  }

  if (type === 'midnight_utc') {
    const d = new Date(now);
    d.setUTCHours(hour, 0, 0, 0);
    if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime();
  }

  if (type === 'midnight_pst') {
    const PST_OFFSET_MS = 8 * 3600_000;
    const shifted = now + PST_OFFSET_MS;
    const d = new Date(shifted);
    d.setUTCHours(hour, 0, 0, 0);
    if (d.getTime() <= shifted) d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime() - PST_OFFSET_MS;
  }

  return null;
}

export function poolResetAt(pool, quotaResetWindow, now) {
  return nextQuotaReset(quotaResetWindow, now);
}

export function isBlockedUntilReset(failedUntil, resetAt, now) {
  now = now || Date.now();
  if (!Number.isFinite(failedUntil)) return false;
  if (resetAt === null || resetAt === undefined) return false;
  return failedUntil >= resetAt;
}

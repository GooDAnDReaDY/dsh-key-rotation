// lib/usage-report.js - #209 usage report rows from pool state + 30-day compaction (#11). Pure helpers.
const DAY_MS = 86400000;
export const MAX_USAGE_RETENTION_DAYS = 30;

/**
 * Build per-key usage rows for the last `days` ISO days (default 7).
 * Returns [{ ref, requests, cost, active, usageByDay: {day: n} }].
 */
export function usageRows(pool, days = 7, now = Date.now()) {
  const out = [];
  const dayKeys = [];
  for (let i = 0; i < Math.max(1, days); i++) dayKeys.push(new Date(now - i * DAY_MS).toISOString().slice(0, 10));
  const refs = pool?.refs ?? [];
  for (const ref of refs) {
    const daysMap = pool.state.usageDays?.get(ref) ?? new Map();
    const costMap = pool.state.costDays?.get(ref) ?? new Map();
    let requests = 0, cost = 0;
    const usageByDay = {};
    for (const d of dayKeys) {
      const r = daysMap.get(d) ?? 0;
      const c = costMap.get(d) ?? 0;
      requests += r;
      cost += c;
      usageByDay[d] = r;
    }
    out.push({
      ref,
      requests,
      cost: Math.round(cost * 100) / 100,
      active: pool.state.lastUsed === ref,
      usageByDay,
    });
  }
  return out;
}

/** CSV of usage rows: ref,requests,cost,active + per-day columns. */
export function usageCsv(rows) {
  const dayCols = [...new Set(rows.flatMap((r) => Object.keys(r.usageByDay)))].sort();
  const head = ['ref', 'requests', 'cost', 'active', ...dayCols];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([esc(r.ref), r.requests, r.cost, r.active ? 'yes' : 'no', ...dayCols.map((d) => r.usageByDay[d] ?? 0)].join(','));
  }
  return lines.join('\n');
}

/**
 * Compact usage days/cost data by purging dates older than maxDays (default 30).
 * Returns count of purged day keys.
 */
export function compactUsage(pool, maxDays = MAX_USAGE_RETENTION_DAYS, now = Date.now()) {
  if (!pool?.state) return 0;
  const cutoffIso = new Date(now - maxDays * DAY_MS).toISOString().slice(0, 10);
  let purged = 0;

  for (const daysMap of pool.state.usageDays?.values() ?? []) {
    for (const d of [...daysMap.keys()]) {
      if (d < cutoffIso) {
        daysMap.delete(d);
        purged++;
      }
    }
  }

  for (const costMap of pool.state.costDays?.values() ?? []) {
    for (const d of [...costMap.keys()]) {
      if (d < cutoffIso) {
        costMap.delete(d);
      }
    }
  }

  return purged;
}
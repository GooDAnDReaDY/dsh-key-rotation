// lib/usage-report.js - #209 usage report rows from pool state. Pure helpers.
const DAY_MS = 86400000;

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

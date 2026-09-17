// lib/budget-monitor.js — periodic budget, expiry, low health and SLO alerts
import { expiringSoon, shouldNotifyDaily, costForDay, costForWeek, budgetVerdict } from './pool.js';

const DAY_MS = 86400000;

export function checkBudgetAndHealthAlerts({
  runtime,
  poolState,
  now,
  expiryNotifiedAt,
  budgetNotifiedAt,
  lowHealthNotifiedAt,
  sloNotifiedAt,
  latencyHistogram,
  webhookSender,
  logger,
}) {
  try {
    const seen = new Set();
    for (const pool of runtime.poolByRef.values()) {
      if (seen.has(pool.base)) continue;
      seen.add(pool.base);
      // #207: keys expiring within expiryWarnDays -> one webhook per key/day
      for (const { ref, expiresInDays } of expiringSoon(pool, runtime.expiryWarnDays, now)) {
        if (!shouldNotifyDaily(expiryNotifiedAt, pool.base + ':' + ref, now)) continue;
        logger?.warn?.(`[dsh-key-rotation] ${pool.base}: key ${ref} expires in ~${expiresInDays}d`);
        if (runtime.notifyWebhook) {
          webhookSender.send(runtime.notifyWebhook, {
            title: `Key expiring soon: ${pool.base}`,
            text: `${ref} expires in ~${expiresInDays} day(s)`,
            provider: pool.base,
            kind: 'expiry',
            keys: [ref],
          });
        }
      }
      // #208: daily/weekly budget -> warn webhook, optional 1-day pause at 100%
      const budget = runtime.providerBudgets.get(pool.base);
      if (!budget) continue;
      const daily = costForDay(pool.state.costDays);
      const weekly = costForWeek(pool.state.costDays, now);
      const verdict = budgetVerdict(daily, budget.costBudgetDaily);
      const wVerdict = budgetVerdict(weekly, budget.costBudgetWeekly);
      const hit = verdict.warn || wVerdict.warn;
      if (hit && shouldNotifyDaily(budgetNotifiedAt, pool.base + ':budget', now)) {
        logger?.warn?.(`[dsh-key-rotation] ${pool.base}: cost budget - day $${daily.toFixed(2)}/$${budget.costBudgetDaily} week $${weekly.toFixed(2)}/$${budget.costBudgetWeekly}`);
        if (runtime.notifyWebhook) {
          // #217: budget webhook gains action buttons when a callback token is configured
          const token = runtime.webhookActionToken ?? '';
          webhookSender.send(runtime.notifyWebhook, {
            title: `Cost budget: ${pool.base}`,
            text: `day $${daily.toFixed(2)} of $${budget.costBudgetDaily} · week $${weekly.toFixed(2)} of $${budget.costBudgetWeekly}` + (verdict.exceeded || wVerdict.exceeded ? ' · EXCEEDED' : ''),
            provider: pool.base,
            kind: 'budget',
            spend: { daily, weekly },
            actionToken: token || undefined,
            actions: token ? [
              { id: `pause-${pool.base}`, label: 'Pause 1h' },
              { id: `reset-${pool.base}`, label: 'Reset cooldown' },
            ] : undefined,
          });
        }
      }
      if ((verdict.exceeded || wVerdict.exceeded) && budget.pauseOnBudget) {
        const until = now + DAY_MS;
        for (const ref of pool.refs) {
          if ((pool.state.failedUntil.get(ref) ?? 0) < until) pool.state.failedUntil.set(ref, until);
        }
      }
      // #221: pool running low - webhook while healthy < warnBelowHealthy
      const warnBelow = runtime.warnBelowHealthy ?? 0;
      if (warnBelow > 0) {
        let healthy = 0;
        for (const ref of pool.refs) {
          const fu = pool.state.failedUntil.get(ref);
          if (fu !== undefined && fu > now) continue;
          const exp = pool.expiresAt?.[ref];
          if (exp !== undefined && now >= exp) continue;
          healthy++;
        }
        if (healthy < warnBelow && shouldNotifyDaily(lowHealthNotifiedAt, pool.base, now)) {
          logger?.warn?.(`[dsh-key-rotation] ${pool.base}: pool running low - ${healthy}/${pool.refs.length} healthy`);
          if (runtime.notifyWebhook) {
            const token = runtime.webhookActionToken ?? '';
            webhookSender.send(runtime.notifyWebhook, {
              title: `Pool running low: ${pool.base}`,
              text: `${healthy}/${pool.refs.length} keys healthy (alert below ${warnBelow})`,
              provider: pool.base,
              kind: 'low-health',
              healthy,
              total: pool.refs.length,
              actionToken: token || undefined,
              actions: token ? [{ id: `reset-${pool.base}`, label: 'Reset cooldown' }] : undefined,
            });
          }
        }
      }
      // #225: latency SLO - webhook when a key's p95 exceeds the threshold
      const slo = runtime.latencySloMs ?? 0;
      if (slo > 0) {
        for (const ref of pool.refs) {
          const snap = latencyHistogram.snapshot(ref);
          if (!snap.p95 || snap.p95 <= slo) continue;
          if (!shouldNotifyDaily(sloNotifiedAt, pool.base + ':' + ref + ':slo', now)) continue;
          logger?.warn?.(`[dsh-key-rotation] ${pool.base}: ${ref} p95 ${Math.round(snap.p95)}ms > SLO ${slo}ms`);
          if (runtime.notifyWebhook) {
            webhookSender.send(runtime.notifyWebhook, {
              title: `Latency SLO exceeded: ${pool.base}`,
              text: `${ref} p95 ${Math.round(snap.p95)}ms > ${slo}ms (${snap.count} samples)`,
              provider: pool.base,
              kind: 'latency-slo',
              ref,
              p95: Math.round(snap.p95),
              slo,
            });
          }
        }
      }
    }
  } catch (_) {
    /* maintenance must never crash the sweep */
  }
}

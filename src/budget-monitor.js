// lib/budget-monitor.js — periodic budget, expiry, low health and SLO alerts
import { expiringSoon, shouldNotifyDaily, costForDay, costForWeek, budgetVerdict, isKeyPaused, isKeyRevoked } from './pool.js';
import { isModelQuotaAvailable, hasModelQuotaConfig } from './model-quota.js';
import { getProviderCost } from './resolver.js';

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
    // #208 / #422: provider monetary budget alerts & pause across base and model pools
    if (runtime.providerBudgets && runtime.providerBudgets.size > 0) {
      for (const [provider, budget] of runtime.providerBudgets) {
        const { daily, weekly, pools } = getProviderCost(provider, runtime, now);
        const verdict = budgetVerdict(daily, budget.costBudgetDaily);
        const wVerdict = budgetVerdict(weekly, budget.costBudgetWeekly);
        const hit = verdict.warn || wVerdict.warn;
        if (hit && shouldNotifyDaily(budgetNotifiedAt, provider + ':budget', now)) {
          logger?.warn?.(`[dsh-key-rotation] ${provider}: cost budget - day $${daily.toFixed(2)}/$${budget.costBudgetDaily} week $${weekly.toFixed(2)}/$${budget.costBudgetWeekly}`);
          if (runtime.notifyWebhook) {
            const token = runtime.webhookActionToken ?? '';
            webhookSender.send(runtime.notifyWebhook, {
              title: `Cost budget: ${provider}`,
              text: `day $${daily.toFixed(2)} of $${budget.costBudgetDaily} · week $${weekly.toFixed(2)} of $${budget.costBudgetWeekly}` + (verdict.exceeded || wVerdict.exceeded ? ' · EXCEEDED' : ''),
              provider,
              kind: 'budget',
              spend: { daily, weekly },
              actionToken: token || undefined,
              actions: token ? [
                { id: `pause-${provider}`, label: 'Pause 1h' },
                { id: `reset-${provider}`, label: 'Reset cooldown' },
              ] : undefined,
            });
          }
        }
        if ((verdict.exceeded || wVerdict.exceeded) && budget.pauseOnBudget) {
          const until = now + DAY_MS;
          for (const p of pools) {
            for (const ref of p.refs) {
              if ((p.state.failedUntil.get(ref) ?? 0) < until) p.state.failedUntil.set(ref, until);
            }
          }
        }
      }
    }

    const seen = new Set();
    const poolsToScan = runtime.pools ?? runtime.poolByRef.values();
    for (const pool of poolsToScan) {
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
      // #208 / #422: handled provider-wide before pool loop
      // #221: pool running low - webhook while healthy < warnBelowHealthy
      const warnBelow = runtime.warnBelowHealthy ?? 0;
      if (warnBelow > 0) {
        const quotaAware = hasModelQuotaConfig(pool);
        let healthy = 0;
        for (const ref of pool.refs) {
          if (isKeyRevoked(pool, ref) || isKeyPaused(pool, ref)) continue;
          const fu = pool.state.failedUntil.get(ref);
          if (fu !== undefined && fu > now) continue;
          const exp = pool.expiresAt?.[ref];
          if (exp !== undefined && now >= exp) continue;
          if (quotaAware && !isModelQuotaAvailable(pool, ref, now)) continue;
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

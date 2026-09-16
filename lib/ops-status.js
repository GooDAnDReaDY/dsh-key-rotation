// lib/ops-status.js — status + health operational routes (#312 split from routes-ops.js).
import { json } from './http-bridge.js';
import {
  isTrustedBridgeRequest,
  keyTail,
  envValue,
  computeHealthScore,
  costForDay,
  costForWeek,
  isLoopbackAddress,
} from './pool.js';
import { bucketInfo } from './bucket.js';
import { sanitizeSnapshot } from './sanitize-snapshot.js';
import {
  STATUS_PATH,
  HEALTH_PATH,
} from './ops-paths.js';

/**
 * @param {object} ctx cordis context
 * @param {object} deps live dependencies from apply()
 */
export function registerStatusRoutes(ctx, deps) {
  const {
    buildRuntime,
    latencyHistogram,
    circuitBreaker,
    quotaStore,
  } = deps;

// ── status route: what the settings card cannot know on its own ──
//
// Reports, per configured provider, which key is in use, which are cooling
// down and until when, whether an env name resolves to a credential at all
// (a typo is otherwise silent), and how often rotation has fired.
//
// Key VALUES never leave the host — only the boolean fact that one exists.
ctx.effect(() => ctx.webServer.register({
  kind: 'exact',
  path: STATUS_PATH,
  handler: async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: { code: 'method', message: 'GET only' } });
      return;
    }
    if (!isTrustedBridgeRequest(req)) {
      json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: status is local-only' } });
      return;
    }
    const runtime = buildRuntime();
    const { poolByRef, providerTags, providerBudgets, latencySloMs } = runtime;
    const base = ctx.get('credentials');
    const now = Date.now();
    const seen = new Set();
    const providers = [];
    for (const pool of poolByRef.values()) {
      if (seen.has(pool.base)) continue;
      seen.add(pool.base);
      try {
      const keys = [];
      for (const ref of pool.refs) {
        let present = false;
        let tail = '';
        let source = null;
        let writable = true;
        try {
          // The resolve patch is installed on this same service, so ask for
          // the exact ref: a pool ref would otherwise round-robin to another
          // key and report a missing name as present.
          let hit = await (base?.__dshKeyRotationOriginalResolve ?? base?.resolve)?.call(base, ref);
          present = Boolean(hit && typeof hit.value === 'string' && hit.value.length > 0);
          if (present) tail = keyTail(hit.value);
          // fallback: env var bootstrapping (issue #7)
          if (!present) {
            const ev = envValue(ref);
            if (ev !== undefined) { present = true; tail = keyTail(ev); source = 'env'; writable = false; }
          }
        } catch {
          present = false;
        }
        try {
          const described = await base?.describe?.(ref);
          source = described?.source ?? null;
          writable = described?.writable !== false;
        } catch {
          /* describe is optional — the card falls back to editable */
        }
        const until = pool.state.failedUntil.get(ref);
        keys.push({
          ref,
          present,
          tail,
          source,
          writable,
          active: pool.state.lastUsed === ref,
          cooldownMsLeft: until !== undefined && until > now ? until - now : 0,
          // #210: RPM capacity snapshot (null when rpmLimit is off)
          rpm: bucketInfo(pool.state.rpmWindows, ref, pool.rpmLimit, now),
          // #215: effective round-robin weight of this key
          weight: pool.weights?.[pool.refs.indexOf(ref)] ?? 1,
          usage: pool.state.usageCounts?.get(ref) ?? 0,
          byModel: pool.state.byModel?.get(ref) ? Object.fromEntries(pool.state.byModel.get(ref)) : {},
          usageDays: pool.state.usageDays?.get(ref) ? Object.fromEntries(pool.state.usageDays.get(ref)) : {},
          cost: pool.state.costPerKey?.get(ref) ?? 0,
          lastUsedAt: pool.state.lastUsedAt?.get(ref) ?? null,
          expiresAt: pool.expiresAt?.[ref] ?? null,
          expired: pool.expiresAt?.[ref] !== undefined && now >= pool.expiresAt[ref],
          broken: pool.state.brokenUntil?.has(ref) ?? false,
        });
      }
      providers.push({
        provider: pool.base,
        keys,
        tags: providerTags.get(pool.base) ?? [],
        // #260 circuit breaker state (may be null if not yet tripped)
        circuit: (() => {
          const br = runtime.breaker;
          if (!br) return null;
          const st = br.state(pool.base);
          return { state: st, threshold: br.threshold, openMs: br.openMs };
        })(),
        switches: pool.state.switches ?? 0,
        lastReason: pool.state.lastReason ?? null,
        lastSwitchAt: pool.state.lastSwitchAt ?? null,
        lastExhaustionAt: pool.state.lastExhaustionAt ?? null,
        exhaustionCount: pool.state.exhaustionCount ?? 0,
        totalUsage: (() => { let s = 0; if (pool.state.usageCounts) for (const v of pool.state.usageCounts.values()) s += v; return s; })(),
        // #225: aggregate p95 across the pool's keys
        p95: (() => {
          const vals = (pool.refs ?? []).map((r) => (typeof latencyHistogram?.snapshot === 'function' ? latencyHistogram.snapshot(r) : null)).filter((s) => s && s.p95 != null).map((s) => s.p95);
          return vals.length ? Math.round(Math.max(...vals)) : null;
        })(),
        latencySloMs,
        events: (pool.state.events ?? []).slice(-50),
        healthScore: computeHealthScore(pool.state),
        // #208: today/week spend + configured budget for the card
        todayCost: costForDay(pool.state.costDays),
        weeklyCost: costForWeek(pool.state.costDays, now),
        budgetDaily: (providerBudgets?.get ? providerBudgets.get(pool.base) : providerBudgets?.[pool.base])?.costBudgetDaily ?? 0,
        budgetWeekly: (providerBudgets?.get ? providerBudgets.get(pool.base) : providerBudgets?.[pool.base])?.costBudgetWeekly ?? 0,
        pauseOnBudget: (providerBudgets?.get ? providerBudgets.get(pool.base) : providerBudgets?.[pool.base])?.pauseOnBudget ?? false,
        routingStrategy: pool.routingStrategy ?? runtime.routingStrategy ?? 'round-robin',
        proactiveRateLimitGuard: pool.proactiveRateLimitGuard ?? runtime.proactiveRateLimitGuard ?? true,
      });
      } catch (e) {
        console.warn(`[dsh-key-rotation] status: pool ${pool.base} failed: ${String(e?.message ?? e)} ${e?.stack ?? ''}`);
        providers.push({ provider: pool.base, keys: [], statusError: String(e?.message ?? e) });
      }
    }
    json(res, 200, sanitizeSnapshot({
      providers,
      // #266/#263 operational extras (additive)
      meta: {
        expectedClones: [...(runtime.expectedClones ?? [])],
        notifyQueue: runtime.notifyQueue?.stats?.() ?? null,
        breakerEnabled: runtime.circuitBreakerEnabled !== false,
        at: now,
      },
    }, now));
  },
}), 'dsh-key-rotation: status route');

// #209: usage report - per-key requests/cost over the last N days.
// ?format=csv returns text/csv; ?days=N window (1..90, default 7).

ctx.effect(() => ctx.webServer.register({
  kind: 'exact',
  path: HEALTH_PATH,
  handler: async (req, res) => {
    if (!isTrustedBridgeRequest(req) && req.socket?.remoteAddress !== '127.0.0.1' && req.socket?.remoteAddress !== '::1') { } // allow same-origin already checked
    if (!isTrustedBridgeRequest(req)) {
      // also allow plain loopback without Origin
      if (!isLoopbackAddress(req.socket?.remoteAddress)) { res.writeHead(403); res.end(); return; }
      if (req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403); res.end(); return; }
    }
    if (req.method !== 'GET') { json(res, 405, { error: { code: 'method', message: 'GET only' } }); return; }
    const now = Date.now();
    const pools = {};
    let exhaustedAny = false;
    const { poolByRef: pr, providerTags } = buildRuntime();
    const seenH = new Set();
    for (const pool of pr.values()) {
      if (seenH.has(pool.base)) continue;
      seenH.add(pool.base);
      let healthy = 0;
      for (const ref of pool.refs) {
        const until = pool.state.failedUntil.get(ref);
        if (until !== undefined && until > now) continue;
        const exp = pool.expiresAt?.[ref];
        if (exp !== undefined && now >= exp) continue;
        healthy++;
      }
      const total = pool.refs.length;
      const exhausted = healthy === 0 && total > 0;
      if (exhausted) exhaustedAny = true;
      pools[pool.base] = { healthy, total, exhausted, healthScore: computeHealthScore(pool.state) };
    }
    json(res, 200, { status: exhaustedAny ? 'degraded' : 'ok', pools, exhaustedAny, latency: latencyHistogram.snapshotAll(), quota: typeof quotaStore?.snapshot === 'function' ? quotaStore.snapshot() : null });
  },
}), 'dsh-key-rotation: health');

}

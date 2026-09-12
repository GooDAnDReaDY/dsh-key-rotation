// dsh-key-rotation — per-provider API key rotation for DeepSeek Harness.
//
// Transparent key pool rotation: credentials.resolve patch + llm/stream
// interceptor. Provider identity never changes (keeps pi-ai replay state).
// See README.md and docs/design/DESIGN.md for the full contract.
// Config (all optional): switchCodes, cooldownMs, providers[{provider,keys}],
// verboseLogging (default false) gates per-request rotation logs.

import { AsyncLocalStorage } from 'node:async_hooks';
import Schema from '@deepseek-ai/schemastery';
import { keyTail, isLoopbackAddress, isTrustedBridgeRequest, SWITCHABLE_MESSAGE_PATTERN, DEFAULT_SWITCH_CODES, isValidRef, pickNext, applyCooldown, recordFailure, recordSuccess, computeBackoff, envValue, sweepExpired, parseRetryAfter, computeHealthScore, extractRateLimit, isRateLimited, selectPool, isSwitchableError, formatExhaustionMessage, expiringSoon, shouldNotifyDaily, costForDay, costForWeek, budgetVerdict } from './pool.js';

export const name = 'dsh-key-rotation';
export const inject = ['llm', 'webServer', 'settings', 'credentials'];
export { keyTail, isLoopbackAddress, isTrustedBridgeRequest, DEFAULT_SWITCH_CODES, isSwitchableError, formatExhaustionMessage, getRuntime };

/** Settings namespace owning the GUI-editable section (settingsNamespace-valid). */
const NS = 'dsh-key-rotation';
/** Config bridge route (GET / PUT / DELETE), loopback-fenced like llm-fallback. */
const CONFIG_PATH = '/dsh-key-rotation/config';
const STATUS_PATH = '/dsh-key-rotation/status';
const SNAPSHOT_PATH = '/dsh-key-rotation/snapshot';
const KEY_PATH = '/dsh-key-rotation/key';
const RESET_PATH = '/dsh-key-rotation/reset';
const IMPORT_PATH = '/dsh-key-rotation/import';
const HEALTH_PATH = '/dsh-key-rotation/health';
const USAGE_PATH = '/dsh-key-rotation/usage';
const TEST_PATH = '/dsh-key-rotation/test';
const SANDBOX_CACHE_PATH = '/dsh-key-rotation/sandbox-cache';
import { LastTestCache, SandboxRunner } from './sandbox.js';
import { healIdleCooldowns } from './heal.js';
import { LatencyHistogram } from './histogram.js';
import { pickCascadeFallback } from './cascade.js';
import { ConcurrencyTracker } from './concurrency.js';
import { nextQuotaReset } from './quota-window.js';
import { QuotaStore } from './quota.js';
import { WebhookSender } from './webhook.js';
import { bucketAllow, bucketRetryMs, bucketSweep, bucketInfo } from './bucket.js';
import { usageRows, usageCsv, compactUsage } from './usage-report.js';

const dispatchStorage = new AsyncLocalStorage();
import { findSecrets, looksLikeApiSecret } from './keycheck.js';
import { json, readJson, descriptorOf, viewOf, writeSection, providerCatalog, handleConfigBridge, NS as BRIDGE_NS } from './http-bridge.js';
import { createRotate } from './rotate.js';
import { nowMono } from './clock.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { NotifyQueue } from './notify-queue.js';
import { BoundedMap } from './bounded-map.js';
import { classifyFailure } from './error-taxonomy.js';
import { safeParseJson } from './atomic-io.js';
import { registerOpsRoutes } from './routes-ops.js';
import { StatePersistence, resolveStatePath } from './persistence.js';
import path from 'node:path';

/** The llm-pi-ai namespace whose provider profiles map providers to pools. */
const PIAI_NS = 'llm-pi-ai';
/** Marker on internally re-dispatched requests so the interceptor does not loop. */
const MARKER = '__dshKeyRotation';
/** #199: set true via webhook action; checked in the llm/stream interceptor. */
let rotationDisabled = false;
// #207/#208 dedupe maps: one notification per key/window per day.
const expiryNotifiedAt = new Map();
const budgetNotifiedAt = new Map();
const switchNotifiedAt = new Map();
const lowHealthNotifiedAt = new Map();
const sloNotifiedAt = new Map();
const DAY_MS = 86400000;

// #216: one webhook per switch, deduped to at most one message per provider
// per switchNotifyThrottleMs. Extracted for testability.
export function notifySwitch(runtime, pool, info, hooks = { webhookSender, now: () => Date.now() }) {
  if (!runtime?.notifyWebhook) return;
  const throttle = Math.max(0, runtime.switchNotifyThrottleMs ?? 60000);
  const last = switchNotifiedAt.get(info.provider) ?? 0;
  const now = hooks.now();
  if (now - last < throttle) return;
  switchNotifiedAt.set(info.provider, now);
  // #263: non-blocking — enqueue never awaits webhook I/O
  const send = hooks.notifyQueue
    ? (url, payload) => { hooks.notifyQueue.enqueue(url, payload); return { sent: true, queued: true }; }
    : (url, payload) => hooks.webhookSender.send(url, payload);
  send(runtime.notifyWebhook, {
    title: `Key switched: ${info.provider}`,
    text: `${info.from} failed (${info.code}) - next key in pool`,
    provider: info.provider,
    kind: 'switch',
    from: info.from,
    code: info.code,
    at: info.at,
  });
}
const MAX_EVENTS = 50;
function pushEvent(pool, ref, reason, cooldownMs, type) {
  const ev = { at: Date.now(), ref, reason: String(reason ?? 'UNKNOWN'), cooldownMs, type: type ?? 'fail' };
  pool.state.events.push(ev);
  if (pool.state.events.length > MAX_EVENTS) pool.state.events.shift();
}


// Fallback classification by failure message. pi-ai surfaces many real quota /
// rate-limit / transport failures as thrown exceptions (e.g. the OpenAI SDK
// throws on HTTP 429 before the stream starts), and dsh-llm then normalizes
// them to finish chunks with code "UNKNOWN". The message still carries the
// provider's own text ("429: ...", "Weekly usage limit reached", ...), so we
// treat pre-content failures whose message matches these patterns as
// switchable even when the code is not in `switchCodes`.

// Sandbox-test infrastructure (sandbox.js): in-memory cache + runner.
let lastTestCacheRunnerCtx = null;
const lastTestCache = new LastTestCache();
const latencyHistogram = new LatencyHistogram();
const quotaStore = new QuotaStore();
// #260/#263 module-scope infra (process-wide, reset on reload via buildRuntime)
let moduleBreaker = null;
let moduleNotifyQueue = null;
// Global config accessor safe against early initialization
let getConfig = () => null;
function verboseLoggingOn() {
  try { return Boolean(getConfig()?.verboseLogging); } catch (_) { return false; }
}
let getRuntime = () => null;
let sandboxRunner = null;
const webhookSender = new WebhookSender({ fetchImpl: globalThis.fetch });
// #263: queue webhook I/O off the hot path
moduleNotifyQueue = new NotifyQueue({ send: (url, payload) => webhookSender.send(url, payload) });
// #260: process-wide breaker; thresholds re-read from runtime when dispatching
moduleBreaker = new CircuitBreaker({ threshold: 5, openMs: 30000, halfOpenProbes: 1, now: nowMono });
const concurrencyTracker = new ConcurrencyTracker();
function ensureSandboxRunner(ctx) {
  if (sandboxRunner) return sandboxRunner;
  // provider id or key ref -> baseUrl (stripped of trailing /) for fetch /models probe
  function resolveBaseUrl(providerOrRef) {
    try {
      let provider = providerOrRef;
      const rt = typeof getRuntime === 'function' ? getRuntime() : null;
      const pool = rt?.poolByRef?.get(providerOrRef);
      if (pool?.base) provider = pool.base;
      else if (pool?.provider) provider = pool.provider;

      const c = ctx || lastTestCacheRunnerCtx;
      const pInfo = c?.llm?.getProvider?.(provider);
      if (pInfo && (pInfo.baseUrl || pInfo.endpoint || pInfo.url)) {
        return String(pInfo.baseUrl || pInfo.endpoint || pInfo.url);
      }
      for (const info of (c?.llm?.listProviders?.() || [])) {
        if (info && (info.id === provider || info.name === provider)) {
          const u = info.baseUrl || info.endpoint || info.url;
          if (u) return String(u);
        }
      }
      const ns = c?.get ? c.get(PIAI_NS) : null;
      const list = ns && (ns.providers || (ns.config && ns.config.providers) || []);
      if (Array.isArray(list)) {
        const hit = list.find((p) => p && (p.id === provider || p.name === provider || (Array.isArray(p.aliases) && p.aliases.includes(provider))));
        const base = hit && (hit.baseUrl || hit.endpoint || hit.url);
        if (base) return String(base);
      }
      return null;
    } catch (_) {
      return null;
    }
  }
  sandboxRunner = new SandboxRunner({ fetchImpl: globalThis.fetch, resolveBaseUrl });
  return sandboxRunner;
}
async function probeRef(ref, key) {
  // ref may be like "PROVIDER/KEY_NAME" — for sandbox we only care about the credential ref
  // (the resolveBaseUrl uses the full provider id; ref can carry any string)
  const runner = ensureSandboxRunner(lastTestCacheRunnerCtx);
  const result = await runner.probeModels(ref, key);
  lastTestCache.set(ref, { ...result, at: Date.now() });
  return result;
}

// // Bootstrap key pools. The user configures them in the Settings GUI or via
// the dsh profile bundle config; the plugin itself ships no provider defaults
// so it does not bind to any specific installation. Empty array means: until
// the user adds a pool, no rotation happens, and every provider falls back to
// its single configured credential exactly as before this plugin was installed.
const DEFAULT_PROVIDERS = [];

export const Config = Schema.object({
  switchCodes: Schema.array(Schema.string()).default([...DEFAULT_SWITCH_CODES]),
  cooldownMs: Schema.number().default(60000),
  maxCooldownMs: Schema.number(),
  notifyWebhook: Schema.string().default(''),
  notifyThreshold: Schema.number().default(3),
  selfHealCooldown: Schema.boolean().default(true),
  selfHealIdleMs: Schema.number().default(3600000),
  latencyEnabled: Schema.boolean().default(true),
  latencyWindow: Schema.number().default(200),
  concurrencyLimit: Schema.number().default(0),
  cascade: Schema.array(Schema.object({
    provider: Schema.string().required(),
    model: Schema.string(),
  })).default([]),
  quotaResetWindow: Schema.object({
    type: Schema.string().default('midnight_utc'),
    hour: Schema.number().default(0),
  }),
  rateLimitThreshold: Schema.number().default(0.1),
  rpmLimit: Schema.number().default(0),
  webhookActionToken: Schema.string().role('secret').default(''),
  expiryWarnDays: Schema.number().default(7),
  switchNotify: Schema.boolean().default(false),
  verboseLogging: Schema.boolean().default(false),
  // #260 circuit breaker
  circuitBreakerEnabled: Schema.boolean().default(true),
  circuitBreakerThreshold: Schema.number().default(5),
  circuitBreakerOpenMs: Schema.number().default(30000),
  circuitBreakerHalfOpenProbes: Schema.number().default(1),
  // #287 persistence across restarts
  persistenceEnabled: Schema.boolean().default(true),
  persistencePath: Schema.string().default(''),
  switchNotifyThrottleMs: Schema.number().default(60000),
  warnBelowHealthy: Schema.number().default(0),
  latencySloMs: Schema.number().default(0),
  providers: Schema.array(Schema.object({
    provider: Schema.string().required(),
    keys: Schema.array(Schema.string()).default([]),
    weights: Schema.array(Schema.number()).default([]),
    expiresAt: Schema.array(Schema.union([Schema.number(), Schema.string()])).default([]),
    tags: Schema.array(Schema.string()).default([]),
    costBudgetDaily: Schema.number(),
    costBudgetWeekly: Schema.number(),
    pauseOnBudget: Schema.boolean().default(false),
    models: Schema.dict(Schema.object({
      keys: Schema.array(Schema.string()).default([]),
      weights: Schema.array(Schema.number()).default([]),
    })).default({}),
    cooldownMs: Schema.number(),
    maxCooldownMs: Schema.number(),
  })).default([...DEFAULT_PROVIDERS]),
});

// ── config bridge (GET/PUT/DELETE on CONFIG_PATH), mirroring llm-fallback ──


function registerConfigBridge(ctx, getCloneIds) {
  return ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_PATH,
    handler: (req, res) => void handleConfigBridge(ctx, req, res, getCloneIds),
  });
}

// ── plugin ──

export function apply(ctx, config = {}) {
  // GUI section: defaults -> cordis row config -> saved user section.
  // (installSettingsSection inlined: no @deepseek-ai/dsh-settings import, so the
  // profile does not need a second copy of that package.)
  getConfig = () => config;
  registerConfigBridge(ctx, () => buildRuntime().cloneIds);
  lastTestCacheRunnerCtx = ctx;
  // Cache should not survive profile restarts (apply is called per reload).
  // We deliberately do NOT clear on every apply — that would wipe badges when
  // the user is just typing in the settings card. Re-init only on true reload.
  ensureSandboxRunner(ctx);

  // Self-healing idle cooldowns: every 60s, lift expired cooldowns for keys
  // that have been idle for selfHealIdleMs (default 1h). ponytail: small
  // interval, low cost; skipped when selfHealCooldown is disabled in config.
  // ponytail: keep handle on the same ctx via closure so buildRuntime() reads
  // fresh config on every tick. Naive but correct: 60s cadence is cheap.
  // Self-healing idle cooldowns lifecycle effect
  ctx.effect(() => {
    const cfg = getConfig();
    if (!cfg || cfg.selfHealCooldown === false) return () => {};
    const timer = setInterval(() => {
      try {
        const c = getConfig();
        if (!c || c.selfHealCooldown === false) return;
        const idle = Number.isFinite(c.selfHealIdleMs) && c.selfHealIdleMs > 0 ? c.selfHealIdleMs : 3600000;
        const providers = Array.isArray(c.providers) ? c.providers : [];
        const pools = providers
          .map((p) => buildRuntime().providerToPool.get(p.provider))
          .filter(Boolean);
        healIdleCooldowns(pools, idle);
      } catch (_) { /* ponytail: never crash the timer */ }
    }, 60000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'dsh-key-rotation: self-healing idle');

  // ── key-pool state, persisted across config reloads ──
  // base provider -> { failedUntil: Map<ref, epochMs>, pointer: number, lastUsed: ref }
  const poolState = new Map();

  // #287: persist cooldowns / circuit / quota across DSH reloads.
  // Path resolution: explicit config -> host data dir -> DSH_HOME -> cwd.
  // Disabled (with a single warn) when no writable directory can be found.
  let statePersistence = null;
  try {
    const cfg0 = getConfig() ?? config ?? {};
    // Cordis ctx properties require inject; bare getters throw.
    // Use only host env/cwd so apply() never trips the injector.
    const hostDirs = [
      process.env.DSH_HOME,
      process.cwd(),
    ].filter((d) => typeof d === 'string' && d.length > 0);
    const resolvedPath = resolveStatePath({
      configuredPath: cfg0.persistencePath,
      dataDir: hostDirs[0],
    });
    if (cfg0.persistenceEnabled !== false && resolvedPath) {
      statePersistence = new StatePersistence({ filePath: resolvedPath });
      statePersistence.load().then((snap) => {
        if (!snap) return;
        try {
          StatePersistence.restorePools(poolState, snap);
          if (moduleBreaker && snap.circuit) moduleBreaker.restore(snap.circuit);
          if (verboseLoggingOn()) {
            console.warn(`[dsh-key-rotation] restored ${Object.keys(snap.pools ?? {}).length} pool state(s) from ${path.basename(resolvedPath)}`);
          }
        } catch (e) {
          console.warn('[dsh-key-rotation] persistence restore failed', e?.message ?? e);
        }
      }).catch(() => {});
    } else if (cfg0.persistenceEnabled !== false && !resolvedPath) {
      console.warn('[dsh-key-rotation] persistence disabled: no data directory');
    }
  } catch (e) {
    console.warn('[dsh-key-rotation] persistence init failed', e?.message ?? e);
  }

  function persistenceSnapshot() {
    if (!statePersistence) return null;
    return StatePersistence.serialize({
      poolState,
      circuitSnapshot: moduleBreaker ? moduleBreaker.snapshot() : {},
      quotaSnapshot: {},
    });
  }

  function schedulePersist() {
    if (!statePersistence) return;
    const snap = persistenceSnapshot();
    if (snap) statePersistence.save(snap);
  }

  ctx.effect(() => {
    const timer = setInterval(() => { try { schedulePersist(); } catch (_) {} }, 15000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => {
      clearInterval(timer);
      try {
        if (statePersistence) {
          const snap = persistenceSnapshot();
          if (snap) {
            statePersistence.save(snap);
            // best-effort flush; dispose clears the debounce timer
            void statePersistence.flush();
          }
          statePersistence.dispose();
        }
      } catch (_) {}
    };
  }, 'dsh-key-rotation: state persistence');
  // Periodic sweep of expired cooldowns — keeps health probe cheap and avoids waiting for next user request
  ctx.effect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      // probe events for keys whose cooldown just expired
      for (const st of poolState.values()) {
        for (const [ref, until] of [...(st.failedUntil?.entries() ?? [])]) {
          if (until <= now && !st.probedAt?.has(ref)) {
            st.events.push({ at: until, ref, reason: 'probe', cooldownMs: 0, type: 'probe' });
            if (st.events.length > 50) st.events.shift();
            if (!st.probedAt) st.probedAt = new Map();
            st.probedAt.set(ref, until);
          }
        }
      }
      const n = sweepExpired(poolState, now);
      if (n > 0) console.warn(`[dsh-key-rotation] sweep: cleared ${n} expired cooldown(s)`);
      const runtime = buildRuntime();
      for (const pool of runtime.poolByRef.values()) {
        compactUsage(pool, 30, now);
      }
      // #207 expiry pre-warning + #208 cost budget - piggybacked on this timer,
      // deduped to one notification per key/window per day (shouldNotifyDaily).
      try {
        const seen = new Set();
        for (const pool of runtime.poolByRef.values()) {
          if (seen.has(pool.base)) continue;
          seen.add(pool.base);
          // #207: keys expiring within expiryWarnDays -> one webhook per key/day
          for (const { ref, expiresInDays } of expiringSoon(pool, runtime.expiryWarnDays, now)) {
            if (!shouldNotifyDaily(expiryNotifiedAt, pool.base + ':' + ref, now)) continue;
            console.warn(`[dsh-key-rotation] ${pool.base}: key ${ref} expires in ~${expiresInDays}d`);
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
            console.warn(`[dsh-key-rotation] ${pool.base}: cost budget - day $${daily.toFixed(2)}/$${budget.costBudgetDaily} week $${weekly.toFixed(2)}/$${budget.costBudgetWeekly}`);
            if (runtime.notifyWebhook) {
              // #217: budget webhook gains action buttons when a callback token
              // is configured (the /webhook-action route already knows these ids)
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
              console.warn(`[dsh-key-rotation] ${pool.base}: pool running low - ${healthy}/${pool.refs.length} healthy`);
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
              console.warn(`[dsh-key-rotation] ${pool.base}: ${ref} p95 ${Math.round(snap.p95)}ms > SLO ${slo}ms`);
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
      } catch (_) { /* maintenance must never crash the sweep */ }
    }, 30000);
    if (typeof id.unref === 'function') id.unref();
    return () => clearInterval(id);
  }, 'dsh-key-rotation: sweep expired cooldowns');

  // ── runtime snapshot: config + llm-pi-ai profile mapping ──
  let cachedRuntime = null;
  let lastConfigRef = null;
  let lastProfilesRef = null;

  getRuntime = buildRuntime;
  function buildRuntime() {
    const rawConfig = getConfig() ?? {};
    let currentProfiles = null;
    try {
      currentProfiles = ctx.get('settings')?.get(PIAI_NS)?.providers ?? null;
    } catch {
      /* settings not mounted yet — empty mapping */
    }

    if (cachedRuntime && lastConfigRef === rawConfig && lastProfilesRef === currentProfiles) {
      return cachedRuntime;
    }

    const cfg = Config(rawConfig) ?? {};
    const switchCodes = new Set(cfg.switchCodes ?? DEFAULT_SWITCH_CODES);
    const cooldownMs = cfg.cooldownMs ?? 60000;
    const maxCooldownMs = cfg.maxCooldownMs ?? undefined;
    const notifyWebhook = cfg.notifyWebhook ?? '';
    const notifyThreshold = cfg.notifyThreshold ?? 3;
    const rateLimitThreshold = cfg.rateLimitThreshold ?? 0.1;
    const rpmLimit = cfg.rpmLimit ?? 0;
    const webhookActionToken = cfg.webhookActionToken ?? '';
    const concurrencyLimit = cfg.concurrencyLimit ?? 0;
    const cascade = Array.isArray(cfg.cascade) ? cfg.cascade : [];
    const quotaResetWindow = cfg.quotaResetWindow || null;

    // ref -> pool (every key env of every configured provider)
    const poolByRef = new Map();
    // provider route (from llm-pi-ai profiles) -> its key pool
    const providerToPool = new Map();
    // per-model key pools: provider -> Map<model, pool>
    const modelPoolByProvider = new Map();
    // clone route ids (for the settings dropdown filter)
    const cloneIds = new Set();

    const makeState = (base) => {
      let st = poolState.get(base);
      if (!st) {
        st = {
          failedUntil: new Map(),
          failCounts: new Map(),
          authFailCounts: new Map(),
          brokenUntil: new Map(),
          costPerKey: new Map(),
          lastUsedAt: new Map(),
          usageCounts: new Map(),
          byModel: new Map(),
          usageDays: new Map(),
          quotaWindows: new Map(),
          // #260 per-provider circuit breaker (lazy)
          breaker: null,
          pointer: 0,
          lastUsed: undefined,
          switches: 0,
          lastReason: undefined,
          lastSwitchAt: undefined,
          lastExhaustionAt: undefined,
          exhaustionCount: 0,
          events: [],
        };
        poolState.set(base, st);
      }
      return st;
    };
    const parseExpiry = (v) => {
      if (typeof v === 'number' && v > 0) return v;
      if (typeof v === 'string' && v.length > 0) { const ts = Date.parse(v); return Number.isNaN(ts) ? undefined : ts; }
      return undefined;
    };
    const buildPool = (base, keys, weights, poolCooldown, poolMax, expiresAt) => {
      const refs = (keys ?? []).filter((ref) => typeof ref === 'string' && ref.length > 0);
      if (refs.length === 0) return null;
      const w = Array.isArray(weights) ? weights : [];
      const weightedRefs = [];
      for (let i = 0; i < refs.length; i++) {
        const ww = typeof w[i] === 'number' && w[i] > 0 ? Math.floor(w[i]) : 1;
        for (let k = 0; k < ww; k++) weightedRefs.push(refs[i]);
      }
      const parsedExpiry = {};
      if (Array.isArray(expiresAt)) {
        for (let i = 0; i < refs.length; i++) {
          const exp = parseExpiry(expiresAt[i]);
          if (exp !== undefined) parsedExpiry[refs[i]] = exp;
        }
      }
      return { base, refs, weights: refs.map((_, i) => (typeof w[i] === 'number' && w[i] > 0 ? Math.floor(w[i]) : 1)),
               weightedRefs: weightedRefs.length > 0 ? weightedRefs : refs,
               state: makeState(base), cooldownMs: poolCooldown, maxCooldownMs: poolMax, expiresAt: parsedExpiry, rpmLimit };
    };
    for (const p of cfg.providers ?? []) {
      const poolCooldown = typeof p.cooldownMs === 'number' ? p.cooldownMs : (cfg.cooldownMs ?? 60000);
      const poolMax = typeof p.maxCooldownMs === 'number' ? p.maxCooldownMs : (cfg.maxCooldownMs ?? undefined);
      // base provider pool (fallback)
      const pool = buildPool(p.provider, p.keys, p.weights, poolCooldown, poolMax);
      if (pool) {
        for (const ref of pool.refs) poolByRef.set(ref, pool);
        for (let i = 1; i < pool.refs.length; i++) cloneIds.add(`${p.provider}-${i + 1}`);
      }
      // per-model pools
      const models = p.models ?? {};
      const byModel = new Map();
      for (const [model, mp] of Object.entries(models)) {
        const mpool = buildPool(`${p.provider}::${model}`, mp.keys, mp.weights, poolCooldown, poolMax);
        if (mpool) {
          byModel.set(model, mpool);
          for (const ref of mpool.refs) poolByRef.set(ref, mpool);
        }
      }
      if (byModel.size > 0) modelPoolByProvider.set(p.provider, byModel);
    }

    let profiles = {};
    try {
      profiles = ctx.get('settings')?.get(PIAI_NS)?.providers ?? {};
    } catch {
      /* settings not mounted yet — empty mapping */
    }
    for (const [provider, profile] of Object.entries(profiles)) {
      if (profile?.apiKeyEnv && poolByRef.has(profile.apiKeyEnv)) {
        providerToPool.set(provider, poolByRef.get(profile.apiKeyEnv));
      }
    }

    // auto-cleanup: remove poolState for providers that are now empty or removed
    for (const key of [...poolState.keys()]) {
      if (![...poolByRef.values()].some((p) => p.base === key)) {
        poolState.delete(key);
        lowHealthNotifiedAt.delete(key);
        budgetNotifiedAt.delete(key + ':budget');
      }
    }
    // #192: drop RPM windows for refs that no longer belong to any pool
    for (const st of poolState.values()) {
      if (st.rpmWindows) bucketSweep(st.rpmWindows, new Set(poolByRef.keys()));
    }
    // #195: provider -> tags (metadata, surfaced in status)
    const providerTags = new Map();
    // #208: provider -> { costBudgetDaily, costBudgetWeekly, pauseOnBudget }
    const providerBudgets = new Map();
    for (const p of cfg.providers ?? []) {
      if (Array.isArray(p.tags) && p.tags.length > 0) providerTags.set(p.provider, p.tags);
      const daily = typeof p.costBudgetDaily === 'number' ? p.costBudgetDaily : 0;
      const weekly = typeof p.costBudgetWeekly === 'number' ? p.costBudgetWeekly : 0;
      if (daily > 0 || weekly > 0) providerBudgets.set(p.provider, { costBudgetDaily: daily, costBudgetWeekly: weekly, pauseOnBudget: p.pauseOnBudget ?? false });
    }
    // #266: orphan clone-route GC — expected clones only for live multi-key providers
    const expectedClones = new Set();
    for (const p of cfg.providers ?? []) {
      const n = (p.keys ?? []).filter((k) => typeof k === 'string' && k.length > 0).length;
      for (let i = 1; i < n; i++) expectedClones.add(`${p.provider}-${i + 1}`);
    }
    // drop breaker entries for removed providers
    if (moduleBreaker) {
      for (const key of Object.keys(moduleBreaker.snapshot())) {
        if (![...providerToPool.keys()].includes(key) && !expectedClones.has(key)) {
          // keep until TTL; only reset if provider gone from config entirely
          const still = (cfg.providers ?? []).some((p) => p.provider === key);
          if (!still) moduleBreaker.reset(key);
        }
      }
    }
    cachedRuntime = { switchCodes, cooldownMs, maxCooldownMs, notifyWebhook, notifyThreshold, concurrencyLimit, cascade, quotaResetWindow, rateLimitThreshold, rpmLimit, webhookActionToken, expiryWarnDays: cfg.expiryWarnDays ?? 7, switchNotify: cfg.switchNotify ?? false, verboseLogging: cfg.verboseLogging ?? false, switchNotifyThrottleMs: cfg.switchNotifyThrottleMs ?? 60000, warnBelowHealthy: cfg.warnBelowHealthy ?? 0, latencySloMs: cfg.latencySloMs ?? 0, providerTags, providerBudgets, poolByRef, providerToPool, modelPoolByProvider, cloneIds, expectedClones,
      circuitBreakerEnabled: cfg.circuitBreakerEnabled ?? true,
      circuitBreakerThreshold: cfg.circuitBreakerThreshold ?? 5,
      circuitBreakerOpenMs: cfg.circuitBreakerOpenMs ?? 30000,
      circuitBreakerHalfOpenProbes: cfg.circuitBreakerHalfOpenProbes ?? 1,
      breaker: moduleBreaker,
      notifyQueue: moduleNotifyQueue,
    };
    lastConfigRef = rawConfig;
    lastProfilesRef = currentProfiles;
    return cachedRuntime;
  }

  // ── patch credentials.resolve: pool refs resolve to the next healthy key ──
  // Round-robin over the pool, skipping keys in cooldown; the request's
  // provider identity never changes, so pi-ai replay state stays consistent.
  ctx.effect(() => {
    const credentials = ctx.get('credentials');
    if (credentials && typeof credentials.resolve === 'function' && !credentials.__dshKeyRotationPatched) {
      const original = credentials.resolve.bind(credentials);
      // Kept for the status route: it must ask about one exact ref instead of
      // being rotated to a different key by the patch below.
      credentials.__dshKeyRotationOriginalResolve = original;
      credentials.resolve = async (ref) => {
      const { poolByRef } = buildRuntime();
      const pool = poolByRef.get(ref);
      if (!pool) return original(ref);
      const now = Date.now();
      const list = pool.weightedRefs ?? pool.refs;
      const start = pool.state.pointer ?? 0;
      for (let i = 0; i < list.length; i++) {
        const index = (start + i) % list.length;
        const candidate = list[index];
        const until = pool.state.failedUntil.get(candidate);
        if (until !== undefined && until > now) continue;
        if (pool.expiresAt?.[candidate] !== undefined && now >= pool.expiresAt[candidate]) continue;
        // #192 RPM token bucket: skip a key that already hit its requests/min cap
        const rpmLimit = pool.rpmLimit ?? 0;
        if (rpmLimit > 0) {
          if (!pool.state.rpmWindows) pool.state.rpmWindows = new Map();
          if (!bucketAllow(pool.state.rpmWindows, candidate, rpmLimit, now)) {
            const waitMs = bucketRetryMs(pool.state.rpmWindows, candidate, rpmLimit, now);
            if ((pool.state.failedUntil.get(candidate) ?? 0) < now + waitMs) {
              pool.state.failedUntil.set(candidate, now + waitMs);
            }
            continue;
          }
        }
        if (pool.perHour) {
          if (!pool.state.quotaWindows) pool.state.quotaWindows = new Map();
          let win = pool.state.quotaWindows.get(candidate);
          if (!win || now - win.start >= 3600000) win = { count: 0, start: now };
          if (win.count >= pool.perHour) {
            const until = win.start + 3600000;
            if ((pool.state.failedUntil.get(candidate) ?? 0) < until) pool.state.failedUntil.set(candidate, until);
            continue;
          }
        }
        // Advance pointer immediately so concurrent requests round-robin across distinct healthy keys
        pool.state.pointer = (index + 1) % list.length;
        let hit = await original(candidate);
        if (hit && typeof hit.value === 'string' && hit.value.length > 0) {
          pool.state.lastUsed = candidate;
          if (!pool.state.lastUsedAt) pool.state.lastUsedAt = new Map();
          pool.state.lastUsedAt.set(candidate, now);
          const store = dispatchStorage.getStore();
          if (store && store.pool === pool) store.pickedRef = candidate;
          if (pool.state.failCounts) pool.state.failCounts.delete(candidate);
          pool.state.failedUntil.delete(candidate);
          if (pool.state.authFailCounts) pool.state.authFailCounts.delete(candidate);
          if (pool.state.brokenUntil) pool.state.brokenUntil.delete(candidate);
          if (!pool.state.usageCounts) pool.state.usageCounts = new Map();
          pool.state.usageCounts.set(candidate, (pool.state.usageCounts.get(candidate) ?? 0) + 1);
          if (pool.perHour) {
            if (!pool.state.quotaWindows) pool.state.quotaWindows = new Map();
            let win2 = pool.state.quotaWindows.get(candidate);
            if (!win2 || now - win2.start >= 3600000) win2 = { count: 0, start: now };
            win2.count++;
            pool.state.quotaWindows.set(candidate, win2);
          }
          return hit;
        }
        // fallback: env var (transient, not persisted)
        const envVal = envValue(candidate);
        if (envVal !== undefined) {
          pool.state.lastUsed = candidate;
          if (!pool.state.lastUsedAt) pool.state.lastUsedAt = new Map();
          pool.state.lastUsedAt.set(candidate, now);
          const store = dispatchStorage.getStore();
          if (store && store.pool === pool) store.pickedRef = candidate;
          if (pool.state.failCounts) pool.state.failCounts.delete(candidate);
          pool.state.failedUntil.delete(candidate);
          if (pool.state.authFailCounts) pool.state.authFailCounts.delete(candidate);
          if (pool.state.brokenUntil) pool.state.brokenUntil.delete(candidate);
          if (!pool.state.usageCounts) pool.state.usageCounts = new Map();
          pool.state.usageCounts.set(candidate, (pool.state.usageCounts.get(candidate) ?? 0) + 1);
          if (pool.perHour) {
            if (!pool.state.quotaWindows) pool.state.quotaWindows = new Map();
            let win2 = pool.state.quotaWindows.get(candidate);
            if (!win2 || now - win2.start >= 3600000) win2 = { count: 0, start: now };
            win2.count++;
            pool.state.quotaWindows.set(candidate, win2);
          }
          return { value: envVal, source: 'env' };
        }
      }
      return original(ref); // everything cooled/missing — surface the base value
      };
      credentials.__dshKeyRotationPatched = true;
      return () => {
        if (credentials.__dshKeyRotationPatched) {
          credentials.resolve = original;
          delete credentials.__dshKeyRotationPatched;
          delete credentials.__dshKeyRotationOriginalResolve;
        }
      };
    }
  }, 'dsh-key-rotation: patch credentials.resolve');

  const finishError = (code, message) => ({
    type: 'finish',
    reason: { kind: 'error', failure: Object.freeze({ code, message }) },
  });

  // Latency recording (#6): record successful llm/stream latency per ref.
  // ponytail: only the true success path (finish-chunk). Failures are not recorded.
  let _rotateStartMs = Date.now();
  function recordLatency(pool, reqStore) {
    try {
      const cfg = getConfig();
      if (!cfg || cfg.latencyEnabled === false) return;
      const ref = reqStore?.pickedRef ?? pool?.state?.lastUsed;
      if (!ref) return;
      const startMs = reqStore?.startMs ?? _rotateStartMs;
      const elapsed = Date.now() - startMs;
      if (!Number.isFinite(elapsed) || elapsed < 0) return;
      latencyHistogram.record(ref, elapsed);
    } catch (_) { /* ponytail: never crash */ }
  }

  // rotate() factory (#253): dependencies injected for testability
    const rotate = createRotate({
    ctx,
    dispatchStorage,
    buildRuntime,
    pushEvent,
    notifySwitch: (runtime, pool, info) => notifySwitch(runtime, pool, info, { webhookSender, notifyQueue: moduleNotifyQueue, now: () => Date.now() }),
    notifyExhaustion,
    recordLatency,
    concurrencyTracker,
    MARKER,
    finishError,
    setRotateStartMs: (v) => { _rotateStartMs = v; },
    quotaStore,
    circuitBreaker: moduleBreaker,
    now: nowMono,
  });

  // Retry one request on the next pool key when the current key fails with a
  // switchable error before any content chunk. The provider never changes —
  // the resolve patch hands out the next key on each dispatch.
  // Operational routes (status/usage/snapshot/key/import/test/health/webhook) (#253)
  registerOpsRoutes(ctx, {
    buildRuntime,
    latencyHistogram,
    lastTestCache,
    ensureSandboxRunner,
    poolState,
    getRotationDisabled: () => rotationDisabled,
    setRotationDisabled: (v) => { rotationDisabled = v; },
    circuitBreaker: moduleBreaker,
    quotaStore,
  });

  ctx.effect(() => ctx.on('llm/stream', (options, next) => {
    if (options[MARKER]) return next();
    if (rotationDisabled) return next(); // #199: disabled via webhook action
    const { providerToPool, modelPoolByProvider } = buildRuntime();
    // #195: exact model pool -> longest model-family prefix -> provider pool
    const pool = selectPool(modelPoolByProvider, providerToPool, options.provider, options.model);
    if (!pool) return next();
    if (buildRuntime()?.verboseLogging) {
      console.warn(`[dsh-key-rotation] rotating ${options.provider}/${options.model} across ${(pool.weightedRefs ?? pool.refs).length} slots (${pool.refs.length} keys)`);
    }
    return rotate(options, pool);
  }), 'dsh-key-rotation: llm/stream');

  // Safety net for non-stream requests (agent/request-error waterfall).
  // llm/stream covers streaming calls; sync calls (embeddings, batch) go
  // through agent/request and surface errors here. If the error is
  // switchable, mark the key and ask the agent loop to retry.
  ctx.effect(() => ctx.on('agent/request-error', async (payload, next) => {
    const provider = payload?.provider ?? payload?.failure?.provider ?? '';
    if (!provider) return next();
    const { providerToPool, modelPoolByProvider, switchCodes } = buildRuntime();
    const model = payload?.model || payload?.failure?.model || '';
    // #195: same tier-aware selection as llm/stream
    const pool = selectPool(modelPoolByProvider, providerToPool, provider, model);
    if (!pool) return next();
    const code = String(payload?.failure?.code ?? payload?.code ?? '');
    const message = String(payload?.failure?.message ?? payload?.message ?? '');
    const effectiveSwitchCodes = pool.switchCodes ?? switchCodes;
    const cls = classifyFailure(payload);
    const switchable = isSwitchableError(payload, effectiveSwitchCodes) || cls.action === 'switch';
    if (!switchable) return next();
    if (moduleBreaker) moduleBreaker.onFailure(provider);
    const ref = pool.state.lastUsed;
    if (ref) {
      const backoff = recordFailure(pool, ref, Date.now(), pool.cooldownMs ?? 60000, undefined, cls.soft, true);
      pushEvent(pool, ref, code || 'UNKNOWN', backoff);
      schedulePersist();
      pool.state.switches = (pool.state.switches ?? 0) + 1;
      pool.state.lastReason = code || 'UNKNOWN';
      pool.state.lastSwitchAt = Date.now();
      console.warn(`[dsh-key-rotation] ${provider}: key ${String(ref)} failed via agent/request-error (${String(code)} ${String(message).slice(0, 80)}) — retry`);
    }
    return { kind: 'retry' };
  }), 'dsh-key-rotation: agent/request-error');

  ctx.inject(['settings'], (sctx) => {
    const settingsSvc = sctx.get('settings');
    if (!settingsSvc || typeof settingsSvc.register !== 'function') {
      console.warn('[dsh-key-rotation] settings service unavailable — config scope not registered');
      return;
    }
    const scope = settingsSvc.register(NS, Config, { base: config });
    getConfig = () => scope.get() ?? config;
    sctx.effect(() => () => {
      getConfig = () => config;
    });
  });
}

// Notify on exhaustion: webhook notification.
// Extracted at module scope for testability. No I/O outside the injected hooks.
// ponytail: thresholds and URLs are runtime-resolved per call, so changing Config is reflected immediately.
export function notifyExhaustion(runtime, pool, options, hooks = { webhookSender }) {
  if (!runtime || !pool) return;
  const count = pool.state ? (pool.state.exhaustionCount ?? 0) : 0;
  if (count <= 0) return;
  try {
    if (runtime.notifyWebhook && count >= (runtime.notifyThreshold ?? 0)) {
      const token = runtime.webhookActionToken ?? '';
      const payload = {
        title: `Key pool exhausted: ${options.provider}`,
        text: `${count} exhaustion(s); keys: ${(pool.refs ?? []).join(', ')}`,
        provider: options.provider,
        exhaustionCount: count,
        at: pool.state.lastExhaustionAt,
        keys: pool.refs,
        actionToken: token || undefined,
        actions: token ? [
          { id: `reset-${options.provider}`, label: 'Reset cooldown' },
          { id: `pause-${options.provider}`, label: 'Pause 1h' },
        ] : undefined,
      };
      if (hooks.notifyQueue) hooks.notifyQueue.enqueue(runtime.notifyWebhook, payload);
      else hooks.webhookSender.send(runtime.notifyWebhook, payload);
    }
  } catch (_) { /* ponytail: never crash rotate() */ }
}


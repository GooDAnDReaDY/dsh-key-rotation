import { createResolver } from './resolver.js';
import { decryptSecret } from './crypto-storage.js';
// dsh-key-rotation — per-provider API key rotation for DeepSeek Harness.
//
// Transparent key pool rotation: credentials.resolve patch + llm/stream
// interceptor. Provider identity never changes (keeps pi-ai replay state).
// See README.md and docs/design/DESIGN.md for the full contract.

import { AsyncLocalStorage } from 'node:async_hooks';
import Schema from '@deepseek-ai/schemastery';
import { createConfigReader, createProviderProfilesReader } from './config-compat.js';
import {
  keyTail, KEY_TAIL_CHARS, KEY_TAIL_PLACEHOLDER, isLoopbackAddress, isTrustedBridgeRequest, SWITCHABLE_MESSAGE_PATTERN,
  DEFAULT_SWITCH_CODES, isValidRef, pickNext, applyCooldown, recordFailure,
  recordSuccess, computeBackoff, envValue, sweepExpired, parseRetryAfter,
  computeHealthScore, extractRateLimit, isRateLimited, selectPool, isSwitchableError,
  formatExhaustionMessage, expiringSoon, shouldNotifyDaily, costForDay, costForWeek,
  budgetVerdict, sortAttemptList, isKeyPaused, isKeyRevoked,
} from './pool.js';
import { LatencyHistogram } from './histogram.js';
import { ConcurrencyTracker } from './concurrency.js';
import { QuotaStore } from './quota.js';
import { WebhookSender, AlertDebouncer } from './webhook.js';
import { compactUsage } from './usage-report.js';
import { json, handleConfigBridge } from './http-bridge.js';
import { createRotate } from './rotate.js';
import { initializePoolState } from './pool-state.js';
import { nowMono } from './clock.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { NotifyQueue } from './notify-queue.js';
import { classifyFailure } from './error-taxonomy.js';
import { registerOpsRoutes } from './routes-ops.js';
import { registerPluginUpdater } from './plugin-updater.js';
import { notifySwitch, notifyExhaustion, pushEvent } from './notify-events.js';
import { getLogger } from './logger.js';
import { createSandboxService } from './sandbox-service.js';
import { checkBudgetAndHealthAlerts } from './budget-monitor.js';
import { cleanupRemovedProviders, buildPools } from './pool-builder.js';
import { resolveRefPool, isQuotaManagedRequest } from './pool-index.js';
import {
  isModelQuotaAvailable,
  hasModelQuotaConfig,
  anyModelQuotaAvailable,
  formatModelQuotaExhaustion,
} from './model-quota.js';
import { LOCAL_QUOTA_CODE } from './rotate.js';
import { setupIdleHealEffect, setupAutoUnbreakEffect, setupPersistence } from './lifecycle.js';

export const name = '@goodandready/dsh-key-rotation';
export const inject = ['llm', 'webServer', 'settings', 'credentials'];
export { keyTail, KEY_TAIL_CHARS, KEY_TAIL_PLACEHOLDER, isLoopbackAddress, isTrustedBridgeRequest, DEFAULT_SWITCH_CODES, isSwitchableError, formatExhaustionMessage, getRuntime };
export { notifySwitch, notifyExhaustion };

const NS = 'dsh-key-rotation';

// DSH serves a namespace's settings form from the volatile fields of its profile
// entry schema, and a volatile field holds a Volatile box rather than its value.
// Unwrap before any caller reads one, and read lazily: the Loader mutates the
// boxes in place and re-announces them with loader/volatile-update.
export function plainConfig(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(plainConfig)
  if (typeof value.get === 'function') return plainConfig(value.get())
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainConfig(v)]))
}
const CONFIG_PATH = '/dsh-key-rotation/config';
const PIAI_NS = 'llm-pi-ai';
const MARKER = '__dshKeyRotation';

const dispatchStorage = new AsyncLocalStorage();
let getRuntime = () => null;

const DEFAULT_PROVIDERS = [];

const SettingsSchema = Schema.object({
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
  proactiveRateLimitGuard: Schema.boolean().default(true),
  selfHealingIntervalMinutes: Schema.number().default(30),
  routingStrategy: Schema.union(['round-robin', 'least-loaded', 'lowest-latency']).default('round-robin'),
  rpmLimit: Schema.number().default(0),
  tpmLimit: Schema.number().default(0),
  webhookActionToken: Schema.string().role('secret').default(''),
  expiryWarnDays: Schema.number().default(7),
  switchNotify: Schema.boolean().default(false),
  verboseLogging: Schema.boolean().default(false),
  circuitBreakerEnabled: Schema.boolean().default(true),
  circuitBreakerThreshold: Schema.number().default(5),
  circuitBreakerOpenMs: Schema.number().default(30000),
  circuitBreakerHalfOpenProbes: Schema.number().default(1),
  persistenceEnabled: Schema.boolean().default(true),
  persistencePath: Schema.string().default(''),
  switchNotifyThrottleMs: Schema.number().default(60000),
  warnBelowHealthy: Schema.number().default(0),
  latencySloMs: Schema.number().default(0),
  providers: Schema.array(Schema.object({
    provider: Schema.string().required(),
    keys: Schema.array(Schema.string()).default([]),
    weights: Schema.array(Schema.number()).default([]),
    paused: Schema.array(Schema.boolean()).default([]),
    revoked: Schema.array(Schema.boolean()).default([]),
    expiresAt: Schema.array(Schema.union([Schema.number(), Schema.string()])).default([]),
    tags: Schema.array(Schema.string()).default([]),
    costBudgetDaily: Schema.number(),
    costBudgetWeekly: Schema.number(),
    pauseOnBudget: Schema.boolean().default(false),
    models: Schema.dict(Schema.object({
      keys: Schema.array(Schema.string()).default([]),
      weights: Schema.array(Schema.number()).default([]),
      quotas: Schema.dict(Schema.object({
        tokenLimit: Schema.number(),
      })).default({}),
      rpmLimit: Schema.number(),
      tpmLimit: Schema.number(),
    })).default({}),
    cooldownMs: Schema.number(),
    maxCooldownMs: Schema.number(),
    routingStrategy: Schema.union(['round-robin', 'least-loaded', 'lowest-latency']),
    proactiveRateLimitGuard: Schema.boolean(),
    rpmLimit: Schema.number(),
    tpmLimit: Schema.number(),
  })).default([...DEFAULT_PROVIDERS]),
});

// New settings derives editable forms from volatile entry Config fields. Keep
// initialization-only persistence options ordinary (restart-bound) and retain a
// plain schema for old namespace registration. Older schemastery has no volatile.
export const Config = typeof Schema.number().volatile === 'function'
  ? Schema.object(Object.fromEntries(Object.entries(SettingsSchema.dict).map(([name, field]) => [
    name, ['persistenceEnabled', 'persistencePath'].includes(name) ? field : field.volatile(),
  ])))
  : SettingsSchema;

function registerConfigBridge(ctx, getCloneIds) {
  return ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_PATH,
    handler: (req, res) => {
      if (!['GET', 'PUT', 'DELETE', 'OPTIONS'].includes(req.method)) {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      return handleConfigBridge(ctx, req, res, getCloneIds);
    },
  });
}

export function apply(ctx, config = {}) {
  const logger = getLogger(ctx);
  const readEntryConfig = createConfigReader(config, ctx);
  let getConfig = readEntryConfig;
  const verboseLoggingOn = () => {
    try { return Boolean(getConfig()?.verboseLogging); } catch (_) { return false; }
  };

  let rotationDisabled = false;
  const expiryNotifiedAt = new Map();
  const budgetNotifiedAt = new Map();
  const lowHealthNotifiedAt = new Map();
  const sloNotifiedAt = new Map();

  const latencyHistogram = new LatencyHistogram();
  const quotaStore = new QuotaStore();
  const concurrencyTracker = new ConcurrencyTracker();

  const moduleBreaker = new CircuitBreaker({ threshold: 5, openMs: 30000, halfOpenProbes: 1, now: nowMono });
  const webhookSender = new WebhookSender({ fetchImpl: globalThis.fetch });
  const alertDebouncer = new AlertDebouncer({ sender: webhookSender, debounceMs: 2000 });
  const moduleNotifyQueue = new NotifyQueue({ send: (url, payload) => alertDebouncer.enqueue(url, payload) });

  const sandboxService = createSandboxService({ getRuntime: () => buildRuntime() });
  const { ensureSandboxRunner, probeRef, lastTestCache } = sandboxService;

  const readProfiles = createProviderProfilesReader(ctx, PIAI_NS);
  registerConfigBridge(ctx, () => buildRuntime().cloneIds);
  ensureSandboxRunner(ctx);

  setupIdleHealEffect(ctx, getConfig, buildRuntime);

  const poolState = new Map();
  const { schedulePersist, persistenceSnapshot } = setupPersistence(ctx, {
    cfg0: getConfig() ?? config ?? {},
    poolState,
    moduleBreaker,
    verboseLoggingOn,
    logger,
  });

  setupAutoUnbreakEffect(ctx, getConfig, buildRuntime, ensureSandboxRunner, logger);

  // Periodic sweep of expired cooldowns
  ctx.effect(() => {
    const id = setInterval(() => {
      const now = Date.now();
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
      const runtime = buildRuntime();
      const allActiveRefs = Array.from(runtime.poolByRef.keys());
      const n = sweepExpired(poolState, now, allActiveRefs, runtime.quotaResetWindow);
      if (n > 0) logger.warn(`[dsh-key-rotation] sweep: cleared ${n} expired cooldown(s)`);
      for (const pool of (runtime.pools ?? runtime.poolByRef.values())) {
        compactUsage(pool, 30, now);
      }
      checkBudgetAndHealthAlerts({
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
      });
    }, 30000);
    if (typeof id.unref === 'function') id.unref();
    return () => clearInterval(id);
  }, 'dsh-key-rotation: sweep expired cooldowns');

  let cachedRuntime = null;
  let lastConfigRef = null;
  let lastProfilesRef = null;

  function buildRuntime() {
    const rawConfig = getConfig();
    // Identity check below stays on the raw object: plainConfig allocates a new
    // object each call, which would defeat the runtime memo cache.
    const cfg = plainConfig(rawConfig ?? {});
    let profilesSnapshot = null;
    try {
      profilesSnapshot = readProfiles();
    } catch {
      profilesSnapshot = null;
    }
    if (cachedRuntime && rawConfig === lastConfigRef && profilesSnapshot === lastProfilesRef) {
      return cachedRuntime;
    }
    lastConfigRef = rawConfig;
    lastProfilesRef = profilesSnapshot;

    moduleBreaker.configure({
      threshold: cfg.circuitBreakerThreshold ?? 5,
      openMs: cfg.circuitBreakerOpenMs ?? 30000,
      halfOpenProbes: cfg.circuitBreakerHalfOpenProbes ?? 1,
    });
    if (cfg.latencyWindow && latencyHistogram.window !== cfg.latencyWindow) {
      latencyHistogram.reconfigure({ window: cfg.latencyWindow });
    }
    const switchCodes = cfg.switchCodes ?? DEFAULT_SWITCH_CODES;
    const cooldownMs = cfg.cooldownMs ?? 60000;
    const maxCooldownMs = cfg.maxCooldownMs;
    const notifyWebhook = cfg.notifyWebhook ?? '';
    const notifyThreshold = cfg.notifyThreshold ?? 3;
    const concurrencyLimit = cfg.concurrencyLimit ?? 0;
    const cascade = cfg.cascade ?? [];
    const quotaResetWindow = cfg.quotaResetWindow ?? { type: 'midnight_utc', hour: 0 };
    const rateLimitThreshold = cfg.rateLimitThreshold ?? 0.1;
    const rpmLimit = cfg.rpmLimit ?? 0;
    const tpmLimit = cfg.tpmLimit ?? 0;
    const webhookActionToken = cfg.webhookActionToken ?? '';

    const built = buildPools({ cfg, poolState, defaultState: initializePoolState });
    const { index, pools, poolByRef, modelPoolByProvider, cloneIds } = built;
    const providerToPool = new Map(built.providerToPool);

    let profiles = {};
    try {
      profiles = profilesSnapshot ?? {};
    } catch { /* settings not mounted yet */ }
    for (const [provider, profile] of Object.entries(profiles)) {
      if (profile?.apiKeyEnv && poolByRef.has(profile.apiKeyEnv)) {
        providerToPool.set(provider, poolByRef.get(profile.apiKeyEnv));
      }
    }

    const providerTags = new Map();
    const providerBudgets = new Map();
    for (const p of cfg.providers ?? []) {
      if (Array.isArray(p.tags) && p.tags.length > 0) providerTags.set(p.provider, p.tags);
      const daily = typeof p.costBudgetDaily === 'number' ? p.costBudgetDaily : 0;
      const weekly = typeof p.costBudgetWeekly === 'number' ? p.costBudgetWeekly : 0;
      if (daily > 0 || weekly > 0) providerBudgets.set(p.provider, { costBudgetDaily: daily, costBudgetWeekly: weekly, pauseOnBudget: p.pauseOnBudget ?? false });
    }

    const expectedClones = new Set();
    for (const p of cfg.providers ?? []) {
      const n = (p.keys ?? []).filter((k) => typeof k === 'string' && k.length > 0).length;
      for (let i = 1; i < n; i++) expectedClones.add(`${p.provider}-${i + 1}`);
    }

    cleanupRemovedProviders({
      cfg,
      poolState,
      poolByRef,
      pools,
      providerToPool,
      expectedClones,
      moduleBreaker,
      lowHealthNotifiedAt,
      budgetNotifiedAt,
    });

    concurrencyTracker.configure({ limit: concurrencyLimit });
    cachedRuntime = {
      switchCodes, cooldownMs, maxCooldownMs, notifyWebhook, notifyThreshold,
      concurrencyLimit, cascade, quotaResetWindow, rateLimitThreshold, rpmLimit, tpmLimit,
      webhookActionToken, expiryWarnDays: cfg.expiryWarnDays ?? 7,
      switchNotify: cfg.switchNotify ?? false, verboseLogging: cfg.verboseLogging ?? false,
      proactiveRateLimitGuard: cfg.proactiveRateLimitGuard ?? true,
      selfHealingIntervalMinutes: cfg.selfHealingIntervalMinutes ?? 30,
      routingStrategy: cfg.routingStrategy ?? 'round-robin',
      switchNotifyThrottleMs: cfg.switchNotifyThrottleMs ?? 60000,
      warnBelowHealthy: cfg.warnBelowHealthy ?? 0, latencySloMs: cfg.latencySloMs ?? 0,
      index, pools,
      breaker: moduleBreaker, notifyQueue: moduleNotifyQueue, concurrencyTracker, quotaStore, latencyHistogram,
      providerTags, providerBudgets, poolByRef, providerToPool, modelPoolByProvider,
      cloneIds, expectedClones,
      circuitBreakerEnabled: cfg.circuitBreakerEnabled ?? true,
      circuitBreakerThreshold: cfg.circuitBreakerThreshold ?? 5,
      circuitBreakerOpenMs: cfg.circuitBreakerOpenMs ?? 30000,
      circuitBreakerHalfOpenProbes: cfg.circuitBreakerHalfOpenProbes ?? 1,
    };
    return cachedRuntime;
  }

  getRuntime = () => buildRuntime();

  ctx.effect(() => {
    const credentials = ctx.get('credentials');
    if (credentials && typeof credentials.resolve === 'function') {
      const original = credentials.resolve.bind(credentials);
      credentials.__dshKeyRotationOriginalResolve = original;
      const resolve = createResolver({
        buildRuntime,
        currentPool: () => dispatchStorage.getStore()?.pool,
        onPicked: (pool, candidate, meta) => {
          const store = dispatchStorage.getStore();
          if (store && store.pool === pool) {
            store.pickedRef = candidate;
            if (meta?.concurrencyRef) store.concurrencyRef = meta.concurrencyRef;
          }
        },
        latencyHistogram,
        concurrencyTracker,
      });
      credentials.resolve = async (ref) => resolve(ref, original);
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

  let _rotateStartMs = Date.now();
  function recordLatency(pool, reqStore) {
    try {
      const cfg = plainConfig(getConfig());
      if (!cfg || cfg.latencyEnabled === false) return;
      const ref = reqStore?.pickedRef ?? pool?.state?.lastUsed;
      if (!ref) return;
      const startMs = reqStore?.startMs ?? _rotateStartMs;
      const elapsed = Date.now() - startMs;
      if (!Number.isFinite(elapsed) || elapsed < 0) return;
      latencyHistogram.record(ref, elapsed);
    } catch (_) { /* ponytail: never crash */ }
  }

  const rotate = createRotate({
    ctx,
    dispatchStorage,
    buildRuntime,
    schedulePersist,
    pushEvent,
    notifySwitch: (runtime, pool, info) => notifySwitch(runtime, pool, info, { webhookSender, notifyQueue: moduleNotifyQueue, now: () => Date.now() }),
    notifyExhaustion: (runtime, pool, options) => notifyExhaustion(runtime, pool, options, { webhookSender, notifyQueue: moduleNotifyQueue, now: () => Date.now() }),
    recordLatency,
    latencyHistogram,
    concurrencyTracker,
    MARKER,
    finishError,
    setRotateStartMs: (v) => { _rotateStartMs = v; },
    quotaStore,
    circuitBreaker: moduleBreaker,
    now: nowMono,
    logger,
  });

  registerOpsRoutes(ctx, {
    buildRuntime,
    latencyHistogram,
    lastTestCache,
    ensureSandboxRunner,
    poolState,
    getRotationDisabled: () => rotationDisabled,
    setRotationDisabled: (v) => { rotationDisabled = v; },
    circuitBreaker: moduleBreaker,
    notifyQueue: moduleNotifyQueue,
    quotaStore,
  });

  ctx.effect(() => {
    if (typeof ctx.webServer?.register !== 'function') return;
    registerPluginUpdater(ctx, {
      endpoint: '/api/dsh-key-rotation/update',
      packageName: '@goodandready/dsh-key-rotation',
      manifestUrl: new URL('../package.json', import.meta.url),
    });
  }, 'dsh-key-rotation: plugin updater');

  ctx.effect(() => ctx.on('llm/stream', (options, next) => {
    if (options[MARKER]) return next();
    if (rotationDisabled) return next();
    const { providerToPool, modelPoolByProvider } = buildRuntime();
    const pool = selectPool(modelPoolByProvider, providerToPool, options.provider, options.model);
    if (!pool) return next();
    if (buildRuntime()?.verboseLogging) {
      logger.warn(`[dsh-key-rotation] rotating ${options.provider}/${options.model} across ${(pool.weightedRefs ?? pool.refs).length} slots (${pool.refs.length} keys)`);
    }
    return rotate(options, pool);
  }), 'dsh-key-rotation: llm/stream');

  ctx.effect(() => ctx.on('agent/request-error', async (payload, next) => {
    const provider = payload?.provider ?? payload?.failure?.provider ?? '';
    if (!provider) return next();
    const { providerToPool, modelPoolByProvider, switchCodes } = buildRuntime();
    const model = payload?.model || payload?.failure?.model || '';
    const pool = selectPool(modelPoolByProvider, providerToPool, provider, model);
    if (!pool) return next();
    const code = String(payload?.failure?.code ?? payload?.code ?? '');
    const message = String(payload?.failure?.message ?? payload?.message ?? '');
    const effectiveSwitchCodes = pool.switchCodes ?? switchCodes;
    const cls = classifyFailure(payload);
    const switchable = isSwitchableError(payload, effectiveSwitchCodes) || cls.action === 'switch';
    if (!switchable) return next();
    if (buildRuntime().circuitBreakerEnabled && moduleBreaker) moduleBreaker.onFailure(provider);
    const ref = pool.state.lastUsed;
    if (ref) {
      const backoff = recordFailure(pool, ref, Date.now(), pool.cooldownMs ?? 60000, undefined, cls.soft, true);
      pushEvent(pool, ref, code || 'UNKNOWN', backoff);
      schedulePersist();
      pool.state.switches = (pool.state.switches ?? 0) + 1;
      pool.state.lastReason = code || 'UNKNOWN';
      pool.state.lastSwitchAt = Date.now();
      logger.warn(`[dsh-key-rotation] ${provider}: key ${String(ref)} failed via agent/request-error (${String(code)} ${String(message).slice(0, 80)}) — retry`);
    }
    return { kind: 'retry' };
  }), 'dsh-key-rotation: agent/request-error');

  ctx.inject(['settings'], (sctx) => {
    const settingsSvc = sctx.get('settings');
    // Modern SettingsForms already owns this Loader entry's volatile Config.
    // Legacy SettingsProvider instead needs a plain namespace registration.
    if (typeof settingsSvc?.register !== 'function') return;
    const scope = settingsSvc.register(NS, SettingsSchema, { base: readEntryConfig() });
    getConfig = () => scope.get() ?? readEntryConfig();
    if (typeof sctx?.effect === 'function') {
      sctx.effect(() => () => { getConfig = readEntryConfig; });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  dsh-key-rotation — per-provider API key rotation for DeepSeek Harness.
//
//  Transparent key rotation, Hermes-style: every configured provider has a KEY
//  POOL (env refs). The plugin patches `ctx.credentials.resolve` so a pool ref
//  resolves to the next available key (round-robin, skipping keys in cooldown),
//  and intercepts `llm/stream` to retry a request on the next key when the
//  current one fails with a switchable error (QUOTA, RATE_LIMIT, ...) before
//  any content chunk.
//
//  The PROVIDER IDENTITY NEVER CHANGES: requests always go out with the
//  provider the user selected, only the resolved API key differs. This keeps
//  pi-ai's replay state consistent across multi-call turns and multi-turn
//  sessions (the earlier clone-provider approach broke it with
//  INVALID_REPLAY_STATE).
//
//  Config is a KEY POOL PER PROVIDER: you list a real provider id and the env
//  names of its API keys (e.g. <PROVIDER>_API_KEY, <PROVIDER>_API_KEY_2, ...).
//  When a key's limit is exhausted, the request retries on the next key in the
//  list; exhausted keys stay in cooldown for cooldownMs. Clone provider routes
//  (named `<base>-2`, `<base>-3`, ...) are no longer used for rotation but
//  remain registered, so selecting them also rotates (their apiKeyEnv ref
//  belongs to the same pool).
//
//  The Settings section ("Key Rotation") edits the provider key pools as a
//  simple list: pick a provider from the dropdown of every provider registered
//  with ctx.llm (clone routes are hidden from the dropdown), then add/remove key
//  env names. Plus cooldown and switch codes.
//
//  Config (all optional, sane defaults):
//    switchCodes: string[]   failure codes eligible to switch
//    cooldownMs: number      key cooldown after a switchable failure
//    providers:  array       [{ provider, keys: [envName, ...] }]
// ─────────────────────────────────────────────────────────────────────────────
import Schema from '@deepseek-ai/schemastery';
import { keyTail, isLoopbackAddress, isTrustedBridgeRequest, SWITCHABLE_MESSAGE_PATTERN, DEFAULT_SWITCH_CODES, isValidRef, pickNext, applyCooldown, recordFailure, recordSuccess, computeBackoff, envValue, sweepExpired, parseRetryAfter } from './pool.js';

export const name = 'dsh-key-rotation';
export const inject = ['llm', 'webServer', 'settings', 'credentials'];
export { keyTail, isLoopbackAddress, isTrustedBridgeRequest, DEFAULT_SWITCH_CODES };

/** Settings namespace owning the GUI-editable section (settingsNamespace-valid). */
const NS = 'dsh-key-rotation';
/** Config bridge route (GET / PUT / DELETE), loopback-fenced like llm-fallback. */
const CONFIG_PATH = '/dsh-key-rotation/config';
const STATUS_PATH = '/dsh-key-rotation/status';
const KEY_PATH = '/dsh-key-rotation/key';
const RESET_PATH = '/dsh-key-rotation/reset';
const IMPORT_PATH = '/dsh-key-rotation/import';
const HEALTH_PATH = '/dsh-key-rotation/health';
const TEST_PATH = '/dsh-key-rotation/test';

/** The llm-pi-ai namespace whose provider profiles map providers to pools. */
const PIAI_NS = 'llm-pi-ai';
/** Marker on internally re-dispatched requests so the interceptor does not loop. */
const MARKER = '__dshKeyRotation';
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

// Bootstrap key pools. The user configures them in the Settings GUI or via
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
  backupDir: Schema.string().default(''),
  backupIntervalMs: Schema.number().default(86400000),
  backupKeep: Schema.number().default(7),
  providers: Schema.array(Schema.object({
    provider: Schema.string().required(),
    keys: Schema.array(Schema.string()).default([]),
    weights: Schema.array(Schema.number()).default([]),
    models: Schema.dict(Schema.object({
      keys: Schema.array(Schema.string()).default([]),
      weights: Schema.array(Schema.number()).default([]),
    })).default({}),
    cooldownMs: Schema.number(),
    maxCooldownMs: Schema.number(),
  })).default([...DEFAULT_PROVIDERS]),
});

// ── config bridge (GET/PUT/DELETE on CONFIG_PATH), mirroring llm-fallback ──


function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (c) => { raw += c; });
    request.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    request.on('error', reject);
  });
}

function descriptorOf(ctx, ns) {
  const settings = ctx.get('settings');
  if (settings === void 0) return void 0;
  return settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === ns);
}

function viewOf(descriptor, settings) {
  return {
    available: true,
    writable: settings.writable,
    hasDocument: settings.hasDocument,
    value: descriptor.value,
    ...descriptor.base === void 0 ? {} : { base: descriptor.base },
    ...descriptor.user === void 0 || Object.keys(descriptor.user).length === 0 ? {} : { user: descriptor.user },
    revision: descriptor.revision,
  };
}

async function writeSection(ctx, ns, section, expectedRevision, res) {
  const settings = ctx.get('settings');
  if (settings === void 0) {
    json(res, 503, { error: { code: 'settings-rejected', message: 'dsh-key-rotation: no settings provider is mounted' } });
    return;
  }
  try {
    await settings.replace(ns, section, expectedRevision);
  } catch (error) {
    if (error?.code === 'SETTINGS_CONFLICT') {
      json(res, 409, { error: { code: 'settings-conflict', message: `dsh-key-rotation: changed elsewhere (expected revision ${String(error.expected)}, current ${String(error.actual)}); reload and retry` } });
      return;
    }
    json(res, 400, { error: { code: 'settings-rejected', message: error instanceof Error ? error.message : String(error) } });
    return;
  }
  const descriptor = descriptorOf(ctx, ns);
  if (descriptor === void 0) {
    json(res, 500, { error: { code: 'settings-rejected', message: 'dsh-key-rotation: namespace vanished after write' } });
    return;
  }
  json(res, 200, viewOf(descriptor, { writable: settings.writable, hasDocument: settings.documentPath !== void 0 }));
}

/** Provider catalog for the GUI dropdown, minus clone routes of configured chains. */
function providerCatalog(ctx, cloneIds) {
  const seen = new Set();
  const out = [];
  for (const info of ctx.llm.listProviders()) {
    if (seen.has(info.id) || cloneIds.has(info.id)) continue;
    seen.add(info.id);
    out.push({ id: info.id, name: info.name ?? info.id });
  }
  return out;
}

async function handleConfigBridge(ctx, request, res, getCloneIds) {
  if (!isTrustedBridgeRequest(request)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const method = request.method ?? 'GET';
  if (method === 'GET') {
    const settings = ctx.get('settings');
    const descriptor = descriptorOf(ctx, NS);
    const body = {
      providers: providerCatalog(ctx, getCloneIds()),
    };
    if (descriptor === void 0) {
      json(res, 200, {
        ...body,
        available: false,
        writable: settings?.writable ?? false,
        hasDocument: settings?.documentPath !== void 0,
        value: void 0,
        revision: 0,
      });
      return;
    }
    json(res, 200, {
      ...body,
      ...viewOf(descriptor, {
        writable: settings?.writable ?? false,
        hasDocument: settings?.documentPath !== void 0,
      }),
    });
    return;
  }
  if (method === 'PUT' || method === 'DELETE') {
    let section;
    let expectedRevision;
    if (method === 'PUT') {
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        json(res, 400, { error: { code: 'settings-rejected', message: `dsh-key-rotation: invalid request body: ${error instanceof Error ? error.message : String(error)}` } });
        return;
      }
      if (typeof body !== 'object' || body === null || typeof body.section !== 'object' || body.section === null || Array.isArray(body.section)) {
        json(res, 400, { error: { code: 'settings-rejected', message: 'dsh-key-rotation: PUT requires {"section": {...}}' } });
        return;
      }
      section = body.section;
      expectedRevision = typeof body.expectedRevision === 'number' ? body.expectedRevision : void 0;
    } else {
      section = {};
    }
    await writeSection(ctx, NS, section, expectedRevision, res);
    return;
  }
  res.writeHead(405);
  res.end();
}

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
  let getConfig = () => config;
  registerConfigBridge(ctx, () => buildRuntime().cloneIds);

  // ── key-pool state, persisted across config reloads ──
  // base provider -> { failedUntil: Map<ref, epochMs>, pointer: number, lastUsed: ref }
  const poolState = new Map();
  // Periodic backup of pools config
  ctx.effect(() => {
    const { backupDir, backupIntervalMs, backupKeep } = buildRuntime();
    if (!backupDir) return;
    const id = setInterval(() => {
      try {
        const fs = require('node:fs');
        const path = require('node:path');
        const dir = backupDir;
        fs.mkdirSync(dir, { recursive: true });
        const now = new Date();
        const dateStr = now.toISOString().slice(0,10).replace(/-/g,'');
        const file = path.join(dir, 'pools-' + dateStr + '.json');
        const data = JSON.stringify({ backup: now.toISOString(), providers: getConfig()?.providers ?? [] }, null, 2);
        fs.writeFileSync(file, data, 'utf8');
        // prune old backups
        const keep = backupKeep || 7;
        const files = fs.readdirSync(dir).filter((f) => f.startsWith('pools-') && f.endsWith('.json')).sort();
        while (files.length > keep) {
          const old = files.shift();
          fs.unlinkSync(path.join(dir, old));
        }
      } catch (e) {
        console.warn('[dsh-key-rotation] backup failed:', String(e?.message ?? e));
      }
    }, backupIntervalMs || 86400000);
    return () => clearInterval(id);
  }, 'dsh-key-rotation: backup pools');
  // Periodic save of usage/cost stats to file
  ctx.effect(() => {
    const { backupDir } = buildRuntime();
    if (!backupDir) return;
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const statsFile = path.join(backupDir, 'stats.json');
      // Load existing stats at startup
      try {
        if (fs.existsSync(statsFile)) {
          const saved = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
          for (const st of poolState.values()) {
            if (saved.usageCounts && st.usageCounts) { for (const [k, v] of Object.entries(saved.usageCounts)) st.usageCounts.set(k, (st.usageCounts.get(k) ?? 0) + v); }
            if (saved.costPerKey && st.costPerKey) { for (const [k, v] of Object.entries(saved.costPerKey)) st.costPerKey.set(k, (st.costPerKey.get(k) ?? 0) + v); }
            if (saved.lastUsedAt && st.lastUsedAt) { for (const [k, v] of Object.entries(saved.lastUsedAt)) { if (!st.lastUsedAt.has(k) || v > st.lastUsedAt.get(k)) st.lastUsedAt.set(k, v); } }
          }
        }
      } catch {}
      // Periodic save
      const id = setInterval(() => {
        try {
          const usageCounts = {}; const costPerKey = {}; const lastUsedAt = {};
          for (const [base, st] of poolState) {
            if (st.usageCounts) for (const [k, v] of st.usageCounts) usageCounts[k] = v;
            if (st.costPerKey) for (const [k, v] of st.costPerKey) costPerKey[k] = v;
            if (st.lastUsedAt) for (const [k, v] of st.lastUsedAt) lastUsedAt[k] = v;
          }
          fs.writeFileSync(statsFile, JSON.stringify({ t: Date.now(), usageCounts, costPerKey, lastUsedAt }), 'utf8');
        } catch {}
      }, 60000);
      return () => clearInterval(id);
    } catch { return () => {}; }
  }, 'dsh-key-rotation: persist stats');
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
    }, 30000);
    return () => clearInterval(id);
  }, 'dsh-key-rotation: sweep expired cooldowns');

  // ── runtime snapshot: config + llm-pi-ai profile mapping ──
  function buildRuntime() {
    // Deep-clone before resolving: the frozen snapshot from settings.register
    // must never be written to by schemastery's dict resolver.
    const cfg = Config(structuredClone(getConfig() ?? {})) ?? {};
    const switchCodes = new Set(cfg.switchCodes ?? DEFAULT_SWITCH_CODES);
    const cooldownMs = cfg.cooldownMs ?? 60000;
    const maxCooldownMs = cfg.maxCooldownMs ?? undefined;
    const notifyWebhook = cfg.notifyWebhook ?? '';
    const notifyThreshold = cfg.notifyThreshold ?? 3;

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
          failedUntil: new Map(), failCounts: new Map(), pointer: 0, lastUsed: undefined,
          switches: 0, lastReason: undefined, lastSwitchAt: undefined,
          lastExhaustionAt: undefined, exhaustionCount: 0, events: [], usageCounts: new Map(),
        };
        poolState.set(base, st);
      }
      return st;
    };
    const buildPool = (base, keys, weights, poolCooldown, poolMax) => {
      const refs = (keys ?? []).filter((ref) => typeof ref === 'string' && ref.length > 0);
      if (refs.length === 0) return null;
      const w = Array.isArray(weights) ? weights : [];
      const weightedRefs = [];
      for (let i = 0; i < refs.length; i++) {
        const ww = typeof w[i] === 'number' && w[i] > 0 ? Math.floor(w[i]) : 1;
        for (let k = 0; k < ww; k++) weightedRefs.push(refs[i]);
      }
      return { base, refs, weightedRefs: weightedRefs.length > 0 ? weightedRefs : refs,
               state: makeState(base), cooldownMs: poolCooldown, maxCooldownMs: poolMax };
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
      if (![...poolByRef.values()].some((p) => p.base === key)) poolState.delete(key);
    }
    return { switchCodes, cooldownMs, maxCooldownMs, notifyWebhook, notifyThreshold, backupDir, backupIntervalMs, backupKeep, poolByRef, providerToPool, modelPoolByProvider, cloneIds };
  }

  // ── patch credentials.resolve: pool refs resolve to the next healthy key ──
  // Round-robin over the pool, skipping keys in cooldown; the request's
  // provider identity never changes, so pi-ai replay state stays consistent.
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
        // perHour quota check
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
        let hit = await original(candidate);
        if (hit && typeof hit.value === 'string' && hit.value.length > 0) {
          pool.state.pointer = (index + 1) % list.length;
          pool.state.lastUsed = candidate;
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
          pool.state.pointer = (index + 1) % list.length;
          pool.state.lastUsed = candidate;
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
  }

  const finishError = (code, message) => ({
    type: 'finish',
    reason: { kind: 'error', failure: Object.freeze({ code, message }) },
  });

  // Retry one request on the next pool key when the current key fails with a
  // switchable error before any content chunk. The provider never changes —
  // the resolve patch hands out the next key on each dispatch.
  function rotate(options, pool) {
    return (async function* () {
      const { switchCodes, cooldownMs, maxCooldownMs } = buildRuntime();
      let lastFailure = null;

      for (let attempt = 0; attempt < (pool.weightedRefs ?? pool.refs).length; attempt++) {
        let yielded = false;
        let switching = false;
        let inner;
        try {
          // mark the internal dispatch so the interceptor does not re-rotate
          inner = ctx.llm.stream({ ...options, [MARKER]: true });
        } catch (e) {
          if (pool.state.lastUsed) { const _retry = parseRetryAfter(String(e?.message ?? '')); const _base = pool.cooldownMs ?? cooldownMs; const _max = pool.maxCooldownMs ?? maxCooldownMs; const _effBase = _retry !== undefined ? Math.max(_base, Math.min(_retry, _max ?? _base * 8)) : _base; const _b = recordFailure(pool, pool.state.lastUsed, Date.now(), _effBase, _max); pushEvent(pool, pool.state.lastUsed, e?.code ?? 'TRANSPORT', _b); const _code = String(e?.code ?? ''); if (_code === 'AUTH' || /auth/i.test(String(e?.message ?? ''))) { const _c = (pool.state.authFailCounts.get(pool.state.lastUsed) ?? 0) + 1; pool.state.authFailCounts.set(pool.state.lastUsed, _c); if (_c >= 3) { pool.state.brokenUntil.set(pool.state.lastUsed, Date.now() + 86400000*30); pool.state.failedUntil.set(pool.state.lastUsed, Date.now() + 86400000*30); } } else { pool.state.authFailCounts.delete(pool.state.lastUsed); } }
          lastFailure = finishError(e?.code ?? 'TRANSPORT',
            `dsh-key-rotation: dispatch failed: ${String(e?.message ?? e)}`);
          console.warn(`[dsh-key-rotation] ${options.provider}: key ${String(pool.state.lastUsed ?? '?')} threw ${String(e?.code ?? e?.message ?? e)}`);
          continue;
        }

        try {
          for await (const chunk of inner) {
            // Only actual content deltas lock the stream (no more rotation).
            // Structural/metadata chunks (block-start/end, usage) do not.
            if (chunk && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta')) {
              yielded = true;
              yield chunk;
              continue;
            }
            if (chunk && chunk.type === 'finish') {
              const kind = chunk.reason?.kind;
              const failure = chunk.reason?.failure;
              const code = failure?.code;
              const message = failure?.message ?? '';
              const effectiveSwitchCodes = pool.switchCodes ?? switchCodes;
              const switchable = !yielded && kind === 'error' &&
                (effectiveSwitchCodes.has(code) || SWITCHABLE_MESSAGE_PATTERN.test(message));
              if (switchable) {
                if (pool.state.lastUsed) { const _retry = parseRetryAfter(message); const _base = pool.cooldownMs ?? cooldownMs; const _max = pool.maxCooldownMs ?? maxCooldownMs; const _effBase = _retry !== undefined ? Math.max(_base, Math.min(_retry, _max ?? _base * 8)) : _base; const _b = recordFailure(pool, pool.state.lastUsed, Date.now(), _effBase, _max); pushEvent(pool, pool.state.lastUsed, code ?? 'UNKNOWN', _b); const _code2 = String(code ?? ''); if (_code2 === 'AUTH' || /auth/i.test(message)) { const _c2 = (pool.state.authFailCounts.get(pool.state.lastUsed) ?? 0) + 1; pool.state.authFailCounts.set(pool.state.lastUsed, _c2); if (_c2 >= 3) { pool.state.brokenUntil.set(pool.state.lastUsed, Date.now() + 86400000*30); pool.state.failedUntil.set(pool.state.lastUsed, Date.now() + 86400000*30); } } else { pool.state.authFailCounts.delete(pool.state.lastUsed); } }
                pool.state.switches = (pool.state.switches ?? 0) + 1;
                pool.state.lastReason = String(code ?? 'UNKNOWN');
                pool.state.lastSwitchAt = Date.now();
                lastFailure = chunk;
                console.warn(`[dsh-key-rotation] ${options.provider}: key ${String(pool.state.lastUsed ?? '?')} failed (${String(code)} ${String(message).slice(0, 100)}) — next key`);
                switching = true;
                break;
              }
              // cost tracking if provider returns usage.cost
              if (chunk.usage?.cost != null && pool.state.lastUsed) {
                const c = Number(chunk.usage.cost);
                if (!isNaN(c)) pool.state.costPerKey.set(pool.state.lastUsed, (pool.state.costPerKey.get(pool.state.lastUsed) ?? 0) + c);
              }
              yield chunk;
              return;
            }
            yield chunk;
          }
        } catch (e) {
          yield finishError(e?.code ?? 'TRANSPORT', String(e?.message ?? e));
          return;
        }

        if (switching) continue; // try the next key
        return; // clean end — served
      }

      // pool exhausted — all keys cooling or missing
      pool.state.lastExhaustionAt = Date.now();
      pool.state.exhaustionCount = (pool.state.exhaustionCount ?? 0) + 1;
      console.warn(`[dsh-key-rotation] ${options.provider}: pool exhausted — all ${pool.refs.length} keys cooling`);
      // notify webhook if configured and threshold reached
      try {
        const { notifyWebhook, notifyThreshold } = buildRuntime();
        if (notifyWebhook && pool.state.exhaustionCount >= notifyThreshold) {
          const payload = JSON.stringify({ provider: options.provider, exhaustionCount: pool.state.exhaustionCount, at: pool.state.lastExhaustionAt, keys: pool.refs });
          fetch(notifyWebhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }).catch(()=>{});
        }
      } catch {}

      yield lastFailure ?? finishError('TRANSPORT', 'dsh-key-rotation: all keys failed');
    })();
  }

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
      const { poolByRef } = buildRuntime();
      const base = ctx.get('credentials');
      const now = Date.now();
      const seen = new Set();
      const providers = [];
      for (const pool of poolByRef.values()) {
        if (seen.has(pool.base)) continue;
        seen.add(pool.base);
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
            usage: pool.state.usageCounts?.get(ref) ?? 0,
            cost: pool.state.costPerKey?.get(ref) ?? 0,
            lastUsedAt: pool.state.lastUsedAt?.get(ref) ?? null,
            broken: pool.state.brokenUntil?.has(ref) ?? false,
          });
        }
        providers.push({
          provider: pool.base,
          keys,
          switches: pool.state.switches ?? 0,
          lastReason: pool.state.lastReason ?? null,
          lastSwitchAt: pool.state.lastSwitchAt ?? null,
          lastExhaustionAt: pool.state.lastExhaustionAt ?? null,
          exhaustionCount: pool.state.exhaustionCount ?? 0,
          totalUsage: [...(pool.state.usageCounts?.values() ?? [])].reduce((a, b) => a + b, 0),
          events: (pool.state.events ?? []).slice(-50),
        });
      }
      json(res, 200, { providers });
    },
  }), 'dsh-key-rotation: status route');

  // ── key route: store a key value without leaving the rotation card ──
  //
  // Adding a key used to mean two screens: create the credential elsewhere,
  // then type its env name here. The value is write-only from the browser —
  // it is never sent back, only its last few characters are (see the status
  // route) — and the route is loopback- and same-origin-gated like the config
  // bridge next to it.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: KEY_PATH,
    handler: async (req, res) => {
      if (req.method !== 'PUT' && req.method !== 'DELETE') {
        json(res, 405, { error: { code: 'method', message: 'PUT or DELETE only' } });
        return;
      }
      if (!isTrustedBridgeRequest(req)) {
        json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: keys are local-only' } });
        return;
      }
      const credentialsService = ctx.get('credentials');
      if (!credentialsService || typeof credentialsService.set !== 'function') {
        json(res, 503, { error: { code: 'no-credentials', message: 'dsh-key-rotation: no credentials service is mounted' } });
        return;
      }
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        json(res, 400, { error: { code: 'bad-request', message: String(error?.message ?? error) } });
        return;
      }
      const ref = typeof body?.ref === 'string' ? body.ref.trim() : '';
      if (!isValidRef(ref)) {
        json(res, 400, { error: { code: 'bad-ref', message: 'dsh-key-rotation: ref must be an environment variable name' } });
        return;
      }
      try {
        if (req.method === 'DELETE') {
          await credentialsService.unset(ref);
          json(res, 200, { ok: true, ref });
          return;
        }
        const value = typeof body?.value === 'string' ? body.value.trim() : '';
        if (value.length === 0) {
          json(res, 400, { error: { code: 'empty-value', message: 'dsh-key-rotation: an empty key cannot be stored' } });
          return;
        }
        await credentialsService.set(ref, value);
        json(res, 200, { ok: true, ref, tail: keyTail(value) });
      } catch (error) {
        // A ref supplied by the launching environment is read-only, and the
        // service says so in plain words — pass that through to the card.
        json(res, 409, { error: { code: 'write-rejected', message: String(error?.message ?? error) } });
      }
    },
  }), 'dsh-key-rotation: key route');

  // ── reset route: clear cooldown for a provider (or a single ref) ──
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RESET_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        json(res, 405, { error: { code: 'method', message: 'POST only' } });
        return;
      }
      if (!isTrustedBridgeRequest(req)) {
        json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: reset is local-only' } });
        return;
      }
      let body;
      try { body = await readJson(req); } catch (e) {
        json(res, 400, { error: { code: 'bad-request', message: String(e?.message ?? e) } });
        return;
      }
      const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
      const ref = typeof body?.ref === 'string' ? body.ref.trim() : '';
      if (provider) {
        const st = poolState.get(provider);
        if (!st) { json(res, 404, { error: { code: 'not-found', message: `dsh-key-rotation: no pool for '${provider}'` } }); return; }
        const cleared = st.failedUntil.size;
        st.failedUntil.clear();
        st.failCounts?.clear();
        st.authFailCounts?.clear();
        st.brokenUntil?.clear();
        st.switches = 0; st.lastReason = undefined; st.lastSwitchAt = undefined;
        json(res, 200, { ok: true, provider, cleared });
        return;
      }
      if (ref) {
        let found = false;
        for (const st of poolState.values()) {
          if (st.failedUntil.has(ref) || st.failCounts?.has(ref)) {
            st.failedUntil.delete(ref);
            st.failCounts?.delete(ref);
            st.authFailCounts?.delete(ref);
            st.brokenUntil?.delete(ref);
            if (st.lastUsed === ref) st.lastUsed = undefined;
            found = true; break;
          }
        }
        // idempotent: even if ref was not cooling, report ok if it looks like a valid ref name
        if (!found && !isValidRef(ref)) { json(res, 400, { error: { code: 'bad-ref', message: 'dsh-key-rotation: ref must be an environment variable name' } }); return; }
        json(res, 200, { ok: true, ref });
        return;
      }
      json(res, 400, { error: { code: 'bad-request', message: 'dsh-key-rotation: POST requires {"provider": "..."} or {"ref": "..."}' } });
    },
  }), 'dsh-key-rotation: reset route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: IMPORT_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { error: { code: 'method', message: 'POST only' } }); return; }
      if (!isTrustedBridgeRequest(req)) { json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: import is local-only' } }); return; }
      let body; try { body = await readJson(req); } catch (e) { json(res, 400, { error: { code: 'bad-request', message: String(e?.message ?? e) } }); return; }
      const url = typeof body?.url === 'string' ? body.url.trim() : '';
      if (!url || !url.startsWith('https://')) { json(res, 400, { error: { code: 'bad-url', message: 'dsh-key-rotation: only HTTPS URLs are allowed' } }); return; }
      try {
        const resp = await fetch(url);
        if (!resp.ok) { json(res, 400, { error: { code: 'fetch-failed', message: 'dsh-key-rotation: fetch returned ' + resp.status } }); return; }
        const data = await resp.json();
        if (!Array.isArray(data)) { json(res, 400, { error: { code: 'bad-format', message: 'dsh-key-rotation: expected JSON array of providers' } }); return; }
        const settings = ctx.get('settings');
        if (!settings) { json(res, 503, { error: { code: 'settings-rejected', message: 'dsh-key-rotation: no settings provider' } }); return; }
        const desc = settings.describe({ redactSecrets: true }).find((c) => c.ns === NS);
        const cur = desc?.value?.providers ?? [];
        const merged = new Map();
        for (const p of cur) if (p && p.provider) merged.set(p.provider, p);
        for (const p of data) if (p && p.provider && typeof p.provider === 'string') merged.set(p.provider, p);
        const mergedArr = [...merged.values()];
        await settings.replace(NS, { ...(desc?.value ?? {}), providers: mergedArr }, desc?.revision);
        json(res, 200, { ok: true, providersImported: data.length, total: mergedArr.length });
      } catch (e) { json(res, 400, { error: { code: 'import-failed', message: String(e?.message ?? e) } }); }
    },
  }), 'dsh-key-rotation: import route');

  // Health for external panels (Beszel/Uptime)
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
      const { poolByRef: pr } = buildRuntime();
      const seenH = new Set();
      for (const pool of pr.values()) {
        if (seenH.has(pool.base)) continue;
        seenH.add(pool.base);
        let healthy = 0;
        for (const ref of pool.refs) {
          const until = pool.state.failedUntil.get(ref);
          if (!(until !== undefined && until > now)) healthy++;
        }
        const total = pool.refs.length;
        const exhausted = healthy === 0 && total > 0;
        if (exhausted) exhaustedAny = true;
        pools[pool.base] = { healthy, total, exhausted };
      }
      json(res, 200, { status: exhaustedAny ? 'degraded' : 'ok', pools, exhaustedAny });
    },
  }), 'dsh-key-rotation: health');

  // ── test route: dry-run a single key without rotation ──
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TEST_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { error: { code: 'method', message: 'POST only' } }); return; }
      if (!isTrustedBridgeRequest(req)) { json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: test is local-only' } }); return; }
      let body; try { body = await readJson(req); } catch (e) { json(res, 400, { error: { code: 'bad-request', message: String(e?.message ?? e) } }); return; }
      const ref = typeof body?.ref === 'string' ? body.ref.trim() : '';
      if (!isValidRef(ref)) { json(res, 400, { error: { code: 'bad-ref', message: 'dsh-key-rotation: ref must be an environment variable name' } }); return; }
      const base = ctx.get('credentials');
      try {
        const hit = await (base?.__dshKeyRotationOriginalResolve ?? base?.resolve)?.call(base, ref);
        const present = Boolean(hit && typeof hit.value === 'string' && hit.value.length > 0);
        if (!present) { json(res, 200, { ok: false, ref, code: 'no-credential', message: 'no such credential' }); return; }
        const tail = keyTail(hit.value);
        // Check env source
        let source = null; try { const d = await base?.describe?.(ref); source = d?.source ?? null; } catch {}
        if (!present) {
          const ev = envValue(ref);
          if (ev !== undefined) json(res, 200, { ok: true, ref, tail: keyTail(ev), source: 'env' });
        }
        json(res, 200, { ok: true, ref, tail, source });
      } catch (e) {
        json(res, 200, { ok: false, ref, code: 'error', message: String(e?.message ?? e) });
      }
    },
  }), 'dsh-key-rotation: test route');

  // Intercept the llm/stream waterfall: rotate any request whose provider maps
  // to a configured key pool; pass everything else (and internal dispatches)
  // straight through.
  ctx.on('llm/stream', (options, next) => {
    if (options[MARKER]) return next();
    const { providerToPool, modelPoolByProvider } = buildRuntime();
    const byModel = modelPoolByProvider.get(options.provider);
    const pool = (byModel && byModel.get(options.model)) || providerToPool.get(options.provider);
    if (!pool) return next();
    console.warn(`[dsh-key-rotation] rotating ${options.provider}/${options.model} across ${(pool.weightedRefs ?? pool.refs).length} slots (${pool.refs.length} keys)`);
    return rotate(options, pool);
  });

  // Safety net for non-stream requests (agent/request-error waterfall).
  // llm/stream covers streaming calls; sync calls (embeddings, batch) go
  // through agent/request and surface errors here. If the error is
  // switchable, mark the key and ask the agent loop to retry.
  ctx.on('agent/request-error', async (payload, next) => {
    const provider = payload?.provider ?? payload?.failure?.provider ?? '';
    if (!provider) return next();
    const { providerToPool, modelPoolByProvider, switchCodes } = buildRuntime();
    const model = payload?.model || payload?.failure?.model || '';
    const byModel = modelPoolByProvider.get(provider);
    const pool = (byModel && byModel.get(model)) || providerToPool.get(provider);
    if (!pool) return next();
    const code = String(payload?.failure?.code ?? payload?.code ?? '');
    const message = String(payload?.failure?.message ?? payload?.message ?? '');
    const effectiveSwitchCodes = pool.switchCodes ?? switchCodes;
    const switchable = effectiveSwitchCodes.has(code) || SWITCHABLE_MESSAGE_PATTERN.test(message);
    if (!switchable) return next();
    const ref = pool.state.lastUsed;
    if (ref) {
      const backoff = recordFailure(pool, ref, Date.now(), pool.cooldownMs ?? 60000);
      pushEvent(pool, ref, code || 'UNKNOWN', backoff);
      pool.state.switches = (pool.state.switches ?? 0) + 1;
      pool.state.lastReason = code || 'UNKNOWN';
      pool.state.lastSwitchAt = Date.now();
      console.warn(`[dsh-key-rotation] ${provider}: key ${String(ref)} failed via agent/request-error (${String(code)} ${String(message).slice(0, 80)}) — retry`);
    }
    return { kind: 'retry' };
  });

  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(NS, Config, { base: config });
    getConfig = () => scope.get() ?? config;
    sctx.effect(() => () => {
      getConfig = () => config;
    });
  });
}

import { decryptSecret, encryptSecret } from './crypto-storage.js';
// lib/ops-keys.js — key store + cooldown reset + import routes (#312 split from routes-ops.js).
import {
  json,
  readJson,
  NS,
} from './http-bridge.js';
import { safeFetchJson } from './safe-fetch.js';
import {
  isTrustedBridgeRequest,
  isValidRef,
  keyTail,
  envValue,
} from './pool.js';
import { looksLikeApiSecret } from './keycheck.js';
import { mutateSettings, validateProviders } from './settings-write.js';
import { bestEffort } from './best-effort.js';
import {
  KEY_PATH,
  RESET_PATH,
  IMPORT_PATH,
  DRAIN_PATH,
  DISCOVER_PATH,
  AUTO_IMPORT_PATH,
  PRESET_LIMITS_PATH,
} from './ops-paths.js';
import { lookupPreset, CANONICAL_PROVIDER_PRESETS } from './provider-limits-detector.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markKeyDraining, isKeyDraining, cancelKeyDrain, getDrainingStatus, getAllDrainingKeys } from './key-drain.js';

/**
 * @param {object} ctx cordis context
 * @param {object} deps live dependencies from apply()
 */
const KNOWN_PROVIDER_PATTERNS = [
  { provider: 'deepseek', pattern: /^DEEPSEEK_API_KEY(?:_\w+)?$/i },
  { provider: 'opencode', pattern: /^OPENCODE(?:_GO)?_API_KEY(?:_\w+)?$/i },
  { provider: 'openai', pattern: /^OPENAI_API_KEY(?:_\w+)?$/i },
  { provider: 'anthropic', pattern: /^ANTHROPIC_API_KEY(?:_\w+)?$/i },
  { provider: 'openrouter', pattern: /^OPENROUTER_API_KEY(?:_\w+)?$/i },
  { provider: 'siliconflow', pattern: /^SILICONFLOW_API_KEY(?:_\w+)?$/i },
  { provider: 'groq', pattern: /^GROQ_API_KEY(?:_\w+)?$/i },
  { provider: 'mistral', pattern: /^MISTRAL_API_KEY(?:_\w+)?$/i },
  { provider: 'gemini', pattern: /^(?:GEMINI|GOOGLE)_API_KEY(?:_\w+)?$/i },
  { provider: 'ollama', pattern: /^OLLAMA_API_KEY(?:_\w+)?$/i },
  { provider: 'sensenova', pattern: /^SENSENOVA_API_KEY(?:_\w+)?$/i },
  { provider: 'cohere', pattern: /^COHERE_API_KEY(?:_\w+)?$/i },
  { provider: 'fal', pattern: /^FAL_API_KEY(?:_\w+)?$/i },
  { provider: 'together', pattern: /^TOGETHER_API_KEY(?:_\w+)?$/i },
  { provider: 'xai', pattern: /^XAI_API_KEY(?:_\w+)?$/i },
];

export function inferProviderFromRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  for (const { provider, pattern } of KNOWN_PROVIDER_PATTERNS) {
    if (pattern.test(ref)) return provider;
  }
  const generic = /^([A-Z0-9]+)_API_KEY(?:_\w+)?$/i.exec(ref);
  if (generic && generic[1]) {
    const prov = generic[1].toLowerCase();
    if (!/TOKEN|SECRET|WEBHOOK|PASSWORD|AUTH|SESSION|OAUTH|GITEA|KANBAN/i.test(prov)) {
      return prov;
    }
  }
  return null;
}

export async function discoverUnconfiguredKeys(ctx, runtimePools = []) {
  const configuredRefs = new Set();
  for (const p of runtimePools) {
    for (const r of (p.refs || [])) configuredRefs.add(r);
    for (const r of (p.keys || [])) configuredRefs.add(typeof r === 'string' ? r : r?.ref);
  }

  // Also check DSH settings describe if available
  const settings = ctx.get('settings');
  if (settings && typeof settings.describe === 'function') {
    try {
      const desc = settings.describe({ redactSecrets: true })?.find?.((c) => c.ns === NS);
      const providers = desc?.value?.providers ?? [];
      for (const p of providers) {
        for (const k of (p.keys || [])) {
          configuredRefs.add(typeof k === 'string' ? k : k?.ref);
        }
      }
    } catch (_) { /* best-effort */ }
  }

  const candidates = new Map(); // ref -> { provider, source }

  // 1. Process environment
  for (const k of Object.keys(process.env)) {
    if (configuredRefs.has(k)) continue;
    const prov = inferProviderFromRef(k);
    if (prov && process.env[k]?.trim()) {
      candidates.set(k, { provider: prov, source: 'env' });
    }
  }

  // 2. ~/.dsh/.credentials.yaml
  try {
    const credPath = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    if (fs.existsSync(credPath)) {
      const content = fs.readFileSync(credPath, 'utf8');
      let inRefs = false;
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === 'refs:') {
          inRefs = true;
          continue;
        }
        if (inRefs) {
          if (line.startsWith('  ') && line.includes(':')) {
            const refName = trimmed.split(':')[0].trim();
            if (!configuredRefs.has(refName)) {
              const prov = inferProviderFromRef(refName);
              if (prov && !candidates.has(refName)) {
                candidates.set(refName, { provider: prov, source: 'credentials' });
              }
            }
          } else if (!line.startsWith(' ') && trimmed.length > 0) {
            inRefs = false;
          }
        }
      }
    }
  } catch (_) { /* best-effort */ }

  const credentialsService = ctx.get('credentials');
  const discovered = [];

  for (const [ref, { provider, source }] of candidates) {
    let tail = '';
    try {
      let hit = await (credentialsService?.__dshKeyRotationOriginalResolve ?? credentialsService?.resolve)?.call(credentialsService, ref);
      let raw = hit?.value;
      if (!raw) raw = envValue(ref);
      if (raw) {
        const plain = decryptSecret(raw);
        tail = keyTail(plain);
      }
    } catch (_) { /* best-effort tail */ }
    discovered.push({
      provider,
      ref,
      keyTail: tail,
      source,
    });
  }

  return discovered;
}


export function registerKeyRoutes(ctx, deps) {

ctx.effect(() => ctx.webServer.register({
  kind: 'exact',
  path: DRAIN_PATH,
  handler: async (req, res) => {
    if (!isTrustedBridgeRequest(req)) {
      json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: drain is local-only' } });
      return;
    }
    const concurrency = deps.concurrencyTracker;

    if (req.method === 'GET') {
      const url = new URL(req.url ?? DRAIN_PATH, 'http://localhost');
      const ref = url.searchParams.get('ref');
      if (ref) {
        const status = getDrainingStatus(ref, concurrency);
        if (!status) { json(res, 404, { error: { code: 'not-found', message: `Key ${ref} is not currently draining` } }); return; }
        json(res, 200, { ok: true, draining: status });
        return;
      }
      json(res, 200, { ok: true, draining: getAllDrainingKeys(concurrency) });
      return;
    }

    if (req.method === 'POST') {
      let body;
      try { body = await readJson(req); } catch (e) {
        json(res, 400, { error: { code: 'bad-request', message: String(e?.message ?? e) } });
        return;
      }
      const ref = body?.ref;
      if (!ref) { json(res, 400, { error: { code: 'bad-request', message: 'Missing ref' } }); return; }
      markKeyDraining(ref, body?.provider || '');
      json(res, 200, { ok: true, status: getDrainingStatus(ref, concurrency) });
      return;
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url ?? DRAIN_PATH, 'http://localhost');
      const ref = url.searchParams.get('ref');
      if (!ref) { json(res, 400, { error: { code: 'bad-request', message: 'Missing ref query parameter' } }); return; }
      const cancelled = cancelKeyDrain(ref);
      json(res, 200, { ok: true, cancelled });
      return;
    }

    json(res, 405, { error: { code: 'method', message: 'GET, POST, or DELETE only' } });
  },
}), 'dsh-key-rotation: drain route');
  const {
    lastTestCache,
    poolState,
    buildRuntime,
    circuitBreaker,
  } = deps;

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
    if (req.method !== 'PUT' && req.method !== 'DELETE' && req.method !== 'GET') {
      json(res, 405, { error: { code: 'method', message: 'GET, PUT or DELETE only' } });
      return;
    }
    if (!isTrustedBridgeRequest(req)) {
      json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: keys are local-only' } });
      return;
    }
    const credentialsService = ctx.get('credentials');
    if (req.method === 'GET') {
      // Disallow plaintext key reveal without authorized session (#543)
      json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: plaintext key extraction via GET is forbidden' } });
      return;
    }
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
        for (const st of poolState.values()) {
          st.failedUntil?.delete(ref);
          st.failCounts?.delete(ref);
          st.authFailCounts?.delete(ref);
          st.brokenUntil?.delete(ref);
          st.revokedRefs?.delete(ref);
          st.tokenUsage?.delete(ref);
          if (st.lastUsed === ref) st.lastUsed = undefined;
        }
        bestEffort('lastTestCache.delete', () => { lastTestCache?.delete?.(ref); }, ctx.logger);
        json(res, 200, { ok: true, ref });
        return;
      }
      const value = typeof body?.value === 'string' ? body.value.trim() : '';
      if (value.length === 0) {
        json(res, 400, { error: { code: 'empty-value', message: 'dsh-key-rotation: an empty key cannot be stored' } });
        return;
      }
      const storedValue = encryptSecret(value);
      await credentialsService.set(ref, storedValue);
      // #200: leak-detector hint - stored value should look like a credential
      const secretShape = looksLikeApiSecret(value);
      json(res, 200, { ok: true, ref, tail: keyTail(value), looksLikeSecret: secretShape });
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
      let found = false;
      let cleared = 0;
      for (const [key, st] of poolState.entries()) {
        if (key === provider || key.startsWith(provider + '::')) {
          found = true;
          cleared += st.failedUntil ? st.failedUntil.size : 0;
          st.failedUntil?.clear();
          st.failCounts?.clear();
          st.authFailCounts?.clear();
          st.brokenUntil?.clear();
          st.revokedRefs?.clear();
          st.tokenUsage?.clear();
          st.switches = 0;
          st.lastReason = undefined;
          st.lastSwitchAt = undefined;
        }
      }
      if (!found) {
        json(res, 404, { error: { code: 'not-found', message: `dsh-key-rotation: no pool for '${provider}'` } });
        return;
      }
      let circuitReset = false;
      const br = circuitBreaker ?? buildRuntime().breaker;
      if (br) {
        if (typeof br.reset === 'function') { br.reset(provider); circuitReset = true; }
        else if (typeof br.onSuccess === 'function') { br.onSuccess(provider); circuitReset = true; }
      }
      json(res, 200, { ok: true, provider, cleared, circuitReset });
      return;
    }
    if (ref) {
      let found = false;
      for (const st of poolState.values()) {
        if (
          st.failedUntil?.has(ref) ||
          st.failCounts?.has(ref) ||
          st.authFailCounts?.has(ref) ||
          st.brokenUntil?.has(ref) ||
          st.revokedRefs?.has(ref) ||
          st.tokenUsage?.has(ref) ||
          st.lastUsed === ref
        ) {
          st.failedUntil?.delete(ref);
          st.failCounts?.delete(ref);
          st.authFailCounts?.delete(ref);
          st.brokenUntil?.delete(ref);
          st.revokedRefs?.delete(ref);
          st.tokenUsage?.delete(ref);
          if (st.lastUsed === ref) st.lastUsed = undefined;
          found = true;
        }
      }
      // idempotent: even if ref was not cooling, report ok if it looks like a valid ref name
      if (!found && !isValidRef(ref)) {
        json(res, 400, { error: { code: 'bad-ref', message: 'dsh-key-rotation: ref must be an environment variable name' } });
        return;
      }
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
      const data = await safeFetchJson(url, {
        signal: AbortSignal.timeout(10000),
        fetchImpl: deps.fetchImpl ?? globalThis.fetch,
        lookupImpl: deps.lookupImpl ?? undefined,
      });
      validateProviders(data);
      const settings = ctx.get('settings');
      if (!settings) { json(res, 503, { error: { code: 'settings-rejected', message: 'dsh-key-rotation: no settings provider' } }); return; }
      const desc = settings.describe({ redactSecrets: true }).find((c) => c.ns === NS);
      if (!desc) throw new Error('Settings namespace is unavailable');
      const cur = desc.value?.providers ?? [];
      const merged = new Map();
      for (const p of cur) if (p && p.provider) merged.set(p.provider, p);
      for (const p of data) if (p && p.provider && typeof p.provider === 'string') merged.set(p.provider, p);
      const mergedArr = [...merged.values()];
      await mutateSettings(settings, NS, [{ op: 'set', path: ['providers'], value: mergedArr }], body.expectedRevision ?? desc.revision);
      json(res, 200, { ok: true, providersImported: data.length, total: mergedArr.length });
    } catch (e) {
      const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.code === 'timeout';
      json(res, isTimeout ? 504 : e?.code === 'SETTINGS_CONFLICT' ? 409 : 400, { error: { code: isTimeout ? 'timeout' : 'import-failed', message: String(e?.message ?? e) } });
    }
  },
}), 'dsh-key-rotation: import route');

// Health for external panels (Beszel/Uptime)

// ── discover unconfigured keys route (#491) ──
ctx.effect(() => ctx.webServer.register({
  kind: 'exact',
  path: DISCOVER_PATH,
  handler: async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: { code: 'method', message: 'GET only' } });
      return;
    }
    if (!isTrustedBridgeRequest(req)) {
      json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: discover is local-only' } });
      return;
    }
    try {
      const runtime = deps.buildRuntime?.() ?? {};
      const discovered = await discoverUnconfiguredKeys(ctx, runtime.pools || []);
      json(res, 200, { ok: true, discovered });
    } catch (e) {
      json(res, 500, { error: { code: 'discover-failed', message: String(e?.message ?? e) } });
    }
  },
}), 'dsh-key-rotation: discover route');

// ── auto-import discovered keys into pools (#491) ──
ctx.effect(() => ctx.webServer.register({
  kind: 'exact',
  path: AUTO_IMPORT_PATH,
  handler: async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: { code: 'method', message: 'POST only' } });
      return;
    }
    if (!isTrustedBridgeRequest(req)) {
      json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: auto-import is local-only' } });
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      json(res, 400, { error: { code: 'bad-request', message: e.message || 'invalid request body' } });
      return;
    }
    const hasRefs = Array.isArray(body?.refs) && body.refs.length > 0;
    if (!hasRefs && body?.all !== true) {
      json(res, 400, { error: { code: 'bad-request', message: 'auto-import requires explicit "refs" array or "all: true"' } });
      return;
    }

    try {
      const runtime = deps.buildRuntime?.() ?? {};
      const discovered = await discoverUnconfiguredKeys(ctx, runtime.pools || []);
      const targetRefs = hasRefs ? new Set(body.refs) : null;
      const toImport = targetRefs ? discovered.filter((d) => targetRefs.has(d.ref)) : discovered;

      if (toImport.length === 0) {
        json(res, 200, { ok: true, importedCount: 0, message: 'No unassigned keys to import' });
        return;
      }

      const settings = ctx.get('settings');
      if (!settings) {
        json(res, 503, { error: { code: 'settings-rejected', message: 'dsh-key-rotation: no settings provider' } });
        return;
      }
      const desc = settings.describe({ redactSecrets: true })?.find?.((c) => c.ns === NS);
      if (!desc) throw new Error('Settings namespace is unavailable');

      const curProviders = (desc.value?.providers ?? []).map((p) => ({
        ...p,
        keys: Array.isArray(p.keys) ? [...p.keys] : [],
      }));

      const providerMap = new Map();
      for (const p of curProviders) {
        if (p?.provider) providerMap.set(p.provider, p);
      }

      let importedCount = 0;
      for (const item of toImport) {
        const { provider, ref } = item;
        let poolConfig = providerMap.get(provider);
        if (!poolConfig) {
          poolConfig = {
            provider,
            strategy: 'round-robin',
            cooldownMs: 30000,
            keys: [],
          };
          providerMap.set(provider, poolConfig);
        }
        const existingKeys = poolConfig.keys.map((k) => (typeof k === 'string' ? k : k?.ref));
        if (!existingKeys.includes(ref)) {
          poolConfig.keys.push(ref);
          importedCount++;
        }
      }

      const updatedProviders = [...providerMap.values()];
      await mutateSettings(
        settings,
        NS,
        [{ op: 'set', path: ['providers'], value: updatedProviders }],
        body.expectedRevision ?? desc.revision
      );

      json(res, 200, {
        ok: true,
        importedCount,
        providersCount: updatedProviders.length,
        providers: updatedProviders,
      });
    } catch (e) {
      json(res, 400, { error: { code: 'auto-import-failed', message: String(e?.message ?? e) } });
    }
  },
}), 'dsh-key-rotation: auto-import route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PRESET_LIMITS_PATH,
    handler: async (req, res) => {
      if (!isTrustedBridgeRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
        return;
      }
      if (req.method === 'GET') {
        const urlObj = new URL(req.url, 'http://127.0.0.1');
        const prov = urlObj.searchParams.get('provider');
        if (prov) {
          const preset = lookupPreset(prov);
          json(res, 200, { ok: true, provider: prov, preset });
          return;
        }
        json(res, 200, { ok: true, presets: CANONICAL_PROVIDER_PRESETS });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const prov = body?.provider;
        const preset = lookupPreset(prov);
        if (!preset) {
          json(res, 404, { ok: false, error: `No canonical preset found for provider '${prov}'` });
          return;
        }
        json(res, 200, { ok: true, provider: prov, preset });
        return;
      }
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
    },
  }), 'dsh-key-rotation: preset limits route');

}

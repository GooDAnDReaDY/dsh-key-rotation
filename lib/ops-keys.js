// lib/ops-keys.js — key store + cooldown reset + import routes (#312 split from routes-ops.js).
import {
  json,
  readJson,
  NS,
} from './http-bridge.js';
import {
  isTrustedBridgeRequest,
  isValidRef,
  keyTail,
} from './pool.js';
import { looksLikeApiSecret } from './keycheck.js';
import { mutateSettings, validateProviders } from './settings-write.js';
import { bestEffort } from './best-effort.js';
import {
  KEY_PATH,
  RESET_PATH,
  IMPORT_PATH,
} from './ops-paths.js';

/**
 * @param {object} ctx cordis context
 * @param {object} deps live dependencies from apply()
 */
export function registerKeyRoutes(ctx, deps) {
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
        for (const st of poolState.values()) {
          st.failedUntil?.delete(ref);
          st.failCounts?.delete(ref);
          st.authFailCounts?.delete(ref);
          st.brokenUntil?.delete(ref);
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
      await credentialsService.set(ref, value);
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
      const st = poolState.get(provider);
      if (!st) { json(res, 404, { error: { code: 'not-found', message: `dsh-key-rotation: no pool for '${provider}'` } }); return; }
      const cleared = st.failedUntil.size;
      st.failedUntil.clear();
      st.failCounts?.clear();
      st.authFailCounts?.clear();
      st.brokenUntil?.clear();
      st.switches = 0; st.lastReason = undefined; st.lastSwitchAt = undefined;
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
        if (st.failedUntil?.has(ref) || st.failCounts?.has(ref) || st.authFailCounts?.has(ref) || st.brokenUntil?.has(ref)) {
          st.failedUntil?.delete(ref);
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
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) { json(res, 400, { error: { code: 'fetch-failed', message: 'dsh-key-rotation: fetch returned ' + resp.status } }); return; }
      const data = await resp.json();
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
      const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      json(res, isTimeout ? 504 : e?.code === 'SETTINGS_CONFLICT' ? 409 : 400, { error: { code: isTimeout ? 'timeout' : 'import-failed', message: String(e?.message ?? e) } });
    }
  },
}), 'dsh-key-rotation: import route');

// Health for external panels (Beszel/Uptime)
}

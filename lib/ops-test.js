// lib/ops-test.js — sandbox test + sandbox cache routes (#312 split from routes-ops.js).
import {
  json,
  readJson,
} from './http-bridge.js';
import {
  isTrustedBridgeRequest,
  isValidRef,
  keyTail,
  envValue,
} from './pool.js';
import { bestEffort } from './best-effort.js';
import {
  TEST_PATH,
  SANDBOX_CACHE_PATH,
} from './ops-paths.js';

/**
 * @param {object} ctx cordis context
 * @param {object} deps live dependencies from apply()
 */
export function registerTestRoutes(ctx, deps) {
  const {
    lastTestCache,
    ensureSandboxRunner,
    poolState,
  } = deps;

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
    // Optional value for pre-save validation (issue #118)
    const testValue = typeof body?.value === 'string' && body.value.length > 0 ? body.value : undefined;
    const probe = body?.probe === 'models' || body?.probe === 'chat' ? body.probe : undefined;
    const base = ctx.get('credentials');
    try {
      let hit = await (base?.__dshKeyRotationOriginalResolve ?? base?.resolve)?.call(base, ref);
      let present = Boolean(hit && typeof hit.value === 'string' && hit.value.length > 0);
      const effectiveValue = testValue || hit?.value;
      const valid = present ? Boolean(effectiveValue && typeof effectiveValue === 'string' && effectiveValue.length > 0) : Boolean(testValue);
      const tail = valid ? keyTail(effectiveValue) : '';
      let source = null;
      await bestEffort('credentials.describe', async () => { const d = await base?.describe?.(ref); source = d?.source ?? null; }, ctx.logger);
      if (!present && !testValue) { json(res, 200, { ok: false, ref, code: 'no-credential', message: 'no such credential' }); return; }
      if (!present && testValue) { source = 'pre-save'; }
      else if (!present) {
        const ev = envValue(ref);
        if (ev !== undefined) { present = true; json(res, 200, { ok: true, ref, tail: keyTail(ev), source: 'env' }); return; }
      }
      // sandbox probe (models is free; chat is hook-only, see sandbox.js)
      if (probe) {
        const keyForProbe = effectiveValue;
        const runner = ensureSandboxRunner(ctx);
        const result = probe === 'chat' ? await runner.probeChat(ref, keyForProbe) : await runner.probeModels(ref, keyForProbe);
        const cached = { ...result, at: Date.now() };
        lastTestCache.set(ref, cached);
        if (cached.ok) {
          for (const st of poolState.values()) {
            if (st.failedUntil?.has(ref) || st.failCounts?.has(ref) || st.brokenUntil?.has(ref)) {
              st.failedUntil?.delete(ref);
              st.failCounts?.delete(ref);
              st.authFailCounts?.delete(ref);
              st.brokenUntil?.delete(ref);
            }
          }
        }
        json(res, 200, { ok: cached.ok, ref, tail, source, probe, code: cached.code, latencyMs: cached.latencyMs, modelsCount: cached.modelsCount });
        return;
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
// Read-only cache snapshot for clients (badge polling).

ctx.effect(() => ctx.webServer.register({
  kind: 'exact',
  path: SANDBOX_CACHE_PATH,
  handler: (req, res) => {
    if (!isTrustedBridgeRequest(req)) { json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: cache is local-only' } }); return; }
    const cacheSnap = typeof lastTestCache?.snapshot === 'function'
      ? lastTestCache.snapshot()
      : (lastTestCache instanceof Map ? Object.fromEntries(lastTestCache) : (lastTestCache ?? {}));
    json(res, 200, cacheSnap);
  },
}), 'dsh-key-rotation: sandbox cache');



// #199 webhook-action: interactive webhook buttons call back here.
// Auth: bearer token from Config (external services like Telegram/Discord
// cannot be same-origin, so a shared secret is the gate).
}

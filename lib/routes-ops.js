// lib/routes-ops.js — operational HTTP routes for dsh-key-rotation (#253).
// Registration is injected with the live apply() dependencies.

import {
  json,
  readJson,
  descriptorOf,
  NS,
} from './http-bridge.js';
import {
  isTrustedBridgeRequest,
  keyTail,
  envValue,
  isValidRef,
  computeHealthScore,
  recordFailure,
  costForDay,
  costForWeek,
} from './pool.js';
import { bucketInfo } from './bucket.js';
import { usageRows, usageCsv } from './usage-report.js';
import { findSecrets, looksLikeApiSecret } from './keycheck.js';
import { nextQuotaReset } from './quota-window.js';

const STATUS_PATH = '/dsh-key-rotation/status';
const SNAPSHOT_PATH = '/dsh-key-rotation/snapshot';
const KEY_PATH = '/dsh-key-rotation/key';
const RESET_PATH = '/dsh-key-rotation/reset';
const IMPORT_PATH = '/dsh-key-rotation/import';
const HEALTH_PATH = '/dsh-key-rotation/health';
const USAGE_PATH = '/dsh-key-rotation/usage';
const TEST_PATH = '/dsh-key-rotation/test';
const SANDBOX_CACHE_PATH = '/dsh-key-rotation/sandbox-cache';

/**
 * @param {object} ctx cordis context
 * @param {object} deps live dependencies from apply()
 */
export function registerOpsRoutes(ctx, deps) {
  const {
    buildRuntime,
    latencyHistogram,
    lastTestCache,
    ensureSandboxRunner,
    poolState,
    getRotationDisabled,
    setRotationDisabled,
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
          switches: pool.state.switches ?? 0,
          lastReason: pool.state.lastReason ?? null,
          lastSwitchAt: pool.state.lastSwitchAt ?? null,
          lastExhaustionAt: pool.state.lastExhaustionAt ?? null,
          exhaustionCount: pool.state.exhaustionCount ?? 0,
          totalUsage: (() => { let s = 0; if (pool.state.usageCounts) for (const v of pool.state.usageCounts.values()) s += v; return s; })(),
          // #225: aggregate p95 across the pool's keys
          p95: (() => {
            const vals = (pool.refs ?? []).map((r) => latencyHistogram.snapshot(r)).filter((s) => s && s.p95 != null).map((s) => s.p95);
            return vals.length ? Math.round(Math.max(...vals)) : null;
          })(),
          latencySloMs,
          events: (pool.state.events ?? []).slice(-50),
          healthScore: computeHealthScore(pool.state),
          // #208: today/week spend + configured budget for the card
          todayCost: costForDay(pool.state.costDays),
          weeklyCost: costForWeek(pool.state.costDays, now),
          budgetDaily: providerBudgets.get(pool.base)?.costBudgetDaily ?? 0,
          budgetWeekly: providerBudgets.get(pool.base)?.costBudgetWeekly ?? 0,
          pauseOnBudget: providerBudgets.get(pool.base)?.pauseOnBudget ?? false,
        });
        } catch (e) {
          console.warn(`[dsh-key-rotation] status: pool ${pool.base} failed: ${String(e?.message ?? e)} ${e?.stack ?? ''}`);
          providers.push({ provider: pool.base, keys: [], statusError: String(e?.message ?? e) });
        }
      }
      json(res, 200, { providers });
    },
  }), 'dsh-key-rotation: status route');

  // #209: usage report - per-key requests/cost over the last N days.
  // ?format=csv returns text/csv; ?days=N window (1..90, default 7).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: USAGE_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { error: { code: 'method', message: 'GET only' } }); return; }
      if (!isTrustedBridgeRequest(req)) { json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: usage is local-only' } }); return; }
      const url = new URL(req.url ?? USAGE_PATH, 'http://localhost');
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
      const csv = url.searchParams.get('format') === 'csv';
      const provider = url.searchParams.get('provider') ?? '';
      const runtime = buildRuntime();
      const now = Date.now();
      const seen = new Set();
      const report = [];
      for (const pool of runtime.poolByRef.values()) {
        if (seen.has(pool.base)) continue;
        seen.add(pool.base);
        if (provider && pool.base !== provider) continue;
        report.push({ provider: pool.base, rows: usageRows(pool, days, now) });
      }
      if (csv) {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="dsh-key-rotation-usage.csv"' });
        const parts = [];
        for (const p of report) {
          if (parts.length > 0) parts.push('');
          parts.push('# ' + p.provider);
          parts.push(usageCsv(p.rows));
        }
        res.end(parts.join('\n') + '\n');
        return;
      }
      json(res, 200, { at: now, days, providers: report });
    },
  }), 'dsh-key-rotation: usage route');

  // #218: full config snapshot - one JSON file to move between machines.
  // Secret values never travel: only credential/env names. Token fields are
  // exported as empty strings; on import they keep existing values when empty.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SNAPSHOT_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') { json(res, 405, { error: { code: 'method', message: 'GET (export) or POST (import) only' } }); return; }
      if (!isTrustedBridgeRequest(req)) { json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: snapshot is local-only' } }); return; }
      if (req.method === 'GET') {
        const descriptor = descriptorOf(ctx, NS);
        const value = descriptor?.value ?? {};
        const exportable = { ...value };
        // token-shaped fields stay empty in the file; refs are names, not secrets
        exportable.webhookActionToken = '';
        json(res, 200, { at: Date.now(), version: 1, snapshot: exportable });
        return;
      }
      // POST = import: { snapshot } -> merge with current section, PUT semantics
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { error: { code: 'bad-request', message: String(e?.message ?? e) } }); return; }
      const snap = body?.snapshot;
      if (!snap || typeof snap !== 'object' || Array.isArray(snap)) { json(res, 400, { error: { code: 'bad-format', message: 'dsh-key-rotation: POST requires {"snapshot": {...}}' } }); return; }
      // #200 leak guard applies to imported content too
      try {
        const masked = structuredClone(snap);
        if (masked.webhookActionToken) masked.webhookActionToken = '***';
        if (masked.notifyWebhook) masked.notifyWebhook = '***';
        const findings = findSecrets(JSON.stringify(masked));
        if (findings.length > 0) { json(res, 400, { error: { code: 'secret-in-snapshot', message: 'dsh-key-rotation: snapshot carries a live-looking credential', findings } }); return; }
      } catch { /* scanning must never block a valid import */ }
      const settings = ctx.get('settings');
      if (!settings) { json(res, 503, { error: { code: 'settings-rejected', message: 'dsh-key-rotation: no settings provider' } }); return; }
      const desc = descriptorOf(ctx, NS);
      if (desc === void 0) { json(res, 500, { error: { code: 'settings-rejected', message: 'dsh-key-rotation: namespace missing' } }); return; }
      const cur = desc.value ?? {};
      // empty token fields in the file keep the current values (never wipe a secret)
      const merged = { ...cur, ...snap };
      if (!snap.webhookActionToken) merged.webhookActionToken = cur.webhookActionToken ?? '';
      try {
        await settings.replace(NS, merged, desc.revision);
        const after = descriptorOf(ctx, NS);
        json(res, 200, { ok: true, revision: after?.revision });
      } catch (e) {
        json(res, e?.code === 'SETTINGS_CONFLICT' ? 409 : 400, { error: { code: 'settings-rejected', message: String(e?.message ?? e) } });
      }
    },
  }), 'dsh-key-rotation: snapshot route');

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
      json(res, 200, { status: exhaustedAny ? 'degraded' : 'ok', pools, exhaustedAny, latency: latencyHistogram.snapshotAll(), quota: quotaStore.snapshot() });
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
        try { const d = await base?.describe?.(ref); source = d?.source ?? null; } catch {}
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
      json(res, 200, lastTestCache.snapshot());
    },
  }), 'dsh-key-rotation: sandbox cache');



  // #199 webhook-action: interactive webhook buttons call back here.
  // Auth: bearer token from Config (external services like Telegram/Discord
  // cannot be same-origin, so a shared secret is the gate).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-key-rotation/webhook-action',
    handler: async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { error: { code: 'method', message: 'POST only' } }); return; }
      const runtime = buildRuntime();
      const expected = runtime.webhookActionToken;
      if (!expected) { json(res, 503, { error: { code: 'no-token', message: 'dsh-key-rotation: webhookActionToken is not configured' } }); return; }
      const auth = String(req.headers.authorization ?? '');
      if (auth !== `Bearer ${expected}`) { json(res, 401, { error: { code: 'unauthorized', message: 'dsh-key-rotation: bad webhook action token' } }); return; }
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { error: { code: 'bad-request', message: String(e?.message ?? e) } }); return; }
      // Accept callback payloads from formatInteractive (Telegram/Discord/Slack) or plain {action}
      let action = typeof body?.action === 'string' ? body.action : '';
      if (!action && typeof body?.data === 'string') {
        try { action = String(JSON.parse(body.data)?.id ?? ''); } catch { action = ''; }
      }
      if (!action && typeof body?.callback_data === 'string') {
        try { action = String(JSON.parse(body.callback_data)?.id ?? ''); } catch { action = ''; }
      }
      // #222: Telegram update envelope {update_id, callback_query:{data}}
      if (!action && typeof body?.callback_query?.data === 'string') {
        try { action = String(JSON.parse(body.callback_query.data)?.id ?? ''); } catch { action = ''; }
      }
      // #222: Telegram setWebhook registration helper
      if (typeof body?.setWebhook === 'object' && body.setWebhook) {
        const botToken = typeof body.setWebhook.botToken === 'string' ? body.setWebhook.botToken : '';
        if (!botToken) { json(res, 400, { error: { code: 'bad-request', message: 'dsh-key-rotation: setWebhook.botToken required' } }); return; }
        // derive the public URL from request headers; explicit URL wins
        const url = typeof body.setWebhook.url === 'string' && body.setWebhook.url ? body.setWebhook.url : `https://${String(req.headers.host ?? '')}/dsh-key-rotation/webhook-action`;
        try {
          const hookRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url, allowed_updates: ['callback_query'] }),
          });
          const hookData = await hookRes.json().catch(() => ({}));
          json(res, 200, { ok: hookRes.ok, url, telegram: hookData });
        } catch (e) {
          json(res, 502, { error: { code: 'telegram-failed', message: String(e?.message ?? e) } });
        }
        return;
      }
      if (!action) { json(res, 400, { error: { code: 'bad-action', message: 'dsh-key-rotation: no action in payload' } }); return; }
      const provider = action.startsWith('pause-') || action.startsWith('reset-') ? action.replace(/^(pause|reset)-/, '') : '';
      try {
        if (action === 'disable-rotation') {
          setRotationDisabled(true);
          console.warn('[dsh-key-rotation] rotation DISABLED via webhook action');
          json(res, 200, { ok: true, action });
          return;
        }
        if (action === 'enable-rotation') {
          setRotationDisabled(false);
          json(res, 200, { ok: true, action });
          return;
        }
        if (action.startsWith('pause-') || action.startsWith('reset-')) {
          const st = poolState.get(provider);
          if (!st) { json(res, 404, { error: { code: 'not-found', message: `dsh-key-rotation: no pool for '${provider}'` } }); return; }
          if (action.startsWith('pause-')) {
            const until = Date.now() + 3600000; // 1h pause
            for (const ref of (st.failedUntil ? [...st.failedUntil.keys()] : [])) st.failedUntil.set(ref, Math.max(st.failedUntil.get(ref) ?? 0, until));
            // also pause every key currently healthy
            for (const p of buildRuntime().poolByRef.values()) {
              if (p.base !== provider) continue;
              for (const ref of p.refs) st.failedUntil.set(ref, Math.max(st.failedUntil.get(ref) ?? 0, until));
            }
            console.warn(`[dsh-key-rotation] pool ${provider} PAUSED 1h via webhook action`);
            json(res, 200, { ok: true, action, provider, until: Date.now() + 3600000 });
            return;
          }
          const cleared = st.failedUntil.size;
          st.failedUntil.clear(); st.failCounts?.clear(); st.brokenUntil?.clear();
          console.warn(`[dsh-key-rotation] pool ${provider} RESET via webhook action`);
          json(res, 200, { ok: true, action, provider, cleared });
          return;
        }
        json(res, 400, { error: { code: 'unknown-action', message: `dsh-key-rotation: unknown action '${action}'` } });
      } catch (e) {
        json(res, 500, { error: { code: 'action-failed', message: String(e?.message ?? e) } });
      }
    },
  }), 'dsh-key-rotation: webhook-action');




}

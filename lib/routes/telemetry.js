import { getWebServer } from './guard.js';
// lib/ops-telemetry.js — usage + snapshot operational routes (#312 split from routes-ops.js).
import {
  json,
  readJson,
  descriptorOf,
  NS,
} from '../http-bridge.js';
import { isTrustedBridgeRequest } from '../pool.js';
import {
  usageRows,
  usageCsv,
} from '../usage-report.js';
import {
  USAGE_PATH,
  SNAPSHOT_PATH,
  DIAG_PATH,
  TRACE_PATH,
  SIMULATE_PATH,
} from './paths.js';
import { simulateRouting } from '../simulator.js';
import { getSelectionTraces, clearSelectionTraces } from '../selection-trace.js';
import { findSecrets } from '../keycheck.js';
import { mutateSettings, sectionOps } from '../settings-write.js';
import { compute24hAnalytics } from '../ops-analytics.js';
import { getPromptCacheSummary } from '../prompt-cache.js';

/**
 * @param {object} ctx cordis context
 * @param {object} deps live dependencies from apply()
 */

const DIAG_BUFFER_LIMIT = 200;

export class DiagBuffer {
  constructor(limit = DIAG_BUFFER_LIMIT) {
    this.limit = limit;
    this.buffer = [];
  }

  push(entry) {
    if (this.buffer.length >= this.limit) {
      this.buffer.shift();
    }
    this.buffer.push({
      timestamp: Date.now(),
      ...entry,
    });
  }

  get() {
    return this.buffer.slice();
  }

  clear() {
    this.buffer.length = 0;
  }
}

const defaultDiagBuffer = new DiagBuffer();

export function pushDiag(entry, buffer = null) {
  (buffer || defaultDiagBuffer).push(entry);
}

export function getDiagBuffer(buffer = null) {
  return (buffer || defaultDiagBuffer).get();
}

export function registerTelemetryRoutes(ctx, deps) {
  const {
    buildRuntime,
  } = deps;

ctx.effect(() => getWebServer(ctx).register({
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
    const poolsToScan = runtime.pools ?? runtime.poolByRef.values();
    for (const pool of poolsToScan) {
      if (seen.has(pool.base)) continue;
      seen.add(pool.base);
      if (provider && pool.base !== provider && pool.provider !== provider) continue;
      report.push({
        provider: pool.base,
        rows: usageRows(pool, days, now),
        promptCache: getPromptCacheSummary(pool, now),
        analytics24h: compute24hAnalytics(pool, now),
      });
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

ctx.effect(() => getWebServer(ctx).register({
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
    try {
      // Empty exported tokens mean omitted, not erased. Never reconstruct a
      // complete section from the redacted describe response.
      const ops = sectionOps(snap, { preserveEmptySecrets: true });
      await mutateSettings(settings, NS, ops, body.expectedRevision ?? desc.revision);
      const after = descriptorOf(ctx, NS);
      json(res, 200, { ok: true, revision: after?.revision });
    } catch (e) {
      json(res, e?.code === 'SETTINGS_CONFLICT' ? 409 : 400, { error: { code: 'settings-rejected', message: String(e?.message ?? e) } });
    }
  },
}), 'dsh-key-rotation: snapshot route');


ctx.effect(() => getWebServer(ctx).register({
  kind: 'exact',
  path: TRACE_PATH,
  handler: (req, res) => {
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      json(res, 405, { error: { code: 'method', message: 'GET or DELETE only' } });
      return;
    }
    if (!isTrustedBridgeRequest(req)) {
      json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: trace is local-only' } });
      return;
    }
    const traceStore = deps.selectionTraceStore || null;
    if (req.method === 'DELETE') {
      clearSelectionTraces(traceStore);
      json(res, 200, { ok: true, message: 'trace history cleared' });
      return;
    }
    const url = new URL(req.url ?? TRACE_PATH, 'http://localhost');
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    json(res, 200, { ok: true, traces: getSelectionTraces(limit, traceStore) });
  },
}), 'dsh-key-rotation: trace route');


ctx.effect(() => getWebServer(ctx).register({
  kind: 'exact',
  path: SIMULATE_PATH,
  handler: async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: { code: 'method', message: 'POST only' } });
      return;
    }
    if (!isTrustedBridgeRequest(req)) {
      json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: simulate is local-only' } });
      return;
    }
    let body;
    try { body = await readJson(req); } catch (e) {
      json(res, 400, { error: { code: 'bad-request', message: String(e?.message ?? e) } });
      return;
    }

    const runtime = buildRuntime();
    const provider = body?.provider?.trim();
    if (!provider) {
      json(res, 400, { error: { code: 'bad-request', message: 'provider is required for simulation' } });
      return;
    }

    let pool = null;
    if (runtime.providerToPool instanceof Map) {
      pool = runtime.providerToPool.get(provider);
    } else if (runtime.providerToPool && typeof runtime.providerToPool === 'object') {
      pool = runtime.providerToPool[provider];
    }
    if (!pool) {
      const pools = runtime.pools ?? [];
      pool = pools.find(p => p.provider === provider || p.base === provider);
    }

    if (!pool) {
      json(res, 404, { error: { code: 'not-found', message: `Provider '${provider}' not found in configured pools` } });
      return;
    }

    try {
      const result = simulateRouting({
        pool,
        runtime,
        events: Array.isArray(body?.events) ? body.events : [],
        model: body?.model || '',
        maxAttempts: Number(body?.maxAttempts) || 0,
      });
      json(res, 200, { ok: true, simulation: result });
    } catch (e) {
      json(res, 500, { error: { code: 'sim-error', message: String(e?.message ?? e) } });
    }
  },
}), 'dsh-key-rotation: simulate route');

ctx.effect(() => getWebServer(ctx).register({
  kind: 'exact',
  path: DIAG_PATH,
  handler: async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      json(res, 405, { error: { code: 'method', message: 'GET or POST only' } });
      return;
    }
    if (!isTrustedBridgeRequest(req)) {
      json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: diag is local-only' } });
      return;
    }
    if (req.method === 'POST') {
      let body;
      try { body = await readJson(req); } catch (e) {
        json(res, 400, { error: { code: 'bad-request', message: String(e?.message ?? e) } });
        return;
      }
      pushDiag({
        level: typeof body?.level === 'string' ? body.level : 'info',
        message: typeof body?.message === 'string' ? body.message.slice(0, 500) : 'unknown',
        details: body?.details ?? null,
      });
      json(res, 200, { ok: true, count: diagBuffer.length });
      return;
    }
    json(res, 200, { diag: deps.diagBuffer ? deps.diagBuffer.get() : getDiagBuffer() });
  },
}), 'dsh-key-rotation: diag route');

}

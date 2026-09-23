// lib/ops-telemetry.js — usage + snapshot operational routes (#312 split from routes-ops.js).
import {
  json,
  readJson,
  descriptorOf,
  NS,
} from './http-bridge.js';
import { isTrustedBridgeRequest } from './pool.js';
import {
  usageRows,
  usageCsv,
} from './usage-report.js';
import {
  USAGE_PATH,
  SNAPSHOT_PATH,
} from './ops-paths.js';
import { findSecrets } from './keycheck.js';
import { mutateSettings, sectionOps } from './settings-write.js';

/**
 * @param {object} ctx cordis context
 * @param {object} deps live dependencies from apply()
 */
export function registerTelemetryRoutes(ctx, deps) {
  const {
    buildRuntime,
  } = deps;

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

}

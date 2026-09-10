// lib/http-bridge.js — shared HTTP helpers for dsh-key-rotation routes.
import { findSecrets } from './keycheck.js';
import { isTrustedBridgeRequest } from './pool.js';

export const NS = 'dsh-key-rotation';

export function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function readJson(request) {
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

export function descriptorOf(ctx, ns) {
  const settings = ctx.get('settings');
  if (settings === void 0) return void 0;
  return settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === ns);
}

export function viewOf(descriptor, settings) {
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

export async function writeSection(ctx, ns, section, expectedRevision, res) {
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

export function providerCatalog(ctx, cloneIds) {
  const seen = new Set();
  const out = [];
  const llm = ctx.get('llm');
  for (const info of (llm?.listProviders?.() ?? [])) {
    if (seen.has(info.id) || cloneIds.has(info.id)) continue;
    seen.add(info.id);
    out.push({ id: info.id, name: info.name ?? info.id });
  }
  return out;
}

export function guardLocal(req, res, label) {
  if (!isTrustedBridgeRequest(req)) {
    json(res, 403, { error: { code: 'forbidden', message: `dsh-key-rotation: ${label} is local-only` } });
    return false;
  }
  return true;
}

export function scanForLiveSecrets(section) {
  const masked = structuredClone(section);
  if (masked.webhookActionToken) masked.webhookActionToken = '***';
  if (masked.notifyWebhook) masked.notifyWebhook = '***';
  return findSecrets(JSON.stringify(masked));
}

/** Config bridge GET/PUT/DELETE — extracted from lib/index.js for size (#253). */
export async function handleConfigBridge(ctx, request, res, getCloneIds) {
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
      try {
        const findings = scanForLiveSecrets(section);
        if (findings.length > 0) {
          json(res, 400, {
            error: {
              code: 'secret-in-config',
              message: `dsh-key-rotation: value looks like a live credential (${findings[0].type}); store key values via the key field, not the config section`,
              findings,
            },
          });
          return;
        }
      } catch {
        /* scanning must never block a valid save */
      }
    } else {
      section = {};
      expectedRevision = void 0;
    }
    await writeSection(ctx, NS, section, expectedRevision, res);
    return;
  }
  json(res, 405, { error: { code: 'method', message: 'GET, PUT, or DELETE only' } });
}

// lib/http-bridge.js — shared HTTP helpers for dsh-key-rotation routes.
import { findSecrets } from './keycheck.js';
import { isTrustedBridgeRequest } from './pool.js';
export { isTrustedBridgeRequest };
import { mutateSettings, plainObject, requireRevision, sectionOps, validateOps } from './settings-write.js';

export const NS = 'dsh-key-rotation';

export function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function readJson(request, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const off = (evt, fn) => {
      if (typeof request?.off === 'function') request.off(evt, fn);
      else if (typeof request?.removeListener === 'function') request.removeListener(evt, fn);
    };
    const cleanup = () => {
      off('data', onData); off('end', onEnd);
      off('error', onError); off('aborted', onAborted);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onAborted = () => onError(new Error('Request body was aborted'));
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        onError(Object.assign(new Error('Request body exceeds the 1 MiB limit'), { status: 413 }));
        request.resume();
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(error); }
    };
    request.on('data', onData); request.on('end', onEnd);
    request.on('error', onError); request.on('aborted', onAborted);
  });
}

export function descriptorOf(ctx, ns) {
  const settings = ctx.get('settings');
  if (settings === void 0 || typeof settings?.describe !== 'function') return void 0;
  return settings.describe({ redactSecrets: true })?.find((candidate) => candidate.ns === ns);
}

export function viewOf(descriptor, settings) {
  return {
    available: true,
    writable: Boolean(settings?.writable),
    hasDocument: Boolean(settings?.hasDocument),
    value: descriptor?.value,
    ...descriptor.base === void 0 ? {} : { base: descriptor.base },
    ...descriptor.user === void 0 || Object.keys(descriptor.user).length === 0 ? {} : { user: descriptor.user },
    revision: descriptor.revision,
  };
}

export async function writeSection(ctx, ns, section, expectedRevision, res, reset = false) {
  const settings = ctx.get('settings');
  if (settings === void 0) {
    json(res, 503, { error: { code: 'settings-rejected', message: 'dsh-key-rotation: no settings provider is mounted' } });
    return;
  }
  try {
    if (reset) {
      // DELETE is the explicit reset API; an ordinary save/import never comes here.
      await settings.replace(ns, {}, expectedRevision);
    } else {
      const ops = Array.isArray(section) ? validateOps(section) : sectionOps(section);
      await mutateSettings(settings, ns, ops, expectedRevision);
    }
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
  json(res, 200, viewOf(descriptor, { writable: Boolean(settings?.writable), hasDocument: settings?.documentPath !== void 0 }));
}

/**
 * Normalise one provider entry into `{ id, name }`, or null when unusable.
 * Provider info shapes differ across core generations: `listProviders()` yields
 * `{ id, name }`, while `listConfigurableProviders()` yields
 * `{ provider, displayName, ... }`.
 */
function toCatalogEntry(info) {
  if (!info || typeof info !== 'object') return null;
  const id = typeof info.id === 'string' && info.id
    ? info.id
    : (typeof info.provider === 'string' && info.provider ? info.provider : null);
  if (!id) return null;
  const name = typeof info.name === 'string' && info.name ? info.name
    : (typeof info.displayName === 'string' && info.displayName ? info.displayName : id);
  return { id, name };
}

/**
 * Registered providers for the Settings card's picker (#379).
 *
 * `llm` is a service whose members are resolved through the host's service
 * layer, and on newer cores some of them are *remote* (RPC-backed). A remote
 * member may legitimately return a promise, and an older core may not expose
 * `listProviders` at all. Both cases used to throw out of the GET handler and
 * surface to the user as an unavailable provider list, so every call is
 * guarded and `listConfigurableProviders()` is used as a fallback source.
 *
 * Never throws: an empty list is a valid answer, and the caller reports
 * availability separately.
 */
export function providerCatalog(ctx, cloneIds) {
  const out = [];
  const seen = new Set();
  const push = (infos) => {
    if (!Array.isArray(infos)) return;
    for (const raw of infos) {
      const entry = toCatalogEntry(raw);
      if (!entry || seen.has(entry.id) || cloneIds?.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  };

  let llm = null;
  try {
    llm = ctx?.get?.('llm') ?? null;
  } catch (_) {
    llm = null;
  }

  const listProviders = llm?.listProviders;
  if (typeof listProviders === 'function') {
    try {
      const infos = listProviders.call(llm);
      if (infos && typeof infos.then !== 'function') push(infos);
    } catch (_) {
      /* fall through to configurable-provider directory */
    }
  }

  if (out.length === 0) {
    const listConfigurable = llm?.listConfigurableProviders;
    if (typeof listConfigurable === 'function') {
      try {
        const infos = listConfigurable.call(llm);
        if (infos && typeof infos.then !== 'function') push(infos);
      } catch (_) {
        /* an unavailable catalog is reported by the card, not thrown here */
      }
    }
  }

  return out;
}


export function scanForLiveSecrets(section) {
  if (Array.isArray(section)) {
    return findSecrets(JSON.stringify(section.filter(op => !['webhookActionToken', 'notifyWebhook'].includes(op?.path?.[0]))));
  }
  const masked = structuredClone(section);
  if (masked && typeof masked === 'object') {
    if (masked.webhookActionToken) masked.webhookActionToken = '***';
    if (masked.notifyWebhook) masked.notifyWebhook = '***';
  }
  return findSecrets(JSON.stringify(masked));
}

/** Config bridge GET/PUT/DELETE — extracted from lib/index.js for size (#253). */
export async function handleConfigBridge(ctx, request, res, getCloneIds) {
  if (!isTrustedBridgeRequest(request)) {
    json(res, 403, { error: { code: 'forbidden', message: 'Settings writes require a trusted loopback origin' } });
    return;
  }
  const method = request.method ?? 'GET';
  if (method === 'GET') {
    try {
      const settings = ctx.get('settings');
      const descriptor = descriptorOf(ctx, NS);
      const body = {
        providers: providerCatalog(ctx, getCloneIds()),
      };
      if (descriptor === void 0) {
        json(res, 200, {
          ...body,
          available: false,
          writable: Boolean(settings?.writable),
          hasDocument: settings?.documentPath !== void 0,
          value: void 0,
          revision: 0,
        });
        return;
      }
      json(res, 200, {
        ...body,
        ...viewOf(descriptor, {
          writable: Boolean(settings?.writable),
          hasDocument: settings?.documentPath !== void 0,
        }),
      });
    } catch (error) {
      json(res, 500, {
        error: {
          code: 'settings-read-failed',
          message: `dsh-key-rotation: failed to read settings: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
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
        json(res, error?.status === 413 ? 413 : 400, { error: { code: 'settings-rejected', message: `dsh-key-rotation: invalid request body: ${error instanceof Error ? error.message : String(error)}` } });
        return;
      }
      try {
        if (!plainObject(body) || (Object.hasOwn(body, 'ops') === Object.hasOwn(body, 'section'))) {
          throw new TypeError('PUT requires exactly one of {ops: [...]} or {section: {...}}');
        }
        section = Object.hasOwn(body, 'ops') ? validateOps(body.ops) : sectionOps(body.section);
      } catch (error) {
        json(res, 400, { error: { code: 'settings-rejected', message: error.message } });
        return;
      }
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
      try {
        expectedRevision = requireRevision(body.expectedRevision);
      } catch (error) {
        json(res, 400, { error: { code: 'settings-rejected', message: error.message } });
        return;
      }
    } else {
      section = {};
      expectedRevision = void 0;
    }
    await writeSection(ctx, NS, section, expectedRevision, res, method === 'DELETE');
    return;
  }
  json(res, 405, { error: { code: 'method', message: 'GET, PUT, or DELETE only' } });
}

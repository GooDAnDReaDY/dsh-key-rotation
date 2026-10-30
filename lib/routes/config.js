// lib/ops-config-io.js — full configuration export and import (#504).
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

let PLUGIN_VERSION = '0.8.68';
try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (pkg.version) PLUGIN_VERSION = pkg.version;
} catch (_) { /* fallback */ }
import { json, readJson, isTrustedBridgeRequest, NS } from '../http-bridge.js';
import { CONFIG_EXPORT_PATH, CONFIG_IMPORT_PATH, IMPORT_PATH } from './paths.js';
import { keyTail } from '../pool.js';
import { plainConfig } from '../index.js';

export const MAX_PBKDF2_ITERATIONS = 200000;
export const MIN_PBKDF2_ITERATIONS = 10000;
export const DEFAULT_PBKDF2_ITERATIONS = 100000;

export function deriveKeyAsync(passphrase, salt, iterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(passphrase, salt, iterations, 32, 'sha256', (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

function validateAndExtractCryptoParams(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid encrypted config payload structure');
  }
  if (!payload.salt || !payload.iv || !payload.tag || !payload.ciphertext) {
    throw new Error('Missing salt, iv, tag or ciphertext in payload');
  }
  const iters = Number(payload.iterations) || DEFAULT_PBKDF2_ITERATIONS;
  if (!Number.isFinite(iters) || iters < MIN_PBKDF2_ITERATIONS || iters > MAX_PBKDF2_ITERATIONS) {
    throw new Error(`PBKDF2 iterations must be between ${MIN_PBKDF2_ITERATIONS} and ${MAX_PBKDF2_ITERATIONS}`);
  }
  const salt = Buffer.from(payload.salt, 'hex');
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const ciphertext = Buffer.from(payload.ciphertext, 'hex');
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) {
    throw new Error('Malformed salt, iv or auth tag length in encrypted payload');
  }
  return { iters, salt, iv, tag, ciphertext };
}

export function encryptConfig(plainText, passphrase) {
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(passphrase, salt, DEFAULT_PBKDF2_ITERATIONS, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: true,
    algorithm: 'aes-256-gcm',
    kdf: 'pbkdf2',
    iterations: DEFAULT_PBKDF2_ITERATIONS,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
  };
}

export function decryptConfig(payload, passphrase) {
  const { iters, salt, iv, tag, ciphertext } = validateAndExtractCryptoParams(payload);
  const key = crypto.pbkdf2Sync(passphrase, salt, iters, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export async function decryptConfigAsync(payload, passphrase) {
  const { iters, salt, iv, tag, ciphertext } = validateAndExtractCryptoParams(payload);
  const key = await deriveKeyAsync(passphrase, salt, iters);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export function maskConfig(config) {
  if (!config || typeof config !== 'object') return config;
  const clone = JSON.parse(JSON.stringify(config));
  if (Array.isArray(clone.providers)) {
    for (const prov of clone.providers) {
      if (Array.isArray(prov.keys)) {
        prov.keys = prov.keys.map((k) => {
          if (typeof k === 'string') return k.length > 8 ? `sk-...${k.slice(-4)}` : '***';
          if (k && typeof k === 'object') {
            return {
              ...k,
              value: typeof k.value === 'string' ? (k.value.length > 8 ? `sk-...${k.value.slice(-4)}` : '***') : '***',
            };
          }
          return '***';
        });
      }
    }
  }
  function maskWebhookString(val) {
    if (!val || typeof val !== 'string') return val;
    try {
      const u = new URL(val);
      if (u.username) u.username = '***';
      if (u.password) u.password = '***';
      if (u.search) u.search = '?token=***';
      const parts = u.pathname.split('/');
      if (parts.length > 2) {
        parts[parts.length - 1] = '***';
        u.pathname = parts.join('/');
      }
      return u.toString();
    } catch (_) {
      return '***';
    }
  }

  if (clone.webhookUrl) {
    clone.webhookUrl = maskWebhookString(clone.webhookUrl);
  }
  if (clone.notifyWebhook) {
    clone.notifyWebhook = maskWebhookString(clone.notifyWebhook);
  }
  if (clone.webhookActionToken) clone.webhookActionToken = '***';
  return clone;
}

export function diffConfigs(currentConfig, incomingConfig, mode = 'merge') {
  const currentProviders = Array.isArray(currentConfig?.providers) ? currentConfig.providers : [];
  const incomingProviders = Array.isArray(incomingConfig?.providers) ? incomingConfig.providers : [];

  const currentMap = new Map();
  for (const p of currentProviders) {
    const name = p.provider || p.name || p.id;
    if (name) currentMap.set(name, p);
  }

  const createdProviders = [];
  const updatedProviders = [];
  let keysAdded = 0;
  let keysUpdated = 0;

  for (const p of incomingProviders) {
    const name = p.provider || p.name || p.id;
    if (!name) continue;
    const inKeys = Array.isArray(p.keys) ? p.keys : [];
    if (!currentMap.has(name)) {
      createdProviders.push(name);
      keysAdded += inKeys.length;
    } else {
      updatedProviders.push(name);
      const curP = currentMap.get(name);
      const curKeys = new Set(Array.isArray(curP.keys) ? curP.keys.map((k) => (typeof k === 'string' ? k : k?.value)) : []);
      for (const k of inKeys) {
        const val = typeof k === 'string' ? k : k?.value;
        if (!curKeys.has(val)) keysAdded++;
        else keysUpdated++;
      }
    }
  }

  const removedProviders = [];
  if (mode === 'replace') {
    const incomingNames = new Set(incomingProviders.map((p) => p.provider || p.name || p.id).filter(Boolean));
    for (const [name] of currentMap.entries()) {
      if (!incomingNames.has(name)) removedProviders.push(name);
    }
  }

  const totalKeys = incomingProviders.reduce((acc, p) => acc + (Array.isArray(p.keys) ? p.keys.length : 0), 0);

  return {
    mode,
    createdProviders,
    updatedProviders,
    removedProviders,
    keysAdded,
    keysUpdated,
    totalKeys,
  };
}

export function registerConfigIoRoutes(ctx, deps) {
  // ── GET & POST /dsh-key-rotation/export (#552: support POST for safe passphrase transmission) ──
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_EXPORT_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        json(res, 405, { error: { code: 'method', message: 'GET or POST only' } });
        return;
      }
      if (!isTrustedBridgeRequest(req)) {
        json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: export is local-only' } });
        return;
      }

      let masked = true;
      let passphrase = null;

      if (req.method === 'POST') {
        let body = {};
        try {
          body = await readJson(req);
        } catch (_) {
          body = {};
        }
        masked = body.masked !== false;
        passphrase = typeof body.passphrase === 'string' && body.passphrase.trim() ? body.passphrase.trim() : null;
      } else {
        const urlObj = new URL(req.url, 'http://127.0.0.1');
        const maskedParam = urlObj.searchParams.get('masked');
        masked = maskedParam === null ? true : maskedParam !== 'false';
        if (urlObj.searchParams.has('passphrase')) {
          passphrase = urlObj.searchParams.get('passphrase') || null;
          try {
            res.setHeader?.('X-Deprecated-Security-Warning', 'Passphrase in query string is deprecated and will be removed; use POST /dsh-key-rotation/export with body');
          } catch (_) {}
        }
      }

      const settings = typeof ctx?.get === 'function' ? ctx.get('settings') : (ctx?.settings || null);
      let currentConfig = {};
      try {
        if (settings && typeof settings.get === 'function') {
          currentConfig = settings.get(NS) || {};
        } else if (settings && typeof settings.describe === 'function') {
          const desc = settings.describe({ redactSecrets: false })?.find((c) => c.ns === NS);
          currentConfig = desc?.value || {};
        } else {
          currentConfig = deps.buildRuntime().cfg0 || {};
        }
      } catch (_) {
        currentConfig = deps.buildRuntime().cfg0 || {};
      }

      const rawConfig = plainConfig(currentConfig);
      const exportData = masked ? maskConfig(rawConfig) : rawConfig;

      if (passphrase) {
        try {
          const encryptedPayload = await encryptConfig(JSON.stringify(exportData), passphrase);
          json(res, 200, {
            ok: true,
            version: PLUGIN_VERSION,
            exportedAt: new Date().toISOString(),
            masked,
            encrypted: true,
            ...encryptedPayload,
          });
          return;
        } catch (err) {
          json(res, 500, { error: { code: 'encryption-failed', message: err.message } });
          return;
        }
      }

      json(res, 200, {
        ok: true,
        version: PLUGIN_VERSION,
        exportedAt: new Date().toISOString(),
        masked,
        encrypted: false,
        config: exportData,
      });
    },
  }));

  // ── POST /dsh-key-rotation/config-import ──
  const handleImport = async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: { code: 'method', message: 'POST only' } });
      return;
    }
    if (!isTrustedBridgeRequest(req)) {
      json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: import is local-only' } });
      return;
    }

    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      json(res, 400, { error: { code: 'bad-request', message: String(e?.message ?? e) } });
      return;
    }

    let incomingConfig = null;
    const passphrase = body.passphrase || null;

    if (body.encrypted && body.ciphertext) {
      if (!passphrase) {
        json(res, 400, { error: { code: 'passphrase-required', message: 'Passphrase is required for encrypted configuration' } });
        return;
      }
      try {
        const decryptedStr = await decryptConfigAsync(body, passphrase);
        incomingConfig = JSON.parse(decryptedStr);
      } catch (err) {
        json(res, 400, { error: { code: 'decryption-failed', message: `Decryption failed: ${err.message}` } });
        return;
      }
    } else if (body.config) {
      incomingConfig = body.config;
    } else if (body.providers) {
      incomingConfig = body;
    } else {
      json(res, 400, { error: { code: 'invalid-payload', message: 'Missing config or providers in request' } });
      return;
    }

    if (!incomingConfig || typeof incomingConfig !== 'object') {
      json(res, 400, { error: { code: 'invalid-config', message: 'Imported configuration must be an object' } });
      return;
    }

    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    const dryRun = Boolean(body.dryRun);

    const settings = typeof ctx?.get === 'function' ? ctx.get('settings') : (ctx?.settings || null);
    if (!settings || typeof settings.replace !== 'function') {
      // Fail closed when settings service is missing or lacks replace (#533)
      json(res, 503, { error: { code: 'settings-unavailable', message: 'Settings service is not available or does not support writing configuration' } });
      return;
    }

    let currentConfig = {};
    let currentRevision = null;
    try {
      if (typeof settings.describe === 'function') {
        const desc = settings.describe({ redactSecrets: false })?.find((c) => c.ns === NS);
        if (desc) {
          currentConfig = desc.value || {};
          currentRevision = desc.revision ?? null;
        }
      }
      if (!currentConfig || Object.keys(currentConfig).length === 0) {
        if (typeof settings.get === 'function') {
          currentConfig = settings.get(NS) || {};
        }
      }
    } catch (_) {
      currentConfig = deps.buildRuntime().cfg0 || {};
    }
    const rawCurrent = plainConfig(currentConfig);

    // Concurrency control: validate expectedRevision format and match (#553)
    if (body.expectedRevision !== undefined && body.expectedRevision !== null) {
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
        json(res, 400, {
          error: {
            code: 'bad-request',
            message: 'expectedRevision must be a non-negative integer',
          },
        });
        return;
      }
      if (currentRevision !== null && body.expectedRevision !== currentRevision) {
        json(res, 409, {
          error: {
            code: 'conflict',
            message: `Configuration has been modified concurrently (expected revision ${body.expectedRevision}, current is ${currentRevision})`,
            currentRevision,
          },
        });
        return;
      }
    }

    const preview = diffConfigs(rawCurrent, incomingConfig, mode);

    if (dryRun) {
      json(res, 200, {
        ok: true,
        dryRun: true,
        revision: currentRevision,
        preview,
      });
      return;
    }

    // Apply configuration
    let mergedConfig;
    if (mode === 'replace') {
      mergedConfig = { ...rawCurrent, ...incomingConfig };
      if (Array.isArray(incomingConfig.providers)) {
        mergedConfig.providers = incomingConfig.providers;
      }
    } else {
      // Merge mode
      mergedConfig = { ...rawCurrent, ...incomingConfig };
      const curProviders = Array.isArray(rawCurrent.providers) ? [...rawCurrent.providers] : [];
      const curMap = new Map();
      for (let i = 0; i < curProviders.length; i++) {
        const name = curProviders[i].provider || curProviders[i].name || curProviders[i].id;
        if (name) curMap.set(name, i);
      }
      const inProviders = Array.isArray(incomingConfig.providers) ? incomingConfig.providers : [];
      for (const p of inProviders) {
        const name = p.provider || p.name || p.id;
        if (!name) continue;
        if (curMap.has(name)) {
          const idx = curMap.get(name);
          curProviders[idx] = { ...curProviders[idx], ...p };
        } else {
          curProviders.push(p);
        }
      }
      mergedConfig.providers = curProviders;
    }

    try {
      await settings.replace(NS, mergedConfig, body.expectedRevision ?? currentRevision ?? undefined);
    } catch (err) {
      const isConflict = err?.code === 'SETTINGS_CONFLICT' ||
        err?.status === 409 ||
        err?.code === 'CONFLICT' ||
        /conflict|revision|stale/i.test(err?.message || '');
      if (isConflict) {
        let latestRevision = null;
        try {
          latestRevision = settings.describe({ redactSecrets: false })?.find((c) => c.ns === NS)?.revision ?? null;
        } catch (_) {}
        json(res, 409, {
          error: {
            code: 'conflict',
            message: `Configuration has been modified concurrently: ${err.message}`,
            currentRevision: latestRevision ?? currentRevision,
          },
        });
        return;
      }
      json(res, 500, { error: { code: 'settings-write-failed', message: err.message } });
      return;
    }

    json(res, 200, {
      ok: true,
      applied: true,
      mode,
      revision: typeof currentRevision === 'number' ? currentRevision + 1 : undefined,
      preview,
    });
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_IMPORT_PATH,
    handler: handleImport,
  }));
}

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
//  provider the user selected (e.g. "opencode-go"), only the resolved API key
//  differs. This keeps pi-ai's replay state consistent across multi-call turns
//  and multi-turn sessions (the earlier clone-provider approach broke it with
//  INVALID_REPLAY_STATE).
//
//  Config is a KEY POOL PER PROVIDER: you list a real provider (e.g. "ollama")
//  and the env names of its API keys (e.g. OLLAMA_API_KEY, OLLAMA_API_KEY_2,
//  OLLAMA_API_KEY_3). When a key's limit is exhausted, the request retries on
//  the next key in the list; exhausted keys stay in cooldown for cooldownMs.
//  Clone provider routes (opencode-go-2, ...) are no longer used for rotation
//  but remain registered, so selecting them also rotates (their apiKeyEnv ref
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

export const name = 'dsh-key-rotation';
export const inject = ['llm', 'webServer', 'settings', 'credentials'];

/** Settings namespace owning the GUI-editable section (settingsNamespace-valid). */
const NS = 'dsh-key-rotation';
/** Config bridge route (GET / PUT / DELETE), loopback-fenced like llm-fallback. */
const CONFIG_PATH = '/dsh-key-rotation/config';
/** The llm-pi-ai namespace whose provider profiles map providers to pools. */
const PIAI_NS = 'llm-pi-ai';
/** Marker on internally re-dispatched requests so the interceptor does not loop. */
const MARKER = '__dshKeyRotation';

const DEFAULT_SWITCH_CODES = [
  'QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'UNKNOWN_MODEL', 'AUTH',
];

// Fallback classification by failure message. pi-ai surfaces many real quota /
// rate-limit / transport failures as thrown exceptions (e.g. the OpenAI SDK
// throws on HTTP 429 before the stream starts), and dsh-llm then normalizes
// them to finish chunks with code "UNKNOWN". The message still carries the
// provider's own text ("429: ...", "Weekly usage limit reached", ...), so we
// treat pre-content failures whose message matches these patterns as
// switchable even when the code is not in `switchCodes`.
const SWITCHABLE_MESSAGE_PATTERN = new RegExp([
  /\b(?:quota|usage[\s_-]+limit|rate[\s_-]?limit)\b/i,
  /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i,
  /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i,
  /\b(?:exceeded|exhausted)[\s_-]+(?:quota|limit|budget)\b/i,
  /\bbilling\b/i,
  /\b429\b|\b5\d\d\b/i,
  /\btime(?:d)?\s*out\b|timeout/i,
  /\b(?:network|connection|socket|fetch|ECONN[A-Z]+)\b/i,
  /\bother side closed|premature close|stream ended (?:before|without)\b/i,
  // auth: a dead/revoked key should also rotate to the next pool key
  /\b401\b|\b403\b/i,
  /\b(?:invalid|expired|revoked|unauthorized)[\s_-]+(?:api[\s_-]?key|token)\b/i,
  /\bapi[\s_-]?key[\s_-]+(?:is[\s_-]+)?(?:invalid|expired|revoked|unauthorized)\b/i,
  /\b(?:authentication|unauthorized|not[\s_-]+authorized)\b/i,
].map((r) => r.source).join('|'));

// Bootstrap key pools. The user edits these in the Settings GUI; this is just
// the default matching the current server setup.
const DEFAULT_PROVIDERS = [
  {
    provider: 'opencode-go',
    keys: ['OPENCODE_GO_API_KEY', 'OPENCODE_GO_API_KEY_2', 'OPENCODE_GO_API_KEY_3', 'OPENCODE_GO_API_KEY_4'],
  },
  {
    provider: 'ollama',
    keys: ['OLLAMA_API_KEY', 'OLLAMA_API_KEY_2', 'OLLAMA_API_KEY_3'],
  },
];

export const Config = Schema.object({
  switchCodes: Schema.array(Schema.string()).default([...DEFAULT_SWITCH_CODES]),
  cooldownMs: Schema.number().default(60000),
  providers: Schema.array(Schema.object({
    provider: Schema.string().required(),
    keys: Schema.array(Schema.string()).default([]),
  })).default([...DEFAULT_PROVIDERS]),
});

// ── config bridge (GET/PUT/DELETE on CONFIG_PATH), mirroring llm-fallback ──

function isLoopbackAddress(address) {
  if (address === void 0) return false;
  if (address === '127.0.0.1' || address === '::1') return true;
  if (address.startsWith('::ffff:')) return address.slice(7) === '127.0.0.1';
  return false;
}

function isTrustedBridgeRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers['origin'];
  if (origin === void 0) return true;
  try {
    const host = request.headers['host'];
    if (host === void 0) return false;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

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

  // ── runtime snapshot: config + llm-pi-ai profile mapping ──
  function buildRuntime() {
    // Deep-clone before resolving: the frozen snapshot from settings.register
    // must never be written to by schemastery's dict resolver.
    const cfg = Config(structuredClone(getConfig() ?? {})) ?? {};
    const switchCodes = new Set(cfg.switchCodes ?? DEFAULT_SWITCH_CODES);
    const cooldownMs = cfg.cooldownMs ?? 60000;

    // ref -> pool (every key env of every configured provider)
    const poolByRef = new Map();
    // provider route (from llm-pi-ai profiles) -> its key pool
    const providerToPool = new Map();
    // clone route ids (for the settings dropdown filter)
    const cloneIds = new Set();

    for (const p of cfg.providers ?? []) {
      const refs = (p.keys ?? []).filter((ref) => typeof ref === 'string' && ref.length > 0);
      if (refs.length === 0) continue;
      let state = poolState.get(p.provider);
      if (!state) {
        state = { failedUntil: new Map(), pointer: 0, lastUsed: undefined };
        poolState.set(p.provider, state);
      }
      const pool = { base: p.provider, refs, state };
      for (const ref of refs) poolByRef.set(ref, pool);
      for (let i = 1; i < refs.length; i++) cloneIds.add(`${p.provider}-${i + 1}`);
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

    return { switchCodes, cooldownMs, poolByRef, providerToPool, cloneIds };
  }

  // ── patch credentials.resolve: pool refs resolve to the next healthy key ──
  // Round-robin over the pool, skipping keys in cooldown; the request's
  // provider identity never changes, so pi-ai replay state stays consistent.
  const credentials = ctx.get('credentials');
  if (credentials && typeof credentials.resolve === 'function' && !credentials.__dshKeyRotationPatched) {
    const original = credentials.resolve.bind(credentials);
    credentials.resolve = async (ref) => {
      const { poolByRef } = buildRuntime();
      const pool = poolByRef.get(ref);
      if (!pool) return original(ref);
      const now = Date.now();
      const start = pool.state.pointer ?? 0;
      for (let i = 0; i < pool.refs.length; i++) {
        const index = (start + i) % pool.refs.length;
        const candidate = pool.refs[index];
        const until = pool.state.failedUntil.get(candidate);
        if (until !== undefined && until > now) continue;
        const hit = await original(candidate);
        if (hit && typeof hit.value === 'string' && hit.value.length > 0) {
          pool.state.pointer = (index + 1) % pool.refs.length;
          pool.state.lastUsed = candidate;
          return hit;
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
      const { switchCodes, cooldownMs } = buildRuntime();
      let lastFailure = null;

      for (let attempt = 0; attempt < pool.refs.length; attempt++) {
        let yielded = false;
        let switching = false;
        let inner;
        try {
          // mark the internal dispatch so the interceptor does not re-rotate
          inner = ctx.llm.stream({ ...options, [MARKER]: true });
        } catch (e) {
          if (pool.state.lastUsed) pool.state.failedUntil.set(pool.state.lastUsed, Date.now() + cooldownMs);
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
              const switchable = !yielded && kind === 'error' &&
                (switchCodes.has(code) || SWITCHABLE_MESSAGE_PATTERN.test(message));
              if (switchable) {
                if (pool.state.lastUsed) pool.state.failedUntil.set(pool.state.lastUsed, Date.now() + cooldownMs);
                lastFailure = chunk;
                console.warn(`[dsh-key-rotation] ${options.provider}: key ${String(pool.state.lastUsed ?? '?')} failed (${String(code)} ${String(message).slice(0, 100)}) — next key`);
                switching = true;
                break;
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

      yield lastFailure ?? finishError('TRANSPORT', 'dsh-key-rotation: all keys failed');
    })();
  }

  // Intercept the llm/stream waterfall: rotate any request whose provider maps
  // to a configured key pool; pass everything else (and internal dispatches)
  // straight through.
  ctx.on('llm/stream', (options, next) => {
    if (options[MARKER]) return next();
    const { providerToPool } = buildRuntime();
    const pool = providerToPool.get(options.provider);
    if (!pool) return next();
    console.warn(`[dsh-key-rotation] rotating ${options.provider}/${options.model} across ${pool.refs.length} keys`);
    return rotate(options, pool);
  });

  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(NS, Config, { base: config });
    getConfig = () => scope.get() ?? config;
    sctx.effect(() => () => {
      getConfig = () => config;
    });
  });
}

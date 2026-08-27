// sandbox.js — probe sandbox-test runner + last-test cache.
// Ponytail-mode (full): simplest correct path.
// YAGNI: chat completions is a hook (not-implemented).
// In-memory only; restart dsh-web = clear cache.

export const PROBE_MODELS_TIMEOUT_MS = 5000;
export const PROBE_RETRY_DELAY_MS = 1000;
export const LAST_TEST_MAX = 200;

export class LastTestCache {
  constructor(max = LAST_TEST_MAX) {
    this._max = max;
    this._data = new Map();
  }

  set(ref, result) {
    if (!ref || !result) return;
    if (this._data.has(ref)) this._data.delete(ref);
    this._data.set(ref, result);
    while (this._data.size > this._max) {
      const first = this._data.keys().next().value;
      if (first === undefined) break;
      this._data.delete(first);
    }
  }

  get(ref) {
    return this._data.get(ref);
  }

  snapshot() {
    const out = {};
    for (const [k, v] of this._data) out[k] = v;
    return out;
  }

  clear() {
    this._data.clear();
  }

  get size() {
    return this._data.size;
  }
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limit';
  if (status >= 500 && status < 600) return 'server';
  return `http-${status}`;
}

export class SandboxRunner {
  constructor({ fetchImpl, resolveBaseUrl, log = () => {} } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('sandbox: fetchImpl required');
    if (typeof resolveBaseUrl !== 'function') throw new Error('sandbox: resolveBaseUrl required');
    this._fetch = fetchImpl;
    this._resolveBaseUrl = resolveBaseUrl;
    this._log = log;
  }

  async probeModels(ref, key) {
    if (!ref || typeof key !== 'string' || key.length === 0) {
      return { ok: false, code: 'no-credential', latencyMs: 0 };
    }
    const baseUrl = await this._resolveBaseUrl(ref);
    if (!baseUrl) {
      return { ok: false, code: 'no-baseurl', latencyMs: 0 };
    }
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_MODELS_TIMEOUT_MS);
    const doFetch = () => this._fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: ctrl.signal,
    });
    try {
      let res;
      try {
        res = await doFetch();
      } catch (e) {
        if (e && e.name === 'AbortError') return { ok: false, code: 'timeout', latencyMs: Date.now() - started };
        return { ok: false, code: 'network', latencyMs: Date.now() - started };
      }
      // ponytail: 1 retry on 5xx — naive; classifier refines if needed
      if (res.status >= 500 && res.status < 600) {
        await new Promise((r) => setTimeout(r, PROBE_RETRY_DELAY_MS));
        if (ctrl.signal.aborted) return { ok: false, code: 'timeout', latencyMs: Date.now() - started };
        try {
          res = await doFetch();
        } catch (e) {
          if (e && e.name === 'AbortError') return { ok: false, code: 'timeout', latencyMs: Date.now() - started };
          return { ok: false, code: 'network', latencyMs: Date.now() - started };
        }
      }
      const status = res.status;
      if (status >= 200 && status < 300) {
        let modelsCount = 0;
        try {
          const body = await res.json();
          modelsCount = Array.isArray(body && body.data) ? body.data.length : 0;
        } catch (_) { /* not json */ }
        return { ok: true, code: 'ok', latencyMs: Date.now() - started, modelsCount };
      }
      return { ok: false, code: classifyStatus(status), latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  async probeChat(_ref, _key) {
    return { ok: false, code: 'not-implemented', latencyMs: 0 };
  }
}

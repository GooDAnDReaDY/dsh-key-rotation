// lib/model-catalog.js — Centralized model catalog with Cache Stampede protection (#550).
// Deduplicates concurrent in-flight requests and provides TTL-based caching and model capability normalization.

export const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_CATALOG_TIMEOUT_MS = 15_000;      // 15 seconds

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;

export const KNOWN_MODELS_FALLBACK = {
  'deepseek-chat': {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    contextWindow: 64_000,
    maxTokens: 8_000,
    supportsReasoning: false,
    supportsTools: true,
    supportsVision: false,
  },
  'deepseek-reasoner': {
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner',
    contextWindow: 64_000,
    maxTokens: 8_000,
    supportsReasoning: true,
    supportsTools: false,
    supportsVision: false,
  },
  'gpt-4o': {
    id: 'gpt-4o',
    name: 'GPT-4o',
    contextWindow: 128_000,
    maxTokens: 16_384,
    supportsReasoning: false,
    supportsTools: true,
    supportsVision: true,
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    contextWindow: 128_000,
    maxTokens: 16_384,
    supportsReasoning: false,
    supportsTools: true,
    supportsVision: true,
  },
  'claude-3-5-sonnet-20241022': {
    id: 'claude-3-5-sonnet-20241022',
    name: 'Claude 3.5 Sonnet',
    contextWindow: 200_000,
    maxTokens: 8_192,
    supportsReasoning: false,
    supportsTools: true,
    supportsVision: true,
  },
};

/**
 * Normalizes raw model object from provider /models endpoint.
 * @param {object|string} raw
 * @returns {object}
 */
export function normalizeModelMeta(raw) {
  if (typeof raw === 'string') {
    const fallback = KNOWN_MODELS_FALLBACK[raw];
    return fallback ? { ...fallback } : {
      id: raw,
      name: raw,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      supportsReasoning: raw.includes('reason') || raw.includes('r1') || raw.includes('thought'),
      supportsTools: true,
      supportsVision: raw.includes('vision') || raw.includes('4o') || raw.includes('vl'),
    };
  }

  const id = String(raw?.id || raw?.slug || raw?.name || '');
  const fallback = KNOWN_MODELS_FALLBACK[id];

  const name = String(raw?.name || raw?.display_name || id);
  const contextWindow =
    Number(raw?.context_window || raw?.max_context_window || raw?.contextWindow) ||
    fallback?.contextWindow ||
    DEFAULT_CONTEXT_WINDOW;
  const maxTokens =
    Number(raw?.max_tokens || raw?.max_output_tokens || raw?.maxTokens) ||
    fallback?.maxTokens ||
    DEFAULT_MAX_TOKENS;

  const caps = Array.isArray(raw?.capabilities) ? raw.capabilities : [];
  const reasoningLevels = Array.isArray(raw?.supported_reasoning_levels) ? raw.supported_reasoning_levels : [];

  const supportsReasoning =
    Boolean(raw?.supportsReasoning) ||
    caps.includes('thinking') ||
    caps.includes('reasoning') ||
    reasoningLevels.length > 0 ||
    id.includes('reason') ||
    id.includes('r1') ||
    fallback?.supportsReasoning ||
    false;

  const supportsTools =
    raw?.supportsTools !== undefined
      ? Boolean(raw.supportsTools)
      : caps.includes('tools') || fallback?.supportsTools || true;

  const inputModalities = Array.isArray(raw?.input_modalities) ? raw.input_modalities : [];
  const supportsVision =
    Boolean(raw?.supportsVision) ||
    inputModalities.includes('image') ||
    id.includes('vision') ||
    id.includes('4o') ||
    id.includes('vl') ||
    fallback?.supportsVision ||
    false;

  return {
    id,
    name,
    contextWindow,
    maxTokens,
    supportsReasoning,
    supportsTools,
    supportsVision,
    raw,
  };
}

export class ModelCatalog {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs]
   * @param {number} [options.timeoutMs]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    /** @type {Map<string, { at: number, models: Array<object> }>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<Array<object>>>} In-flight deduplication map */
    this.inflight = new Map();
  }

  _buildKey(endpoint, apiKey) {
    const keyHint = apiKey ? apiKey.slice(-6) : 'anonymous';
    return `${endpoint || 'default'}|${keyHint}`;
  }

  /**
   * Gets list of models for an endpoint.
   * If a request for this endpoint is already in flight, reuses the promise (anti-stampede).
   *
   * @param {object} options
   * @param {string} options.endpoint Base URL or /models URL
   * @param {string} [options.apiKey]
   * @param {boolean} [options.forceRefresh]
   * @param {typeof fetch} [options.fetchImpl]
   * @returns {Promise<Array<object>>}
   */
  async getModels(options = {}) {
    const { endpoint, apiKey, forceRefresh = false } = options;
    const fetchFn = options.fetchImpl || this.fetchImpl;
    const cacheKey = this._buildKey(endpoint, apiKey);
    const now = Date.now();

    // 1. Check TTL cache if not forcing refresh
    if (!forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && (now - cached.at < this.ttlMs)) {
        return cached.models;
      }
    }

    // 2. Check in-flight deduplication map (Cache Stampede protection)
    const existingPromise = this.inflight.get(cacheKey);
    if (existingPromise) {
      return existingPromise;
    }

    // 3. Initiate single fetch and record in inflight map
    const fetchPromise = (async () => {
      try {
        const models = await this._fetchModels(endpoint, apiKey, fetchFn);
        this.cache.set(cacheKey, { at: Date.now(), models });
        return models;
      } catch (err) {
        // On error, if we have stale cache, serve stale cache
        const stale = this.cache.get(cacheKey);
        if (stale && Array.isArray(stale.models) && stale.models.length > 0) {
          return stale.models;
        }
        // Fallback to known models
        return Object.values(KNOWN_MODELS_FALLBACK).map(normalizeModelMeta);
      } finally {
        this.inflight.delete(cacheKey);
      }
    })();

    this.inflight.set(cacheKey, fetchPromise);
    return fetchPromise;
  }

  /**
   * Gets metadata for a specific model ID.
   * @param {string} modelId
   * @param {object} [options]
   * @returns {Promise<object|null>}
   */
  async getModel(modelId, options = {}) {
    if (!modelId) return null;
    const models = await this.getModels(options);
    const found = models.find((m) => m.id === modelId);
    if (found) return found;
    return normalizeModelMeta(modelId);
  }

  async _fetchModels(endpoint, apiKey, fetchFn) {
    if (!endpoint || typeof fetchFn !== 'function') {
      return Object.values(KNOWN_MODELS_FALLBACK).map(normalizeModelMeta);
    }

    let url = endpoint;
    if (!url.endsWith('/models') && !url.includes('/models?')) {
      url = url.replace(/\/+$/, '') + '/models';
    }

    const headers = {
      accept: 'application/json',
      'user-agent': 'dsh-key-rotation/model-catalog',
    };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetchFn(url, {
        headers,
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`Catalog fetch failed with status ${resp.status}`);
      }

      const body = await resp.json();
      let rawList = [];

      if (Array.isArray(body?.data)) {
        rawList = body.data;
      } else if (Array.isArray(body?.models)) {
        rawList = body.models;
      } else if (body?.models && typeof body.models === 'object') {
        rawList = Object.entries(body.models).map(([k, v]) => ({ id: k, ...(typeof v === 'object' ? v : {}) }));
      }

      if (rawList.length === 0) {
        return Object.values(KNOWN_MODELS_FALLBACK).map(normalizeModelMeta);
      }

      return rawList.map(normalizeModelMeta);
    } finally {
      clearTimeout(timer);
    }
  }

  invalidate(endpoint, apiKey) {
    const key = this._buildKey(endpoint, apiKey);
    this.cache.delete(key);
    this.inflight.delete(key);
  }

  clear() {
    this.cache.clear();
    this.inflight.clear();
  }

  getStatus(endpoint, apiKey) {
    const key = this._buildKey(endpoint, apiKey);
    const entry = this.cache.get(key);
    const isInflight = this.inflight.has(key);
    return {
      cached: Boolean(entry),
      count: entry?.models?.length ?? 0,
      fetchedAt: entry?.at ?? null,
      inflight: isInflight,
    };
  }
}

export const defaultModelCatalog = new ModelCatalog();

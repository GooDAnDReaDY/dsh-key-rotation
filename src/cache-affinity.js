// src/cache-affinity.js — Cache-Affinity Router for hot prompt cache (#573).
// Pure module: zero runtime dependencies, strictly < 600 lines.

export const DEFAULT_CACHE_AFFINITY_TTL_MS = 300000; // 5 minutes
export const DEFAULT_CACHE_AFFINITY_PREFIX_CHARS = 2048;
export const MIN_CACHE_PREFIX_CHARS = 32;

/**
 * 32-bit FNV-1a hash algorithm for fast, deterministic string hashing.
 * @param {string} str
 * @returns {string} Hexadecimal hash representation
 */
export function fnv1a(str) {
  if (typeof str !== 'string') return '0';
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Extracts and hashes a deterministic prompt prefix key from request options.
 * Inspects system prompt, conversation messages, prompt string, or contents.
 * @param {object} options - Request options (messages, prompt, system, model)
 * @param {number} [maxChars=2048]
 * @returns {string|null} Cache prefix key or null if insufficient content
 */
export function extractPromptPrefixKey(options, maxChars = DEFAULT_CACHE_AFFINITY_PREFIX_CHARS) {
  if (!options || typeof options !== 'object') return null;

  let text = '';

  // 1. Explicit system prompt option
  if (typeof options.system === 'string' && options.system.trim()) {
    text += options.system.trim() + '\n';
  }

  // 2. Messages array (OpenAI / Anthropic format)
  if (Array.isArray(options.messages) && options.messages.length > 0) {
    for (const msg of options.messages) {
      if (!msg) continue;
      const role = String(msg.role ?? '').toLowerCase();
      let content = '';

      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Multipart content (e.g. [{ type: 'text', text: '...' }])
        content = msg.content
          .map(part => (typeof part === 'string' ? part : (part?.text ?? '')))
          .filter(Boolean)
          .join('\n');
      }

      if (content.trim()) {
        text += `[${role}] ${content.trim()}\n`;
      }

      // Stop once we have reached or exceeded maxChars
      if (text.length >= maxChars) break;
    }
  }

  // 3. Raw prompt string
  if (!text && typeof options.prompt === 'string' && options.prompt.trim()) {
    text = options.prompt.trim();
  }

  // 4. Contents array (Gemini format)
  if (!text && Array.isArray(options.contents) && options.contents.length > 0) {
    for (const item of options.contents) {
      const parts = item?.parts ?? [];
      for (const p of parts) {
        if (typeof p?.text === 'string' && p.text.trim()) {
          text += p.text.trim() + '\n';
          if (text.length >= maxChars) break;
        }
      }
      if (text.length >= maxChars) break;
    }
  }

  text = text.trim();
  if (text.length < MIN_CACHE_PREFIX_CHARS) {
    return null;
  }

  const slice = text.slice(0, maxChars);
  const hash = fnv1a(slice);
  const model = options.model ? String(options.model).trim() : '';

  return model ? `${model}:${hash}` : hash;
}

/**
 * CacheAffinityRouter tracks which key has warmed the upstream prompt cache.
 */
export class CacheAffinityRouter {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CACHE_AFFINITY_TTL_MS;
    this.maxEntries = options.maxEntries ?? 1000;
    this.entries = new Map();
  }

  resolveAffinity(cacheKey, candidateRefs, now = Date.now()) {
    if (!cacheKey || !this.entries.has(cacheKey) || !Array.isArray(candidateRefs) || candidateRefs.length === 0) {
      return null;
    }

    const entry = this.entries.get(cacheKey);
    if (!entry) return null;

    if (now >= entry.expiresAt) {
      this.entries.delete(cacheKey);
      return null;
    }

    if (!candidateRefs.includes(entry.ref)) {
      return null;
    }

    entry.hits = (entry.hits || 0) + 1;
    return {
      ref: entry.ref,
      hits: entry.hits,
      warmedAt: entry.warmedAt,
      expiresAt: entry.expiresAt,
      ttlRemainingMs: Math.max(0, entry.expiresAt - now),
    };
  }

  recordAffinity(cacheKey, ref, options = {}) {
    if (!cacheKey || !ref) return;
    const now = options.now ?? Date.now();
    const ttlMs = options.ttlMs ?? this.ttlMs;

    if (this.entries.size >= this.maxEntries && !this.entries.has(cacheKey)) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey) this.entries.delete(oldestKey);
    }

    const existing = this.entries.get(cacheKey);
    const hits = existing ? (existing.hits || 0) : 0;

    this.entries.set(cacheKey, {
      ref,
      warmedAt: existing?.warmedAt ?? now,
      lastSeenAt: now,
      expiresAt: now + ttlMs,
      hits,
      model: options.model,
    });
  }

  deleteAffinity(cacheKey) {
    if (cacheKey) this.entries.delete(cacheKey);
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

/**
 * Obtains or lazily creates a CacheAffinityRouter on a pool state.
 * @param {object} pool
 * @returns {CacheAffinityRouter}
 */
export function getOrCreateCacheAffinityRouter(pool) {
  if (!pool) return new CacheAffinityRouter();
  if (!pool.state) pool.state = {};
  if (!pool.state.cacheAffinityRouter || !(pool.state.cacheAffinityRouter instanceof CacheAffinityRouter)) {
    pool.state.cacheAffinityRouter = new CacheAffinityRouter({
      ttlMs: pool.cacheAffinityTtlMs ?? DEFAULT_CACHE_AFFINITY_TTL_MS,
    });
  }
  return pool.state.cacheAffinityRouter;
}

/**
 * Applies prompt cache affinity ordering to candidate attempt list.
 * @param {string[]} attemptList
 * @param {object} pool
 * @param {object} [options]
 * @returns {string[]}
 */
export function applyCacheAffinity(attemptList, pool, options = {}) {
  if (!Array.isArray(attemptList) || attemptList.length <= 1 || !pool) {
    return (attemptList ?? []).slice();
  }

  const enabled = options.enabled ?? pool.cacheAffinityEnabled ?? true;
  if (!enabled) return attemptList.slice();

  const cacheKey = options.cacheKey;
  if (!cacheKey) return attemptList.slice();

  // If a pinned key is configured and already first, keep pinned priority
  if (pool.pinnedRef && attemptList[0] === pool.pinnedRef && options.preservePinned !== false) {
    return attemptList.slice();
  }

  const router = getOrCreateCacheAffinityRouter(pool);
  const now = options.now ?? Date.now();
  const affinity = router.resolveAffinity(cacheKey, attemptList, now);

  if (!affinity || !affinity.ref) {
    return attemptList.slice();
  }

  const targetRef = affinity.ref;
  const list = attemptList.slice();
  const idx = list.indexOf(targetRef);

  if (idx > 0) {
    list.splice(idx, 1);
    list.unshift(targetRef);

    if (options.trace && typeof options.trace.addStep === 'function') {
      options.trace.addStep(targetRef, 'PRIORITIZED', 'CACHE_AFFINITY', `Prompt cache hit affinity (key ${targetRef}, hits: ${affinity.hits})`);
    }
    if (options.pushEvent && typeof options.pushEvent === 'function') {
      options.pushEvent(pool, targetRef, 'CACHE_AFFINITY_HIT', { cacheKey, hits: affinity.hits });
    }
    if (pool.state) {
      pool.state.cacheAffinityHits = (pool.state.cacheAffinityHits ?? 0) + 1;
    }
  }

  return list;
}

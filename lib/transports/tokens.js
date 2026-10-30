// lib/transports/tokens.js — canonical usage token normalization (#546).
// Converts diverse provider token usage shapes into canonical DSH token metrics.

function toNonNegativeInt(val) {
  if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
    return Math.floor(val);
  }
  if (typeof val === 'string') {
    const parsed = parseInt(val, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

/**
 * Normalizes provider token usage payloads into canonical DSH shape:
 * {
 *   inputTokens: number,
 *   outputTokens: number,
 *   cacheReadTokens: number,
 *   cacheWriteTokens: number,
 *   totalTokens: number,
 *   raw: object
 * }
 *
 * Supports OpenAI, Anthropic, Gemini, Ollama, DeepSeek, and generic formats.
 *
 * @param {object|null|undefined} usage Raw usage object from provider
 * @returns {{
 *   inputTokens: number,
 *   outputTokens: number,
 *   cacheReadTokens: number,
 *   cacheWriteTokens: number,
 *   totalTokens: number,
 *   raw: object
 * }}
 */
export function normalizeUsageTokens(usage) {
  if (!usage || typeof usage !== 'object') {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      raw: usage ?? {},
    };
  }

  // 1. Input / prompt tokens
  const input =
    toNonNegativeInt(usage.inputTokens) ??
    toNonNegativeInt(usage.input_tokens) ??
    toNonNegativeInt(usage.prompt_tokens) ??
    toNonNegativeInt(usage.promptTokenCount) ??
    toNonNegativeInt(usage.prompt_eval_count) ??
    0;

  // 2. Output / completion tokens
  const output =
    toNonNegativeInt(usage.outputTokens) ??
    toNonNegativeInt(usage.output_tokens) ??
    toNonNegativeInt(usage.completion_tokens) ??
    toNonNegativeInt(usage.candidatesTokenCount) ??
    toNonNegativeInt(usage.eval_count) ??
    0;

  // 3. Cache read tokens
  const cacheRead =
    toNonNegativeInt(usage.cacheReadTokens) ??
    toNonNegativeInt(usage.cache_read_input_tokens) ??
    toNonNegativeInt(usage.prompt_tokens_details?.cached_tokens) ??
    toNonNegativeInt(usage.cached_tokens) ??
    toNonNegativeInt(usage.prompt_cache_hit_tokens) ??
    toNonNegativeInt(usage.cachedContentTokenCount) ??
    0;

  // 4. Cache write / creation tokens
  const cacheWrite =
    toNonNegativeInt(usage.cacheWriteTokens) ??
    toNonNegativeInt(usage.cache_creation_input_tokens) ??
    toNonNegativeInt(usage.prompt_tokens_details?.cache_creation_tokens) ??
    toNonNegativeInt(usage.cache_write_tokens) ??
    toNonNegativeInt(usage.prompt_cache_miss_tokens) ??
    0;

  // 5. Total tokens
  let total =
    toNonNegativeInt(usage.totalTokens) ??
    toNonNegativeInt(usage.total_tokens) ??
    toNonNegativeInt(usage.totalTokenCount);

  if (total === null) {
    total = input + output;
  }

  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: total,
    raw: usage,
  };
}

/**
 * Extracts a single total token number for quota and TPM accounting.
 * Returns null if no valid token counts are found.
 * Compatible with model-quota.js extractUsageTokens.
 *
 * @param {object|null|undefined} usage
 * @returns {number|null}
 */
export function extractTotalTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;

  const normalized = normalizeUsageTokens(usage);
  if (normalized.totalTokens > 0) return normalized.totalTokens;
  if (normalized.inputTokens > 0 || normalized.outputTokens > 0) {
    return normalized.inputTokens + normalized.outputTokens;
  }
  return null;
}

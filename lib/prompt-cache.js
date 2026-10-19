// lib/prompt-cache.js — prompt caching token tracking, economics calculator, and summary (#497).
// Pure helpers with zero dependencies.

const DAY_MS = 86400000;

/**
 * Extracts prompt cache token counters from streaming/non-streaming usage payloads.
 * Supports DeepSeek, Anthropic, and OpenAI formats.
 * @param {object} usage
 * @returns {{ cachedTokens: number, uncachedTokens: number, totalInputTokens: number } | null}
 */
export function extractPromptCacheTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;

  let cachedTokens = 0;
  let uncachedTokens = 0;
  let detected = false;

  // 1. DeepSeek format: prompt_cache_hit_tokens, prompt_cache_miss_tokens
  if (usage.prompt_cache_hit_tokens != null) {
    cachedTokens = Math.max(0, Number(usage.prompt_cache_hit_tokens) || 0);
    uncachedTokens = Math.max(0, Number(usage.prompt_cache_miss_tokens) || 0);
    detected = true;
  }

  // 2. Anthropic format: cache_read_input_tokens, cache_creation_input_tokens
  if (usage.cache_read_input_tokens != null) {
    cachedTokens = Math.max(0, Number(usage.cache_read_input_tokens) || 0);
    const creation = Math.max(0, Number(usage.cache_creation_input_tokens) || 0);
    const rawInput = Math.max(0, Number(usage.input_tokens) || 0);
    uncachedTokens = creation > 0 ? creation : Math.max(0, rawInput - cachedTokens);
    detected = true;
  }

  // 3. OpenAI format: prompt_tokens_details.cached_tokens
  if (usage.prompt_tokens_details?.cached_tokens != null) {
    cachedTokens = Math.max(0, Number(usage.prompt_tokens_details.cached_tokens) || 0);
    const totalP = Math.max(0, Number(usage.prompt_tokens) || 0);
    uncachedTokens = Math.max(0, totalP - cachedTokens);
    detected = true;
  }

  const explicitTotal = Number(usage.prompt_tokens ?? usage.input_tokens);
  const totalInputTokens = Number.isFinite(explicitTotal) && explicitTotal > 0
    ? Math.max(cachedTokens, explicitTotal)
    : (cachedTokens + uncachedTokens);

  if (!detected && cachedTokens === 0 && totalInputTokens === 0) {
    return null;
  }

  return {
    cachedTokens,
    uncachedTokens,
    totalInputTokens,
  };
}

/**
 * Calculates financial savings in USD based on cached token count and model rates.
 * Standard input cost minus discounted cache read cost (typically 90% savings).
 */
export function calculateCacheSavings(provider = '', model = '', cachedTokens = 0) {
  if (!Number.isFinite(cachedTokens) || cachedTokens <= 0) return 0;

  const key = `${provider}/${model}`.toLowerCase();
  let savingsPerToken = 0.0000009; // Default: $0.90 per 1M tokens saved (90% off $1.00/M)

  if (key.includes('deepseek')) {
    // DeepSeek: standard $0.14/M, cache hit $0.014/M -> saves $0.126/M ($0.000000126/token)
    savingsPerToken = 0.000000126;
  } else if (key.includes('claude') || key.includes('anthropic')) {
    // Anthropic: Sonnet base $3.00/M, cache read $0.30/M -> saves $2.70/M ($0.0000027/token)
    savingsPerToken = 0.0000027;
  } else if (key.includes('gpt-4') || key.includes('openai')) {
    // OpenAI: GPT-4o base $2.50/M, cache read $1.25/M -> saves $1.25/M ($0.00000125/token)
    savingsPerToken = 0.00000125;
  }

  const saved = cachedTokens * savingsPerToken;
  return Math.round(saved * 1000000) / 1000000;
}

function formatSavings(val) {
  if (!Number.isFinite(val) || val <= 0) return 0;
  return val < 0.01 ? Math.round(val * 10000) / 10000 : Math.round(val * 100) / 100;
}

/**
 * Records prompt cache usage in pool state.
 */
export function recordPromptCache(pool, ref, model, usage, now = Date.now()) {
  if (!pool?.state) return null;
  const parsed = extractPromptCacheTokens(usage);
  if (!parsed || (parsed.cachedTokens === 0 && parsed.totalInputTokens === 0)) return null;

  const savings = calculateCacheSavings(pool.provider ?? pool.base, model, parsed.cachedTokens);

  if (!pool.state.promptCache) {
    pool.state.promptCache = {
      cachedTokens: 0,
      totalInputTokens: 0,
      savingsUsd: 0,
      days: new Map(),
      byRef: new Map(),
      byModel: new Map(),
    };
  }

  const pc = pool.state.promptCache;
  pc.cachedTokens += parsed.cachedTokens;
  pc.totalInputTokens += parsed.totalInputTokens;
  pc.savingsUsd = Math.round((pc.savingsUsd + savings) * 1000000) / 1000000;

  const todayIso = new Date(now).toISOString().slice(0, 10);
  const dayEntry = pc.days.get(todayIso) || { cachedTokens: 0, totalInputTokens: 0, savingsUsd: 0 };
  dayEntry.cachedTokens += parsed.cachedTokens;
  dayEntry.totalInputTokens += parsed.totalInputTokens;
  dayEntry.savingsUsd = Math.round((dayEntry.savingsUsd + savings) * 1000000) / 1000000;
  pc.days.set(todayIso, dayEntry);

  if (ref) {
    const refEntry = pc.byRef.get(ref) || { cachedTokens: 0, totalInputTokens: 0, savingsUsd: 0 };
    refEntry.cachedTokens += parsed.cachedTokens;
    refEntry.totalInputTokens += parsed.totalInputTokens;
    refEntry.savingsUsd = Math.round((refEntry.savingsUsd + savings) * 1000000) / 1000000;
    pc.byRef.set(ref, refEntry);
  }

  const mKey = model || 'default';
  const mEntry = pc.byModel.get(mKey) || { cachedTokens: 0, totalInputTokens: 0, savingsUsd: 0 };
  mEntry.cachedTokens += parsed.cachedTokens;
  mEntry.totalInputTokens += parsed.totalInputTokens;
  mEntry.savingsUsd = Math.round((mEntry.savingsUsd + savings) * 1000000) / 1000000;
  pc.byModel.set(mKey, mEntry);

  return parsed;
}

function sumWindow(daysMap, dayKeys) {
  let cachedTokens = 0;
  let totalInputTokens = 0;
  let savingsUsd = 0;

  for (const d of dayKeys) {
    const entry = daysMap?.get(d);
    if (entry) {
      cachedTokens += entry.cachedTokens ?? 0;
      totalInputTokens += entry.totalInputTokens ?? 0;
      savingsUsd += entry.savingsUsd ?? 0;
    }
  }

  const hitRatioPct = totalInputTokens > 0
    ? Math.round((cachedTokens / totalInputTokens) * 1000) / 10
    : 0;

  return {
    cachedTokens,
    totalInputTokens,
    hitRatioPct,
    savingsUsd: formatSavings(savingsUsd),
  };
}

/**
 * Returns structured summary of prompt cache metrics for 24h, 7d, 30d, plus models and keys.
 */
export function getPromptCacheSummary(pool, now = Date.now()) {
  const pc = pool?.state?.promptCache;
  if (!pc) {
    return {
      allTime: { cachedTokens: 0, totalInputTokens: 0, hitRatioPct: 0, savingsUsd: 0 },
      d1: { cachedTokens: 0, totalInputTokens: 0, hitRatioPct: 0, savingsUsd: 0 },
      d7: { cachedTokens: 0, totalInputTokens: 0, hitRatioPct: 0, savingsUsd: 0 },
      d30: { cachedTokens: 0, totalInputTokens: 0, hitRatioPct: 0, savingsUsd: 0 },
      byModel: {},
      byRef: {},
    };
  }

  const makeDayKeys = (count) => {
    const keys = [];
    for (let i = 0; i < count; i++) {
      keys.push(new Date(now - i * DAY_MS).toISOString().slice(0, 10));
    }
    return keys;
  };

  const d1 = sumWindow(pc.days, makeDayKeys(1));
  const d7 = sumWindow(pc.days, makeDayKeys(7));
  const d30 = sumWindow(pc.days, makeDayKeys(30));

  const allHitRatio = pc.totalInputTokens > 0
    ? Math.round((pc.cachedTokens / pc.totalInputTokens) * 1000) / 10
    : 0;

  const byModel = {};
  if (pc.byModel) {
    for (const [m, e] of pc.byModel.entries()) {
      byModel[m] = {
        cachedTokens: e.cachedTokens,
        totalInputTokens: e.totalInputTokens,
        hitRatioPct: e.totalInputTokens > 0 ? Math.round((e.cachedTokens / e.totalInputTokens) * 1000) / 10 : 0,
        savingsUsd: formatSavings(e.savingsUsd),
      };
    }
  }

  const byRef = {};
  if (pc.byRef) {
    for (const [r, e] of pc.byRef.entries()) {
      byRef[r] = {
        cachedTokens: e.cachedTokens,
        totalInputTokens: e.totalInputTokens,
        hitRatioPct: e.totalInputTokens > 0 ? Math.round((e.cachedTokens / e.totalInputTokens) * 1000) / 10 : 0,
        savingsUsd: formatSavings(e.savingsUsd),
      };
    }
  }

  return {
    allTime: {
      cachedTokens: pc.cachedTokens,
      totalInputTokens: pc.totalInputTokens,
      hitRatioPct: allHitRatio,
      savingsUsd: formatSavings(pc.savingsUsd),
    },
    d1,
    d7,
    d30,
    byModel,
    byRef,
  };
}

/**
 * Compact prompt cache history older than maxDays (default 30).
 */
export function compactPromptCache(pool, maxDays = 30, now = Date.now()) {
  const days = pool?.state?.promptCache?.days;
  if (!days) return 0;
  const cutoffIso = new Date(now - maxDays * DAY_MS).toISOString().slice(0, 10);
  let purged = 0;
  for (const d of [...days.keys()]) {
    if (d < cutoffIso) {
      days.delete(d);
      purged++;
    }
  }
  return purged;
}

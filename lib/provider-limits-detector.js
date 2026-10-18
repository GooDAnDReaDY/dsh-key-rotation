// lib/provider-limits-detector.js — accurate dynamic provider limits and presets (#503).

export const CANONICAL_PROVIDER_PRESETS = {
  deepseek: {
    rpmLimit: 60,
    tpmLimit: 100000,
    trafficSmoothingBurst: 5,
    quotaResetWindow: 'midnight_utc',
    displayName: 'DeepSeek Official',
  },
  groq: {
    rpmLimit: 30,
    tpmLimit: 30000,
    trafficSmoothingBurst: 5,
    quotaResetWindow: 'per-minute',
    displayName: 'Groq Cloud',
  },
  opencode: {
    rpmLimit: 120,
    tpmLimit: 200000,
    trafficSmoothingBurst: 10,
    quotaResetWindow: 'midnight_utc',
    displayName: 'OpenCode Zen',
  },
  anthropic: {
    rpmLimit: 50,
    tpmLimit: 100000,
    trafficSmoothingBurst: 5,
    quotaResetWindow: 'per-minute',
    displayName: 'Anthropic Claude',
  },
  openai: {
    rpmLimit: 60,
    tpmLimit: 150000,
    trafficSmoothingBurst: 10,
    quotaResetWindow: 'per-minute',
    displayName: 'OpenAI API',
  },
  siliconflow: {
    rpmLimit: 60,
    tpmLimit: 100000,
    trafficSmoothingBurst: 5,
    quotaResetWindow: 'per-minute',
    displayName: 'SiliconFlow',
  },
  mistral: {
    rpmLimit: 60,
    tpmLimit: 100000,
    trafficSmoothingBurst: 5,
    quotaResetWindow: 'per-minute',
    displayName: 'Mistral AI',
  },
  gemini: {
    rpmLimit: 60,
    tpmLimit: 1000000,
    trafficSmoothingBurst: 10,
    quotaResetWindow: 'midnight_pst',
    displayName: 'Google Gemini',
  },
  openrouter: {
    rpmLimit: 200,
    tpmLimit: 500000,
    trafficSmoothingBurst: 15,
    quotaResetWindow: 'per-minute',
    displayName: 'OpenRouter',
  },
};

/**
 * Extract rate limit and quota information from HTTP response headers.
 * @param {Headers|Record<string, string>} rawHeaders
 * @returns {object|null}
 */
export function extractProviderLimits(rawHeaders) {
  if (!rawHeaders) return null;
  const headers = {};
  if (typeof rawHeaders.forEach === 'function') {
    rawHeaders.forEach((val, key) => { headers[key.toLowerCase()] = String(val); });
  } else if (typeof rawHeaders === 'object') {
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (typeof k === 'string') headers[k.toLowerCase()] = String(v ?? '');
    }
  }

  const getNum = (...names) => {
    for (const name of names) {
      const val = headers[name];
      if (val !== undefined && val !== null && val !== '') {
        const n = Number(val);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
    return undefined;
  };

  const getSeconds = (...names) => {
    for (const name of names) {
      const val = headers[name];
      if (!val) continue;
      const str = String(val).trim();
      // Duration string format "6m0s", "1s", "250ms"
      const match = /^(\d+(?:\.\d+)?)(s|ms|m|h)?$/i.exec(str);
      if (match) {
        const num = parseFloat(match[1]);
        const unit = (match[2] || 's').toLowerCase();
        if (unit === 'ms') return Math.max(0.001, num / 1000);
        if (unit === 's') return num;
        if (unit === 'm') return num * 60;
        if (unit === 'h') return num * 3600;
      }
      // Check for ISO Date string (e.g., Anthropic reset timestamp)
      const parsedDate = Date.parse(str);
      if (Number.isFinite(parsedDate)) {
        const diffSec = (parsedDate - Date.now()) / 1000;
        return Math.max(0, diffSec);
      }
      const n = Number(str);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return undefined;
  };

  const rpmLimit = getNum('x-ratelimit-limit-requests', 'x-ratelimit-limit-rpm', 'ratelimit-limit', 'anthropic-ratelimit-requests-limit');
  const tpmLimit = getNum('x-ratelimit-limit-tokens', 'x-ratelimit-limit-tpm', 'anthropic-ratelimit-tokens-limit');
  const remainingRequests = getNum('x-ratelimit-remaining-requests', 'x-ratelimit-remaining', 'anthropic-ratelimit-requests-remaining');
  const remainingTokens = getNum('x-ratelimit-remaining-tokens', 'anthropic-ratelimit-tokens-remaining');
  const resetRequests = getSeconds('x-ratelimit-reset-requests', 'x-ratelimit-reset', 'anthropic-ratelimit-requests-reset');
  const resetTokens = getSeconds('x-ratelimit-reset-tokens', 'anthropic-ratelimit-tokens-reset');
  const retryAfter = getSeconds('retry-after');

  if (rpmLimit === undefined && tpmLimit === undefined && remainingRequests === undefined && remainingTokens === undefined && resetRequests === undefined && retryAfter === undefined) {
    return null;
  }

  const out = {};
  if (rpmLimit !== undefined) out.rpmLimit = Math.floor(rpmLimit);
  if (tpmLimit !== undefined) out.tpmLimit = Math.floor(tpmLimit);
  if (remainingRequests !== undefined) {
    out.remainingRequests = Math.floor(remainingRequests);
    out.rpmRemaining = out.remainingRequests;
  }
  if (remainingTokens !== undefined) {
    out.remainingTokens = Math.floor(remainingTokens);
    out.tpmRemaining = out.remainingTokens;
  }
  if (resetRequests !== undefined) {
    out.resetRequests = resetRequests;
    out.rpmResetMs = Math.round(resetRequests * 1000);
  }
  if (resetTokens !== undefined) {
    out.resetTokens = resetTokens;
    out.tpmResetMs = Math.round(resetTokens * 1000);
  }
  if (retryAfter !== undefined) {
    out.retryAfterMs = Math.round(retryAfter * 1000);
  }

  return out;
}

/**
 * Match a configured provider name to canonical preset.
 * @param {string} providerName
 * @returns {object|null}
 */
export function lookupPreset(providerName) {
  if (!providerName || typeof providerName !== 'string') return null;
  const p = providerName.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [key, val] of Object.entries(CANONICAL_PROVIDER_PRESETS)) {
    if (p.includes(key)) return { ...val, id: key };
  }
  return null;
}

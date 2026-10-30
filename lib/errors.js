// lib/errors.js — Canonical error classification and taxonomy for DeepSeek Harness (#547).
// Unifies error shapes across OpenAI, Anthropic, Gemini, Ollama, Groq and OpenCode into standard LlmError.

import {
  HarnessError as DshHarnessError,
  LlmError as DshLlmError,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
  ACCOUNT_QUOTA_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  INVALID_CREDENTIAL_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
} from '@deepseek-ai/dsh-llm';

export {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
  ACCOUNT_QUOTA_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  INVALID_CREDENTIAL_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
};

// Fallback HarnessError and LlmError if ever decoupled from runtime
export class HarnessError extends (DshHarnessError || Error) {
  constructor(message, code, options) {
    super(message, code, options);
    this.code = code;
    this.name = this.constructor.name;
  }
}

export class LlmError extends (DshLlmError || HarnessError) {
  constructor(message, code, options) {
    super(message, code, options);
    this.status = options?.status;
    this.providerRetryAfterMs = options?.providerRetryAfterMs;
    this.code = code;
    this.name = this.constructor.name;
  }
}

/**
 * Robust parser for structured error bodies (JSON, object, text).
 * Handles OpenAI, Anthropic, Gemini, Groq, Ollama envelopes.
 *
 * @param {unknown} body
 * @returns {{ message?: string, type?: string, code?: string, status?: number, raw?: unknown }}
 */
export function parseErrorBody(body) {
  if (!body) return {};
  if (typeof body === 'object') {
    return extractErrorFields(body);
  }
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return {};
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return extractErrorFields(parsed);
      } catch {
        // Not valid JSON, return as plain message
      }
    }
    return { message: trimmed.slice(0, 1000) };
  }
  return { message: String(body).slice(0, 1000) };
}

function extractErrorFields(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const outer = obj;
  const nested = outer.error;

  let message = outer.message;
  let type = outer.type;
  let code = outer.code;
  let status = outer.status;

  if (typeof nested === 'string') {
    message = nested;
  } else if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    if (typeof nested.message === 'string') message = nested.message;
    if (typeof nested.type === 'string') type = nested.type;
    if (nested.code !== undefined && nested.code !== null) code = String(nested.code);
    if (typeof nested.status === 'number' || typeof nested.status === 'string') {
      const s = Number(nested.status);
      if (Number.isFinite(s)) status = s;
    }
  }

  // Handle gRPC style status object: { code: 8, message: "Resource exhausted", details: [...] }
  if (outer.details && Array.isArray(outer.details) && outer.details.length > 0) {
    const firstDetail = outer.details[0];
    if (firstDetail && typeof firstDetail === 'object') {
      if (!message && typeof firstDetail.message === 'string') message = firstDetail.message;
      if (!type && typeof firstDetail.reason === 'string') type = firstDetail.reason;
    }
  }

  return {
    ...(message ? { message: String(message) } : {}),
    ...(type ? { type: String(type) } : {}),
    ...(code !== undefined && code !== null ? { code: String(code) } : {}),
    ...(typeof status === 'number' ? { status } : {}),
    raw: obj,
  };
}

/**
 * Parse Retry-After value from Headers, headers object, or string into milliseconds.
 *
 * @param {Headers | Record<string, string | string[]> | string | null | undefined} headers
 * @param {number} [now=Date.now()]
 * @returns {number | undefined}
 */
export function retryAfterMs(headers, now = Date.now()) {
  if (!headers) return undefined;
  let raw = '';
  if (typeof headers === 'string') {
    const m = headers.match(/retry-after\s*[:=]\s*(.+)/i);
    raw = m ? m[1].trim().split(/[\n\r;]/)[0].trim() : headers.trim();
  } else if (typeof headers.get === 'function') {
    raw = headers.get('retry-after') || headers.get('x-ratelimit-reset-after') || '';
  } else if (typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'retry-after' || k.toLowerCase() === 'x-ratelimit-reset-after') {
        raw = Array.isArray(v) ? v[0] : String(v || '');
        break;
      }
    }
  }

  raw = String(raw).trim();
  if (!raw) return undefined;

  // 1. Seconds format: integer or float
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400 * 7) {
    return Math.trunc(seconds * 1000);
  }

  // 2. HTTP-Date format: RFC 1123 / RFC 850
  const parsedTs = Date.parse(raw);
  if (Number.isFinite(parsedTs)) {
    const diff = parsedTs - now;
    return diff > 0 && diff < 86400 * 7 * 1000 ? Math.trunc(diff) : 0;
  }

  return undefined;
}

/**
 * Determine if text/detail indicates quota or balance exhaustion.
 *
 * @param {string} detail
 * @returns {boolean}
 */
export function isQuotaDetail(detail) {
  if (!detail) return false;
  if (isQuotaExceededError(detail)) return true;
  const d = detail.toLowerCase();
  return (
    d.includes('insufficient_quota') ||
    d.includes('insufficient balance') ||
    d.includes('insufficient credits') ||
    d.includes('out of credits') ||
    d.includes('out of budget') ||
    d.includes('quota exceeded') ||
    d.includes('usage limit exceeded') ||
    d.includes('resource_exhausted') ||
    d.includes('credit balance') ||
    d.includes('monthly limit') ||
    d.includes('weekly limit') ||
    d.includes('payment required')
  );
}

/**
 * Canonical classifier translating status, body and headers into typed LlmError (#547).
 *
 * @param {number} status HTTP status code
 * @param {unknown} body Response body (string, object, buffer)
 * @param {Headers | Record<string, unknown> | null | undefined} headers Response headers
 * @param {{ now?: number }} [options]
 * @returns {LlmError}
 */
export function classifyResponseError(status, body, headers, options = {}) {
  const now = options.now ?? Date.now();
  const parsed = parseErrorBody(body);
  const type = parsed.type ?? '';
  const message = parsed.message ?? (status ? `HTTP ${status}` : 'Unknown upstream error');
  const code = (parsed.code ?? '').toUpperCase();
  const detail = `${type} ${code} ${message}`.trim();
  const retryMs = retryAfterMs(headers, now);

  const validStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  const errorOptions = {
    ...(validStatus !== undefined ? { status: validStatus } : {}),
    ...(retryMs !== undefined ? { providerRetryAfterMs: retryMs } : {}),
    ...(parsed.raw ? { cause: parsed.raw } : {}),
  };

  // 1. Context window exceeded
  if (code === CONTEXT_WINDOW_EXCEEDED_CODE || isContextWindowExceededError(detail)) {
    return new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE, errorOptions);
  }

  // 2. Authentication & Credentials (401, 403, invalid_api_key)
  if (
    status === 401 ||
    status === 403 ||
    code === 'INVALID_API_KEY' ||
    code === 'UNAUTHENTICATED' ||
    code === 'PERMISSION_DENIED' ||
    type === 'authentication_error' ||
    type === 'permission_denied'
  ) {
    const isMalformed = /malformed|invalid|bad|incorrect/i.test(detail);
    return new LlmError(
      message,
      isMalformed ? INVALID_CREDENTIAL_CODE : 'AUTH',
      errorOptions
    );
  }

  // 3. Quota & Balance exhaustion (429 or 402 with quota phrasing)
  if (
    status === 402 ||
    code === 'QUOTA' ||
    code === 'RESOURCE_EXHAUSTED' ||
    code === 'INSUFFICIENT_QUOTA' ||
    isQuotaDetail(detail)
  ) {
    const isAccount = /account|billing|subscription|replenish/i.test(detail);
    return new LlmError(
      message,
      isAccount ? ACCOUNT_QUOTA_EXCEEDED_CODE : QUOTA_EXCEEDED_CODE,
      errorOptions
    );
  }

  // 4. Rate Limiting (429 without quota exhaustion, concurrency limits)
  if (
    status === 429 ||
    code === 'RATE_LIMIT' ||
    code === 'RATE_LIMIT_EXCEEDED' ||
    type === 'rate_limit_error' ||
    /rate[\s_-]?limit|too many requests|concurrency[\s_-]+limit|rpm|tpm/i.test(detail)
  ) {
    return new LlmError(message, 'RATE_LIMIT', errorOptions);
  }

  // 5. Unknown Model (explicit model_not_found or invalid_model)
  if (
    code === 'MODEL_NOT_FOUND' ||
    code === 'UNKNOWN_MODEL' ||
    type === 'invalid_model' ||
    /model[_\s]+not[_\s]+found|unknown[_\s]+model/i.test(detail)
  ) {
    return new LlmError(message, 'UNKNOWN_MODEL', errorOptions);
  }

  // 6. Timeouts (408, 504, DEADLINE_EXCEEDED)
  if (
    status === 408 ||
    status === 504 ||
    code === 'TIMEOUT' ||
    code === 'DEADLINE_EXCEEDED' ||
    /timeout|timed[\s_-]?out/i.test(detail)
  ) {
    return new LlmError(message, 'TIMEOUT', errorOptions);
  }

  // 7. Server Errors (500, 502, 503)
  if (
    (status >= 500 && status <= 503) ||
    code === 'SERVER' ||
    code === 'INTERNAL' ||
    code === 'UNAVAILABLE' ||
    type === 'server_error' ||
    type === 'api_error'
  ) {
    return new LlmError(message, 'SERVER', errorOptions);
  }

  // 8. Empty response
  if (code === EMPTY_RESPONSE_CODE || (!message && status === 200)) {
    return new LlmError(message || 'Upstream returned empty completion', EMPTY_RESPONSE_CODE, errorOptions);
  }

  // 9. Default client error (400, 422) or generic provider error
  if (status >= 400 && status < 500) {
    return new LlmError(message, code || String(status), errorOptions);
  }

  return new LlmError(message, code || 'PROVIDER_ERROR', errorOptions);
}


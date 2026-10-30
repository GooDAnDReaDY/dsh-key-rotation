// lib/error-taxonomy.js — complete failure classification (#267, #547).
// action: 'switch' | 'surface' | 'cooldown'

import { SOFT_FAILURE_CODES } from './pool.js';
import {
  classifyResponseError,
  parseErrorBody,
  retryAfterMs,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
  ACCOUNT_QUOTA_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  INVALID_CREDENTIAL_CODE,
} from './errors.js';

export {
  classifyResponseError,
  parseErrorBody,
  retryAfterMs,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
  ACCOUNT_QUOTA_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  INVALID_CREDENTIAL_CODE,
};

const SWITCH_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const SURFACE_STATUS = new Set([400, 404, 422]);
const AUTH_STATUS = new Set([401, 403]);

const SWITCH_CODES = new Set([
  'QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE',
  'UNKNOWN_MODEL', 'AUTH', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL',
  'DEADLINE_EXCEEDED', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'ABORTED',
]);
const SOCKET_SWITCH = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
  'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * Classify a failure for rotation.
 * @param {any} failureOrPayload
 * @returns {{ action: 'switch'|'surface'|'cooldown', code: string, soft: boolean, reason: string, retryAfterMs?: number }}
 */
export function classifyFailure(failureOrPayload) {
  if (!failureOrPayload) {
    return { action: 'surface', code: 'UNKNOWN', soft: false, reason: 'empty' };
  }
  const failure = failureOrPayload.failure ?? failureOrPayload;
  const status = Number(failure.status ?? failure.statusCode ?? failure.httpStatus ?? 0);
  const code = String(failure.code ?? failure.reason ?? failure.name ?? '').toUpperCase();
  const message = String(failure.message ?? failureOrPayload.message ?? '');
  const headers = failure.headers ?? failureOrPayload.headers ?? failure.response?.headers;
  const retryMs = retryAfterMs(headers);

  // Check structured body/error through classifyResponseError if available
  if (status || failure.body || (code && code !== 'ERROR')) {
    const typed = classifyResponseError(status, failure.body ?? message, headers);
    if (typed.code === CONTEXT_WINDOW_EXCEEDED_CODE) {
      return { action: 'surface', code: CONTEXT_WINDOW_EXCEEDED_CODE, soft: false, reason: 'context_window' };
    }
  }

  if (AUTH_STATUS.has(status) || code === 'AUTH' || code === 'UNAUTHENTICATED' || code === 'PERMISSION_DENIED' || code === INVALID_CREDENTIAL_CODE) {
    return {
      action: 'switch',
      code: status ? String(status) : (code || 'AUTH'),
      soft: false,
      reason: 'auth',
      ...(retryMs !== undefined ? { retryAfterMs: retryMs } : {}),
    };
  }
  if (status === 429 || code === 'RATE_LIMIT' || code === 'RESOURCE_EXHAUSTED' || code === 'QUOTA' || code === 'ACCOUNT_QUOTA' || code === QUOTA_EXCEEDED_CODE) {
    return {
      action: 'switch',
      code: status ? '429' : (code || 'RATE_LIMIT'),
      soft: false,
      reason: 'quota',
      ...(retryMs !== undefined ? { retryAfterMs: retryMs } : {}),
    };
  }
  const numCode = Number(code);
  if (SWITCH_STATUS.has(status) || (numCode > 0 && SWITCH_STATUS.has(numCode)) || SOFT_FAILURE_CODES.has(code)) {
    const effCode = status ? String(status) : (numCode > 0 ? String(numCode) : code);
    const soft = SOFT_FAILURE_CODES.has(effCode);
    return {
      action: 'switch',
      code: effCode,
      soft,
      reason: 'http',
      ...(retryMs !== undefined ? { retryAfterMs: retryMs } : {}),
    };
  }
  if (SURFACE_STATUS.has(status)) {
    return { action: 'surface', code: String(status), soft: false, reason: 'client' };
  }
  if (code === 'TIMEOUT' || code === 'DEADLINE_EXCEEDED' || /timeout/i.test(message)) {
    return { action: 'switch', code: 'TIMEOUT', soft: true, reason: 'timeout' };
  }
  if (SOCKET_SWITCH.has(code) || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|premature close/i.test(message)) {
    return { action: 'switch', code: 'TRANSPORT', soft: true, reason: 'socket' };
  }
  if (code === 'UNAVAILABLE' || code === 'INTERNAL' || code === 'SERVER') {
    return { action: 'switch', code: code || 'SERVER', soft: true, reason: 'grpc' };
  }
  if (code === 'TRANSPORT' || code === 'EMPTY_RESPONSE' || code === 'UNKNOWN_MODEL') {
    return { action: 'switch', code, soft: code !== 'UNKNOWN_MODEL', reason: 'named' };
  }
  if (SWITCH_CODES.has(code)) {
    return { action: 'switch', code, soft: false, reason: 'named' };
  }
  return { action: 'surface', code: code || 'UNKNOWN', soft: false, reason: 'unclassified' };
}


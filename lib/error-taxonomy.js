// lib/error-taxonomy.js — complete failure classification (#267).
// action: 'switch' | 'surface' | 'cooldown'

const SWITCH_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const SURFACE_STATUS = new Set([400, 404, 422]);
const AUTH_STATUS = new Set([401, 403]);

const SWITCH_CODES = new Set([
  'QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE',
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
 * @returns {{ action: 'switch'|'surface'|'cooldown', code: string, soft: boolean, reason: string }}
 */
export function classifyFailure(failureOrPayload) {
  if (!failureOrPayload) {
    return { action: 'surface', code: 'UNKNOWN', soft: false, reason: 'empty' };
  }
  const failure = failureOrPayload.failure ?? failureOrPayload;
  const status = Number(failure.status ?? failure.statusCode ?? failure.httpStatus ?? 0);
  const code = String(failure.code ?? failure.reason ?? failure.name ?? '').toUpperCase();
  const message = String(failure.message ?? failureOrPayload.message ?? '');

  if (AUTH_STATUS.has(status) || code === 'AUTH' || code === 'UNAUTHENTICATED' || code === 'PERMISSION_DENIED') {
    return { action: 'switch', code: status ? String(status) : (code || 'AUTH'), soft: false, reason: 'auth' };
  }
  if (status === 429 || code === 'RATE_LIMIT' || code === 'RESOURCE_EXHAUSTED' || code === 'QUOTA') {
    return { action: 'switch', code: status ? '429' : (code || 'RATE_LIMIT'), soft: false, reason: 'quota' };
  }
  if (SWITCH_STATUS.has(status)) {
    const soft = status === 500 || status === 502 || status === 503 || status === 504;
    return { action: 'switch', code: String(status), soft, reason: 'http' };
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

/** True when classification says switch to next key. */
export function shouldSwitch(failureOrPayload) {
  return classifyFailure(failureOrPayload).action === 'switch';
}

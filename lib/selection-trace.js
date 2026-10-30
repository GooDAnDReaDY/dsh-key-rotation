// lib/selection-trace.js — Request-scoped key selection explanation and attempt history (#461).
// Provides auditable reasoning for key skips, selection, failovers, and cascade with strict secret redaction.

import { keyTail } from './pool.js';

const TRACE_BUFFER_LIMIT = 100;
const traces = [];

/**
 * Redacts any sensitive tokens from string / object representation (#537).
 */
export function redactSecret(val) {
  if (typeof val !== 'string') return val;
  // Key refs (env names, vault refs) or tails (sk-...1234) are safe.
  // Full raw tokens (sk-..., key-..., etc.) are masked.
  if (/^(?:sk-|key-|Bearer\s+|ghp_)[a-zA-Z0-9_\-\.]{12,}$/i.test(val)) {
    return "..." + keyTail(val);
  }
  return val;
}

/**
 * Aggressively sanitizes arbitrary error/details strings to prevent token/secret leaks in traces (#537).
 */
export function sanitizeTraceDetails(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/(?:sk-|key-|Bearer\s+|ghp_|token[=:\s]+|api[_-]?key[=:\s]+)[a-zA-Z0-9_\-\.]{8,}/gi, '[REDACTED_SECRET]')
    .replace(/https?:\/\/[^\s/$.?#].[^\s]*[?&](?:token|key|api_key|secret|password)=[^\s&]+/gi, '[REDACTED_URL]')
    .slice(0, 300);
}

export function createSelectionTrace(requestId, options = {}) {
  const reqId = requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const startTime = Date.now();
  const events = [];

  return {
    requestId: reqId,
    provider: options.provider || '',
    model: options.model || '',
    startTime,

    /**
     * Record a candidate evaluation (selected, skipped, cooling, quota, etc.)
     * @param {string} ref - Key identifier
     * @param {string} decision - 'SELECTED' | 'SKIPPED' | 'DISPATCHED' | 'FAILED' | 'CASCADE'
     * @param {string} reasonCode - Machine code e.g. 'COOLDOWN' | 'QUOTA' | 'PINNED_PRIORITY'
     * @param {string} [details] - User-readable explanation
     */
    addStep(ref, decision, reasonCode, details = '') {
      events.push({
        at: Date.now(),
        ref: redactSecret(ref),
        decision,
        reasonCode,
        details: sanitizeTraceDetails(details),
      });
    },

    /**
     * Complete the trace and store into bounded history
     */
    finish(outcome, finalRef = null) {
      const summary = {
        requestId: reqId,
        provider: options.provider || '',
        model: options.model || '',
        startTime,
        durationMs: Date.now() - startTime,
        outcome, // 'SUCCESS' | 'EXHAUSTED' | 'TIMEOUT' | 'CASCADE' | 'ERROR'
        selectedRef: finalRef ? redactSecret(finalRef) : null,
        steps: events,
      };

      if (traces.length >= TRACE_BUFFER_LIMIT) {
        traces.shift();
      }
      traces.push(summary);
      return summary;
    }
  };
}

export function getSelectionTraces(limit = 50) {
  return traces.slice(-Math.max(1, Math.min(100, limit)));
}

export function clearSelectionTraces() {
  traces.length = 0;
}

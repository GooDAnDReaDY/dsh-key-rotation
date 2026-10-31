// lib/transports/anthropic.js — Anthropic Claude Messages wire protocol parsing (#546).
// Handles event discrimination, text/thinking deltas, and split-event usage accumulation.

import { normalizeUsageTokens } from './tokens.js';

/**
 * Parses an Anthropic event payload.
 * @param {string|object} data
 * @returns {object|null}
 */
export function parseAnthropicEvent(data) {
  if (!data) return null;
  if (typeof data === 'object') return data;
  if (typeof data !== 'string') return null;

  const trimmed = data.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Extracts content or reasoning delta from an Anthropic event.
 * @param {object} event
 * @returns {{
 *   type: string,
 *   text: string|null,
 *   thinking: string|null,
 *   partialJson: string|null,
 *   stopReason: string|null
 * }}
 */
export function extractAnthropicDelta(event) {
  if (!event || typeof event !== 'object') {
    return { type: 'unknown', text: null, thinking: null, partialJson: null, stopReason: null };
  }

  const type = event.type || 'unknown';

  if (type === 'content_block_delta') {
    const delta = event.delta || {};
    const deltaType = delta.type;
    return {
      type,
      text: deltaType === 'text_delta' && typeof delta.text === 'string' ? delta.text : null,
      thinking: deltaType === 'thinking_delta' && typeof delta.thinking === 'string' ? delta.thinking : null,
      partialJson: deltaType === 'input_json_delta' && typeof delta.partial_json === 'string' ? delta.partial_json : null,
      stopReason: null,
    };
  }

  if (type === 'message_delta') {
    return {
      type,
      text: null,
      thinking: null,
      partialJson: null,
      stopReason: event.delta?.stop_reason ?? null,
    };
  }

  return { type, text: null, thinking: null, partialJson: null, stopReason: null };
}

/**
 * Creates an accumulator for Anthropic streaming usage.
 * Anthropic provides input tokens at `message_start` and output tokens at `message_delta`.
 *
 * @returns {{
 *   accumulate: (event: object) => void,
 *   getUsage: () => object,
 *   reset: () => void
 * }}
 */
export function createAnthropicUsageAccumulator() {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let rawStart = null;
  let rawDelta = null;

  function accumulate(event) {
    if (!event || typeof event !== 'object') return;

    if (event.type === 'message_start' && event.message?.usage) {
      rawStart = event.message.usage;
      const norm = normalizeUsageTokens(rawStart);
      inputTokens = norm.inputTokens;
      cacheReadTokens = norm.cacheReadTokens;
      cacheWriteTokens = norm.cacheWriteTokens;
    } else if (event.type === 'message_delta' && event.usage) {
      rawDelta = event.usage;
      const norm = normalizeUsageTokens(rawDelta);
      outputTokens = norm.outputTokens;
    }
  }

  function getUsage() {
    const total = inputTokens + outputTokens;
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: total,
      raw: { start: rawStart, delta: rawDelta },
    };
  }

  function reset() {
    inputTokens = 0;
    outputTokens = 0;
    cacheReadTokens = 0;
    cacheWriteTokens = 0;
    rawStart = null;
    rawDelta = null;
  }

  return { accumulate, getUsage, reset };
}

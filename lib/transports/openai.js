// lib/transports/openai.js — OpenAI wire protocol parsing (#546).
// Handles JSON deltas, reasoning streams, tool calls, and usage payloads.

import { normalizeUsageTokens } from './tokens.js';

/**
 * Parses an OpenAI streaming JSON data chunk.
 * @param {string|object} data
 * @returns {object|null}
 */
export function parseOpenAiChunk(data) {
  if (!data) return null;
  if (typeof data === 'object') return data;
  if (typeof data !== 'string') return null;

  const trimmed = data.trim();
  if (!trimmed || trimmed === '[DONE]') return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Extracts content delta, reasoning delta, and tool calls from an OpenAI chunk.
 * @param {object} chunk
 * @returns {{
 *   content: string|null,
 *   reasoningContent: string|null,
 *   toolCalls: Array<object>|null,
 *   finishReason: string|null
 * }}
 */
export function extractOpenAiDelta(chunk) {
  if (!chunk || typeof chunk !== 'object') {
    return {
      content: null,
      reasoningContent: null,
      toolCalls: null,
      finishReason: null,
    };
  }

  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (!choice) {
    return {
      content: null,
      reasoningContent: null,
      toolCalls: null,
      finishReason: null,
    };
  }

  const delta = choice.delta ?? {};
  const finishReason = choice.finish_reason ?? null;

  const content = typeof delta.content === 'string' ? delta.content : null;

  // Support reasoning fields: DeepSeek reasoning_content, OpenAI thought/reasoning
  const reasoningContent =
    typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta.reasoning === 'string'
        ? delta.reasoning
        : typeof delta.thought === 'string'
          ? delta.thought
          : null;

  const toolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0
    ? delta.tool_calls
    : null;

  return {
    content,
    reasoningContent,
    toolCalls,
    finishReason,
  };
}

/**
 * Extracts and normalizes usage from an OpenAI chunk (e.g. stream_options.include_usage).
 * @param {object} chunk
 * @returns {object|null}
 */
export function extractOpenAiUsage(chunk) {
  if (!chunk || typeof chunk !== 'object') return null;
  const usage = chunk.usage;
  if (!usage || typeof usage !== 'object') return null;
  return normalizeUsageTokens(usage);
}

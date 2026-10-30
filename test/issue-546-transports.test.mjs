// test/issue-546-transports.test.mjs — Test suite for transports & token normalization layer (#546).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUsageTokens,
  extractTotalTokens,
  createSseDecoder,
  parseSseStream,
  parseOpenAiChunk,
  extractOpenAiDelta,
  extractOpenAiUsage,
  parseAnthropicEvent,
  extractAnthropicDelta,
  createAnthropicUsageAccumulator,
} from '../lib/transports/index.js';

describe('Issue #546: Transports & Token Normalization Layer', () => {
  describe('normalizeUsageTokens', () => {
    it('normalizes OpenAI token usage shape with cached tokens', () => {
      const openAiUsage = {
        prompt_tokens: 150,
        completion_tokens: 80,
        total_tokens: 230,
        prompt_tokens_details: {
          cached_tokens: 50,
        },
      };

      const norm = normalizeUsageTokens(openAiUsage);
      assert.equal(norm.inputTokens, 150);
      assert.equal(norm.outputTokens, 80);
      assert.equal(norm.totalTokens, 230);
      assert.equal(norm.cacheReadTokens, 50);
      assert.equal(norm.cacheWriteTokens, 0);
    });

    it('normalizes Anthropic token usage with prompt cache', () => {
      const anthropicUsage = {
        input_tokens: 200,
        output_tokens: 100,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 40,
      };

      const norm = normalizeUsageTokens(anthropicUsage);
      assert.equal(norm.inputTokens, 200);
      assert.equal(norm.outputTokens, 100);
      assert.equal(norm.totalTokens, 300);
      assert.equal(norm.cacheReadTokens, 60);
      assert.equal(norm.cacheWriteTokens, 40);
    });

    it('normalizes Gemini token usage shape', () => {
      const geminiUsage = {
        promptTokenCount: 120,
        candidatesTokenCount: 65,
        totalTokenCount: 185,
        cachedContentTokenCount: 30,
      };

      const norm = normalizeUsageTokens(geminiUsage);
      assert.equal(norm.inputTokens, 120);
      assert.equal(norm.outputTokens, 65);
      assert.equal(norm.totalTokens, 185);
      assert.equal(norm.cacheReadTokens, 30);
    });

    it('normalizes Ollama token usage shape', () => {
      const ollamaUsage = {
        prompt_eval_count: 90,
        eval_count: 45,
      };

      const norm = normalizeUsageTokens(ollamaUsage);
      assert.equal(norm.inputTokens, 90);
      assert.equal(norm.outputTokens, 45);
      assert.equal(norm.totalTokens, 135);
    });

    it('handles null, undefined or empty objects gracefully', () => {
      const empty = normalizeUsageTokens(null);
      assert.equal(empty.inputTokens, 0);
      assert.equal(empty.outputTokens, 0);
      assert.equal(empty.totalTokens, 0);

      const normUndefined = normalizeUsageTokens(undefined);
      assert.equal(normUndefined.totalTokens, 0);
    });

    it('extractTotalTokens returns total count or null for empty', () => {
      assert.equal(extractTotalTokens({ prompt_tokens: 10, completion_tokens: 20 }), 30);
      assert.equal(extractTotalTokens(null), null);
      assert.equal(extractTotalTokens({}), null);
    });
  });

  describe('createSseDecoder', () => {
    it('buffers partial chunks across chunk boundaries and parses events', () => {
      const events = [];
      const decoder = createSseDecoder({
        onEvent: (evt) => events.push(evt),
      });

      // Split across multiple partial chunks
      decoder.feed('event: message\nd');
      decoder.feed('ata: {"hello":"world"}\n\n');

      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'message');
      assert.equal(events[0].data, '{"hello":"world"}');
    });

    it('handles CRLF line delimiters and ignores comments', () => {
      const events = [];
      const decoder = createSseDecoder({
        onEvent: (evt) => events.push(evt),
      });

      decoder.feed(': comment line\r\nevent: ping\r\ndata: pong\r\n\r\n');

      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'ping');
      assert.equal(events[0].data, 'pong');
    });

    it('discards [DONE] end-of-stream data without emitting event', () => {
      const events = [];
      const decoder = createSseDecoder({
        onEvent: (evt) => events.push(evt),
      });

      decoder.feed('data: [DONE]\n\n');
      assert.equal(events.length, 0);
    });

    it('flushes trailing buffer on flush()', () => {
      const events = [];
      const decoder = createSseDecoder({
        onEvent: (evt) => events.push(evt),
      });

      decoder.feed('data: unclosed trailing');
      decoder.flush();

      assert.equal(events.length, 1);
      assert.equal(events[0].data, 'unclosed trailing');
    });
  });

  describe('parseSseStream', () => {
    it('yields events from async generator and supports AbortSignal', async () => {
      async function* generateChunks() {
        yield 'data: chunk1\n\n';
        yield 'data: chunk2\n\n';
      }

      const received = [];
      for await (const evt of parseSseStream(generateChunks())) {
        received.push(evt.data);
      }
      assert.deepEqual(received, ['chunk1', 'chunk2']);

      // Test abortion
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        async () => {
          for await (const _ of parseSseStream(generateChunks(), controller.signal)) {
            // should not reach
          }
        },
        { name: 'AbortError' }
      );
    });
  });

  describe('OpenAI protocol parsing', () => {
    it('parses delta and extracts reasoning and tool calls', () => {
      const chunk = {
        choices: [
          {
            delta: {
              content: 'Hello',
              reasoning_content: 'Let me think',
              tool_calls: [{ id: 'call_1', function: { name: 'get_weather' } }],
            },
            finish_reason: null,
          },
        ],
      };

      const parsed = parseOpenAiChunk(JSON.stringify(chunk));
      const delta = extractOpenAiDelta(parsed);
      assert.equal(delta.content, 'Hello');
      assert.equal(delta.reasoningContent, 'Let me think');
      assert.equal(delta.toolCalls?.length, 1);
      assert.equal(delta.finishReason, null);
    });

    it('extracts usage from OpenAI chunk when present', () => {
      const chunkWithUsage = {
        choices: [],
        usage: {
          prompt_tokens: 42,
          completion_tokens: 18,
          total_tokens: 60,
        },
      };

      const norm = extractOpenAiUsage(chunkWithUsage);
      assert.ok(norm);
      assert.equal(norm.totalTokens, 60);
    });
  });

  describe('Anthropic protocol parsing', () => {
    it('parses content block deltas and thinking', () => {
      const textEvent = {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Anthropic text' },
      };
      const d1 = extractAnthropicDelta(textEvent);
      assert.equal(d1.text, 'Anthropic text');

      const thinkingEvent = {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Deep thoughts' },
      };
      const d2 = extractAnthropicDelta(thinkingEvent);
      assert.equal(d2.thinking, 'Deep thoughts');
    });

    it('accumulates usage from message_start and message_delta into canonical usage', () => {
      const accumulator = createAnthropicUsageAccumulator();

      accumulator.accumulate({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 350,
            cache_read_input_tokens: 120,
            cache_creation_input_tokens: 50,
          },
        },
      });

      accumulator.accumulate({
        type: 'message_delta',
        usage: {
          output_tokens: 180,
        },
      });

      const usage = accumulator.getUsage();
      assert.equal(usage.inputTokens, 350);
      assert.equal(usage.outputTokens, 180);
      assert.equal(usage.cacheReadTokens, 120);
      assert.equal(usage.cacheWriteTokens, 50);
      assert.equal(usage.totalTokens, 530);
    });
  });
});

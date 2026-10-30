// test/issue-550-model-catalog.test.mjs — Test suite for ModelCatalog & Cache Stampede deduplication (#550).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelCatalog,
  normalizeModelMeta,
  KNOWN_MODELS_FALLBACK,
} from '../lib/model-catalog.js';

describe('Issue #550: Central ModelCatalog & Anti-Stampede Deduplication', () => {
  it('normalizes string model names with known fallbacks', () => {
    const ds = normalizeModelMeta('deepseek-reasoner');
    assert.equal(ds.id, 'deepseek-reasoner');
    assert.equal(ds.supportsReasoning, true);
    assert.equal(ds.contextWindow, 64000);

    const unknown = normalizeModelMeta('my-custom-vision-model');
    assert.equal(unknown.id, 'my-custom-vision-model');
    assert.equal(unknown.supportsVision, true);
  });

  it('normalizes raw API models payload object', () => {
    const raw = {
      id: 'custom-llm',
      display_name: 'Custom LLM',
      max_context_window: 131072,
      max_output_tokens: 4096,
      capabilities: ['tools', 'thinking'],
      input_modalities: ['text', 'image'],
    };

    const norm = normalizeModelMeta(raw);
    assert.equal(norm.id, 'custom-llm');
    assert.equal(norm.name, 'Custom LLM');
    assert.equal(norm.contextWindow, 131072);
    assert.equal(norm.maxTokens, 4096);
    assert.equal(norm.supportsReasoning, true);
    assert.equal(norm.supportsTools, true);
    assert.equal(norm.supportsVision, true);
  });

  it('deduplicates concurrent in-flight requests (Cache Stampede protection)', async () => {
    let fetchCalls = 0;
    const mockFetch = async () => {
      fetchCalls++;
      // Simulate network latency
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'model-a', name: 'Model A' },
            { id: 'model-b', name: 'Model B' },
          ],
        }),
      };
    };

    const catalog = new ModelCatalog({
      ttlMs: 5000,
      fetchImpl: mockFetch,
    });

    // 10 concurrent requests triggered at the exact same moment
    const promises = Array.from({ length: 10 }, () =>
      catalog.getModels({ endpoint: 'https://api.example.com/v1', apiKey: 'test-key-123' })
    );

    const results = await Promise.all(promises);

    // EXACTLY 1 network fetch should have occurred!
    assert.equal(fetchCalls, 1, 'In-flight promise deduplication failed: expected 1 fetch call');

    // All callers receive the exact same model array
    assert.equal(results.length, 10);
    for (const res of results) {
      assert.equal(res.length, 2);
      assert.equal(res[0].id, 'model-a');
      assert.equal(res[1].id, 'model-b');
    }
  });

  it('serves cached results within TTL without network requests', async () => {
    let fetchCalls = 0;
    const mockFetch = async () => {
      fetchCalls++;
      return {
        ok: true,
        json: async () => ({
          data: [{ id: 'model-cached', name: 'Cached Model' }],
        }),
      };
    };

    const catalog = new ModelCatalog({
      ttlMs: 60000,
      fetchImpl: mockFetch,
    });

    const res1 = await catalog.getModels({ endpoint: 'https://api.example.com/v1' });
    assert.equal(res1.length, 1);
    assert.equal(fetchCalls, 1);

    // Second call within TTL
    const res2 = await catalog.getModels({ endpoint: 'https://api.example.com/v1' });
    assert.equal(res2.length, 1);
    assert.equal(fetchCalls, 1, 'Cache failed: should not have called fetch again');
  });

  it('falls back to known models on network failure', async () => {
    const failingFetch = async () => {
      throw new Error('Network timeout');
    };

    const catalog = new ModelCatalog({
      ttlMs: 1000,
      fetchImpl: failingFetch,
    });

    const models = await catalog.getModels({ endpoint: 'https://broken.invalid' });
    assert.ok(models.length > 0);
    assert.ok(models.some((m) => m.id === 'deepseek-chat'));
  });

  it('retrieves single model and invalidates cache properly', async () => {
    const catalog = new ModelCatalog({
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          data: [{ id: 'target-model', name: 'Target Model', context_window: 32000 }],
        }),
      }),
    });

    const model = await catalog.getModel('target-model', { endpoint: 'https://api.test' });
    assert.equal(model.id, 'target-model');
    assert.equal(model.contextWindow, 32000);

    const statusBefore = catalog.getStatus('https://api.test');
    assert.equal(statusBefore.cached, true);

    catalog.invalidate('https://api.test');
    const statusAfter = catalog.getStatus('https://api.test');
    assert.equal(statusAfter.cached, false);
  });
});

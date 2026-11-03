import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  fnv1a,
  extractPromptPrefixKey,
  CacheAffinityRouter,
  getOrCreateCacheAffinityRouter,
  applyCacheAffinity,
} from '../lib/cache-affinity.js';
import { buildPools } from '../lib/pool-builder.js';
import { createRotate } from '../lib/rotate.js';
import { createResolver } from '../lib/resolver.js';

test('fnv1a: computes deterministic hex hash', () => {
  const h1 = fnv1a('You are a helpful programming assistant.');
  const h2 = fnv1a('You are a helpful programming assistant.');
  const h3 = fnv1a('Different system prompt content.');

  assert.equal(typeof h1, 'string');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(fnv1a(null), '0');
});

test('extractPromptPrefixKey: extracts and hashes prefix across formats', () => {
  // 1. Explicit system prompt
  const key1 = extractPromptPrefixKey({
    model: 'deepseek-chat',
    system: 'You are an expert system that translates and verifies code.',
  });
  assert.match(key1, /^deepseek-chat:[0-9a-f]+$/);

  // 2. Messages array with system and user turns
  const key2 = extractPromptPrefixKey({
    model: 'claude-3-5-sonnet',
    messages: [
      { role: 'system', content: 'Base system prompt with detailed rules for coding.' },
      { role: 'user', content: 'First message asking for something complex.' },
    ],
  });
  assert.match(key2, /^claude-3-5-sonnet:[0-9a-f]+$/);

  // 3. Multipart message content
  const key3 = extractPromptPrefixKey({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'You are an assistant specialized in database query optimizations.' },
        ],
      },
    ],
  });
  assert.match(key3, /^[0-9a-f]+$/);

  // 4. Raw prompt string
  const key4 = extractPromptPrefixKey({
    prompt: 'A long prompt string with plenty of characters exceeding the minimum threshold required.',
  });
  assert.ok(key4);

  // 5. Short string under minimum characters returns null
  assert.equal(extractPromptPrefixKey({ prompt: 'Short hi' }), null);
  assert.equal(extractPromptPrefixKey(null), null);
});

test('CacheAffinityRouter: records and resolves warmed keys with hit counter', () => {
  const router = new CacheAffinityRouter({ ttlMs: 10000 });
  const now = 1000;

  router.recordAffinity('prompt-hash-1', 'KEY_WARM', { now, model: 'deepseek-chat' });

  // Resolve within candidate list
  const res1 = router.resolveAffinity('prompt-hash-1', ['KEY_OTHER', 'KEY_WARM'], now + 2000);
  assert.ok(res1);
  assert.equal(res1.ref, 'KEY_WARM');
  assert.equal(res1.hits, 1);
  assert.equal(res1.ttlRemainingMs, 8000);

  // Second hit increments counter
  const res2 = router.resolveAffinity('prompt-hash-1', ['KEY_WARM'], now + 3000);
  assert.equal(res2.hits, 2);

  // If candidateRefs doesn't include the warmed key, returns null
  const resMissing = router.resolveAffinity('prompt-hash-1', ['KEY_OTHER'], now + 4000);
  assert.equal(resMissing, null);

  // After TTL expiration, returns null and cleans up
  const resExpired = router.resolveAffinity('prompt-hash-1', ['KEY_WARM'], now + 11000);
  assert.equal(resExpired, null);
  assert.equal(router.size, 0);
});

test('CacheAffinityRouter: evicts oldest entry when reaching maxEntries', () => {
  const router = new CacheAffinityRouter({ maxEntries: 2 });
  router.recordAffinity('hash-1', 'KEY_1');
  router.recordAffinity('hash-2', 'KEY_2');
  assert.equal(router.size, 2);

  // Third entry triggers eviction of hash-1
  router.recordAffinity('hash-3', 'KEY_3');
  assert.equal(router.size, 2);
  assert.equal(router.resolveAffinity('hash-1', ['KEY_1']), null);
  assert.ok(router.resolveAffinity('hash-2', ['KEY_2']));
  assert.ok(router.resolveAffinity('hash-3', ['KEY_3']));
});

test('applyCacheAffinity: prioritizes warmed candidate to head of list', () => {
  const pool = {
    cacheAffinityEnabled: true,
    cacheAffinityTtlMs: 300000,
    state: {},
  };

  const router = getOrCreateCacheAffinityRouter(pool);
  router.recordAffinity('hash-target', 'KEY_HOT', { now: 1000 });

  const steps = [];
  const events = [];
  const trace = { addStep: (...args) => steps.push(args) };
  const pushEvent = (...args) => events.push(args);

  const initialList = ['KEY_A', 'KEY_B', 'KEY_HOT', 'KEY_C'];
  const reordered = applyCacheAffinity(initialList, pool, {
    cacheKey: 'hash-target',
    now: 2000,
    trace,
    pushEvent,
  });

  // KEY_HOT must be moved to index 0
  assert.equal(reordered[0], 'KEY_HOT');
  assert.deepEqual(reordered, ['KEY_HOT', 'KEY_A', 'KEY_B', 'KEY_C']);
  assert.equal(pool.state.cacheAffinityHits, 1);
  assert.equal(steps.length, 1);
  assert.equal(events.length, 1);
});

test('applyCacheAffinity: preserves pinnedRef priority when present', () => {
  const pool = {
    pinnedRef: 'KEY_PINNED',
    cacheAffinityEnabled: true,
    state: {},
  };

  const router = getOrCreateCacheAffinityRouter(pool);
  router.recordAffinity('hash-pinned-test', 'KEY_WARM', { now: 1000 });

  const reordered = applyCacheAffinity(['KEY_PINNED', 'KEY_WARM'], pool, {
    cacheKey: 'hash-pinned-test',
    now: 2000,
  });

  // Pinned key remains first
  assert.deepEqual(reordered, ['KEY_PINNED', 'KEY_WARM']);
});

test('applyCacheAffinity: disabled when cacheAffinityEnabled is false', () => {
  const pool = {
    cacheAffinityEnabled: false,
    state: {},
  };

  const router = getOrCreateCacheAffinityRouter(pool);
  router.recordAffinity('hash-test', 'KEY_HOT');

  const reordered = applyCacheAffinity(['KEY_1', 'KEY_HOT'], pool, {
    cacheKey: 'hash-test',
  });

  assert.deepEqual(reordered, ['KEY_1', 'KEY_HOT']);
});

test('resolver e2e: picks hot prompt cache key directly', async () => {
  const poolState = new Map();
  const cfg = {
    providers: [
      {
        provider: 'test-prov-aff-res',
        keys: ['KEY_COLD_1', 'KEY_WARMED_HOT', 'KEY_COLD_2'],
        cacheAffinityEnabled: true,
      },
    ],
  };

  const built = buildPools({ cfg, poolState });
  const pool = built.providerToPool.get('test-prov-aff-res');

  const longSystem = 'You are a system prompt that is definitely longer than thirty-two characters.';
  const cacheKey = extractPromptPrefixKey({ system: longSystem });
  assert.ok(cacheKey);

  // Warm affinity on KEY_WARMED_HOT
  const router = getOrCreateCacheAffinityRouter(pool);
  router.recordAffinity(cacheKey, 'KEY_WARMED_HOT', { now: Date.now() });

  const resolve = createResolver({
    buildRuntime: () => ({ ...built, routingStrategy: 'round-robin' }),
    currentPool: () => pool,
    now: () => Date.now(),
  });

  const res = await resolve('KEY_COLD_1', async (ref) => ({ value: 'secret-' + ref }), { system: longSystem });
  assert.equal(res.value, 'secret-KEY_WARMED_HOT', 'Resolver must select key with hot prompt cache');
});

test('rotate e2e: streaming rotate prioritizes hot prompt cache key and refreshes affinity', async () => {
  const poolState = new Map();
  const cfg = {
    providers: [
      {
        provider: 'test-prov-aff-stream',
        keys: ['KEY_INITIAL', 'KEY_CACHED'],
        cacheAffinityEnabled: true,
      },
    ],
  };

  const { providerToPool, poolByRef } = buildPools({ cfg, poolState });
  const pool = providerToPool.get('test-prov-aff-stream');

  const longPrompt = 'This is an extensive user query text that exceeds the thirty-two character requirement easily.';
  const cacheKey = extractPromptPrefixKey({ prompt: longPrompt });
  assert.ok(cacheKey);

  // Warm cache on KEY_CACHED
  const router = getOrCreateCacheAffinityRouter(pool);
  router.recordAffinity(cacheKey, 'KEY_CACHED', { now: Date.now() });

  const attempts = [];
  const mockCtx = {
    get(name) {
      if (name === 'llm') {
        return {
          stream: async function* (opts) {
            attempts.push(opts._rotationKeyRef);
            yield { type: 'text-delta', text: 'Answer from hot cache key' };
            yield {
              type: 'finish',
              usage: {
                prompt_tokens: 500,
                prompt_cache_hit_tokens: 450,
                completion_tokens: 20,
              },
            };
          },
        };
      }
      return null;
    },
  };

  const rotate = createRotate({
    ctx: mockCtx,
    dispatchStorage: new AsyncLocalStorage(),
    buildRuntime: () => ({
      providerToPool,
      poolByRef,
      switchCodes: ['TIMEOUT'],
    }),
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    recordLatency: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    pushEvent: () => {},
    setRotateStartMs: () => {},
    circuitBreaker: null,
    MARKER: '__test_aff_stream_1',
  });

  const chunks = [];
  for await (const chunk of rotate({ provider: 'test-prov-aff-stream', prompt: longPrompt }, pool)) {
    chunks.push(chunk);
  }

  // KEY_CACHED was chosen first due to hot prompt cache!
  assert.deepEqual(attempts, ['KEY_CACHED']);
  assert.equal(chunks[0].text, 'Answer from hot cache key');
  assert.equal(pool.state.cacheAffinityHits, 1);
});

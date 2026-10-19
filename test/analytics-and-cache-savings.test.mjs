import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPromptCacheTokens,
  calculateCacheSavings,
  recordPromptCache,
  getPromptCacheSummary,
  compactPromptCache,
} from '../lib/prompt-cache.js';

import {
  classifyErrorCategory,
  recordRequestOutcome,
  recordFailureCategory,
  compute24hAnalytics,
} from '../lib/ops-analytics.js';

import { registerStatusRoutes } from '../lib/ops-status.js';
import { registerTelemetryRoutes } from '../lib/ops-telemetry.js';
import { STATUS_PATH, USAGE_PATH } from '../lib/ops-paths.js';
import { createRotate } from '../lib/rotate.js';

test('prompt-cache: extractPromptCacheTokens handles DeepSeek, Anthropic, and OpenAI formats', () => {
  // 1. DeepSeek
  const dsUsage = {
    prompt_cache_hit_tokens: 1500,
    prompt_cache_miss_tokens: 500,
    prompt_tokens: 2000,
    completion_tokens: 300,
  };
  const dsRes = extractPromptCacheTokens(dsUsage);
  assert.equal(dsRes.cachedTokens, 1500);
  assert.equal(dsRes.uncachedTokens, 500);
  assert.equal(dsRes.totalInputTokens, 2000);

  // 2. Anthropic
  const anthUsage = {
    input_tokens: 3200,
    cache_read_input_tokens: 2800,
    cache_creation_input_tokens: 400,
    output_tokens: 150,
  };
  const anthRes = extractPromptCacheTokens(anthUsage);
  assert.equal(anthRes.cachedTokens, 2800);
  assert.equal(anthRes.uncachedTokens, 400);
  assert.equal(anthRes.totalInputTokens, 3200);

  // 3. OpenAI
  const oaiUsage = {
    prompt_tokens: 4000,
    completion_tokens: 200,
    prompt_tokens_details: {
      cached_tokens: 2500,
    },
  };
  const oaiRes = extractPromptCacheTokens(oaiUsage);
  assert.equal(oaiRes.cachedTokens, 2500);
  assert.equal(oaiRes.uncachedTokens, 1500);
  assert.equal(oaiRes.totalInputTokens, 4000);

  // 4. Null or empty usage
  assert.equal(extractPromptCacheTokens(null), null);
  assert.equal(extractPromptCacheTokens({}), null);
  assert.equal(extractPromptCacheTokens({ prompt_tokens: 0 }), null);
});

test('prompt-cache: calculateCacheSavings applies provider-specific economic discounts', () => {
  // DeepSeek: $0.126 / 1M tokens saved
  const dsSavings = calculateCacheSavings('deepseek', 'deepseek-chat', 1_000_000);
  assert.equal(dsSavings, 0.126);

  // Anthropic: $2.70 / 1M tokens saved
  const claudeSavings = calculateCacheSavings('anthropic', 'claude-3-5-sonnet', 1_000_000);
  assert.equal(claudeSavings, 2.7);

  // OpenAI: $1.25 / 1M tokens saved
  const oaiSavings = calculateCacheSavings('openai', 'gpt-4o', 1_000_000);
  assert.equal(oaiSavings, 1.25);

  // Zero tokens
  assert.equal(calculateCacheSavings('deepseek', 'deepseek-chat', 0), 0);
  assert.equal(calculateCacheSavings('deepseek', 'deepseek-chat', -100), 0);
});

test('prompt-cache: recordPromptCache and getPromptCacheSummary aggregate across windows', () => {
  const pool = {
    base: 'deepseek',
    provider: 'deepseek',
    state: {},
  };

  const now = 1791150000000;
  recordPromptCache(pool, 'KEY_1', 'deepseek-chat', {
    prompt_cache_hit_tokens: 8000,
    prompt_cache_miss_tokens: 2000,
  }, now);

  recordPromptCache(pool, 'KEY_2', 'deepseek-coder', {
    prompt_cache_hit_tokens: 2000,
    prompt_cache_miss_tokens: 0,
    prompt_tokens: 2000,
  }, now);

  const summary = getPromptCacheSummary(pool, now);
  assert.equal(summary.allTime.cachedTokens, 10000);
  assert.equal(summary.allTime.totalInputTokens, 12000);
  assert.equal(summary.allTime.hitRatioPct, 83.3); // 10000 / 12000 * 100
  assert.ok(summary.allTime.savingsUsd > 0);

  // Check 24h window
  assert.equal(summary.d1.cachedTokens, 10000);
  assert.equal(summary.d1.totalInputTokens, 12000);

  // Check per-key and per-model breakdown
  assert.equal(summary.byRef['KEY_1'].cachedTokens, 8000);
  assert.equal(summary.byRef['KEY_2'].cachedTokens, 2000);
  assert.equal(summary.byModel['deepseek-chat'].cachedTokens, 8000);
  assert.equal(summary.byModel['deepseek-coder'].cachedTokens, 2000);

  // Compaction test
  const purged = compactPromptCache(pool, 30, now + 40 * 86400000);
  assert.equal(purged, 1);
});

test('ops-analytics: classifyErrorCategory detects failure types accurately', () => {
  assert.equal(classifyErrorCategory(429), 'rateLimit');
  assert.equal(classifyErrorCategory('RATE_LIMIT'), 'rateLimit');
  assert.equal(classifyErrorCategory('UNKNOWN', 'Rate limit exceeded, please retry later'), 'rateLimit');

  assert.equal(classifyErrorCategory(500), 'server');
  assert.equal(classifyErrorCategory('502'), 'server');
  assert.equal(classifyErrorCategory('SERVER'), 'server');
  assert.equal(classifyErrorCategory('BAD_GATEWAY'), 'server');

  assert.equal(classifyErrorCategory('TIMEOUT'), 'timeout');
  assert.equal(classifyErrorCategory('ETIMEDOUT'), 'timeout');
  assert.equal(classifyErrorCategory(null, 'gateway timeout after 30s'), 'timeout');

  assert.equal(classifyErrorCategory('QUOTA'), 'quota');
  assert.equal(classifyErrorCategory(402), 'quota');
  assert.equal(classifyErrorCategory(null, 'insufficient_quota: balance is zero'), 'quota');

  assert.equal(classifyErrorCategory('AUTH'), 'auth');
  assert.equal(classifyErrorCategory(401), 'auth');
  assert.equal(classifyErrorCategory(403), 'auth');
  assert.equal(classifyErrorCategory(null, 'invalid_api_key provided'), 'auth');

  assert.equal(classifyErrorCategory('UNKNOWN', 'something strange happened'), 'other');
});

test('ops-analytics: compute24hAnalytics calculates healthIndex, loadDistribution, and error breakdowns', () => {
  const pool = {
    base: 'openai',
    refs: ['KEY_A', 'KEY_B'],
    state: {
      events: [
        { at: 1791150000000 - 3600000, type: 'fail', cooldownMs: 15000 },
        { at: 1791150000000 - 1800000, type: 'fail', cooldownMs: 25000 },
      ],
    },
  };

  const now = 1791150000000;

  // 1. Clean success on KEY_A
  recordRequestOutcome(pool, { ref: 'KEY_A', success: true, attempts: 1, failovers: 0 }, now - 60000);
  // 2. Clean success on KEY_A
  recordRequestOutcome(pool, { ref: 'KEY_A', success: true, attempts: 1, failovers: 0 }, now - 50000);
  // 3. Clean success on KEY_B
  recordRequestOutcome(pool, { ref: 'KEY_B', success: true, attempts: 1, failovers: 0 }, now - 40000);
  // 4. Failover request (attempt 2, success)
  recordFailureCategory(pool, '429', 'Too many requests', 'KEY_A', now - 30000);
  recordRequestOutcome(pool, { ref: 'KEY_B', success: true, attempts: 2, failovers: 1 }, now - 30000);
  // 5. Total failure
  recordFailureCategory(pool, '500', 'Internal Server Error', 'KEY_B', now - 20000);
  recordRequestOutcome(pool, { ref: 'KEY_B', success: false, attempts: 2, failovers: 2 }, now - 20000);

  const a = compute24hAnalytics(pool, now);

  assert.equal(a.totalRequests, 5);
  assert.equal(a.firstAttemptSuccesses, 3);
  assert.equal(a.healthIndexPct, 60); // 3 / 5 * 100 = 60%

  // Error breakdown
  assert.equal(a.errorBreakdown.rateLimit, 1);
  assert.equal(a.errorBreakdown.server, 1);
  assert.equal(a.errorBreakdown.total, 2);

  // Load distribution
  const keyA = a.loadDistribution.find(x => x.ref === 'KEY_A');
  const keyB = a.loadDistribution.find(x => x.ref === 'KEY_B');
  assert.equal(keyA.count, 2);
  assert.equal(keyB.count, 3);
  assert.equal(keyA.pct, 40);
  assert.equal(keyB.pct, 60);

  // Average recovery from pool.state.events: (15000 + 25000) / 2 = 20000ms
  assert.equal(a.avgCooldownRecoveryMs, 20000);
});

test('routes: /status and /usage endpoints expose promptCache and analytics24h', async () => {
  const routes = new Map();
  const mockCtx = {
    effect(fn) { fn(); },
    webServer: {
      register(opts) { routes.set(opts.path, opts.handler); },
    },
    get() { return null; },
  };

  const pool = {
    base: 'anthropic',
    provider: 'anthropic',
    refs: ['KEY_SONNET'],
    weights: [1],
    state: {},
  };

  recordPromptCache(pool, 'KEY_SONNET', 'claude-3-5-sonnet', {
    input_tokens: 5000,
    cache_read_input_tokens: 4500,
  });
  recordRequestOutcome(pool, { ref: 'KEY_SONNET', success: true, attempts: 1, failovers: 0 });

  const runtime = {
    pools: [pool],
    poolByRef: new Map([['KEY_SONNET', pool]]),
    providerTags: new Map(),
    providerBudgets: new Map(),
  };

  registerStatusRoutes(mockCtx, {
    buildRuntime: () => runtime,
    latencyHistogram: null,
    circuitBreaker: null,
    notifyQueue: null,
    quotaStore: null,
  });

  registerTelemetryRoutes(mockCtx, {
    buildRuntime: () => runtime,
  });

  // Verify /status handler
  const statusHandler = routes.get(STATUS_PATH);
  assert.ok(statusHandler);

  let statusBody = null;
  const mockRes = {
    writeHead() {},
    end(str) { statusBody = JSON.parse(str); },
  };
  const mockReq = {
    method: 'GET',
    url: STATUS_PATH,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3000' },
  };

  await statusHandler(mockReq, mockRes);
  assert.ok(statusBody.providers[0].promptCache);
  assert.equal(statusBody.providers[0].promptCache.allTime.cachedTokens, 4500);
  assert.ok(statusBody.providers[0].analytics24h);
  assert.equal(statusBody.providers[0].analytics24h.totalRequests, 1);
  assert.equal(statusBody.providers[0].analytics24h.healthIndexPct, 100);

  // Verify /usage handler
  const usageHandler = routes.get(USAGE_PATH);
  assert.ok(usageHandler);

  let usageBody = null;
  const mockUsageRes = {
    writeHead() {},
    end(str) { usageBody = JSON.parse(str); },
  };

  await usageHandler(mockReq, mockUsageRes);
  assert.ok(usageBody.providers[0].promptCache);
  assert.equal(usageBody.providers[0].promptCache.allTime.cachedTokens, 4500);
  assert.ok(usageBody.providers[0].analytics24h);
  assert.equal(usageBody.providers[0].analytics24h.totalRequests, 1);
});

test('rotate: records promptCache and 24h request outcome on streaming finish', async () => {
  const pool = {
    base: 'deepseek',
    refs: ['KEY_TEST'],
    weights: [1],
    state: {},
  };

  const runtime = {
    pools: [pool],
    poolByRef: new Map([['KEY_TEST', pool]]),
    switchCodes: ['QUOTA'],
  };

  const dispatchStorage = {
    run(store, fn) {
      store.pickedRef = 'KEY_TEST';
      return fn();
    },
  };

  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: 'hello' };
        yield {
          type: 'finish',
          reason: { kind: 'stop' },
          usage: {
            prompt_cache_hit_tokens: 3000,
            prompt_cache_miss_tokens: 1000,
            prompt_tokens: 4000,
          },
        };
      })();
    },
  };

  const rotate = createRotate({
    ctx: { get: (name) => (name === 'llm' ? llm : undefined) },
    dispatchStorage,
    buildRuntime: () => runtime,
    pushEvent: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    recordLatency: () => {},
    concurrencyTracker: { isEnabled: () => false, acquire() {}, release() {}, pickLeastLoaded: (l) => l[0] },
    MARKER: '__rot',
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    circuitBreaker: null,
    now: () => Date.now(),
    setRotateStartMs: () => {},
    quotaStore: { set() {} },
  });

  const iterator = rotate({
    provider: 'deepseek',
    model: 'deepseek-chat',
  }, pool);

  for await (const chunk of iterator) {
    // consume
  }

  assert.ok(pool.state.promptCache);
  assert.equal(pool.state.promptCache.cachedTokens, 3000);
  assert.equal(pool.state.promptCache.totalInputTokens, 4000);

  assert.ok(pool.state.analytics24h);
  assert.equal(pool.state.analytics24h.requests.length, 1);
  assert.equal(pool.state.analytics24h.requests[0].success, true);
  assert.equal(pool.state.analytics24h.requests[0].attempts, 1);
});

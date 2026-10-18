import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { TrafficSmoother } from '../lib/traffic-smoother.js';
import {
  extractProviderLimits,
  lookupPreset,
  CANONICAL_PROVIDER_PRESETS,
} from '../lib/provider-limits-detector.js';
import { registerKeyRoutes } from '../lib/ops-keys.js';
import { PRESET_LIMITS_PATH } from '../lib/ops-paths.js';
import { createRotate } from '../lib/rotate.js';

test('TrafficSmoother: instant acquisition within burst limit', async () => {
  const smoother = new TrafficSmoother({ maxQueueWaitMs: 800 });
  const start = Date.now();
  const res1 = await smoother.acquire('key-1', { rpmLimit: 60, burstLimit: 3, maxQueueWaitMs: 800 });
  const res2 = await smoother.acquire('key-1', { rpmLimit: 60, burstLimit: 3, maxQueueWaitMs: 800 });
  const res3 = await smoother.acquire('key-1', { rpmLimit: 60, burstLimit: 3, maxQueueWaitMs: 800 });

  assert.equal(res1.delayed, false);
  assert.equal(res1.overflow, false);
  assert.equal(res2.delayed, false);
  assert.equal(res2.overflow, false);
  assert.equal(res3.delayed, false);
  assert.equal(res3.overflow, false);
  assert.ok(Date.now() - start < 100);
});

test('TrafficSmoother: delays request when burst is exhausted', async () => {
  const smoother = new TrafficSmoother({ maxQueueWaitMs: 800 });
  // rpmLimit: 600 -> 10 rps -> 100ms per request. Burst: 1.
  const res1 = await smoother.acquire('key-burst', { rpmLimit: 600, burstLimit: 1, maxQueueWaitMs: 800 });
  assert.equal(res1.delayed, false);

  const t0 = Date.now();
  const res2 = await smoother.acquire('key-burst', { rpmLimit: 600, burstLimit: 1, maxQueueWaitMs: 800 });
  const elapsed = Date.now() - t0;

  assert.equal(res2.delayed, true);
  assert.equal(res2.overflow, false);
  assert.ok(res2.delayMs >= 50, `delayMs was ${res2.delayMs}`);
  assert.ok(elapsed >= 40, `elapsed was ${elapsed}`);
});

test('TrafficSmoother: flags overflow when delay exceeds maxQueueWaitMs', async () => {
  const smoother = new TrafficSmoother({ maxQueueWaitMs: 200 });
  // rpmLimit: 60 -> 1 rps -> 1000ms interval.
  const res1 = await smoother.acquire('key-overflow', { rpmLimit: 60, burstLimit: 1, maxQueueWaitMs: 200 });
  assert.equal(res1.delayed, false);

  const res2 = await smoother.acquire('key-overflow', { rpmLimit: 60, burstLimit: 1, maxQueueWaitMs: 200 });
  assert.equal(res2.overflow, true);
  assert.ok(res2.delayMs >= 900);
});

test('TrafficSmoother: aborts cleanly on signal', async () => {
  const smoother = new TrafficSmoother({ maxQueueWaitMs: 1000 });
  const ac = new AbortController();
  // Fill burst
  await smoother.acquire('key-abort', { rpmLimit: 60, burstLimit: 1, maxQueueWaitMs: 1000 });

  const p = smoother.acquire('key-abort', { rpmLimit: 60, burstLimit: 1, maxQueueWaitMs: 1000, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);

  await assert.rejects(p, (err) => {
    return err.name === 'AbortError' || err.message.includes('aborted');
  });
});

test('TrafficSmoother: returns no delay if rpmLimit <= 0', async () => {
  const smoother = new TrafficSmoother();
  const res = await smoother.acquire('key-nolimit', { rpmLimit: 0, burstLimit: 5 });
  assert.equal(res.delayed, false);
  assert.equal(res.overflow, false);
});

test('extractProviderLimits: parses OpenAI/Groq rate limit headers', () => {
  const headers = {
    'x-ratelimit-limit-requests': '1000',
    'x-ratelimit-remaining-requests': '995',
    'x-ratelimit-reset-requests': '250ms',
    'x-ratelimit-limit-tokens': '50000',
    'x-ratelimit-remaining-tokens': '48200',
    'x-ratelimit-reset-tokens': '1.2s',
  };
  const limits = extractProviderLimits(headers);
  assert.ok(limits);
  assert.equal(limits.rpmLimit, 1000);
  assert.equal(limits.rpmRemaining, 995);
  assert.equal(limits.rpmResetMs, 250);
  assert.equal(limits.tpmLimit, 50000);
  assert.equal(limits.tpmRemaining, 48200);
  assert.equal(limits.tpmResetMs, 1200);
});

test('extractProviderLimits: parses Anthropic rate limit headers', () => {
  const headers = {
    'anthropic-ratelimit-requests-limit': '50',
    'anthropic-ratelimit-requests-remaining': '48',
    'anthropic-ratelimit-requests-reset': '2026-10-18T20:00:00Z',
    'anthropic-ratelimit-tokens-limit': '100000',
    'anthropic-ratelimit-tokens-remaining': '95000',
  };
  const limits = extractProviderLimits(headers);
  assert.ok(limits);
  assert.equal(limits.rpmLimit, 50);
  assert.equal(limits.rpmRemaining, 48);
  assert.equal(limits.tpmLimit, 100000);
  assert.equal(limits.tpmRemaining, 95000);
});

test('extractProviderLimits: handles retry-after and duration strings', () => {
  const headers = {
    'retry-after': '15',
    'x-ratelimit-limit-requests': '120',
  };
  const limits = extractProviderLimits(headers);
  assert.ok(limits);
  assert.equal(limits.rpmLimit, 120);
  assert.equal(limits.retryAfterMs, 15000);
});

test('extractProviderLimits: returns null when no ratelimit headers present', () => {
  const headers = {
    'content-type': 'application/json',
    'server': 'nginx',
  };
  const limits = extractProviderLimits(headers);
  assert.equal(limits, null);
});

test('lookupPreset: returns canonical presets for recognized providers', () => {
  const deepseek = lookupPreset('deepseek');
  assert.ok(deepseek);
  assert.ok(deepseek.rpmLimit > 0);
  assert.ok(deepseek.tpmLimit > 0);

  const groq = lookupPreset('groq');
  assert.ok(groq);
  assert.equal(groq.rpmLimit, 30);

  const anthropic = lookupPreset('anthropic');
  assert.ok(anthropic);
  assert.equal(anthropic.rpmLimit, 50);

  const unknown = lookupPreset('unknown-custom-provider');
  assert.equal(unknown, null);

  assert.ok(Object.keys(CANONICAL_PROVIDER_PRESETS).length >= 8);
});

function mockReqRes({ method = 'GET', url = '/', headers = {}, body = null, remoteAddress = '127.0.0.1' } = {}) {
  const req = Readable.from(body ? [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:3000', ...headers };
  req.socket = { remoteAddress };

  let status = 200;
  const resHeaders = {};
  const chunks = [];
  let finished = false;

  const res = {
    writeHead(s, h) {
      status = s;
      if (h) Object.assign(resHeaders, h);
    },
    setHeader(k, v) { resHeaders[k.toLowerCase()] = v; },
    write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); },
    end(c) {
      if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      finished = true;
    },
    get status() { return status; },
    get body() {
      const b = Buffer.concat(chunks).toString('utf8');
      try { return JSON.parse(b); } catch { return b; }
    },
  };
  return { req, res };
}

test('Route: PRESET_LIMITS_PATH handles GET query, full list, POST, and security', async () => {
  const routeTable = new Map();
  const ctx = {
    effect(fn) { fn(); },
    webServer: {
      register({ path, handler }) {
        routeTable.set(path, handler);
        return () => routeTable.delete(path);
      },
    },
  };
  registerKeyRoutes(ctx, { poolState: new Map(), buildRuntime: () => ({}) });

  const handler = routeTable.get(PRESET_LIMITS_PATH);
  assert.ok(handler, 'Route PRESET_LIMITS_PATH must be registered');

  // 1. GET with specific provider
  {
    const { req, res } = mockReqRes({ method: 'GET', url: `${PRESET_LIMITS_PATH}?provider=deepseek` });
    await handler(req, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.provider, 'deepseek');
    assert.equal(res.body.preset.rpmLimit, 60);
  }

  // 2. GET all presets
  {
    const { req, res } = mockReqRes({ method: 'GET', url: PRESET_LIMITS_PATH });
    await handler(req, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.presets.deepseek);
    assert.ok(res.body.presets.groq);
  }

  // 3. POST for provider preset
  {
    const { req, res } = mockReqRes({ method: 'POST', url: PRESET_LIMITS_PATH, body: { provider: 'groq' } });
    await handler(req, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.provider, 'groq');
    assert.equal(res.body.preset.rpmLimit, 30);
  }

  // 4. POST unknown provider -> 404
  {
    const { req, res } = mockReqRes({ method: 'POST', url: PRESET_LIMITS_PATH, body: { provider: 'nonexistent-ai' } });
    await handler(req, res);
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
  }

  // 5. Untrusted remote IP -> 403 Forbidden
  {
    const { req, res } = mockReqRes({ method: 'GET', url: PRESET_LIMITS_PATH, remoteAddress: '198.51.100.23' });
    await handler(req, res);
    assert.equal(res.status, 403);
    assert.equal(res.body.ok, false);
  }
});

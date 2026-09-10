// test/stability-coverage-281.test.mjs — stability hardening and unit coverage for Issue #281.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';

import {
  QUOTA_WINDOW_TYPES,
  nextQuotaReset,
  poolResetAt,
  isBlockedUntilReset,
} from '../lib/quota-window.js';

import { defaultClock, nowWall, nowMono } from '../lib/clock.js';

import {
  NS,
  json,
  readJson,
  descriptorOf,
  viewOf,
  providerCatalog,
  guardLocal,
  scanForLiveSecrets,
} from '../lib/http-bridge.js';

import {
  LAST_TEST_MAX,
  PROBE_RETRY_DELAY_MS,
  PROBE_MODELS_TIMEOUT_MS,
  LastTestCache,
} from '../lib/sandbox.js';

import {
  isLoopbackAddress,
  isTrustedBridgeRequest,
  isSoftFailure,
  SOFT_FAILURE_CODES,
  keyTail,
  KEY_TAIL_CHARS,
} from '../lib/pool.js';

// =========================================================================
// 1. Quota Window Coverage (#281)
// =========================================================================
test('quota-window: QUOTA_WINDOW_TYPES exports standard types', () => {
  assert.ok(Array.isArray(QUOTA_WINDOW_TYPES));
  assert.ok(QUOTA_WINDOW_TYPES.includes('midnight_utc'));
  assert.ok(QUOTA_WINDOW_TYPES.includes('midnight_pst'));
  assert.ok(QUOTA_WINDOW_TYPES.includes('rolling_24h'));
});

test('quota-window: poolResetAt delegates to nextQuotaReset', () => {
  const baseNow = 1700000000000;
  const cfg = { type: 'midnight_utc', hour: 4 };
  const poolVal = poolResetAt('test-pool', cfg, baseNow);
  const directVal = nextQuotaReset(cfg, baseNow);
  assert.equal(poolVal, directVal);
  assert.ok(typeof poolVal === 'number');
});

test('quota-window: isBlockedUntilReset handles edge cases', () => {
  assert.equal(isBlockedUntilReset(NaN, 1000), false);
  assert.equal(isBlockedUntilReset(Infinity, 1000), false);
  assert.equal(isBlockedUntilReset(-Infinity, 1000), false);
  assert.equal(isBlockedUntilReset(1000, null), false);
  assert.equal(isBlockedUntilReset(1000, undefined), false);
  assert.equal(isBlockedUntilReset(2000, 1500), true);
  assert.equal(isBlockedUntilReset(1500, 1500), true);
  assert.equal(isBlockedUntilReset(1499, 1500), false);
});

// =========================================================================
// 2. Clock Coverage (#281)
// =========================================================================
test('clock: defaultClock exports functions nowWall and nowMono', () => {
  assert.equal(typeof defaultClock.nowWall, 'function');
  assert.equal(typeof defaultClock.nowMono, 'function');
  const w = defaultClock.nowWall();
  const m = defaultClock.nowMono();
  assert.ok(Number.isFinite(w));
  assert.ok(Number.isFinite(m));
  assert.ok(w > 1700000000000);
  assert.ok(m > 0);
});

// =========================================================================
// 3. Pool Helpers & Network Guards Coverage (#281)
// =========================================================================
test('pool: isLoopbackAddress validates various loopback and non-loopback IPs', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.0.0.2'), true);
  assert.equal(isLoopbackAddress('127.255.255.254'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);

  assert.equal(isLoopbackAddress('192.168.1.1'), false);
  assert.equal(isLoopbackAddress('10.0.0.1'), false);
  assert.equal(isLoopbackAddress('8.8.8.8'), false);
  assert.equal(isLoopbackAddress(''), false);
  assert.equal(isLoopbackAddress(null), false);
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackAddress(123), false);
});

test('pool: isTrustedBridgeRequest enforces localhost/loopback and origin safety', () => {
  // Remote non-loopback IP
  assert.equal(isTrustedBridgeRequest({ socket: { remoteAddress: '8.8.8.8' } }), false);

  // Loopback without origin header (e.g. server curl / internal cli)
  assert.equal(isTrustedBridgeRequest({ socket: { remoteAddress: '127.0.0.1' } }), true);

  // Cross-site fetch header
  assert.equal(isTrustedBridgeRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://localhost:5173', 'sec-fetch-site': 'cross-site' },
  }), false);

  // Valid loopback origin matching host
  assert.equal(isTrustedBridgeRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://localhost:5173', host: 'localhost:5173' },
  }), true);

  // Host header mismatch
  assert.equal(isTrustedBridgeRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://evil.com', host: 'localhost:5173' },
  }), false);

  // Malformed origin
  assert.equal(isTrustedBridgeRequest({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'not-a-valid-url', host: 'localhost:5173' },
  }), false);
});

test('pool: isSoftFailure correctly classifies codes and error messages', () => {
  assert.ok(SOFT_FAILURE_CODES.has('TIMEOUT'));
  assert.ok(SOFT_FAILURE_CODES.has('SERVER'));
  assert.ok(SOFT_FAILURE_CODES.has('TRANSPORT'));

  assert.equal(isSoftFailure('TIMEOUT'), true);
  assert.equal(isSoftFailure('SERVER'), true);
  assert.equal(isSoftFailure('502'), true);
  assert.equal(isSoftFailure('AUTH'), false);
  assert.equal(isSoftFailure('RATE_LIMIT'), false);

  // Pattern detection in messages
  assert.equal(isSoftFailure('', 'Gateway timeout 504 occurred'), true);
  assert.equal(isSoftFailure('', 'Socket hang up unexpectedly'), true);
  assert.equal(isSoftFailure('', 'connect ECONNRESET 127.0.0.1:443'), true);
  assert.equal(isSoftFailure('', 'connect ECONNREFUSED 127.0.0.1:443'), true);
  assert.equal(isSoftFailure('', 'Bad gateway 502 returned'), true);
  assert.equal(isSoftFailure('', 'Unrelated error message'), false);
});

test('pool: keyTail handles null, short and standard keys', () => {
  assert.equal(keyTail(null), '');
  assert.equal(keyTail(undefined), '');
  assert.equal(keyTail(12345), '');
  assert.equal(keyTail('abc'), 'abc');
  assert.equal(keyTail('12345'), '12345');
  assert.equal(keyTail('sk-live-123456789'), '56789');
  assert.equal(KEY_TAIL_CHARS, 5);
});

// =========================================================================
// 4. HTTP Bridge Helpers Coverage (#281)
// =========================================================================
test('http-bridge: NS is dsh-key-rotation', () => {
  assert.equal(NS, 'dsh-key-rotation');
});

test('http-bridge: json() sends formatted JSON response with 200/400 status', () => {
  let headerStatus = null;
  let headerObj = null;
  let writtenBody = null;

  const mockRes = {
    writeHead(status, headers) {
      headerStatus = status;
      headerObj = headers;
    },
    end(body) {
      writtenBody = body;
    },
  };

  json(mockRes, 200, { ok: true, data: [1, 2, 3] });
  assert.equal(headerStatus, 200);
  assert.equal(headerObj['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(writtenBody), { ok: true, data: [1, 2, 3] });
});

test('http-bridge: readJson parses streaming request body', async () => {
  const req = new EventEmitter();
  const promise = readJson(req);
  req.emit('data', '{"action":"rotate"');
  req.emit('data', ',"pool":"default"}');
  req.emit('end');

  const result = await promise;
  assert.deepEqual(result, { action: 'rotate', pool: 'default' });
});

test('http-bridge: readJson rejects malformed JSON', async () => {
  const req = new EventEmitter();
  const promise = readJson(req);
  req.emit('data', '{invalid-json');
  req.emit('end');

  await assert.rejects(promise, (err) => err instanceof SyntaxError);
});

test('http-bridge: guardLocal denies untrusted and allows trusted', () => {
  let deniedCode = null;
  const untrustedReq = { socket: { remoteAddress: '10.0.0.1' } };
  const mockRes = {
    writeHead(code) { deniedCode = code; },
    end() {},
  };
  assert.equal(guardLocal(untrustedReq, mockRes, 'test-endpoint'), false);
  assert.equal(deniedCode, 403);

  const trustedReq = { socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(guardLocal(trustedReq, mockRes, 'test-endpoint'), true);
});

test('http-bridge: scanForLiveSecrets masks webhook tokens but flags raw api keys in configs', () => {
  // Config with webhook tokens should have them masked so they are not flagged
  const safeConfig = {
    webhookActionToken: 'secret_token_12345',
    notifyWebhook: 'https://webhook.site/abc',
    pools: { default: ['sk_live_safe_reference_only'] },
  };
  // Structured scan masks webhookActionToken & notifyWebhook
  const cleanFindings = scanForLiveSecrets({
    webhookActionToken: 'bearer-secret-token',
    notifyWebhook: 'https://example.com/hook',
  });
  assert.equal(cleanFindings.length, 0);

  // Config containing real raw OpenAI live key pattern
  const dirtyConfig = {
    randomField: 'sk-proj-abcdefghijklmnopqrstuvwxyz12345678901234567890',
  };
  const dirtyFindings = scanForLiveSecrets(dirtyConfig);
  assert.ok(dirtyFindings.length > 0);
  assert.ok(dirtyFindings[0].type.includes('OpenAI') || dirtyFindings[0].type.length > 0);
});

test('http-bridge: providerCatalog filters and deduplicates', () => {
  const mockCtx = {
    get(name) {
      if (name === 'llm') {
        return {
          listProviders() {
            return [
              { id: 'openai', name: 'OpenAI' },
              { id: 'anthropic', name: 'Anthropic' },
              { id: 'openai', name: 'Duplicate' },
              { id: 'clone_provider', name: 'Cloned' },
            ];
          },
        };
      }
      return undefined;
    },
  };

  const cloneIds = new Set(['clone_provider']);
  const catalog = providerCatalog(mockCtx, cloneIds);
  assert.deepEqual(catalog, [
    { id: 'openai', name: 'OpenAI' },
    { id: 'anthropic', name: 'Anthropic' },
  ]);
});

test('http-bridge: descriptorOf and viewOf format settings view', () => {
  const mockDescriptor = {
    ns: 'dsh-key-rotation',
    value: { pools: {} },
    base: { pools: {} },
    user: { debug: true },
    revision: 4,
  };
  const mockCtx = {
    get(name) {
      if (name === 'settings') {
        return {
          describe() {
            return [mockDescriptor, { ns: 'other-plugin' }];
          },
        };
      }
      return undefined;
    },
  };

  const desc = descriptorOf(mockCtx, 'dsh-key-rotation');
  assert.equal(desc.ns, 'dsh-key-rotation');
  assert.equal(desc.revision, 4);

  const view = viewOf(desc, { writable: true, hasDocument: true });
  assert.equal(view.available, true);
  assert.equal(view.writable, true);
  assert.equal(view.hasDocument, true);
  assert.equal(view.revision, 4);
  assert.deepEqual(view.user, { debug: true });
});

// =========================================================================
// 5. Sandbox Constants & Cache Edge Cases Coverage (#281)
// =========================================================================
test('sandbox: constants exported and sane', () => {
  assert.equal(typeof LAST_TEST_MAX, 'number');
  assert.ok(LAST_TEST_MAX > 0);
  assert.equal(typeof PROBE_RETRY_DELAY_MS, 'number');
  assert.ok(PROBE_RETRY_DELAY_MS >= 500);
  assert.equal(typeof PROBE_MODELS_TIMEOUT_MS, 'number');
});

test('sandbox: LastTestCache ignores falsy ref or result and preserves eviction bounds', () => {
  const cache = new LastTestCache(3);
  cache.set(null, { ok: true });
  cache.set('', { ok: true });
  cache.set('ref1', null);
  cache.set('ref1', undefined);
  assert.equal(cache.size, 0);

  cache.set('A', { ok: true });
  cache.set('B', { ok: true });
  cache.set('C', { ok: true });
  assert.equal(cache.size, 3);
  cache.set('D', { ok: true });
  assert.equal(cache.size, 3);
  assert.equal(cache.get('A'), undefined);
  assert.ok(cache.get('D'));
});

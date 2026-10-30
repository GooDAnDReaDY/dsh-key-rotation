import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedBridgeRequest, isDesktopShellRequest } from '../lib/pool.js';
import { maskConfig, encryptConfig, decryptConfig, decryptConfigAsync, registerConfigIoRoutes, MAX_PBKDF2_ITERATIONS } from '../lib/ops-config-io.js';
import { inspectBalanceForRef } from '../lib/balance-inspector.js';
import { createSelectionTrace, sanitizeTraceDetails } from '../lib/selection-trace.js';
import { registerKeyRoutes } from '../lib/ops-keys.js';
import { KEY_PATH, CONFIG_EXPORT_PATH } from '../lib/ops-paths.js';

test('Issue #516 & #543: Strict loopback and forbidden plaintext GET /key', async () => {
  const routes = new Map();
  const mockWebServer = { register: ({ path, handler }) => routes.set(path, handler) };
  const mockCtx = { effect: f => f(), webServer: mockWebServer, get: () => ({ resolve: async () => ({ value: 'sk-secret' }) }) };
  registerKeyRoutes(mockCtx, { buildRuntime: () => ({}) });

  const handler = routes.get(KEY_PATH);
  assert.ok(handler, 'KEY_PATH route must be registered');

  // GET /key plaintext extraction must return 403 Forbidden (#543)
  let status = 0;
  let body = null;
  const mockRes = {
    writeHead: (s) => { status = s; },
    end: (d) => { body = JSON.parse(d); }
  };
  await handler({
    method: 'GET',
    url: '/dsh-key-rotation/key?ref=TEST_KEY',
    headers: { host: '127.0.0.1:3000' },
    socket: { remoteAddress: '127.0.0.1' }
  }, mockRes);

  assert.equal(status, 403, 'GET /key must return 403 Forbidden');
  assert.equal(body.error.code, 'forbidden');
});

test('Issue #532: maskConfig masks real notifyWebhook including secret tokens', () => {
  const cfg = {
    notifyWebhook: 'https://discord.com/api/webhooks/123456789/secret-webhook-token',
    webhookUrl: 'https://discord.com/api/webhooks/987654321/another-token',
    webhookActionToken: 'secret-action-token',
    providers: [{ provider: 'deepseek', keys: ['sk-live-1234567890abcdef'] }]
  };
  const masked = maskConfig(cfg);
  assert.equal(masked.notifyWebhook, 'https://discord.com/api/webhooks/123456789/***');
  assert.equal(masked.webhookUrl, 'https://discord.com/api/webhooks/987654321/***');
  assert.equal(masked.webhookActionToken, '***');
  assert.equal(masked.providers[0].keys[0], 'sk-...cdef');
});

test('Issue #552: POST /dsh-key-rotation/export accepts passphrase in body and encrypts config', async () => {
  const routes = new Map();
  const mockWebServer = { register: ({ path, handler }) => routes.set(path, handler) };
  const mockSettings = { get: () => ({ providers: [{ provider: 'deepseek', keys: ['sk-key1234567890'] }] }) };
  const mockCtx = { effect: f => f(), webServer: mockWebServer, get: (s) => (s === 'settings' ? mockSettings : undefined) };
  registerConfigIoRoutes(mockCtx, { buildRuntime: () => ({ cfg0: {} }) });

  const handler = routes.get(CONFIG_EXPORT_PATH);
  assert.ok(handler);

  let status = 0;
  let body = null;
  const mockRes = {
    writeHead: (s) => { status = s; },
    setHeader: () => {},
    end: (d) => { body = JSON.parse(d); }
  };

  const buf = Buffer.from(JSON.stringify({ masked: false, passphrase: 'TestSecretMasterKey123!' }));
  const req = {
    method: 'POST',
    url: '/dsh-key-rotation/export',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      if (event === 'data') cb(buf);
      if (event === 'end') cb();
      return this;
    }
  };

  await handler(req, mockRes);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.encrypted, true);
  assert.ok(body.ciphertext);

  const decryptedStr = decryptConfig(body, 'TestSecretMasterKey123!');
  const decrypted = JSON.parse(decryptedStr);
  assert.equal(decrypted.providers[0].keys[0], 'sk-key1234567890');
});

test('Issue #537: selection-trace sanitizes raw tokens and error details', () => {
  const trace = createSelectionTrace('req-test-1', { provider: 'test', model: 'test-m' });
  trace.addStep('KEY_A', 'FAILED', 'RATE_LIMIT', 'Upstream error with raw token sk-live-secret-key-1234567890 and https://api.com?token=secret-token-val');
  const res = trace.finish('ERROR');
  assert.ok(res.steps[0].details.includes('[REDACTED_SECRET]'), 'Details must redact raw sk- token');
  assert.equal(res.steps[0].details.includes('sk-live-secret-key-1234567890'), false, 'Raw token must not appear in trace');
});

test('Issue #539: inspectBalanceForRef fails closed on corrupted or missing key decryption without calling upstream', async () => {
  let networkCalled = false;
  const fakeFetch = async () => {
    networkCalled = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const mockCtx = {
    get: (svc) => svc === 'credentials' ? { resolve: async () => ({ value: 'enc:v1:badiv:badtag:badciphertext' }) } : undefined
  };

  const res = await inspectBalanceForRef(mockCtx, 'TEST_REF', 'openrouter', {
    fetchImpl: fakeFetch,
    testValue: 'enc:v1:corrupt_iv:corrupt_tag:corrupt_cipher'
  });

  assert.equal(res.ok, false);
  assert.ok(res.error.includes('failed to decrypt credential'));
  assert.equal(networkCalled, false, 'Network probe must NEVER be called with ciphertext');
});

test('Issue #542: DoS protection on PBKDF2 iterations bounds', async () => {
  const payload = {
    salt: '0123456789abcdef0123456789abcdef',
    iv: '0123456789abcdef01234567',
    tag: '0123456789abcdef0123456789abcdef',
    ciphertext: 'deadbeef',
    iterations: 10000000 // Exceeds MAX_PBKDF2_ITERATIONS (200000)
  };

  assert.throws(() => {
    decryptConfig(payload, 'pass');
  }, /PBKDF2 iterations must be between/);

  await assert.rejects(async () => {
    await decryptConfigAsync(payload, 'pass');
  }, /PBKDF2 iterations must be between/);
});

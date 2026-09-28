import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { registerWebhookActionRoute } from '../lib/ops-webhook.js';

function createTestEnv() {
  const routes = new Map();
  const mockCtx = {
    effect: (fn) => fn(),
    webServer: {
      register: (opts) => {
        routes.set(opts.path, opts);
      },
    },
    logger: () => ({ warn: () => {}, info: () => {}, error: () => {} }),
  };

  const poolState = new Map([
    ['test-prov', {
      failedUntil: new Map([['KEY_1', Date.now() + 60000]]),
      failCounts: new Map([['KEY_1', 2]]),
      authFailCounts: new Map([['KEY_1', 1]]),
      switches: 1,
    }],
  ]);

  let rotationDisabled = false;
  let circuitResetCount = 0;
  const circuitBreaker = {
    reset: () => { circuitResetCount++; },
  };

  const mockDeps = {
    buildRuntime: () => ({
      webhookActionToken: 'telegram-secret-12345',
      poolByRef: new Map([
        ['KEY_1', { base: 'test-prov', refs: ['KEY_1'] }],
      ]),
      breaker: circuitBreaker,
    }),
    poolState,
    getRotationDisabled: () => rotationDisabled,
    setRotationDisabled: (v) => { rotationDisabled = v; },
    circuitBreaker,
  };

  registerWebhookActionRoute(mockCtx, mockDeps);

  function invoke({ headers = {}, body = null, method = 'POST' } = {}) {
    return new Promise((resolve) => {
      const route = routes.get('/dsh-key-rotation/webhook-action');
      let resCode = 200;
      let resBody = '';

      const content = body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
      const req = Readable.from(content ? [Buffer.from(content)] : []);
      req.method = method;
      req.headers = headers;

      const res = {
        writeHead: (code) => { resCode = code; },
        end: (data) => {
          if (data) resBody += data;
          let parsed = null;
          try { parsed = JSON.parse(resBody); } catch { parsed = resBody; }
          resolve({ status: resCode, body: parsed });
        },
        setHeader: () => {},
      };

      route.handler(req, res);
    });
  }

  return {
    invoke,
    poolState,
    getRotationDisabled: () => rotationDisabled,
    getCircuitResetCount: () => circuitResetCount,
  };
}

test('telegram webhook: 401 when no token is provided', async () => {
  const env = createTestEnv();
  const res = await env.invoke({
    headers: {},
    body: { update_id: 1, callback_query: { id: 'cb1', data: 'reset-test-prov' } },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body?.error?.code, 'unauthorized');
});

test('telegram webhook: 401 on mismatched X-Telegram-Bot-Api-Secret-Token', async () => {
  const env = createTestEnv();
  const res = await env.invoke({
    headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
    body: { update_id: 1, callback_query: { id: 'cb1', data: 'reset-test-prov' } },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body?.error?.code, 'unauthorized');
});

test('telegram webhook: executes reset via X-Telegram-Bot-Api-Secret-Token and answers callback', async () => {
  const env = createTestEnv();
  const res = await env.invoke({
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'telegram-secret-12345' },
    body: {
      update_id: 1001,
      callback_query: {
        id: 'cb_query_reset_1',
        from: { id: 42, first_name: 'Admin' },
        data: JSON.stringify({ id: 'reset-test-prov', token: 'telegram-secret-12345' }),
      },
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body?.ok, true);
  assert.equal(res.body?.action, 'reset-test-prov');
  assert.equal(res.body?.provider, 'test-prov');
  assert.equal(res.body?.circuitReset, true);
  assert.equal(res.body?.method, 'answerCallbackQuery');
  assert.equal(res.body?.callback_query_id, 'cb_query_reset_1');
  assert.equal(res.body?.text, 'Pool test-prov reset');

  const st = env.poolState.get('test-prov');
  assert.equal(st.failedUntil.size, 0);
  assert.equal(env.getCircuitResetCount(), 1);
});

test('telegram webhook: executes pause via lowercase header and answers callback', async () => {
  const env = createTestEnv();
  const res = await env.invoke({
    headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret-12345' },
    body: {
      update_id: 1002,
      callback_query: {
        id: 'cb_query_pause_2',
        data: 'pause-test-prov',
      },
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body?.ok, true);
  assert.equal(res.body?.action, 'pause-test-prov');
  assert.equal(res.body?.method, 'answerCallbackQuery');
  assert.equal(res.body?.callback_query_id, 'cb_query_pause_2');
  assert.equal(res.body?.text, 'Pool test-prov paused 1h');

  const st = env.poolState.get('test-prov');
  assert.ok((st.failedUntil.get('KEY_1') ?? 0) > Date.now());
});

test('telegram webhook: executes disable-rotation and enable-rotation with answerCallbackQuery', async () => {
  const env = createTestEnv();

  const disRes = await env.invoke({
    headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret-12345' },
    body: {
      update_id: 1003,
      callback_query: { id: 'cb_dis', data: 'disable-rotation' },
    },
  });
  assert.equal(disRes.status, 200);
  assert.equal(disRes.body?.method, 'answerCallbackQuery');
  assert.equal(disRes.body?.callback_query_id, 'cb_dis');
  assert.equal(disRes.body?.text, 'Rotation disabled');
  assert.equal(env.getRotationDisabled(), true);

  const enRes = await env.invoke({
    headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret-12345' },
    body: {
      update_id: 1004,
      callback_query: { id: 'cb_en', data: 'enable-rotation' },
    },
  });
  assert.equal(enRes.status, 200);
  assert.equal(enRes.body?.method, 'answerCallbackQuery');
  assert.equal(enRes.body?.callback_query_id, 'cb_en');
  assert.equal(enRes.body?.text, 'Rotation enabled');
  assert.equal(env.getRotationDisabled(), false);
});

test('telegram webhook: Authorization: Bearer still works for backward compatibility', async () => {
  const env = createTestEnv();
  const res = await env.invoke({
    headers: { authorization: 'Bearer telegram-secret-12345' },
    body: { action: 'disable-rotation' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.ok, true);
  assert.equal(res.body?.method, undefined); // non-telegram caller does not receive method answerCallbackQuery
  assert.equal(env.getRotationDisabled(), true);
});

test('telegram webhook: answers callback even on not-found provider error', async () => {
  const env = createTestEnv();
  const res = await env.invoke({
    headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret-12345' },
    body: {
      update_id: 1005,
      callback_query: { id: 'cb_err', data: 'reset-unknown-provider' },
    },
  });
  assert.equal(res.status, 404);
  assert.equal(res.body?.method, 'answerCallbackQuery');
  assert.equal(res.body?.callback_query_id, 'cb_err');
  assert.equal(res.body?.text, 'Pool not found: unknown-provider');
});

test('setWebhook: rejects missing or non-https URL (requires explicit https public url)', async () => {
  const env = createTestEnv();

  // Missing URL
  const noUrl = await env.invoke({
    headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret-12345' },
    body: { setWebhook: { botToken: '12345678:ABCdefGHIjklMNOpqrsTUVwxyz123456789' } },
  });
  assert.equal(noUrl.status, 400);
  assert.match(noUrl.body?.error?.message, /explicit public https url required/);

  // Http instead of https
  const httpUrl = await env.invoke({
    headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret-12345' },
    body: {
      setWebhook: {
        botToken: '12345678:ABCdefGHIjklMNOpqrsTUVwxyz123456789',
        url: 'http://127.0.0.1:3080/dsh-key-rotation/webhook-action',
      },
    },
  });
  assert.equal(httpUrl.status, 400);
  assert.match(httpUrl.body?.error?.message, /explicit public https url required/);
});

test('setWebhook: passes secret_token in telegram setWebhook call', async () => {
  const env = createTestEnv();
  const originalFetch = globalThis.fetch;
  let capturedFetch = null;

  globalThis.fetch = async (url, opts) => {
    capturedFetch = { url, opts, body: JSON.parse(opts.body) };
    return {
      ok: true,
      json: async () => ({ ok: true, result: true, description: 'Webhook was set' }),
    };
  };

  try {
    const res = await env.invoke({
      headers: { authorization: 'Bearer telegram-secret-12345' },
      body: {
        setWebhook: {
          botToken: '12345678:ABCdefGHIjklMNOpqrsTUVwxyz123456789',
          url: 'https://my-domain.example.com/dsh-key-rotation/webhook-action',
        },
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body?.ok, true);
    assert.equal(res.body?.secret_token_set, true);
    assert.equal(capturedFetch?.url, 'https://api.telegram.org/bot12345678:ABCdefGHIjklMNOpqrsTUVwxyz123456789/setWebhook');
    assert.equal(capturedFetch?.body?.url, 'https://my-domain.example.com/dsh-key-rotation/webhook-action');
    assert.equal(capturedFetch?.body?.secret_token, 'telegram-secret-12345');
    assert.deepEqual(capturedFetch?.body?.allowed_updates, ['callback_query']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

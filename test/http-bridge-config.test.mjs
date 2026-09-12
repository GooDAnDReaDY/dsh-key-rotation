// test/http-bridge-config.test.mjs
// Unit tests for handleConfigBridge and writeSection (#301)
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleConfigBridge, writeSection, NS } from '../lib/http-bridge.js';

function createMockBridge(overrides = {}) {
  let curSection = { cooldownMs: 30000, providers: [] };
  let curRevision = 1;

  const mockSettings = {
    writable: true,
    hasDocument: true,
    documentPath: '/home/user/.dsh/config.yaml',
    describe: () => [{ ns: NS, value: curSection, revision: curRevision }],
    replace: async (ns, nextVal, expectedRev) => {
      if (expectedRev !== undefined && expectedRev !== curRevision) {
        const err = new Error('Settings conflict');
        err.code = 'SETTINGS_CONFLICT';
        err.expected = expectedRev;
        err.actual = curRevision;
        throw err;
      }
      curSection = nextVal;
      curRevision++;
    },
  };

  const mockCtx = {
    get: (name) => {
      if (name === 'settings') return mockSettings;
      if (name === 'llm') return { listProviders: () => [{ id: 'mock-llm', name: 'Mock LLM' }] };
      return null;
    },
  };

  function invokeBridge({ method = 'GET', body = null, headers = {} } = {}) {
    return new Promise((resolve) => {
      let resStatus = 200;
      const resHeaders = {};
      let resData = '';

      const req = {
        method,
        headers: {
          host: '127.0.0.1:3080',
          origin: 'http://127.0.0.1:3080',
          'sec-fetch-site': 'same-origin',
          ...headers,
        },
        socket: { remoteAddress: '127.0.0.1' },
        on: (evt, cb) => {
          if (evt === 'data' && body) process.nextTick(() => cb(typeof body === 'string' ? body : JSON.stringify(body)));
          if (evt === 'end') process.nextTick(() => cb());
        },
      };

      const res = {
        writeHead: (st, hdrs = {}) => { resStatus = st; Object.assign(resHeaders, hdrs); },
        setHeader: (k, v) => { resHeaders[k] = v; },
        end: (chunk = '') => {
          resData += chunk;
          let parsed = resData;
          try { parsed = JSON.parse(resData); } catch (_) {}
          resolve({ status: resStatus, headers: resHeaders, body: parsed });
        },
      };

      handleConfigBridge(mockCtx, req, res, () => new Set(['clone-1']));
    });
  }

  return { mockCtx, mockSettings, invokeBridge };
}

test('http-bridge: GET returns provider catalog and settings view', async () => {
  const bridge = createMockBridge();
  const res = await bridge.invokeBridge({ method: 'GET' });
  assert.equal(res.status, 200);
  assert.equal(res.body.available, true);
  assert.equal(res.body.writable, true);
  assert.ok(Array.isArray(res.body.providers));
  assert.equal(res.body.providers[0].id, 'mock-llm');
});

test('http-bridge: PUT updates section and rejects live credentials', async () => {
  const bridge = createMockBridge();

  // Valid section save
  const resOk = await bridge.invokeBridge({
    method: 'PUT',
    body: { section: { cooldownMs: 45000, providers: [{ provider: 'mock-llm', keys: ['KEY_1'] }] }, expectedRevision: 1 },
  });
  assert.equal(resOk.status, 200);
  assert.equal(resOk.body.value.cooldownMs, 45000);

  // Secret leak rejection
  const resBad = await bridge.invokeBridge({
    method: 'PUT',
    body: { section: { rawSecret: 'sk-proj-live-secret-test-key-1234567890abcdef' } },
  });
  assert.equal(resBad.status, 400);
  assert.equal(resBad.body.error.code, 'secret-in-config');
});

test('http-bridge: PUT handles revision conflicts (409)', async () => {
  const bridge = createMockBridge();
  const resConflict = await bridge.invokeBridge({
    method: 'PUT',
    body: { section: { cooldownMs: 60000 }, expectedRevision: 999 },
  });
  assert.equal(resConflict.status, 409);
  assert.equal(resConflict.body.error.code, 'settings-conflict');
});

test('http-bridge: DELETE resets section to empty object', async () => {
  const bridge = createMockBridge();
  const resDel = await bridge.invokeBridge({ method: 'DELETE' });
  assert.equal(resDel.status, 200);
  assert.deepEqual(resDel.body.value, {});
});

test('http-bridge: 405 on POST method', async () => {
  const bridge = createMockBridge();
  const res405 = await bridge.invokeBridge({ method: 'POST' });
  assert.equal(res405.status, 405);
});

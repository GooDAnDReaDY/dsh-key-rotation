import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveKeyDirectly } from '../lib/resolver.js';
import { createRotate } from '../lib/rotate.js';
import { initializePoolState } from '../lib/pool-state.js';

test('issue #526 - resolveKeyDirectly resolves credentials cleanly without monkey-patch', async () => {
  // 1. From credentials service safely
  const mockCreds = {
    async resolve(ref) {
      if (ref === 'TEST_SECRET_REF') return { value: 'secret-xyz-123' };
      return null;
    },
  };
  const mockCtx = {
    get(name) {
      if (name === 'credentials') return mockCreds;
      return null;
    },
  };

  const resolved = await resolveKeyDirectly('TEST_SECRET_REF', mockCtx);
  assert.equal(resolved, 'secret-xyz-123');

  // 2. From environment variable fallback
  process.env.TEST_ENV_VAR_KEY = 'env-value-789';
  const resolvedEnv = await resolveKeyDirectly('TEST_ENV_VAR_KEY', {});
  assert.equal(resolvedEnv, 'env-value-789');
  delete process.env.TEST_ENV_VAR_KEY;
});

test('issue #526 - rotate passes resolved apiKey and headers directly to llm.stream', async () => {
  let capturedStreamOptions = null;

  const mockLlm = {
    async *stream(opts) {
      capturedStreamOptions = opts;
      yield { type: 'text-delta', text: 'Hello' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const mockCtx = {
    get(name) {
      if (name === 'llm') return mockLlm;
      return null;
    },
  };

  const pool = {
    provider: 'openai',
    refs: ['KEY_TEST_REF'],
    weightedRefs: ['KEY_TEST_REF'],
    state: initializePoolState(),
  };

  process.env.KEY_TEST_REF = 'sk-direct-token-999';

  const rotate = createRotate({
    ctx: mockCtx,
    dispatchStorage: { run: (store, fn) => fn() },
    buildRuntime: () => ({ switchCodes: [], cooldownMs: 60000, maxCooldownMs: 3600000 }),
    pushEvent: () => {},
    recordLatency: () => {},
    MARKER: Symbol('marker'),
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    setRotateStartMs: () => {},
  });

  const streamGenerator = rotate({
    provider: 'openai',
    model: 'gpt-4o',
  }, pool);

  const chunks = [];
  for await (const chunk of streamGenerator) {
    chunks.push(chunk);
  }

  delete process.env.KEY_TEST_REF;

  assert.equal(chunks.length, 2);
  assert.ok(capturedStreamOptions);
  assert.equal(capturedStreamOptions.apiKey, 'sk-direct-token-999');
  assert.equal(capturedStreamOptions.headers.Authorization, 'Bearer sk-direct-token-999');
  assert.equal(capturedStreamOptions._rotationKeyRef, 'KEY_TEST_REF');
});

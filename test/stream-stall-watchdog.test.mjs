// test/stream-stall-watchdog.test.mjs — Comprehensive tests for Block 12: Inter-Token Stall & Zombie Stream Detector (#569)

import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { withStreamWatchdog, StreamStallError } from '../lib/stream-watchdog.js';
import { isSwitchableError } from '../lib/pool.js';
import { classifyErrorCategory } from '../lib/ops-analytics.js';
import { classifyFailure } from '../lib/error-taxonomy.js';
import { createRotate } from '../lib/rotate.js';
import { buildPools } from '../lib/pool-builder.js';

test('stream-watchdog: normal stream passes all chunks without interruption', async () => {
  async function* makeStream() {
    yield { type: 'text-delta', text: 'Hello' };
    yield { type: 'text-delta', text: ' world' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }

  const guarded = withStreamWatchdog(makeStream(), {
    stallTimeoutMs: 50,
    stallInitialTimeoutMs: 50,
  });

  const chunks = [];
  for await (const chunk of guarded) {
    chunks.push(chunk);
  }

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].text, 'Hello');
  assert.equal(chunks[1].text, ' world');
  assert.equal(chunks[2].type, 'finish');
});

test('stream-watchdog: stalls before first chunk throws StreamStallError with initial timeout', async () => {
  async function* makeStalledStream() {
    await new Promise((resolve) => setTimeout(resolve, 80));
    yield { type: 'text-delta', text: 'Late' };
  }

  let abortCalled = false;
  const abortCtrl = {
    abort: () => { abortCalled = true; },
  };

  const guarded = withStreamWatchdog(makeStalledStream(), {
    stallInitialTimeoutMs: 30,
    stallTimeoutMs: 50,
    abortController: abortCtrl,
    onStall: (err) => {
      assert.ok(err instanceof StreamStallError);
      assert.equal(err.code, 'STREAM_STALLED');
      assert.equal(err.chunkCount, 0);
    },
  });

  await assert.rejects(
    async () => {
      for await (const _ of guarded) {}
    },
    (err) => {
      assert.ok(err instanceof StreamStallError);
      assert.equal(err.code, 'STREAM_STALLED');
      assert.match(err.message, /Stream stalled: no tokens received for 30ms/);
      return true;
    }
  );

  assert.ok(abortCalled, 'Abort controller must be aborted on stall');
});

test('stream-watchdog: stalls mid-stream after initial token throws StreamStallError with inter-token timeout', async () => {
  async function* makeMidStalledStream() {
    yield { type: 'text-delta', text: 'First token' };
    await new Promise((resolve) => setTimeout(resolve, 80));
    yield { type: 'text-delta', text: 'Second token' };
  }

  const guarded = withStreamWatchdog(makeMidStalledStream(), {
    stallInitialTimeoutMs: 100, // Large initial window
    stallTimeoutMs: 25,         // Short inter-token window
  });

  const chunks = [];
  await assert.rejects(
    async () => {
      for await (const chunk of guarded) {
        chunks.push(chunk);
      }
    },
    (err) => {
      assert.ok(err instanceof StreamStallError);
      assert.equal(err.code, 'STREAM_STALLED');
      assert.equal(err.chunkCount, 1);
      assert.match(err.message, /Stream stalled: no tokens received for 25ms \(chunks: 1\)/);
      return true;
    }
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, 'First token');
});

test('stream-watchdog: disabled watchdog does not interrupt slow stream', async () => {
  async function* makeSlowStream() {
    await new Promise((resolve) => setTimeout(resolve, 35));
    yield { type: 'text-delta', text: 'Slow but ok' };
  }

  const guarded = withStreamWatchdog(makeSlowStream(), {
    stallDetectionEnabled: false,
    stallInitialTimeoutMs: 10,
    stallTimeoutMs: 10,
  });

  const chunks = [];
  for await (const chunk of guarded) {
    chunks.push(chunk);
  }
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, 'Slow but ok');
});

test('classification: error-taxonomy and ops-analytics recognize STREAM_STALLED as timeout', () => {
  assert.equal(classifyErrorCategory('STREAM_STALLED'), 'timeout');
  assert.equal(classifyErrorCategory('TIMEOUT', 'stream stalled for 15000ms'), 'timeout');

  assert.ok(isSwitchableError({ code: 'STREAM_STALLED' }), 'STREAM_STALLED must be switchable error');

  const failure = classifyFailure({ code: 'STREAM_STALLED', message: 'Stream stalled: no tokens received' });
  assert.equal(failure.action, 'switch');
  assert.equal(failure.code, 'TIMEOUT');
  assert.equal(failure.soft, true);
});

test('rotate e2e: stall before first token triggers failover to backup key', async () => {
  const poolState = new Map();
  const cfg = {
    providers: [
      {
        provider: 'test-prov',
        keys: ['KEY_STALL', 'KEY_HEALTHY'],
        stallInitialTimeoutMs: 30,
        stallTimeoutMs: 30,
      },
    ],
  };

  const { providerToPool, poolByRef } = buildPools({ cfg, poolState });
  const pool = providerToPool.get('test-prov');

  const attempts = [];
  const mockCtx = {
    get(name) {
      if (name === 'llm') {
        return {
          stream: async function* (opts) {
            attempts.push(opts._rotationKeyRef);
            if (opts._rotationKeyRef === 'KEY_STALL') {
              // Zombie stream: never emits any tokens
              await new Promise((r) => setTimeout(r, 80));
              yield { type: 'text-delta', text: 'Should never reach' };
            } else {
              // Healthy backup key
              yield { type: 'text-delta', text: 'Healthy answer' };
              yield { type: 'finish', reason: { kind: 'stop' } };
            }
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
      switchCodes: ['TIMEOUT', 'QUOTA', 'RATE_LIMIT'],
      stallDetectionEnabled: true,
      stallInitialTimeoutMs: 30,
      stallTimeoutMs: 30,
    }),
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    recordLatency: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    pushEvent: () => {},
    setRotateStartMs: () => {},
    circuitBreaker: null,
    MARKER: '__test_stall_1',
  });

  const chunks = [];
  for await (const chunk of rotate({ provider: 'test-prov', model: 'test-model' }, pool)) {
    chunks.push(chunk);
  }

  assert.deepEqual(attempts, ['KEY_STALL', 'KEY_HEALTHY']);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, 'Healthy answer');
  assert.equal(chunks[1].type, 'finish');
  assert.equal(pool.state.switches, 1);
  assert.equal(pool.state.lastReason, 'STREAM_STALLED');
  assert.ok(pool.state.failedUntil.has('KEY_STALL'), 'Stalled key must be placed in cooldown');
});

test('rotate e2e: stall mid-stream after first token delivers error finish chunk', async () => {
  const poolState = new Map();
  const cfg = {
    providers: [
      {
        provider: 'test-prov-mid',
        keys: ['KEY_MID_STALL'],
        stallInitialTimeoutMs: 100,
        stallTimeoutMs: 25,
      },
    ],
  };

  const { providerToPool, poolByRef } = buildPools({ cfg, poolState });
  const pool = providerToPool.get('test-prov-mid');

  const mockCtx = {
    get(name) {
      if (name === 'llm') {
        return {
          stream: async function* (opts) {
            yield { type: 'text-delta', text: 'Partial text emitted' };
            // Then stalls
            await new Promise((r) => setTimeout(r, 70));
            yield { type: 'text-delta', text: 'Lost token' };
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
      stallDetectionEnabled: true,
      stallInitialTimeoutMs: 100,
      stallTimeoutMs: 25,
    }),
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    recordLatency: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    pushEvent: () => {},
    setRotateStartMs: () => {},
    circuitBreaker: null,
    MARKER: '__test_stall_2',
  });

  const chunks = [];
  for await (const chunk of rotate({ provider: 'test-prov-mid', model: 'test-model' }, pool)) {
    chunks.push(chunk);
  }

  assert.equal(chunks[0].text, 'Partial text emitted');
  const finishChunk = chunks[chunks.length - 1];
  assert.equal(finishChunk.type, 'finish');
  assert.equal(finishChunk.reason.kind, 'error');
  assert.equal(finishChunk.reason.failure.code, 'STREAM_STALLED');
  assert.ok(pool.state.failedUntil.has('KEY_MID_STALL'), 'Mid-stalled key must be penalized');
});

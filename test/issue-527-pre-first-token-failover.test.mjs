import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRotate, isContentChunk } from '../lib/rotate.js';
import { CircuitBreaker } from '../lib/circuit-breaker.js';

test('issue #527: isContentChunk accurately distinguishes visible tokens from stream metadata', () => {
  // Model visible content chunks
  assert.equal(isContentChunk({ type: 'text-delta', text: 'hi' }), true);
  assert.equal(isContentChunk({ type: 'reasoning-delta', reasoning: 'think' }), true);
  assert.equal(isContentChunk({ type: 'tool-call-delta', toolCall: {} }), true);
  assert.equal(isContentChunk({ delta: 'content' }), true);
  assert.equal(isContentChunk({ text: 'sample' }), true);
  assert.equal(isContentChunk({ choices: [{ delta: {} }] }), true);

  // Structural metadata chunks
  assert.equal(isContentChunk({ type: 'start' }), false);
  assert.equal(isContentChunk({ type: 'block-start' }), false);
  assert.equal(isContentChunk({ type: 'block-stop' }), false);
  assert.equal(isContentChunk({ type: 'response-metadata' }), false);
  assert.equal(isContentChunk({ type: 'usage' }), false);
  assert.equal(isContentChunk({ type: 'finish' }), false);
  assert.equal(isContentChunk(null), false);
  assert.equal(isContentChunk(undefined), false);
});

test('issue #527: pre-first-token failover transparently switches on 429/503 without leaking initial metadata chunks', async () => {
  const pool = {
    base: 'failover-provider',
    refs: ['KEY_FAILING', 'KEY_HEALTHY'],
    cooldownMs: 60000,
    state: {
      failedUntil: new Map(),
      pointer: 0,
      switches: 0,
      sessionSticky: new Map(),
    },
  };

  const runtime = {
    providerToPool: new Map([['failover-provider', pool]]),
    poolByRef: new Map([
      ['KEY_FAILING', pool],
      ['KEY_HEALTHY', pool],
    ]),
  };

  const dispatchStorage = new AsyncLocalStorage();
  const dispatchedKeys = [];

  const rotate = createRotate({
    ctx: {
      get: () => ({
        stream: (opts) => (async function* () {
          const currentKey = dispatchStorage.getStore()?.pickedRef ?? (dispatchedKeys.length === 0 ? 'KEY_FAILING' : 'KEY_HEALTHY');
          dispatchedKeys.push(currentKey);

          if (currentKey === 'KEY_FAILING') {
            // Emits metadata first, then aborts with 429 finish before any content token!
            yield { type: 'response-metadata', id: 'resp-1' };
            yield { type: 'block-start', block: 'message' };
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: {
                  code: '429',
                  message: 'Rate limit exceeded, please retry later',
                },
              },
            };
            return;
          }

          // Healthy key emits its own clean stream
          yield { type: 'response-metadata', id: 'resp-2' };
          yield { type: 'block-start', block: 'message' };
          yield { type: 'text-delta', text: 'Hello from healthy key!' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })(),
      }),
    },
    dispatchStorage,
    buildRuntime: () => runtime,
    pushEvent: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    recordLatency: () => {},
    finishError: (code, msg) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message: msg } } }),
    setRotateStartMs: () => {},
    circuitBreaker: null,
    now: () => 1000,
  });

  const receivedChunks = [];
  const stream = rotate({ provider: 'failover-provider', sessionId: 'test-session-1' }, pool);

  for await (const chunk of stream) {
    receivedChunks.push(chunk);
  }

  // 1. Both keys were dispatched (failover loop executed)
  assert.deepEqual(dispatchedKeys, ['KEY_FAILING', 'KEY_HEALTHY']);

  // 2. Client did NOT receive the abandoned metadata from KEY_FAILING!
  // Client only received resp-2 from the successful healthy key!
  const metadataIds = receivedChunks
    .filter((c) => c.type === 'response-metadata')
    .map((c) => c.id);
  assert.deepEqual(metadataIds, ['resp-2'], 'Metadata from failed attempt must be discarded');

  // 3. Exactly one block-start was received
  const blockStarts = receivedChunks.filter((c) => c.type === 'block-start');
  assert.equal(blockStarts.length, 1, 'Client must receive exactly one block-start');

  // 4. Text content delivered successfully
  const textDeltas = receivedChunks.filter((c) => c.type === 'text-delta');
  assert.equal(textDeltas.length, 1);
  assert.equal(textDeltas[0].text, 'Hello from healthy key!');

  // 5. Final finish is successful stop
  const finalChunk = receivedChunks[receivedChunks.length - 1];
  assert.equal(finalChunk.type, 'finish');
  assert.equal(finalChunk.reason.kind, 'stop');

  // 6. Failing key was penalized with cooldown
  assert.ok(pool.state.failedUntil.has('KEY_FAILING'));
  assert.equal(pool.state.switches, 1);
});

test('issue #527: failover is prevented once a content token has already yielded', async () => {
  const pool = {
    base: 'midstream-provider',
    refs: ['KEY_STREAM_FAIL', 'KEY_RESERVE'],
    state: {
      failedUntil: new Map(),
      pointer: 0,
      switches: 0,
      sessionSticky: new Map(),
    },
  };

  const runtime = {
    providerToPool: new Map([['midstream-provider', pool]]),
    poolByRef: new Map([
      ['KEY_STREAM_FAIL', pool],
      ['KEY_RESERVE', pool],
    ]),
  };

  const dispatchStorage = new AsyncLocalStorage();
  const dispatched = [];

  const rotate = createRotate({
    ctx: {
      get: () => ({
        stream: () => (async function* () {
          const key = dispatchStorage.getStore()?.pickedRef ?? 'KEY_STREAM_FAIL';
          dispatched.push(key);
          // Yields actual content token
          yield { type: 'text-delta', text: 'Partial text...' };
          // Then fails mid-stream
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { code: '503', message: 'Mid-stream connection broken' },
            },
          };
        })(),
      }),
    },
    dispatchStorage,
    buildRuntime: () => runtime,
    pushEvent: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    recordLatency: () => {},
    finishError: (code, msg) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message: msg } } }),
    setRotateStartMs: () => {},
    circuitBreaker: null,
    now: () => 1000,
  });

  const chunks = [];
  const stream = rotate({ provider: 'midstream-provider' }, pool);
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  // Once content has yielded, failover MUST NOT happen (cannot replay partially rendered reply)
  assert.deepEqual(dispatched, ['KEY_STREAM_FAIL'], 'Must not attempt failover after content was emitted');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, 'Partial text...');
  assert.equal(chunks[1].reason.kind, 'error');
});


import test from 'node:test';
import assert from 'node:assert/strict';
import { sortAttemptList, setSessionSticky, getSessionSticky } from '../lib/pool.js';
import { SessionRouter } from '../lib/session-router.js';
import { createResolver } from '../lib/resolver.js';
import { createRotate } from '../lib/rotate.js';
import { initializePoolState } from '../lib/pool-state.js';

test('GitHub #28: sortAttemptList distributes 4 parallel sessions across 4 keys in sticky mode', () => {
  const refs = ['KEY_1', 'KEY_2', 'KEY_3', 'KEY_4'];
  const pool = {
    refs,
    state: initializePoolState({
      lastUsed: 'KEY_1', // Existing traffic previously used KEY_1
    }),
  };

  // Session 1 arrives: should be assigned KEY_1
  const list1 = sortAttemptList(refs, 'sticky', {
    pool,
    sessionId: 'session-1',
  });
  assert.equal(list1[0], 'KEY_1', 'Session 1 gets KEY_1');
  assert.equal(getSessionSticky(pool, 'session-1'), 'KEY_1');

  // Session 2 arrives: must NOT collapse to lastUsed (KEY_1) — must distribute to KEY_2
  const list2 = sortAttemptList(refs, 'sticky', {
    pool,
    sessionId: 'session-2',
  });
  assert.equal(list2[0], 'KEY_2', 'Session 2 distributes to KEY_2');
  assert.equal(getSessionSticky(pool, 'session-2'), 'KEY_2');

  // Session 3 arrives: distributes to KEY_3
  const list3 = sortAttemptList(refs, 'sticky', {
    pool,
    sessionId: 'session-3',
  });
  assert.equal(list3[0], 'KEY_3', 'Session 3 distributes to KEY_3');
  assert.equal(getSessionSticky(pool, 'session-3'), 'KEY_3');

  // Session 4 arrives: distributes to KEY_4
  const list4 = sortAttemptList(refs, 'sticky', {
    pool,
    sessionId: 'session-4',
  });
  assert.equal(list4[0], 'KEY_4', 'Session 4 distributes to KEY_4');
  assert.equal(getSessionSticky(pool, 'session-4'), 'KEY_4');

  // Subsequent requests for each session stick to their assigned keys
  const list1_again = sortAttemptList(refs, 'sticky', { pool, sessionId: 'session-1' });
  assert.equal(list1_again[0], 'KEY_1', 'Session 1 retains affinity to KEY_1');

  const list2_again = sortAttemptList(refs, 'sticky', { pool, sessionId: 'session-2' });
  assert.equal(list2_again[0], 'KEY_2', 'Session 2 retains affinity to KEY_2');

  const list3_again = sortAttemptList(refs, 'sticky', { pool, sessionId: 'session-3' });
  assert.equal(list3_again[0], 'KEY_3', 'Session 3 retains affinity to KEY_3');

  const list4_again = sortAttemptList(refs, 'sticky', { pool, sessionId: 'session-4' });
  assert.equal(list4_again[0], 'KEY_4', 'Session 4 retains affinity to KEY_4');
});

test('GitHub #28: createResolver records and maintains sticky session affinity across multiple sessions', async () => {
  const refs = ['KEY_1', 'KEY_2', 'KEY_3', 'KEY_4'];
  const pool = {
    provider: 'openai-completions',
    base: 'openai-completions',
    refs,
    routingStrategy: 'sticky',
    state: initializePoolState({
      lastUsed: 'KEY_1',
    }),
  };

  const runtime = {
    routingStrategy: 'sticky',
    index: { allPools: [pool] },
    poolByRef: new Map(refs.map((r) => [r, pool])),
  };

  const pickedKeys = [];
  const resolver = createResolver({
    buildRuntime: () => runtime,
    currentPool: () => pool,
    onPicked: (p, cand) => {
      pickedKeys.push(cand);
    },
  });

  const mockOriginal = async (r) => ({ value: `secret-for-${r}` });

  // Resolve session 1
  const res1 = await resolver('KEY_1', mockOriginal, { sessionId: 'chat-sess-1' });
  assert.equal(res1.value, 'secret-for-KEY_1');
  assert.equal(getSessionSticky(pool, 'chat-sess-1'), 'KEY_1');

  // Resolve session 2 — should resolve KEY_2, NOT KEY_1
  const res2 = await resolver('KEY_1', mockOriginal, { sessionId: 'chat-sess-2' });
  assert.equal(res2.value, 'secret-for-KEY_2');
  assert.equal(getSessionSticky(pool, 'chat-sess-2'), 'KEY_2');

  // Resolve session 3 — should resolve KEY_3
  const res3 = await resolver('KEY_1', mockOriginal, { sessionId: 'chat-sess-3' });
  assert.equal(res3.value, 'secret-for-KEY_3');
  assert.equal(getSessionSticky(pool, 'chat-sess-3'), 'KEY_3');

  // Subsequent call for session 2 must stick to KEY_2
  const res2_again = await resolver('KEY_1', mockOriginal, { sessionId: 'chat-sess-2' });
  assert.equal(res2_again.value, 'secret-for-KEY_2');
});

test('GitHub #28: rotate() streaming distributes and records distinct sticky keys for 4 sessions', async () => {
  const refs = ['KEY_1', 'KEY_2', 'KEY_3', 'KEY_4'];
  const pool = {
    provider: 'openai-completions',
    refs,
    routingStrategy: 'sticky',
    state: initializePoolState({
      lastUsed: 'KEY_1',
    }),
  };

  const dispatchedKeys = [];
  const fakeCtx = {
    get: (svc) => {
      if (svc === 'credentials') {
        return {
          resolve: async (ref) => ({ value: `secret-${ref}` }),
        };
      }
      if (svc === 'llm') {
        return {
          stream: async function* (opts) {
            dispatchedKeys.push(opts._rotationKeyRef);
            yield { type: 'text-delta', delta: 'hello' };
            yield { type: 'finish', reason: { kind: 'stop' }, usage: { totalTokens: 10 } };
          },
        };
      }
      return null;
    },
  };

  const rotate = createRotate({
    ctx: fakeCtx,
    dispatchStorage: {
      run: (store, fn) => fn(),
      getStore: () => null,
    },
    buildRuntime: () => ({
      routingStrategy: 'sticky',
      switchCodes: ['RATE_LIMIT', '429'],
    }),
    pushEvent: () => {},
    recordLatency: () => {},
    latencyHistogram: { record: () => {} },
    MARKER: Symbol('MARKER'),
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    setRotateStartMs: () => {},
    now: () => 1000,
  });

  // Execute stream for Session 1
  const s1Chunks = [];
  for await (const chunk of rotate({ provider: 'openai-completions', sessionId: 'sess-alpha' }, pool)) {
    s1Chunks.push(chunk);
  }
  assert.equal(dispatchedKeys[0], 'KEY_1');

  // Execute stream for Session 2
  for await (const chunk of rotate({ provider: 'openai-completions', sessionId: 'sess-beta' }, pool)) {
    // drain
  }
  assert.equal(dispatchedKeys[1], 'KEY_2', 'Session 2 must dispatch to KEY_2, not KEY_1');

  // Execute stream for Session 3
  for await (const chunk of rotate({ provider: 'openai-completions', sessionId: 'sess-gamma' }, pool)) {
    // drain
  }
  assert.equal(dispatchedKeys[2], 'KEY_3', 'Session 3 must dispatch to KEY_3');

  // Execute stream for Session 4
  for await (const chunk of rotate({ provider: 'openai-completions', sessionId: 'sess-delta' }, pool)) {
    // drain
  }
  assert.equal(dispatchedKeys[3], 'KEY_4', 'Session 4 must dispatch to KEY_4');

  // Second stream for Session 2 must stick to KEY_2
  for await (const chunk of rotate({ provider: 'openai-completions', sessionId: 'sess-beta' }, pool)) {
    // drain
  }
  assert.equal(dispatchedKeys[4], 'KEY_2', 'Session 2 retains affinity to KEY_2');

  // Verify usageCounts recorded across keys
  assert.equal(pool.state.usageCounts.get('KEY_1'), 1);
  assert.equal(pool.state.usageCounts.get('KEY_2'), 2);
  assert.equal(pool.state.usageCounts.get('KEY_3'), 1);
  assert.equal(pool.state.usageCounts.get('KEY_4'), 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  extractSubagentContext,
  partitionPoolKeys,
} from '../lib/subagent-partitions.js';
import { ConcurrencyTracker } from '../lib/concurrency.js';
import { buildPools } from '../lib/pool-builder.js';
import { createRotate } from '../lib/rotate.js';
import { createResolver } from '../lib/resolver.js';

test('extractSubagentContext: detects subagent markers across options', () => {
  // 1. Direct options property
  assert.deepEqual(extractSubagentContext({ subagentId: 'sub-1' }), { isSubagent: true, subagentId: 'sub-1' });
  assert.equal(extractSubagentContext({ isSubagent: true }).isSubagent, true);
  assert.equal(extractSubagentContext({ subagent: true }).isSubagent, true);

  // 2. Metadata subagentId
  assert.deepEqual(extractSubagentContext({ metadata: { subagentId: 'worker-42' } }), { isSubagent: true, subagentId: 'worker-42' });

  // 3. ParentSessionId in metadata
  const parentRes = extractSubagentContext({ metadata: { parentSessionId: 'sess-parent-1', subagentId: 'child-1' } });
  assert.equal(parentRes.isSubagent, true);
  assert.equal(parentRes.parentSessionId, 'sess-parent-1');

  // 4. Session ID prefixes
  assert.equal(extractSubagentContext({ sessionId: 'subagent:search-task' }).isSubagent, true);
  assert.equal(extractSubagentContext({ sessionId: 'subtask:code-review' }).isSubagent, true);

  // 5. Tags
  assert.equal(extractSubagentContext({ tags: ['search', 'subagent'] }).isSubagent, true);

  // 6. Normal user session
  assert.equal(extractSubagentContext({ sessionId: 'chat-sess-123' }).isSubagent, false);
  assert.deepEqual(extractSubagentContext({}), { isSubagent: false });
  assert.deepEqual(extractSubagentContext(null), { isSubagent: false });
});

test('partitionPoolKeys: subagentReservedKeysCount partitions user and subagent attempts', () => {
  const pool = {
    subagentPartitionsEnabled: true,
    subagentReservedKeysCount: 1,
    subagentPartitionStrategy: 'shared-burst',
    refs: ['KEY_USER_1', 'KEY_USER_2', 'KEY_SUB_DEDICATED'],
  };

  const initialList = ['KEY_USER_1', 'KEY_USER_2', 'KEY_SUB_DEDICATED'];

  // Primary user request
  const userList = partitionPoolKeys(initialList, pool, {
    reqOptions: { sessionId: 'user-chat-1' },
  });
  // Primary keys first, subagent reserved key last
  assert.deepEqual(userList, ['KEY_USER_1', 'KEY_USER_2', 'KEY_SUB_DEDICATED']);

  // Subagent request
  const subList = partitionPoolKeys(initialList, pool, {
    reqOptions: { subagentId: 'sub-worker-1' },
  });
  // Dedicated subagent key first, shared user keys after
  assert.deepEqual(subList, ['KEY_SUB_DEDICATED', 'KEY_USER_1', 'KEY_USER_2']);
});

test('partitionPoolKeys: isolated strategy completely segregates pools', () => {
  const pool = {
    subagentPartitionsEnabled: true,
    subagentReservedKeysCount: 1,
    subagentPartitionStrategy: 'isolated',
    refs: ['KEY_MAIN_1', 'KEY_MAIN_2', 'KEY_SUB_ONLY'],
  };

  const initialList = ['KEY_MAIN_1', 'KEY_MAIN_2', 'KEY_SUB_ONLY'];

  // Subagent in isolated mode only gets dedicated key
  const subList = partitionPoolKeys(initialList, pool, {
    reqOptions: { isSubagent: true },
  });
  assert.deepEqual(subList, ['KEY_SUB_ONLY']);

  // User in isolated mode only gets main keys
  const userList = partitionPoolKeys(initialList, pool, {
    reqOptions: { isSubagent: false },
  });
  assert.deepEqual(userList, ['KEY_MAIN_1', 'KEY_MAIN_2']);
});

test('partitionPoolKeys: explicit labels configure dedicated partitions', () => {
  const pool = {
    subagentPartitionsEnabled: true,
    subagentPartitionStrategy: 'shared-burst',
    labels: {
      KEY_A: 'primary',
      KEY_B: 'subagent',
      KEY_C: 'subtask',
    },
    refs: ['KEY_A', 'KEY_B', 'KEY_C'],
  };

  const subList = partitionPoolKeys(['KEY_A', 'KEY_B', 'KEY_C'], pool, {
    reqOptions: { subagentId: 'indexer-task' },
  });

  // Dedicated subagent keys (KEY_B, KEY_C) must come before primary KEY_A
  assert.deepEqual(subList.slice(0, 2), ['KEY_B', 'KEY_C']);
  assert.equal(subList[2], 'KEY_A');
});

test('partitionPoolKeys: caps per-key subagent concurrency', () => {
  const pool = {
    subagentPartitionsEnabled: true,
    subagentReservedKeysCount: 2,
    subagentMaxConcurrencyPerKey: 2,
    refs: ['KEY_MAIN', 'KEY_SUB_1', 'KEY_SUB_2'],
  };

  const tracker = new ConcurrencyTracker({ limit: 10 });
  const now = 1000;
  // Saturate KEY_SUB_1 with 2 active requests
  tracker.acquire('KEY_SUB_1', now);
  tracker.acquire('KEY_SUB_1', now);
  // KEY_SUB_2 has 0 active requests
  assert.equal(tracker.getActive('KEY_SUB_1', now), 2);
  assert.equal(tracker.getActive('KEY_SUB_2', now), 0);

  const subList = partitionPoolKeys(['KEY_MAIN', 'KEY_SUB_1', 'KEY_SUB_2'], pool, {
    reqOptions: { isSubagent: true },
    concurrencyTracker: tracker,
    now,
  });

  // KEY_SUB_2 has free concurrency slots (< 2), so it comes before saturated KEY_SUB_1!
  assert.equal(subList[0], 'KEY_SUB_2');
  assert.deepEqual(subList, ['KEY_SUB_2', 'KEY_MAIN', 'KEY_SUB_1']);
});

test('partitionPoolKeys: records trace step on reordering', () => {
  const pool = {
    subagentPartitionsEnabled: true,
    subagentReservedKeysCount: 1,
    refs: ['KEY_MAIN', 'KEY_SUB'],
  };

  const steps = [];
  const trace = { addStep: (...args) => steps.push(args) };

  partitionPoolKeys(['KEY_MAIN', 'KEY_SUB'], pool, {
    reqOptions: { isSubagent: true },
    trace,
  });

  assert.equal(steps.length, 1);
  assert.equal(steps[0][0], 'KEY_SUB');
  assert.equal(steps[0][1], 'PRIORITIZED');
  assert.equal(steps[0][2], 'SUBAGENT_PARTITION');
});

test('resolver e2e: resolves distinct keys for primary and subagent requests', async () => {
  const poolState = new Map();
  const cfg = {
    providers: [
      {
        provider: 'test-prov-sub-res',
        keys: ['KEY_USER_CHAT', 'KEY_BACKGROUND_SUB'],
        subagentPartitionsEnabled: true,
        subagentReservedKeysCount: 1,
        subagentPartitionStrategy: 'isolated',
      },
    ],
  };

  const built = buildPools({ cfg, poolState });
  const pool = built.providerToPool.get('test-prov-sub-res');

  const resolve = createResolver({
    buildRuntime: () => ({ ...built, routingStrategy: 'round-robin' }),
    currentPool: () => pool,
    now: () => Date.now(),
  });

  // User chat resolves KEY_USER_CHAT
  const userRes = await resolve('KEY_USER_CHAT', async (ref) => ({ value: 'sec-' + ref }), { isSubagent: false });
  assert.equal(userRes.value, 'sec-KEY_USER_CHAT');

  // Subagent task resolves KEY_BACKGROUND_SUB
  const subRes = await resolve('KEY_USER_CHAT', async (ref) => ({ value: 'sec-' + ref }), { subagentId: 'sub-agent-99' });
  assert.equal(subRes.value, 'sec-KEY_BACKGROUND_SUB');
});

test('rotate e2e: streaming rotate prioritizes subagent partition for background task', async () => {
  const poolState = new Map();
  const cfg = {
    providers: [
      {
        provider: 'test-prov-sub-stream',
        keys: ['KEY_MAIN_CHAT', 'KEY_RESERVED_SUB'],
        subagentPartitionsEnabled: true,
        subagentReservedKeysCount: 1,
      },
    ],
  };

  const { providerToPool, poolByRef } = buildPools({ cfg, poolState });
  const pool = providerToPool.get('test-prov-sub-stream');

  const attempts = [];
  const mockCtx = {
    get(name) {
      if (name === 'llm') {
        return {
          stream: async function* (opts) {
            attempts.push(opts._rotationKeyRef);
            yield { type: 'text-delta', text: 'Subagent completed' };
            yield { type: 'finish' };
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
    }),
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    recordLatency: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    pushEvent: () => {},
    setRotateStartMs: () => {},
    circuitBreaker: null,
    MARKER: '__test_sub_stream_1',
  });

  const chunks = [];
  for await (const chunk of rotate({ provider: 'test-prov-sub-stream', metadata: { subagentId: 'researcher-agent-1' } }, pool)) {
    chunks.push(chunk);
  }

  // KEY_RESERVED_SUB was picked first because the request had subagent metadata!
  assert.deepEqual(attempts, ['KEY_RESERVED_SUB']);
  assert.equal(chunks[0].text, 'Subagent completed');
});

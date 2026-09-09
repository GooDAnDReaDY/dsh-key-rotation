import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';

const INDEX_SRC = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
const ROTATE_SRC = fs.readFileSync(new URL('../lib/rotate.js', import.meta.url), 'utf8');
const OPS_SRC = fs.readFileSync(new URL('../lib/routes-ops.js', import.meta.url), 'utf8');
const ALL_SRC = INDEX_SRC + '\n' + ROTATE_SRC + '\n' + OPS_SRC;

test('AsyncLocalStorage is imported from node:async_hooks and used for request isolation', () => {
  assert.match(ALL_SRC, /import\s*\{[^}]*AsyncLocalStorage[^}]*\}\s*from\s*['"]node:async_hooks['"]/, 'must import AsyncLocalStorage');
  assert.match(ALL_SRC, /const dispatchStorage = new AsyncLocalStorage\(\);/, 'must instantiate dispatchStorage');
  assert.match(ALL_SRC, /dispatchStorage\.run\(reqStore,\s*\(\)\s*=>\s*ctx\.llm\.stream/, 'must wrap stream dispatch in dispatchStorage.run');
});

test('compactUsage is imported and wired into 30s sweep effect', () => {
  assert.match(ALL_SRC, /import\s*\{[^}]*compactUsage[^}]*\}\s*from\s*['"]\.\/usage-report\.js['"]/, 'must import compactUsage');
  assert.match(ALL_SRC, /compactUsage\(pool,\s*30,\s*now\)/, 'must call compactUsage on pools during periodic sweep');
});

test('rotate() does not mutate pool.weightedRefs in place', () => {
  assert.doesNotMatch(ALL_SRC, /pool\.weightedRefs\s*=\s*list;/, 'must not mutate pool.weightedRefs');
  assert.match(ALL_SRC, /let attemptList = \(pool\.weightedRefs \?\? pool\.refs\)\.slice\(\);/, 'must copy candidates to local attemptList');
});

test('rotate() handles stream exception before content chunk with failover', () => {
  assert.match(ALL_SRC, /if \(!yielded && isSwitchableError\(e, effectiveSwitchCodes\)\)/, 'must check isSwitchableError on stream exception');
  assert.match(ALL_SRC, /continue;\s*\/\/\s*Failover to next key!/, 'must continue to next key on switchable stream exception');
});

test('recordLatency supports request-scoped startMs and pickedRef', () => {
  assert.match(ALL_SRC, /function recordLatency\(pool,\s*reqStore\)/, 'recordLatency must accept reqStore');
  assert.match(ALL_SRC, /const ref = reqStore\?\.pickedRef \?\? pool\?\.state\?\.lastUsed;/, 'recordLatency must prefer reqStore.pickedRef');
});

test('TEST_PATH auto-clears quarantine when probe succeeds', () => {
  assert.match(ALL_SRC, /if \(cached\.ok\) \{[\s\S]*?st\.failedUntil\?\.delete\(ref\)[\s\S]*?st\.brokenUntil\?\.delete\(ref\)/, 'successful probe must clear quarantine');
});

test('AsyncLocalStorage scopes pickedRef cleanly across concurrent dispatches', async () => {
  const storage = new AsyncLocalStorage();
  const pool = {
    state: {
      pointer: 0,
      lastUsed: 'OLD_KEY',
    },
    refs: ['KEY_A', 'KEY_B'],
  };

  async function simulateDispatch(candidate, delayMs) {
    const reqStore = { pool, pickedRef: undefined };
    return storage.run(reqStore, async () => {
      await new Promise(r => setTimeout(r, 10));
      // simulate credentials.resolve
      pool.state.lastUsed = candidate;
      const store = storage.getStore();
      if (store) store.pickedRef = candidate;

      await new Promise(r => setTimeout(r, delayMs));

      // verify that reqStore.pickedRef did not get corrupted by overlapping calls
      return {
        sharedLastUsed: pool.state.lastUsed,
        isolatedPickedRef: storage.getStore()?.pickedRef,
      };
    });
  }

  // Run Request 1 (slow, resolves KEY_A) and Request 2 (fast, resolves KEY_B) concurrently
  const [res1, res2] = await Promise.all([
    simulateDispatch('KEY_A', 50),
    simulateDispatch('KEY_B', 20),
  ]);

  // Request 2 finished before Request 1, so shared pool.state.lastUsed was mutated,
  // BUT each request context accurately preserved its own isolatedPickedRef!
  assert.equal(res1.isolatedPickedRef, 'KEY_A', 'Request 1 pickedRef must remain KEY_A');
  assert.equal(res2.isolatedPickedRef, 'KEY_B', 'Request 2 pickedRef must remain KEY_B');
});

test('Stream failover continues to next key on pre-yield exception', async () => {
  const attempts = [];
  async function* mockStream(candidate) {
    attempts.push(candidate);
    if (candidate === 'KEY_1') {
      const err = new Error('HTTP 429 Too Many Requests');
      err.code = 'RATE_LIMIT';
      throw err;
    }
    yield { type: 'text-delta', text: 'hello' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }

  const keys = ['KEY_1', 'KEY_2'];
  let yielded = false;
  let successKey = null;

  for (const k of keys) {
    try {
      for await (const chunk of mockStream(k)) {
        if (chunk.type === 'text-delta') {
          yielded = true;
          successKey = k;
        }
      }
      break;
    } catch (e) {
      if (!yielded && e.code === 'RATE_LIMIT') {
        continue; // failover
      }
      throw e;
    }
  }

  assert.equal(successKey, 'KEY_2');
  assert.deepEqual(attempts, ['KEY_1', 'KEY_2']);
});

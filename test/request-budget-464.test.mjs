import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestBudget, BUDGET_EXHAUSTED_TIMEOUT, BUDGET_EXHAUSTED_ATTEMPTS } from '../lib/request-budget.js';
import { createRotate } from '../lib/rotate.js';

test('Issue #464: RequestBudget unit tests', async (t) => {
  await t.test('createRequestBudget initializes with defaults', () => {
    const budget = createRequestBudget();
    assert.equal(budget.maxDurationMs, 0);
    assert.equal(budget.maxAttempts, 0);
    assert.equal(budget.isExpired(), false);
    assert.equal(budget.canAttempt(), true);
    assert.equal(budget.remainingMs(), Infinity);
    assert.equal(budget.getAttempts(), 0);
    budget.recordAttempt();
    assert.equal(budget.getAttempts(), 1);
    assert.equal(budget.canAttempt(), true);
    budget.dispose();
  });

  await t.test('maxAttempts limits dispatch count', () => {
    const budget = createRequestBudget({ maxAttempts: 2 });
    assert.equal(budget.canAttempt(), true);
    budget.recordAttempt();
    assert.equal(budget.canAttempt(), true);
    budget.recordAttempt();
    assert.equal(budget.canAttempt(), false);
    assert.throws(() => budget.recordAttempt(), (err) => {
      return err.code === BUDGET_EXHAUSTED_ATTEMPTS;
    });
    budget.dispose();
  });

  await t.test('caller AbortSignal triggers budget expiration and signal abortion', () => {
    const callerController = new AbortController();
    const budget = createRequestBudget({ signal: callerController.signal });
    assert.equal(budget.isExpired(), false);
    callerController.abort(new Error('User cancelled'));
    assert.equal(budget.isExpired(), true);
    assert.equal(budget.canAttempt(), false);
    assert.equal(budget.signal.aborted, true);
    budget.dispose();
  });

  await t.test('deadline timer aborts signal when duration is exceeded', async () => {
    const budget = createRequestBudget({ maxDurationMs: 30 });
    assert.equal(budget.isExpired(), false);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(budget.isExpired(), true);
    assert.equal(budget.canAttempt(), false);
    assert.equal(budget.signal.aborted, true);
    assert.equal(budget.signal.reason?.code, BUDGET_EXHAUSTED_TIMEOUT);
    budget.dispose();
  });
});

test('Issue #464: Rotate integration with request budget', async (t) => {
  function makeMockDeps(llmStreamFn) {
    const pool = {
      refs: ['key-1', 'key-2', 'key-3'],
      state: {
        failedUntil: new Map(),
        failCounts: new Map(),
        switches: 0,
      },
    };
    const ctx = {
      get(svc) {
        if (svc === 'llm') return { stream: llmStreamFn };
        return null;
      },
    };
    const dispatchStorage = {
      run(store, fn) { return fn(); }
    };
    const rotate = createRotate({
      ctx,
      dispatchStorage,
      buildRuntime: () => ({ switchCodes: ['RATE_LIMIT', 'TIMEOUT'], providerToPool: { mock: pool } }),
      pushEvent: () => {},
      notifySwitch: () => {},
      notifyExhaustion: () => {},
      recordLatency: () => {},
      latencyHistogram: { record: () => {} },
      concurrencyTracker: { isEnabled: () => false },
      MARKER: '__dshKeyRotation',
      finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
      setRotateStartMs: () => {},
      now: () => Date.now(),
    });
    return { rotate, pool };
  }

  await t.test('enforces maxAttempts budget across rotating keys', async () => {
    let dispatchCount = 0;
    const { rotate, pool } = makeMockDeps(async function* () {
      dispatchCount++;
      // Return a switchable error
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'rate limit' } } };
    });

    const stream = rotate({ provider: 'mock', maxAttempts: 2 }, pool);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    assert.equal(dispatchCount, 2, 'Must stop dispatching after 2 attempts even though pool has 3 keys');
    const lastChunk = chunks[chunks.length - 1];
    assert.equal(lastChunk?.type, 'finish');
    assert.equal(lastChunk?.reason?.failure?.code, BUDGET_EXHAUSTED_ATTEMPTS);
  });

  await t.test('enforces maxDurationMs budget when deadline expires', async () => {
    let dispatchCount = 0;
    const { rotate, pool } = makeMockDeps(async function* () {
      dispatchCount++;
      await new Promise((r) => setTimeout(r, 40));
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'rate limit' } } };
    });

    const stream = rotate({ provider: 'mock', maxDurationMs: 50 }, pool);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    assert.ok(dispatchCount >= 1, 'At least 1 dispatch attempted');
    assert.ok(dispatchCount < 3, 'Did not proceed through entire pool due to deadline');
    const lastChunk = chunks[chunks.length - 1];
    assert.equal(lastChunk?.type, 'finish');
    assert.equal(lastChunk?.reason?.failure?.code, BUDGET_EXHAUSTED_TIMEOUT);
  });
});

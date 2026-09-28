// test/dispatch-context.test.mjs — AsyncLocalStorage context must survive lazy
// credential resolution inside the upstream stream.
//
// Regression guard for a silent quota bypass: AsyncLocalStorage context is
// captured when an async generator is created, not when it is iterated. The
// upstream adapter resolves the credential from inside its generator body, so if
// rotate() iterated the inner stream without re-entering the dispatch store, the
// request-scoped model pool would be invisible to credentials.resolve() and
// local token budgets would never be enforced.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';

import { preserveDispatchContext } from '../lib/rotate.js';
import { createResolver } from '../lib/resolver.js';
import { buildPools } from '../lib/pool-builder.js';
import { consumeModelTokens } from '../lib/model-quota.js';

const WINDOW = { type: 'midnight_utc', hour: 0 };
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

test('preserveDispatchContext keeps the store visible during lazy resolution', async () => {
  const als = new AsyncLocalStorage();
  const store = { pool: 'sonnet' };
  const observed = [];

  // Mirrors the real adapter: the credential is resolved lazily, mid-iteration.
  async function* upstream() {
    observed.push(als.getStore()?.pool ?? null);
    await new Promise((r) => setTimeout(r, 1));
    observed.push(als.getStore()?.pool ?? null);
    yield { type: 'text-delta' };
    observed.push(als.getStore()?.pool ?? null);
    yield { type: 'finish' };
  }

  const inner = als.run(store, () => upstream());
  const out = [];
  for await (const chunk of preserveDispatchContext(inner, als, store)) out.push(chunk.type);

  assert.deepEqual(out, ['text-delta', 'finish']);
  assert.deepEqual(observed, ['sonnet', 'sonnet', 'sonnet'],
    'every step of the upstream stream runs with the dispatch store active');
});

test('without the wrapper the store is lost (documents why it exists)', async () => {
  const als = new AsyncLocalStorage();
  const store = { pool: 'sonnet' };
  const observed = [];
  async function* upstream() {
    observed.push(als.getStore()?.pool ?? null);
    yield 1;
  }
  const inner = als.run(store, () => upstream());
  for await (const _ of inner) { /* plain iteration */ }
  assert.deepEqual(observed, [null], 'plain for-await loses the context');
});

test('consumer cancellation still reaches the upstream iterator', async () => {
  const als = new AsyncLocalStorage();
  const store = { pool: 'sonnet' };
  let returned = false;

  async function* upstream() {
    try {
      yield 1;
      yield 2;
      yield 3;
    } finally {
      returned = true;
    }
  }

  const inner = als.run(store, () => upstream());
  const seen = [];
  for await (const value of preserveDispatchContext(inner, als, store)) {
    seen.push(value);
    if (value === 2) break; // early exit must still close the upstream stream
  }
  assert.deepEqual(seen, [1, 2]);
  assert.equal(returned, true, 'the inner generator was finalised');
});

test('an error thrown by the upstream stream propagates unchanged', async () => {
  const als = new AsyncLocalStorage();
  const store = { pool: 'sonnet' };
  async function* upstream() {
    yield 1;
    throw Object.assign(new Error('boom'), { code: 'TRANSPORT' });
  }
  const inner = als.run(store, () => upstream());
  const seen = [];
  await assert.rejects(async () => {
    for await (const v of preserveDispatchContext(inner, als, store)) seen.push(v);
  }, /boom/);
  assert.deepEqual(seen, [1]);
});

test('the model quota guard is enforced through lazy resolution end to end', async () => {
  // Key A is out of budget; a Sonnet request must not be able to reach it,
  // which is only true when the dispatch store survives lazy resolution.
  const built = buildPools({
    cfg: {
      quotaResetWindow: WINDOW,
      providers: [{
        provider: 'anthropic',
        keys: ['KEY_A', 'KEY_B'],
        models: {
          'claude-sonnet': {
            keys: ['KEY_A', 'KEY_B'],
            quotas: { KEY_A: { tokenLimit: 100 }, KEY_B: { tokenLimit: 100 } },
          },
        },
      }],
    },
    poolState: new Map(),
  });
  const sonnet = built.modelPoolByProvider.get('anthropic').get('claude-sonnet');
  consumeModelTokens(sonnet, 'KEY_A', 100, WINDOW, NOW);

  const als = new AsyncLocalStorage();
  const reqStore = { pool: sonnet, pickedRef: undefined };
  const store = new Map([['KEY_A', 'secret-A'], ['KEY_B', 'secret-B']]);
  const original = async (ref) => (store.has(ref) ? { value: store.get(ref) } : undefined);
  const resolve = createResolver({
    buildRuntime: () => ({ ...built, routingStrategy: 'round-robin', quotaResetWindow: WINDOW }),
    currentPool: () => als.getStore()?.pool ?? null,
    onPicked: (pool, candidate) => { if (als.getStore()?.pool === pool) als.getStore().pickedRef = candidate; },
    now: () => NOW,
  });

  // The adapter resolves the credential lazily, from inside the generator body.
  async function* llmStream() {
    const hit = await resolve('KEY_A', original);
    reqStore.resolvedRef = hit.value;
    yield { type: 'finish' };
  }

  const inner = als.run(reqStore, () => llmStream());
  for await (const _ of preserveDispatchContext(inner, als, reqStore)) { /* consume */ }

  assert.equal(reqStore.resolvedRef, 'secret-B', 'the exhausted key was skipped, not bypassed');
  assert.equal(reqStore.pickedRef, 'KEY_B', 'the picked ref was recorded on the request store');
});

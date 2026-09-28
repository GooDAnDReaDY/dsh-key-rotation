// test/rotate-accounting.test.mjs — the rotate() generator's model quota
// behaviour: accounting on a successful finish, and fail-closed refusal when
// every credential is out of local budget.
//
// Drives the real createRotate() with a stub llm service, so the shipped
// generator logic is what runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';

import { createRotate } from '../lib/rotate.js';
import { buildPools } from '../lib/pool-builder.js';
import { getModelTokenUsage, getModelTokenRemaining } from '../lib/model-quota.js';
import { nowMono } from '../lib/clock.js';

const WINDOW = { type: 'midnight_utc', hour: 0 };
const MARKER = '__dshKeyRotation';

/**
 * Build a rotate() instance backed by a scripted llm service.
 * `script` is a list of chunk arrays; each dispatch consumes the next entry.
 */
function makeRotate({ providers, script, credentialRefs }) {
  const cfg = { providers, quotaResetWindow: WINDOW, cooldownMs: 60000, switchCodes: ['QUOTA', 'RATE_LIMIT'] };
  const built = buildPools({ cfg, poolState: new Map() });
  const refs = credentialRefs ?? new Set(
    providers.flatMap((p) => [
      ...(p.keys ?? []),
      ...Object.values(p.models ?? {}).flatMap((m) => m.keys ?? []),
    ]),
  );
  const store = new Map([...refs].map((r) => [r, `secret-for-${r}`]));
  const dispatchStorage = new AsyncLocalStorage();
  const dispatched = [];
  let scriptIndex = 0;

  const llm = {
    stream(options) {
      const record = { provider: options.provider, model: options.model, pickedRef: null };
      dispatched.push(record);
      const chunks = script[Math.min(scriptIndex++, script.length - 1)] ?? [];
      return (async function* () {
        // Resolve the credential lazily, exactly as the real adapter does.
        const resolved = await credentials.resolve(options.apiKeyEnv ?? built.providerToPool.get(options.provider)?.refs?.[0]);
        record.pickedRef = resolved?.value ?? null;
        for (const chunk of chunks) yield chunk;
      })();
    },
  };

  const credentials = {
    async resolve(ref) {
      // The patched resolver is installed by lib/index.js; here we emulate it by
      // delegating to the same request-scoped pool the real one would consult.
      const pool = dispatchStorage.getStore()?.pool ?? null;
      if (pool) {
        const { createResolver } = await import('../lib/resolver.js');
        const resolve = createResolver({
          buildRuntime: () => runtime,
          currentPool: () => dispatchStorage.getStore()?.pool ?? null,
          onPicked: (p, candidate) => {
            const s = dispatchStorage.getStore();
            if (s && s.pool === p) s.pickedRef = candidate;
          },
        });
        return resolve(ref, async (r) => (store.has(r) ? { value: store.get(r) } : undefined));
      }
      return store.has(ref) ? { value: store.get(ref) } : undefined;
    },
  };

  const runtime = {
    ...built,
    switchCodes: cfg.switchCodes,
    cooldownMs: 60000,
    maxCooldownMs: undefined,
    switchNotify: false,
    rateLimitThreshold: 0.1,
    concurrencyLimit: 0,
    cascade: [],
    quotaResetWindow: WINDOW,
    routingStrategy: 'round-robin',
    proactiveRateLimitGuard: false,
    circuitBreakerEnabled: false,
    notifier: null,
  };

  const events = [];
  const rotate = createRotate({
    ctx: { get: (name) => (name === 'llm' ? llm : undefined) },
    dispatchStorage,
    buildRuntime: () => runtime,
    schedulePersist: () => {},
    pushEvent: (pool, ref, code, ms) => events.push({ ref, code, ms }),
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    recordLatency: () => {},
    latencyHistogram: { snapshot: () => null, record: () => {} },
    concurrencyTracker: { isEnabled: () => false, acquire: () => false, release: () => {}, getActive: () => 0, pickLeastLoaded: () => null },
    MARKER,
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: Object.freeze({ code, message }) } }),
    setRotateStartMs: () => {},
    quotaStore: null,
    circuitBreaker: null,
    now: nowMono,
    logger: { warn: () => {} },
  });

  const drain = async (options, pool) => {
    const out = [];
    for await (const chunk of rotate(options, pool)) out.push(chunk);
    return out;
  };

  return { ...built, runtime, rotate, drain, dispatched, events, credentials, store };
}

/** A successful finish chunk carrying provider-reported usage. */
const finishOk = (usage) => ({ type: 'finish', reason: { kind: 'stop' }, usage });

function sonnetConfig(limits = { KEY_A: 100, KEY_B: 100 }) {
  return [{
    provider: 'test-provider',
    keys: ['KEY_A', 'KEY_B'],
    models: {
      sonnet: { keys: ['KEY_A', 'KEY_B'], quotas: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, { tokenLimit: v }])) },
      opus: { keys: ['KEY_A', 'KEY_B'], quotas: { KEY_A: { tokenLimit: 50 }, KEY_B: { tokenLimit: 50 } } },
    },
  }];
}

test('a successful finish charges the usage the provider reported', async () => {
  const h = makeRotate({ providers: sonnetConfig(), script: [[finishOk({ total_tokens: 60 })]] });
  const sonnet = h.modelPoolByProvider.get('test-provider').get('sonnet');

  await h.drain({ provider: 'test-provider', model: 'sonnet' }, sonnet);

  const used = [...sonnet.state.tokenUsage.values()].reduce((a, e) => a + e.used, 0);
  assert.equal(used, 60, 'exactly the reported usage was charged');
  assert.equal(getModelTokenUsage(sonnet, 'KEY_A', Date.now()), 60);
  assert.equal(getModelTokenRemaining(sonnet, 'KEY_A', Date.now()), 40);
});

test('two Sonnet requests accumulate to exhaustion, then rotate; Opus unaffected', async () => {
  // The end-to-end acceptance scenario, driven through the real generator.
  const h = makeRotate({
    providers: sonnetConfig({ KEY_A: 100, KEY_B: 100 }),
    script: [[finishOk({ total_tokens: 60 })], [finishOk({ total_tokens: 50 })], [finishOk({ total_tokens: 20 })]],
  });
  const sonnet = h.modelPoolByProvider.get('test-provider').get('sonnet');
  const opus = h.modelPoolByProvider.get('test-provider').get('opus');
  const now = Date.now();

  // Pin the cursor so both Sonnet requests land on KEY_A.
  const pin = (pool, ref) => { pool.state.pointer = (pool.weightedRefs ?? pool.refs).indexOf(ref); };

  pin(sonnet, 'KEY_A');
  await h.drain({ provider: 'test-provider', model: 'sonnet' }, sonnet);
  pin(sonnet, 'KEY_A');
  await h.drain({ provider: 'test-provider', model: 'sonnet' }, sonnet);

  assert.equal(getModelTokenUsage(sonnet, 'KEY_A', now), 110, 'Sonnet/KEY_A used 110');
  assert.equal(getModelTokenRemaining(sonnet, 'KEY_A', now), 0, 'Sonnet/KEY_A exhausted');
  assert.equal(getModelTokenRemaining(sonnet, 'KEY_B', now), 100, 'Sonnet/KEY_B still available');

  // The next Sonnet request must go to KEY_B even with the cursor on KEY_A.
  pin(sonnet, 'KEY_A');
  const out = await h.drain({ provider: 'test-provider', model: 'sonnet' }, sonnet);
  assert.equal(out.at(-1).type, 'finish');
  const refs = h.dispatched.map((d) => d.pickedRef);
  assert.equal(refs.at(-1), 'secret-for-KEY_B', 'Sonnet rotated to KEY_B');

  // Opus is a different pool: KEY_A is still selectable and still funded.
  pin(opus, 'KEY_A');
  await h.drain({ provider: 'test-provider', model: 'opus' }, opus);
  assert.equal(h.dispatched.at(-1).pickedRef, 'secret-for-KEY_A', 'Opus still selects KEY_A');
  assert.equal(getModelTokenUsage(opus, 'KEY_A', now), 20, 'Opus/KEY_A used 20');
  assert.equal(getModelTokenRemaining(opus, 'KEY_A', now), 30, 'Opus/KEY_A remaining 30');
  assert.equal(getModelTokenUsage(sonnet, 'KEY_A', now), 110, 'Sonnet usage did not change');
});

test('a request with no usage payload charges nothing and cannot exhaust a key', async () => {
  const h = makeRotate({ providers: sonnetConfig({ KEY_A: 100, KEY_B: 100 }), script: [[finishOk(undefined)]] });
  const sonnet = h.modelPoolByProvider.get('test-provider').get('sonnet');
  await h.drain({ provider: 'test-provider', model: 'sonnet' }, sonnet);
  assert.equal(sonnet.state.tokenUsage.size, 0, 'no usage means no charge');
  assert.equal(getModelTokenRemaining(sonnet, 'KEY_A', Date.now()), 100);
});

test('an error terminal never charges tokens', async () => {
  const h = makeRotate({
    providers: sonnetConfig({ KEY_A: 100, KEY_B: 100 }),
    script: [[{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'boom' } }, usage: { total_tokens: 999 } }]],
  });
  const sonnet = h.modelPoolByProvider.get('test-provider').get('sonnet');
  await h.drain({ provider: 'test-provider', model: 'sonnet' }, sonnet);
  assert.equal(sonnet.state.tokenUsage.size, 0, 'a failed request is not billed');
});

test('FAIL CLOSED: an exhausted model pool sends no upstream request', async () => {
  const h = makeRotate({ providers: sonnetConfig({ KEY_A: 10, KEY_B: 10 }), script: [[finishOk({ total_tokens: 1 })]] });
  const sonnet = h.modelPoolByProvider.get('test-provider').get('sonnet');

  // Spend both keys' budgets directly.
  const { consumeModelTokens } = await import('../lib/model-quota.js');
  consumeModelTokens(sonnet, 'KEY_A', 10, WINDOW, Date.now());
  consumeModelTokens(sonnet, 'KEY_B', 10, WINDOW, Date.now());

  const before = h.dispatched.length;
  const out = await h.drain({ provider: 'test-provider', model: 'sonnet' }, sonnet);

  assert.equal(h.dispatched.length, before, 'no upstream llm.stream() call was made');
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'finish');
  assert.equal(out[0].reason.kind, 'error');
  assert.equal(out[0].reason.failure.code, 'LOCAL_MODEL_QUOTA_EXHAUSTED');
  assert.equal(/local token budget/.test(out[0].reason.failure.message), true);
  // A local budget is not an upstream failure: no cooldown was created.
  assert.equal(sonnet.state.failedUntil.size, 0, 'no credential was penalised');
});

test('a locally exhausted pool does not fabricate a provider failure penalty', async () => {
  const h = makeRotate({ providers: sonnetConfig({ KEY_A: 10, KEY_B: 10 }), script: [[finishOk({ total_tokens: 1 })]] });
  const sonnet = h.modelPoolByProvider.get('test-provider').get('sonnet');
  const { consumeModelTokens } = await import('../lib/model-quota.js');
  consumeModelTokens(sonnet, 'KEY_A', 10, WINDOW, Date.now());
  consumeModelTokens(sonnet, 'KEY_B', 10, WINDOW, Date.now());

  await h.drain({ provider: 'test-provider', model: 'sonnet' }, sonnet);
  assert.equal(sonnet.state.failCounts.size, 0);
  assert.equal(sonnet.state.authFailCounts.size, 0);
  assert.equal(sonnet.state.brokenUntil.size, 0);
  assert.equal(h.events.length, 0, 'no switch/failure events were pushed');
});

test('a pool with no quotas behaves exactly as before', async () => {
  const h = makeRotate({
    providers: [{ provider: 'test-provider', keys: ['KEY_A', 'KEY_B'], models: { sonnet: { keys: ['KEY_A', 'KEY_B'] } } }],
    script: [[finishOk({ total_tokens: 500 })], [finishOk({ total_tokens: 500 })]],
  });
  const sonnet = h.modelPoolByProvider.get('test-provider').get('sonnet');
  const now = Date.now();
  await h.drain({ provider: 'test-provider', model: 'sonnet' }, sonnet);
  await h.drain({ provider: 'test-provider', model: 'sonnet' }, sonnet);

  assert.equal(sonnet.state.tokenUsage.size, 0, 'no quota state is invented');
  assert.equal(h.dispatched.length, 2);
  assert.equal(h.dispatched.map((d) => d.pickedRef).join(','), 'secret-for-KEY_A,secret-for-KEY_B',
    'plain round-robin rotation is unchanged');
  assert.equal(getModelTokenRemaining(sonnet, 'KEY_A', now), null, 'unlimited');
});

test('concurrent overshoot is bounded and never corrupts state', async () => {
  // Two in-flight requests may both spend from a nearly empty budget: with a
  // single credential there is no sibling to rotate to, so both are dispatched
  // against a limit of 100 and each reports 80. That overshoot is accepted
  // behaviour in this version. What must never happen is NaN, a negative counter,
  // or a key that stays usable afterwards.
  const h = makeRotate({
    providers: [{
      provider: 'test-provider',
      keys: ['KEY_A'],
      models: { sonnet: { keys: ['KEY_A'], quotas: { KEY_A: { tokenLimit: 100 } } } },
    }],
    script: [[finishOk({ total_tokens: 80 })], [finishOk({ total_tokens: 80 })]],
  });
  const sonnet = h.modelPoolByProvider.get('test-provider').get('sonnet');
  const before = sonnet.state.tokenUsage.get('KEY_A')?.used ?? 0;

  await Promise.all([
    h.drain({ provider: 'test-provider', model: 'sonnet' }, sonnet),
    h.drain({ provider: 'test-provider', model: 'sonnet' }, sonnet),
  ]);

  const used = getModelTokenUsage(sonnet, 'KEY_A', Date.now());
  assert.equal(Number.isFinite(used), true, 'never NaN');
  assert.ok(used >= 0, 'never negative');
  assert.equal(used, before + 160, 'both concurrent requests were billed');
  assert.ok(used > 100, 'the bounded overshoot exceeds the configured limit');
  assert.equal(getModelTokenRemaining(sonnet, 'KEY_A', Date.now()), 0);
  assert.equal(h.dispatched.length, 2, 'both requests were actually dispatched');
});

test('a single exhausted credential stops further dispatches immediately', async () => {
  const h = makeRotate({
    providers: [{
      provider: 'test-provider',
      keys: ['KEY_A'],
      models: { sonnet: { keys: ['KEY_A'], quotas: { KEY_A: { tokenLimit: 100 } } } },
    }],
    script: [[finishOk({ total_tokens: 150 })], [finishOk({ total_tokens: 10 })]],
  });
  const sonnet = h.modelPoolByProvider.get('test-provider').get('sonnet');

  // First request overshoots the limit in a single response.
  await h.drain({ provider: 'test-provider', model: 'sonnet' }, sonnet);
  assert.equal(getModelTokenUsage(sonnet, 'KEY_A', Date.now()), 150);

  const before = h.dispatched.length;
  const out = await h.drain({ provider: 'test-provider', model: 'sonnet' }, sonnet);
  assert.equal(h.dispatched.length, before, 'the exhausted key is not dispatched again');
  assert.equal(out[0].reason.failure.code, 'LOCAL_MODEL_QUOTA_EXHAUSTED');
});

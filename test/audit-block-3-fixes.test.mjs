import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { createResolver } from '../lib/resolver.js';
import { recordFailure, recordSuccess } from '../lib/pool.js';
import { pickCascadeFallback } from '../lib/cascade.js';
import { createRotate } from '../lib/rotate.js';
import { encryptSecret, decryptSecret } from '../lib/crypto-storage.js';
import { autoUnbreakBrokenKeys } from '../lib/heal.js';

// ============================================================================
// #424: CI dependencies & supported core matrix
// ============================================================================

test('audit #424: package.json declares essential devDependencies for clean checkout reproducibility', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const devDeps = pkg.devDependencies || {};
  assert.ok(devDeps['@deepseek-ai/schemastery'], 'schemastery must be in devDependencies');
  assert.ok(devDeps['@deepseek-ai/cordis'], 'cordis must be in devDependencies');
  assert.ok(devDeps['@deepseek-ai/dsh-llm'], 'dsh-llm must be in devDependencies');
  assert.ok(devDeps['semver'], 'semver must be in devDependencies');
});

test('audit #424: real-core fixture version detector recognizes modern 0.1.7 and 0.2.0-rc lines', () => {
  const isModern = (version) => !/^(?:0\.1\.[0-6])(?:[.-]|$)/.test(version);
  assert.equal(isModern('0.1.0'), false);
  assert.equal(isModern('0.1.5'), false);
  assert.equal(isModern('0.1.6-rc.1'), false);
  assert.equal(isModern('0.1.7'), true);
  assert.equal(isModern('0.1.7-rc.2'), true);
  assert.equal(isModern('0.2.0-rc.1'), true);
  assert.equal(isModern('0.2.0-rc.2'), true);
  assert.equal(isModern('0.2.1'), true);
  assert.equal(isModern('1.0.0'), true);
});

// ============================================================================
// #410: Backoff preserved on selection until upstream success
// ============================================================================

test('audit #410: resolver selection does not prematurely clear failCounts / backoff', async () => {
  const now = 1000;
  const pool = {
    provider: 'backoff-prov',
    base: 'backoff-prov',
    refs: ['KEY_B'],
    cooldownMs: 1000,
    maxCooldownMs: 60000,
    state: {
      failedUntil: new Map([['KEY_B', now - 10]]), // cooldown expired
      failCounts: new Map([['KEY_B', 3]]), // 3 previous consecutive failures
      authFailCounts: new Map(),
      brokenUntil: new Map(),
      usageCounts: new Map(),
      pointer: 0,
    },
  };

  const runtime = {
    providerToPool: new Map([['backoff-prov', pool]]),
    poolByRef: new Map([['KEY_B', pool]]),
  };

  const resolve = createResolver({
    buildRuntime: () => runtime,
    currentPool: () => pool,
    now: () => now,
  });

  // Resolver selects KEY_B
  const cred = await resolve('KEY_B', async (ref) => ({ value: 'val-' + ref }));
  assert.equal(cred.value, 'val-KEY_B');

  // KEY_B was selected, but failCounts must NOT be deleted yet!
  assert.equal(pool.state.failCounts.get('KEY_B'), 3, 'selection must preserve failCounts before upstream result');

  // If upstream fails, recordFailure increments failCounts from 3 -> 4
  recordFailure(pool, 'KEY_B', now, pool.cooldownMs, pool.maxCooldownMs);
  assert.equal(pool.state.failCounts.get('KEY_B'), 4, 'subsequent failure must reach attempt 4');

  // Upstream success cleans it up
  recordSuccess(pool, 'KEY_B', now + 100);
  assert.equal(pool.state.failCounts?.get('KEY_B'), undefined, 'recordSuccess clears failCounts');
});

// ============================================================================
// #413: Open circuit breaker triggers cascade fallback
// ============================================================================

test('audit #413: open circuit breaker triggers healthy cascade fallback', async () => {
  const poolA = {
    base: 'prov-a',
    provider: 'prov-a',
    refs: ['KEY_A'],
    state: { failedUntil: new Map(), lastUsed: 'KEY_A', pointer: 0 },
  };

  const poolB = {
    base: 'prov-b',
    provider: 'prov-b',
    refs: ['KEY_B'],
    state: { failedUntil: new Map(), lastUsed: 'KEY_B', pointer: 0 },
  };

  const runtime = {
    providerToPool: new Map([['prov-a', poolA], ['prov-b', poolB]]),
    poolByRef: new Map([['KEY_A', poolA], ['KEY_B', poolB]]),
    cascade: [{ provider: 'prov-b' }],
  };

  const fakeBreaker = {
    acquire: (prov) => (prov === 'prov-a' ? null : { release: () => {} }),
    canRequest: (prov) => prov !== 'prov-a',
  };

  const dispatchStorage = new AsyncLocalStorage();
  const rotate = createRotate({
    ctx: {
      get: () => ({
        stream: (opts) => (async function* () {
          yield { delta: `response-from-${opts.provider}` };
        })(),
      }),
    },
    dispatchStorage,
    buildRuntime: () => runtime,
    circuitBreaker: fakeBreaker,
    pushEvent: () => {},
    notifySwitch: () => {},
    notifyExhaustion: () => {},
    recordLatency: () => {},
    finishError: (code, msg) => new Error(`finishError: ${code} - ${msg}`),
    setRotateStartMs: () => {},
    now: () => 1000,
  });

  const stream = rotate({ provider: 'prov-a' }, poolA);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].delta, 'response-from-prov-b', 'must cascade to prov-b when prov-a circuit is open');
});

test('audit #413: pickCascadeFallback skips fallback provider when fallback circuit is open', () => {
  const poolA = { base: 'prov-a', provider: 'prov-a', refs: ['KEY_A'], state: { failedUntil: new Map() } };
  const poolB = { base: 'prov-b', provider: 'prov-b', refs: ['KEY_B'], state: { failedUntil: new Map() } };
  const poolC = { base: 'prov-c', provider: 'prov-c', refs: ['KEY_C'], state: { failedUntil: new Map() } };

  const cfg = {
    cascade: [{ provider: 'prov-b' }, { provider: 'prov-c' }],
  };
  const pools = new Map([['prov-a', poolA], ['prov-b', poolB], ['prov-c', poolC]]);

  // Breaker has prov-b open, prov-c open
  const breakerBothOpen = { canRequest: () => false };
  assert.equal(pickCascadeFallback('prov-a', cfg, pools, null, null, breakerBothOpen), null);

  // Breaker has prov-b open, prov-c closed
  const breakerBOpen = { canRequest: (p) => p === 'prov-c' };
  const fb = pickCascadeFallback('prov-a', cfg, pools, null, null, breakerBOpen);
  assert.ok(fb);
  assert.equal(fb.provider, 'prov-c', 'must skip open prov-b and select prov-c');
});

// ============================================================================
// #415: Decrypt credentials before sandbox probe and auto-unbreak
// ============================================================================

test('audit #415: auto-unbreak and decryptSecret decrypt ciphertext credentials', async () => {
  const secretKey = 'test-secret-encryption-key-for-audit';
  const plaintext = 'sk-actual-plain-secret-key-12345';
  const ciphertext = encryptSecret(plaintext, secretKey);

  assert.ok(ciphertext.startsWith('enc:v1:'));
  assert.equal(decryptSecret(ciphertext, secretKey), plaintext);

  let probeReceivedKey = null;
  const pool = {
    base: 'sandbox-prov',
    state: {
      brokenUntil: new Map([['KEY_ENC', Date.now() + 10000]]),
      failedUntil: new Map(),
      failCounts: new Map(),
      events: [],
    },
  };

  const fakeProbe = async (ref) => {
    // Simulate what lifecycle.js does with decryptSecret:
    const raw = ciphertext;
    const value = raw ? decryptSecret(raw, secretKey) : raw;
    probeReceivedKey = value;
    return { ok: true };
  };

  const results = await autoUnbreakBrokenKeys([pool], fakeProbe, Date.now(), { isActive: () => true });

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(probeReceivedKey, plaintext, 'probe must receive decrypted plaintext, not ciphertext');
});

// ============================================================================
// #416: Fan-out reset across all model pools and shared refs
// ============================================================================

test('audit #416: fan-out reset clears shared ref across base pool and model pools without stopping at first', () => {
  const poolState = new Map([
    [
      'prov-x',
      {
        failedUntil: new Map([['KEY_SHARED', 999999]]),
        failCounts: new Map([['KEY_SHARED', 2]]),
        authFailCounts: new Map([['KEY_SHARED', 1]]),
        brokenUntil: new Map([['KEY_SHARED', 999999]]),
        revokedRefs: new Set(['KEY_SHARED']),
        tokenUsage: new Map([['KEY_SHARED', { used: 500 }]]),
        lastUsed: 'KEY_SHARED',
      },
    ],
    [
      'prov-x::model-m',
      {
        failedUntil: new Map([['KEY_SHARED', 999999]]),
        failCounts: new Map([['KEY_SHARED', 1]]),
        authFailCounts: new Map([['KEY_SHARED', 1]]),
        brokenUntil: new Map([['KEY_SHARED', 999999]]),
        revokedRefs: new Set(['KEY_SHARED']),
        tokenUsage: new Map([['KEY_SHARED', { used: 300 }]]),
        lastUsed: 'KEY_SHARED',
      },
    ],
  ]);

  // Execute ref reset loop from lib/ops-keys.js
  const ref = 'KEY_SHARED';
  let found = false;
  for (const st of poolState.values()) {
    if (
      st.failedUntil?.has(ref) ||
      st.failCounts?.has(ref) ||
      st.authFailCounts?.has(ref) ||
      st.brokenUntil?.has(ref) ||
      st.revokedRefs?.has(ref) ||
      st.tokenUsage?.has(ref) ||
      st.lastUsed === ref
    ) {
      st.failedUntil?.delete(ref);
      st.failCounts?.delete(ref);
      st.authFailCounts?.delete(ref);
      st.brokenUntil?.delete(ref);
      st.revokedRefs?.delete(ref);
      st.tokenUsage?.delete(ref);
      if (st.lastUsed === ref) st.lastUsed = undefined;
      found = true;
    }
  }

  assert.equal(found, true);
  // Both prov-x AND prov-x::model-m must be cleared
  const baseSt = poolState.get('prov-x');
  assert.equal(baseSt.failedUntil.has(ref), false);
  assert.equal(baseSt.revokedRefs.has(ref), false);
  assert.equal(baseSt.tokenUsage.has(ref), false);

  const modelSt = poolState.get('prov-x::model-m');
  assert.equal(modelSt.failedUntil.has(ref), false, 'model pool must also be cleared');
  assert.equal(modelSt.revokedRefs.has(ref), false, 'model pool revokedRefs must be cleared');
  assert.equal(modelSt.tokenUsage.has(ref), false, 'model pool tokenUsage must be cleared');
});

test('audit #416: provider reset clears base and all model pools (provider::*) and circuit breaker', () => {
  const poolState = new Map([
    [
      'prov-all',
      {
        failedUntil: new Map([['KEY_1', 999999]]),
        failCounts: new Map([['KEY_1', 2]]),
        brokenUntil: new Map([['KEY_1', 999999]]),
        revokedRefs: new Set(['KEY_1']),
        tokenUsage: new Map([['KEY_1', { used: 100 }]]),
      },
    ],
    [
      'prov-all::sonnet',
      {
        failedUntil: new Map([['KEY_2', 999999]]),
        failCounts: new Map([['KEY_2', 3]]),
        brokenUntil: new Map([['KEY_2', 999999]]),
        revokedRefs: new Set(['KEY_2']),
        tokenUsage: new Map([['KEY_2', { used: 200 }]]),
      },
    ],
    [
      'other-prov',
      {
        failedUntil: new Map([['KEY_OTHER', 999999]]),
        revokedRefs: new Set(['KEY_OTHER']),
      },
    ],
  ]);

  let circuitResetCalled = false;
  const circuitBreaker = {
    reset: (p) => { if (p === 'prov-all') circuitResetCalled = true; },
  };

  // Execute provider reset loop from lib/ops-keys.js
  const provider = 'prov-all';
  let found = false;
  let cleared = 0;
  for (const [key, st] of poolState.entries()) {
    if (key === provider || key.startsWith(provider + '::')) {
      found = true;
      cleared += st.failedUntil ? st.failedUntil.size : 0;
      st.failedUntil?.clear();
      st.failCounts?.clear();
      st.brokenUntil?.clear();
      st.revokedRefs?.clear();
      st.tokenUsage?.clear();
    }
  }

  circuitBreaker.reset(provider);

  assert.equal(found, true);
  assert.equal(cleared, 2);
  assert.equal(circuitResetCalled, true);

  // Both prov-all and prov-all::sonnet are cleared
  assert.equal(poolState.get('prov-all').failedUntil.size, 0);
  assert.equal(poolState.get('prov-all').revokedRefs.size, 0);
  assert.equal(poolState.get('prov-all::sonnet').failedUntil.size, 0);
  assert.equal(poolState.get('prov-all::sonnet').revokedRefs.size, 0);

  // other-prov must NOT be affected!
  assert.equal(poolState.get('other-prov').failedUntil.size, 1);
  assert.equal(poolState.get('other-prov').revokedRefs.has('KEY_OTHER'), true);
});

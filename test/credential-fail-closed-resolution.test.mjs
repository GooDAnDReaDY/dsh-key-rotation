import test from 'node:test';
import assert from 'node:assert/strict';
import { createResolver } from '../lib/resolver.js';
import { createPoolIndex, addProviderPools } from '../lib/pool-index.js';
import { encryptSecret, decryptSecretFailClosed } from '../lib/crypto-storage.js';

test('Issue #579 - decryptSecretFailClosed throws on corrupted payload or wrong secret', () => {
  const secretKey = 'test-secret-key-12345';
  const plain = 'sk-valid-api-key-value-9999';
  const enc = encryptSecret(plain, secretKey);

  assert.ok(enc.startsWith('enc:v1:'));
  assert.equal(decryptSecretFailClosed(enc, secretKey), plain);

  // Mismatched secret key throws
  assert.throws(() => {
    decryptSecretFailClosed(enc, 'wrong-secret-key');
  }, /authenticate data|auth tag/i);

  // Corrupted ciphertext payload throws
  assert.throws(() => {
    decryptSecretFailClosed('enc:v1:badpayload', secretKey);
  }, /Malformed encrypted secret payload/i);
});

test('Issue #579 - resolver fails closed and skips corrupted encrypted keys to healthy keys', async () => {
  const secretKey = 'my-dsh-master-key';
  process.env.DSH_KEY_SECRET = secretKey;

  const validKey = 'sk-healthy-key-tail-1234';
  const corruptedEncKey = 'enc:v1:001122:334455:badhexdata'; // malformed auth tag length

  const mockPool = {
    base: 'deepseek',
    provider: 'deepseek',
    refs: ['KEY_CORRUPTED', 'KEY_HEALTHY'],
    strategy: 'round-robin',
    cooldownMs: 60000,
    state: {
      pointer: 0,
      brokenUntil: new Map(),
      failedUntil: new Map(),
      pausedRefs: new Set(),
      lastUsed: null,
    },
  };

  const storedKeys = new Map([
    ['KEY_CORRUPTED', corruptedEncKey],
    ['KEY_HEALTHY', validKey],
  ]);

  const originalResolver = async (ref) => {
    const val = storedKeys.get(ref);
    return val ? { value: val } : null;
  };

  const mockIndex = createPoolIndex();
  addProviderPools(mockIndex, 'deepseek', mockPool, []);

  const deps = {
    buildRuntime: () => ({
      index: mockIndex,
      pools: [mockPool],
      poolByRef: mockIndex.poolByRef,
    }),
    concurrencyTracker: {
      tryAcquire: () => true,
      release: () => {},
    },
  };

  const resolve = createResolver(deps);

  // Resolving should skip KEY_CORRUPTED because it fails closed, and return KEY_HEALTHY
  const result = await resolve('KEY_CORRUPTED', originalResolver);
  assert.ok(result);
  assert.equal(result.value, validKey);
  // KEY_CORRUPTED is quarantined in brokenUntil
  assert.ok(mockPool.state.brokenUntil.has('KEY_CORRUPTED'));
});

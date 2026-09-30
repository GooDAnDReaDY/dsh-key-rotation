import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateOrReservedIp, assertSafeUrl } from '../lib/safe-fetch.js';
import { createResolver, LOCAL_POOL_EXHAUSTED_CODE } from '../lib/resolver.js';
import { buildPools } from '../lib/pool-builder.js';
import { isKeyPaused, isKeyRevoked } from '../lib/pool.js';
import { StatePersistence } from '../lib/persistence.js';
import { tpmRecord } from '../lib/bucket.js';

// --- #411 SSRF ---
test('audit #411: IPv4-mapped IPv6 loopbacks (hex and dotted) are blocked', async () => {
  assert.equal(isPrivateOrReservedIp('::ffff:7f00:1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:7f00:0001'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('0:0:0:0:0:ffff:7f00:1'), true);

  await assert.rejects(
    assertSafeUrl('https://[::ffff:7f00:1]/audit'),
    /private or reserved/
  );
  await assert.rejects(
    assertSafeUrl('https://[::ffff:127.0.0.1]/audit'),
    /private or reserved/
  );
});

// --- #406 Resolver fail-closed ---
test('audit #406: resolver fail-closed throws LOCAL_POOL_EXHAUSTED when all pool keys are blocked', async () => {
  const cfg = {
    providers: [
      {
        provider: 'failclosed-prov',
        keys: ['KEY_A', 'KEY_B'],
        rpmLimit: 1,
        tpmLimit: 100,
        expiresAt: { KEY_A: 100, KEY_B: 100 },
      },
    ],
  };

  const built = buildPools({ cfg });
  const pool = built.providerToPool.get('failclosed-prov');
  const now = 1000;
  let originalCalls = 0;
  const original = async (ref) => {
    originalCalls++;
    return { value: 'secret-' + ref };
  };

  const resolve = createResolver({
    buildRuntime: () => ({ ...built, routingStrategy: 'round-robin' }),
    currentPool: () => pool,
    now: () => now,
  });

  // Scenario 1: Expired keys
  await assert.rejects(
    resolve('KEY_A', original),
    (err) => {
      assert.equal(err.code, LOCAL_POOL_EXHAUSTED_CODE);
      assert.equal(err.localExhausted, true);
      return true;
    }
  );
  assert.equal(originalCalls, 0, 'must not call original when pool keys are expired');

  // Scenario 2: Active keys but on cooldown
  pool.expiresAt = { KEY_A: 999999, KEY_B: 999999 };
  pool.state.failedUntil.set('KEY_A', now + 60000);
  pool.state.failedUntil.set('KEY_B', now + 60000);
  await assert.rejects(
    resolve('KEY_A', original),
    (err) => err.code === LOCAL_POOL_EXHAUSTED_CODE
  );
  assert.equal(originalCalls, 0, 'must not call original when pool keys are on cooldown');

  // Scenario 3: TPM exceeded
  pool.state.failedUntil.clear();
  tpmRecord(pool.state.tpmWindows, 'KEY_A', 200, now);
  tpmRecord(pool.state.tpmWindows, 'KEY_B', 200, now);
  await assert.rejects(
    resolve('KEY_A', original),
    (err) => err.code === LOCAL_POOL_EXHAUSTED_CODE
  );
  assert.equal(originalCalls, 0, 'must not call original when pool keys are over TPM');

  // Scenario 4: Unmanaged ref outside pool still passes to original
  const unmanaged = await resolve('UNKNOWN_REF', original);
  assert.equal(unmanaged.value, 'secret-UNKNOWN_REF');
  assert.equal(originalCalls, 1, 'unmanaged refs fall back to original');
});

// --- #408 Model pools inherit pause, revoke, and expiry ---
test('audit #408: model pools inherit paused, revoked, and expiry from base provider', async () => {
  const cfg = {
    providers: [
      {
        provider: 'shared-prov',
        keys: ['KEY_1', 'KEY_2'],
        paused: ['KEY_1'],
        revoked: ['KEY_2'],
        expiresAt: { KEY_1: 500, KEY_2: 500 },
        models: {
          'model-x': {
            keys: ['KEY_1', 'KEY_2'],
          },
        },
      },
    ],
  };

  const { providerToPool, modelPoolByProvider } = buildPools({ cfg });
  const basePool = providerToPool.get('shared-prov');
  const modelPool = modelPoolByProvider.get('shared-prov').get('model-x');

  assert.equal(isKeyPaused(modelPool, 'KEY_1'), true, 'model pool inherits paused from base');
  assert.equal(isKeyRevoked(modelPool, 'KEY_2'), true, 'model pool inherits revoked from base');
  assert.equal(modelPool.expiresAt?.KEY_1, 500, 'model pool inherits expiresAt from base');
  assert.equal(modelPool.basePool, basePool, 'model pool points to basePool');
});

// --- #409 StatePersistence preserves revokedRefs, Infinity, and spend ---
test('audit #409: StatePersistence preserves revokedRefs, Infinity failedUntil, and cost maps', () => {
  const poolState = new Map();
  const st = {
    failedUntil: new Map([
      ['KEY_ACTIVE', 1700000000],
      ['KEY_REVOKED', Infinity],
    ]),
    revokedRefs: new Set(['KEY_REVOKED']),
    pointer: 1,
    lastUsed: 'KEY_ACTIVE',
    costDays: new Map([['2026-09-30', 4.52]]),
    costPerKey: new Map([['KEY_ACTIVE', 4.52]]),
    usageDays: new Map([['2026-09-30', 12]]),
    usageCounts: new Map([['KEY_ACTIVE', 12]]),
  };
  poolState.set('test-prov', st);

  const snapshot = StatePersistence.serialize({ poolState });
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.pools['test-prov'].failedUntil.KEY_REVOKED, 'Infinity');
  assert.deepEqual(snapshot.pools['test-prov'].revokedRefs, ['KEY_REVOKED']);
  assert.equal(snapshot.pools['test-prov'].costDays['2026-09-30'], 4.52);

  const restored = new Map();
  const count = StatePersistence.restorePools(restored, snapshot);
  assert.equal(count, 1);

  const rSt = restored.get('test-prov');
  assert.equal(rSt.failedUntil.get('KEY_REVOKED'), Infinity);
  assert.equal(rSt.revokedRefs.has('KEY_REVOKED'), true);
  assert.equal(rSt.costDays.get('2026-09-30'), 4.52);
  assert.equal(rSt.costPerKey.get('KEY_ACTIVE'), 4.52);
  assert.equal(rSt.usageDays.get('2026-09-30'), 12);
  assert.equal(rSt.usageCounts.get('KEY_ACTIVE'), 12);
});

// --- #412 Reorder keys preserves paused, revoked, weights, expiry ---
test('audit #412: client.js reorderKeys keeps paused, revoked, weights, and expiry aligned with refs', () => {
  const entry = {
    keys: ['KEY_A', 'KEY_B'],
    weights: [10, 20],
    expiresAt: [1000, 2000],
    paused: [true, false],
    revoked: [true, false],
  };

  // Reordering [1, 0] -> KEY_B, KEY_A
  const order = [1, 0];
  const next = { ...entry, keys: order.map((i) => entry.keys[i]) };
  for (const [field, fallback] of [['weights', 1], ['expiresAt', 0], ['paused', false], ['revoked', false]]) {
    if (Array.isArray(entry[field]) && entry[field].length) {
      next[field] = order.map((i) => entry[field][i] ?? fallback);
    }
  }

  assert.deepEqual(next.keys, ['KEY_B', 'KEY_A']);
  assert.deepEqual(next.weights, [20, 10]);
  assert.deepEqual(next.expiresAt, [2000, 1000]);
  assert.deepEqual(next.paused, [false, true], 'paused flag must follow KEY_A to index 1');
  assert.deepEqual(next.revoked, [false, true], 'revoked flag must follow KEY_A to index 1');
});

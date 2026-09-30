import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tpmAllow,
  tpmRecord,
  tpmRetryMs,
  tpmSweep,
  tpmInfo,
} from '../lib/bucket.js';
import { buildPools } from '../lib/pool-builder.js';
import { createResolver } from '../lib/resolver.js';
import { sanitizeSnapshot } from '../lib/sanitize-snapshot.js';

test('tpmAllow & tpmRecord: sliding 60-second window token bucket', () => {
  const windows = new Map();
  const ref = 'TEST_KEY_1';
  const limit = 5000;
  const t0 = 1000000;

  // Initially empty -> allowed
  assert.equal(tpmAllow(windows, ref, limit, t0), true);
  assert.equal(tpmRetryMs(windows, ref, limit, t0), 0);

  // Consume 3000 tokens
  tpmRecord(windows, ref, 3000, t0);
  assert.equal(tpmAllow(windows, ref, limit, t0 + 1000), true);

  const info1 = tpmInfo(windows, ref, limit, t0 + 1000);
  assert.equal(info1.used, 3000);
  assert.equal(info1.remaining, 2000);
  assert.equal(info1.limit, 5000);
  assert.equal(info1.resetMs, 0);

  // Consume another 2500 tokens at t0 + 5000 -> total 5500 >= 5000 (exceeded)
  tpmRecord(windows, ref, 2500, t0 + 5000);
  assert.equal(tpmAllow(windows, ref, limit, t0 + 6000), false);

  const info2 = tpmInfo(windows, ref, limit, t0 + 6000);
  assert.equal(info2.used, 5500);
  assert.equal(info2.remaining, 0);
  assert.ok(info2.resetMs > 0);

  // tpmRetryMs should wait until the first 3000 tokens expire (t0 + 60000)
  // At t0 + 60000, remaining will be 2500 < 5000 -> allowable again!
  const expectedWait = (t0 + 60000) - (t0 + 6000);
  assert.equal(tpmRetryMs(windows, ref, limit, t0 + 6000), expectedWait);

  // After 60.1s from t0, first batch has expired
  const tAfter = t0 + 60100;
  assert.equal(tpmAllow(windows, ref, limit, tAfter), true);
  const info3 = tpmInfo(windows, ref, limit, tAfter);
  assert.equal(info3.used, 2500);
  assert.equal(info3.remaining, 2500);
});

test('tpmSweep: cleans up removed keys', () => {
  const windows = new Map();
  tpmRecord(windows, 'KEY_A', 100, 1000);
  tpmRecord(windows, 'KEY_B', 200, 1000);
  assert.equal(windows.size, 2);

  tpmSweep(windows, new Set(['KEY_A']));
  assert.equal(windows.has('KEY_A'), true);
  assert.equal(windows.has('KEY_B'), false);
});

test('buildPools configures tpmLimit per provider and per model', () => {
  const cfg = {
    tpmLimit: 10000,
    providers: [
      {
        provider: 'openai',
        keys: ['OPENAI_KEY_1', 'OPENAI_KEY_2'],
        tpmLimit: 50000,
        models: {
          'gpt-4o': {
            keys: ['OPENAI_KEY_1'],
            tpmLimit: 20000,
          },
        },
      },
      {
        provider: 'anthropic',
        keys: ['ANTHROPIC_KEY_1'],
      },
    ],
  };

  const { providerToPool, modelPoolByProvider } = buildPools({ cfg });
  const openAiPool = providerToPool.get('openai');
  assert.equal(openAiPool.tpmLimit, 50000);

  const anthropicPool = providerToPool.get('anthropic');
  assert.equal(anthropicPool.tpmLimit, 10000, 'falls back to global tpmLimit');

  const gpt4Pool = modelPoolByProvider.get('openai')?.get('gpt-4o');
  assert.equal(gpt4Pool.tpmLimit, 20000, 'model specific tpmLimit takes precedence');
});

test('resolver: fails over to next key when tpmLimit is exhausted', async () => {
  const cfg = {
    providers: [
      {
        provider: 'deepseek',
        keys: ['KEY_1', 'KEY_2'],
        tpmLimit: 1000,
      },
    ],
  };

  const built = buildPools({ cfg });
  const pool = built.providerToPool.get('deepseek');
  const t0 = 1000000;

  // Key 1 has used 1200 tokens (exceeded 1000 limit)
  tpmRecord(pool.state.tpmWindows, 'KEY_1', 1200, t0);

  const original = async (ref) => ({ value: 'secret-' + ref });
  const runtime = {
    ...built,
    routingStrategy: 'round-robin',
  };

  const resolve = createResolver({
    buildRuntime: () => runtime,
    currentPool: () => pool,
    now: () => t0,
  });

  // When resolving KEY_1, KEY_1 is over TPM limit, so it must pick KEY_2
  const picked = await resolve('KEY_1', original);
  assert.ok(picked, 'should successfully resolve key');
  assert.equal(picked.value, 'secret-KEY_2', 'must fail over to KEY_2');
  assert.ok(pool.state.failedUntil.get('KEY_1') > t0, 'KEY_1 must be placed on retry cooldown');
});

test('sanitizeSnapshot: sanitizes tpm info cleanly', () => {
  const snapshot = {
    providers: [
      {
        provider: 'test',
        keys: [
          {
            ref: 'KEY_1',
            tpm: {
              used: 1500,
              remaining: 3500,
              limit: 5000,
              resetMs: 12000,
            },
          },
          {
            ref: 'KEY_2',
            tpm: {
              used: -50,
              remaining: -10,
              limit: 5000,
              resetMs: -5,
            },
          },
        ],
      },
    ],
  };

  const sanitized = sanitizeSnapshot(snapshot);
  const k1 = sanitized.providers[0].keys[0];
  assert.equal(k1.tpm.used, 1500);
  assert.equal(k1.tpm.remaining, 3500);
  assert.equal(k1.tpm.limit, 5000);

  const k2 = sanitized.providers[0].keys[1];
  assert.equal(k2.tpm.used, 0, 'clamped negative');
  assert.equal(k2.tpm.remaining, 0, 'clamped negative');
});

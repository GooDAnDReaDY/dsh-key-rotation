import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createResolver } from '../lib/resolver.js';
import { buildPools } from '../lib/pool-builder.js';
import { pushDiag, getDiagBuffer } from '../lib/ops-telemetry.js';
import { DIAG_PATH, KEY_PATH } from '../lib/ops-paths.js';

test('Issue #459: Semver triplet peerDependencies in package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const peer = pkg.peerDependencies['@deepseek-ai/dsh-llm'];
  assert.ok(peer.includes('<0.2.1-0'), 'Peer dependency should use <0.2.1-0 upper bound');
  assert.ok(peer.includes('>=0.2.0-rc.1'), 'Peer dependency should accept >=0.2.0-rc.1');
});

test('Issue #455: Key pinning (pinnedRef) with resilient cooldown/quota bypass', async () => {
  const cfg = {
    providers: [
      {
        provider: 'test-pinned',
        keys: ['KEY_A', 'KEY_B', 'KEY_C'],
        pinnedRef: 'KEY_B',
      },
    ],
  };

  const poolState = new Map();
  const { providerToPool, poolByRef } = buildPools({ cfg, poolState });
  const pool = providerToPool.get('test-pinned');
  assert.equal(pool.pinnedRef, 'KEY_B');

  let now = 1000;
  const runtime = {
    routingStrategy: 'round-robin',
    index: null,
    providerToPool,
    poolByRef,
  };

  const resolve = createResolver({
    buildRuntime: () => runtime,
    currentPool: () => pool,
    now: () => now,
  });

  // 1. When pinned key is healthy, resolver picks KEY_B
  const res1 = await resolve('KEY_A', async (ref) => ({ value: `secret-${ref}` }));
  assert.equal(res1.value, 'secret-KEY_B', 'Should resolve pinned key KEY_B');

  // 2. When pinned key is cooling, resolver automatically bypasses pin and falls back to remaining keys
  pool.state.failedUntil.set('KEY_B', 2000);
  const res2 = await resolve('KEY_A', async (ref) => ({ value: `secret-${ref}` }));
  assert.notEqual(res2.value, 'secret-KEY_B', 'Should bypass cooling pinned key');
  assert.ok(['secret-KEY_A', 'secret-KEY_C'].includes(res2.value), 'Should pick alternative healthy key');
});

test('Issue #456: User-defined key labels (labels array aligned with keys)', () => {
  const cfg = {
    providers: [
      {
        provider: 'test-labels',
        keys: ['KEY_ONE', 'KEY_TWO'],
        labels: ['Personal Pro Account', 'Team Shared Quota'],
      },
    ],
  };

  const { providerToPool } = buildPools({ cfg });
  const pool = providerToPool.get('test-labels');
  assert.equal(pool.labels['KEY_ONE'], 'Personal Pro Account');
  assert.equal(pool.labels['KEY_TWO'], 'Team Shared Quota');
});

test('Issue #457: Plaintext key reveal endpoint (GET /dsh-key-rotation/key)', async () => {
  assert.equal(KEY_PATH, '/dsh-key-rotation/key');
  const code = readFileSync(new URL('../lib/ops-keys.js', import.meta.url), 'utf8');
  assert.ok(code.includes("req.method === 'GET'"), 'GET handler must be present');
  assert.ok(code.includes('decryptSecret(raw)'), 'Must decrypt raw secret');
  assert.ok(code.includes('isTrustedBridgeRequest(req)'), 'Must guard with trusted bridge');
});

test('Issue #458: In-memory client diagnostics ring buffer (/dsh-key-rotation/diag)', () => {
  assert.equal(DIAG_PATH, '/dsh-key-rotation/diag');
  const initialCount = getDiagBuffer().length;
  pushDiag({ level: 'error', message: 'Client fetch failed', details: { url: '/status' } });
  const buffer = getDiagBuffer();
  assert.equal(buffer.length, initialCount + 1);
  const last = buffer[buffer.length - 1];
  assert.equal(last.level, 'error');
  assert.equal(last.message, 'Client fetch failed');
  assert.equal(last.details.url, '/status');
  assert.ok(typeof last.timestamp === 'number');
});

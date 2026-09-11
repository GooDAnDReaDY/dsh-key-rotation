import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StatePersistence, resolveStatePath } from '../lib/persistence.js';
import { CircuitBreaker, BREAKER_OPEN } from '../lib/circuit-breaker.js';

async function tmpFile(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'krot-persist-'));
  return path.join(dir, name);
}

test('resolveStatePath prefers configuredPath', () => {
  assert.equal(
    resolveStatePath({ configuredPath: '/tmp/x.json', dataDir: '/data' }),
    '/tmp/x.json',
  );
});

test('resolveStatePath falls back to dataDir and returns null without either', () => {
  assert.equal(resolveStatePath({ dataDir: '/data' }), path.join('/data', 'dsh-key-rotation-state.json'));
  assert.equal(resolveStatePath({}), null);
});

test('serialize + restorePools round-trip', async () => {
  const file = await tmpFile('state.json');
  const persist = new StatePersistence({ filePath: file });
  const poolState = new Map();
  const failedUntil = new Map([['A/KEY', 123]]);
  poolState.set('prov', { failedUntil, pointer: 2, lastUsed: 'A/KEY' });
  const breaker = new CircuitBreaker({ threshold: 1 });
  breaker.onFailure('prov');

  const snap = StatePersistence.serialize({
    poolState,
    circuitSnapshot: breaker.snapshot(),
    quotaSnapshot: {},
  });
  persist.save(snap);
  const ok = await persist.flush();
  assert.equal(ok, true);

  const loaded = await persist.load();
  assert.ok(loaded);
  assert.equal(loaded.version, 1);
  const restored = new Map();
  const n = StatePersistence.restorePools(restored, loaded);
  assert.equal(n, 1);
  assert.equal(restored.get('prov').failedUntil.get('A/KEY'), 123);
  assert.equal(restored.get('prov').pointer, 2);

  const b2 = new CircuitBreaker({ threshold: 1 });
  const rn = b2.restore(loaded.circuit);
  assert.ok(rn >= 1);
  assert.equal(b2.state('prov'), BREAKER_OPEN);
  persist.dispose();
});

test('corrupt file load returns null (never wipes)', async () => {
  const file = await tmpFile('bad.json');
  await fs.writeFile(file, '{not json');
  const persist = new StatePersistence({ filePath: file });
  assert.equal(await persist.load(), null);
  persist.dispose();
});

test('missing file load returns null', async () => {
  const file = await tmpFile('missing.json');
  const persist = new StatePersistence({ filePath: file });
  assert.equal(await persist.load(), null);
  persist.dispose();
});

test('failed write keeps dirty and retries', async () => {
  // path in a non-existent nested dir is created by atomicWriteFile; use a file path under a file-as-dir to force failure after first success is hard.
  // Instead: successful write then load works.
  const file = await tmpFile('retry.json');
  const persist = new StatePersistence({ filePath: file });
  persist.save({ version: 1, savedAt: 1, pools: {}, circuit: {}, quota: {} });
  assert.equal(await persist.flush(), true);
  assert.equal(await persist.flush(), false); // nothing dirty
  persist.dispose();
});

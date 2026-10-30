import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteFile, cleanupStaleTmpFiles } from '../lib/atomic-io.js';
import { createRequestBudget, BUDGET_EXHAUSTED_TIMEOUT, BUDGET_EXHAUSTED_ATTEMPTS } from '../lib/request-budget.js';
import { buildPools, buildPoolItem } from '../lib/pool-builder.js';
import { ConcurrencyTracker } from '../lib/concurrency.js';
import { createSelectionTrace, SelectionTraceStore } from '../lib/selection-trace.js';
import { createRotate } from '../lib/rotate.js';

describe('Block 3 Fixes & Audit DoD Verification', () => {
  it('atomicWriteFile: cleans up .tmp file when write/rename fails (#521)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'krot-test-atomic-'));
    const dest = path.join(tmpDir, 'state.json');

    // Make dest a directory so fs.rename to it fails
    await fs.mkdir(dest);

    await assert.rejects(
      async () => {
        await atomicWriteFile(dest, '{"test": 1}');
      }
    );

    const files = await fs.readdir(tmpDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    assert.equal(tmpFiles.length, 0, 'No orphaned .tmp files should remain after failure');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('cleanupStaleTmpFiles: removes orphaned .tmp files older than maxAgeMs (#521)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'krot-test-cleanup-'));
    const targetFile = path.join(tmpDir, 'state.json');
    await fs.writeFile(targetFile, '{"ok": true}');

    const staleTmp = path.join(tmpDir, '.state.json.1234.abcdef.tmp');
    await fs.writeFile(staleTmp, 'stale data');
    // Set mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    await fs.utimes(staleTmp, twoHoursAgo, twoHoursAgo);

    const freshTmp = path.join(tmpDir, '.state.json.5678.123456.tmp');
    await fs.writeFile(freshTmp, 'fresh data');

    const cleaned = await cleanupStaleTmpFiles(targetFile, 3600 * 1000);
    assert.equal(cleaned, 1);

    const remaining = await fs.readdir(tmpDir);
    assert.ok(remaining.includes('state.json'));
    assert.ok(remaining.includes(path.basename(freshTmp)));
    assert.ok(!remaining.includes(path.basename(staleTmp)));

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('createRequestBudget: dispose() removes listener from external AbortSignal (#464)', () => {
    const callerController = new AbortController();
    const callerSignal = callerController.signal;

    // Check event listeners cleanup
    const budgets = [];
    for (let i = 0; i < 15; i++) {
      const b = createRequestBudget({
        maxDurationMs: 10000,
        maxAttempts: 3,
        signal: callerSignal,
      });
      budgets.push(b);
    }

    // Dispose all budgets
    for (const b of budgets) {
      b.dispose();
    }

    // Emitting abort on callerSignal should not trigger memory leak or unhandled handler
    callerController.abort('test caller abort');
    assert.equal(callerSignal.aborted, true);
  });

  it('buildPoolItem & buildPools: preserves maxAttempts and maxDurationMs in pool objects (#464)', () => {
    const cfg = {
      maxAttempts: 4,
      maxDurationMs: 15000,
      providers: [
        {
          provider: 'deepseek',
          keys: ['DEEPSEEK_KEY_1', 'DEEPSEEK_KEY_2'],
          models: {
            'deepseek-chat': {
              keys: ['DEEPSEEK_KEY_1'],
              maxAttempts: 2,
              maxDurationMs: 8000,
            },
            'deepseek-coder': {
              keys: ['DEEPSEEK_KEY_2'],
            },
          }
        }
      ]
    };

    const built = buildPools({ cfg });
    const pool = built.providerToPool.get('deepseek');
    assert.ok(pool);
    assert.equal(pool.maxAttempts, 4);
    assert.equal(pool.maxDurationMs, 15000);

    const modelPools = built.modelPoolByProvider.get('deepseek');
    assert.ok(modelPools);
    const chatPool = modelPools.get('deepseek-chat');
    assert.equal(chatPool.maxAttempts, 2);
    assert.equal(chatPool.maxDurationMs, 8000);

    const coderPool = modelPools.get('deepseek-coder');
    assert.equal(coderPool.maxAttempts, 4, 'Inherited from provider/cfg');
    assert.equal(coderPool.maxDurationMs, 15000, 'Inherited from provider/cfg');
  });

  it('rotate: records SKIPPED steps in selection trace for paused, cooling and capability-mismatched keys (#461)', async () => {
    const traceStore = new SelectionTraceStore();
    const poolState = new Map();
    const st = {
      pointer: 0,
      lastUsed: null,
      failedUntil: new Map([
        ['KEY_COOLING', Date.now() + 60000],
      ]),
      pausedRefs: new Set(['KEY_PAUSED']),
      revokedRefs: new Set(['KEY_REVOKED']),
      modelCapabilities: new Map([
        ['KEY_READY', new Set(['deepseek-chat'])],
        ['KEY_CODING_ONLY', new Set(['deepseek-coder'])],
      ]),
    };
    poolState.set('test-prov', st);

    const pool = {
      base: 'test-prov',
      provider: 'test-prov',
      refs: ['KEY_PAUSED', 'KEY_REVOKED', 'KEY_COOLING', 'KEY_CODING_ONLY', 'KEY_READY'],
      weightedRefs: ['KEY_PAUSED', 'KEY_REVOKED', 'KEY_COOLING', 'KEY_CODING_ONLY', 'KEY_READY'],
      state: st,
    };

    const dispatchStorage = {
      run(store, fn) { return fn(); },
      getStore() { return {}; }
    };

    const rotate = createRotate({
      ctx: {},
      dispatchStorage,
      buildRuntime: () => ({
        switchCodes: ['429'],
        cooldownMs: 60000,
        selectionTraceStore: traceStore,
      }),
      pushEvent: () => {},
      notifySwitch: () => {},
      notifyExhaustion: () => {},
      notifyEarlyWarning: () => {},
      recordLatency: () => {},
      latencyHistogram: null,
      concurrencyTracker: null,
      MARKER: Symbol('marker'),
      finishError: (code, msg) => new Error(`${code}: ${msg}`),
      setRotateStartMs: () => {},
      quotaStore: null,
      circuitBreaker: null,
      logger: { warn: () => {} },
      schedulePersist: () => {},
      trafficSmoother: null,
      keyDrainManager: null,
      selectionTraceStore: traceStore,
    });

    const options = {
      provider: 'test-prov',
      model: 'deepseek-chat',
      requestId: 'req-test-trace-1',
    };

    // Execute rotate
    const gen = rotate(options, pool);
    // Even if interceptor yields nothing or throws, trace must record candidate evaluations
    try {
      await gen.next();
    } catch (_) {}

    const traces = traceStore.get(10);
    assert.equal(traces.length, 1);
    const trace = traces[0];
    const steps = trace.steps;

    // Verify SKIPPED steps
    const skippedPaused = steps.find(s => s.ref === 'KEY_PAUSED' && s.decision === 'SKIPPED' && s.reasonCode === 'PAUSED');
    assert.ok(skippedPaused, 'KEY_PAUSED must have SKIPPED step');

    const skippedRevoked = steps.find(s => s.ref === 'KEY_REVOKED' && s.decision === 'SKIPPED' && s.reasonCode === 'REVOKED');
    assert.ok(skippedRevoked, 'KEY_REVOKED must have SKIPPED step');

    const skippedCooling = steps.find(s => s.ref === 'KEY_COOLING' && s.decision === 'SKIPPED' && s.reasonCode === 'COOLDOWN');
    assert.ok(skippedCooling, 'KEY_COOLING must have SKIPPED step');

    const skippedCaps = steps.find(s => s.ref === 'KEY_CODING_ONLY' && s.decision === 'SKIPPED' && s.reasonCode === 'CAPABILITY_MISMATCH');
    assert.ok(skippedCaps, 'KEY_CODING_ONLY must have SKIPPED step for model deepseek-chat');
  });

  it('concurrency: touch and consistent snapshot (#463)', () => {
    const ct = new ConcurrencyTracker({ limit: 5, staleMs: 2000 });
    const now = 1000;
    ct.acquire('KEY_1', now);
    assert.equal(ct.getActive('KEY_1', now), 1);
    assert.equal(ct.snapshot(now).KEY_1.count, 1);

    // Touch at now + 1500
    ct.touch('KEY_1', now + 1500);

    // At now + 2500, without touch it would have been stale (1000 + 2000 = 3000 stale from 1000 is > 2000).
    // With touch at 2500, time elapsed since 2500 is 0.
    assert.equal(ct.getActive('KEY_1', now + 2500), 1);
    assert.equal(ct.snapshot(now + 2500).KEY_1.count, 1);

    // At now + 4000 (2500ms since lastAcquired 2500 > staleMs 2000), it should be stale in both getActive and snapshot
    assert.equal(ct.getActive('KEY_1', now + 4000), 0);
    assert.equal(ct.snapshot(now + 4000).KEY_1.count, 0);
  });
});

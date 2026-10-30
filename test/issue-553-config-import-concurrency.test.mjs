// test/issue-553-config-import-concurrency.test.mjs — verify config-import optimistic concurrency & revision conflict handling (#553).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { registerConfigIoRoutes } from '../lib/ops-config-io.js';
import { CONFIG_IMPORT_PATH } from '../lib/ops-paths.js';

test('Issue #553: config-import dry-run returns revision and apply verifies expectedRevision with 409 conflict', async () => {
  const routes = new Map();
  let currentRevision = 10;
  let settingsValue = {
    providers: [{ provider: 'openai', strategy: 'round-robin', cooldownMs: 30000, keys: ['KEY1'] }],
  };
  let replaceCalledWith = null;

  const mockSettings = {
    describe: () => [{
      ns: 'dsh-key-rotation',
      revision: currentRevision,
      value: settingsValue,
    }],
    replace: async (ns, newVal, expectedRev) => {
      if (expectedRev !== undefined && expectedRev !== currentRevision) {
        const err = new Error(`SETTINGS_CONFLICT: expected ${expectedRev}, actual ${currentRevision}`);
        err.code = 'SETTINGS_CONFLICT';
        err.expected = expectedRev;
        err.actual = currentRevision;
        throw err;
      }
      currentRevision++;
      settingsValue = newVal;
      replaceCalledWith = { ns, newVal, expectedRev };
    },
  };

  const ctx = {
    effect: (fn) => fn(),
    webServer: {
      register: ({ path, handler }) => {
        routes.set(path, handler);
      },
    },
    get: (key) => (key === 'settings' ? mockSettings : undefined),
  };

  registerConfigIoRoutes(ctx, {
    buildRuntime: () => ({ cfg0: settingsValue, pools: [] }),
  });

  const importHandler = routes.get(CONFIG_IMPORT_PATH);
  assert.ok(importHandler, 'config-import handler must be registered');

  const makeReqRes = (bodyObj) => {
    const stream = Readable.from([Buffer.from(JSON.stringify(bodyObj))]);
    stream.method = 'POST';
    stream.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };
    stream.socket = { remoteAddress: '127.0.0.1' };

    let status = 0;
    let resData = null;
    const res = {
      writeHead: (s) => { status = s; },
      end: (d) => {
        try { resData = JSON.parse(d); } catch { resData = d; }
      },
    };
    return { req: stream, res, getStatus: () => status, getData: () => resData };
  };

  // 1. Dry run returns current revision
  {
    const { req, res, getStatus, getData } = makeReqRes({
      config: { cooldownMs: 15000 },
      mode: 'merge',
      dryRun: true,
    });
    await importHandler(req, res);
    assert.equal(getStatus(), 200);
    assert.equal(getData().ok, true);
    assert.equal(getData().dryRun, true);
    assert.equal(getData().revision, 10, 'dry-run must return current revision');
  }

  // 2. Invalid expectedRevision returns 400 Bad Request
  {
    const { req, res, getStatus, getData } = makeReqRes({
      config: { cooldownMs: 15000 },
      mode: 'merge',
      expectedRevision: -1,
      dryRun: false,
    });
    await importHandler(req, res);
    assert.equal(getStatus(), 400);
    assert.equal(getData().error.code, 'bad-request');
  }

  // 3. Stale preview: settings changed from revision 10 -> 11 concurrently
  currentRevision = 11;
  {
    const { req, res, getStatus, getData } = makeReqRes({
      config: { cooldownMs: 15000 },
      mode: 'merge',
      expectedRevision: 10, // Preview was made at revision 10
      dryRun: false,
    });
    await importHandler(req, res);
    assert.equal(getStatus(), 409, 'must reject stale apply with 409 Conflict');
    assert.equal(getData().error.code, 'conflict');
    assert.equal(getData().error.currentRevision, 11);
    assert.equal(replaceCalledWith, null, 'settings.replace must not be called on conflict');
  }

  // 4. Apply with matching expectedRevision succeeds
  {
    const { req, res, getStatus, getData } = makeReqRes({
      config: { cooldownMs: 20000 },
      mode: 'merge',
      expectedRevision: 11,
      dryRun: false,
    });
    await importHandler(req, res);
    assert.equal(getStatus(), 200);
    assert.equal(getData().ok, true);
    assert.equal(getData().applied, true);
    assert.equal(replaceCalledWith.expectedRev, 11);
    assert.equal(replaceCalledWith.newVal.cooldownMs, 20000);
  }

  // 5. Concurrent modification during replace throws SETTINGS_CONFLICT -> returns 409 (not 500)
  {
    // Mock settings.replace throwing SETTINGS_CONFLICT
    mockSettings.replace = async () => {
      const err = new Error('SETTINGS_CONFLICT: revision mismatch');
      err.code = 'SETTINGS_CONFLICT';
      throw err;
    };

    const { req, res, getStatus, getData } = makeReqRes({
      config: { cooldownMs: 25000 },
      mode: 'merge',
      expectedRevision: 12,
      dryRun: false,
    });
    await importHandler(req, res);
    assert.equal(getStatus(), 409, 'must return 409 Conflict when replace throws SETTINGS_CONFLICT');
    assert.equal(getData().error.code, 'conflict');
  }
});

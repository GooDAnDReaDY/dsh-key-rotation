import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { isTrustedBridgeRequest, isDesktopShellRequest, hasNonLoopbackForwarding } from '../lib/pool.js';
import { registerKeyRoutes } from '../lib/ops-keys.js';
import { AUTO_IMPORT_PATH } from '../lib/ops-paths.js';

test('Issue #516: isDesktopShellRequest predicate and forwarding guards', () => {
  // Positive identification
  assert.equal(
    isDesktopShellRequest({
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) @deepseek-ai/dsh-desktop/0.2.1-rc.2 Chrome/120.0',
        cookie: 'dsh-auth-session=abc123xyz; other=1',
      },
    }),
    true,
    'must trust request with both Desktop UA and dsh-auth- cookie'
  );

  // Rejection when proxied from LAN / remote IP (#516)
  assert.equal(
    isDesktopShellRequest({
      headers: {
        'user-agent': 'Mozilla/5.0 @deepseek-ai/dsh-desktop/0.2.1-rc.2',
        cookie: 'dsh-auth-session=abc123xyz',
        'x-forwarded-for': '192.168.1.150',
      },
    }),
    false,
    'must reject Desktop credentials proxied from remote LAN client via x-forwarded-for'
  );

  assert.equal(
    isDesktopShellRequest({
      headers: {
        'user-agent': 'Mozilla/5.0 @deepseek-ai/dsh-desktop/0.2.1-rc.2',
        cookie: 'dsh-auth-session=abc123xyz',
        'x-real-ip': '10.0.0.5',
      },
    }),
    false,
    'must reject Desktop credentials with remote x-real-ip'
  );

  // Negative cases
  assert.equal(
    isDesktopShellRequest({
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) @deepseek-ai/dsh-desktop/0.2.1-rc.2',
      },
    }),
    false,
    'must reject Desktop UA without dsh-auth- cookie'
  );

  assert.equal(
    isDesktopShellRequest({
      headers: {
        'user-agent': 'curl/8.4.0',
        cookie: 'dsh-auth-session=abc123xyz',
      },
    }),
    false,
    'must reject non-desktop UA even if dsh-auth- cookie is present'
  );

  assert.equal(isDesktopShellRequest({ headers: {} }), false);
  assert.equal(isDesktopShellRequest(undefined), false);
  assert.equal(isDesktopShellRequest(null), false);
});

test('Issue #516: isTrustedBridgeRequest write-origin-guard and spoofing protection', () => {
  const loopbackReq = (method, headers = {}) => ({
    method,
    headers: { host: '127.0.0.1:3000', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  });

  const desktopHeaders = {
    'user-agent': 'Mozilla/5.0 @deepseek-ai/dsh-desktop/0.2.1-rc.2',
    cookie: 'dsh-auth-session=secret',
  };

  // Read methods (GET/HEAD/OPTIONS) pass without Origin (browsers omit it on same-origin reads)
  assert.equal(isTrustedBridgeRequest(loopbackReq('GET')), true);
  assert.equal(isTrustedBridgeRequest(loopbackReq('HEAD')), true);
  assert.equal(isTrustedBridgeRequest(loopbackReq('OPTIONS')), true);

  // Write methods without Origin or Desktop credentials must FAIL CLOSED (403)
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal(
      isTrustedBridgeRequest(loopbackReq(m)),
      false,
      `${m} without Origin and without Desktop shell must be refused`
    );
  }

  // Write methods without Origin but WITH Desktop credentials must PASS
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal(
      isTrustedBridgeRequest(loopbackReq(m, desktopHeaders)),
      true,
      `${m} with Desktop shell credentials must pass`
    );
  }

  // Write methods with matching same-origin Referer pass
  assert.equal(
    isTrustedBridgeRequest(loopbackReq('POST', { referer: 'http://127.0.0.1:3000/settings' })),
    true,
    'POST with matching Referer must pass'
  );

  // Write methods with cross-origin Referer fail
  assert.equal(
    isTrustedBridgeRequest(loopbackReq('POST', { referer: 'http://evil.com/page' })),
    false,
    'POST with foreign Referer must fail'
  );

  // Write methods with matching Origin pass
  assert.equal(
    isTrustedBridgeRequest(loopbackReq('POST', { origin: 'http://127.0.0.1:3000' })),
    true
  );

  // dsh-app://app Origin on direct local loopback passes (#22, #465)
  assert.equal(
    isTrustedBridgeRequest(loopbackReq('POST', { origin: 'dsh-app://app' })),
    true,
    'POST with dsh-app Origin on direct local loopback must pass'
  );

  // Authentic dsh-app://app Origin WITH desktop credentials passes
  assert.equal(
    isTrustedBridgeRequest(loopbackReq('POST', { origin: 'dsh-app://app', ...desktopHeaders })),
    true,
    'POST with authentic Desktop origin and credentials must pass'
  );

  // dsh-app://app Origin proxied from remote LAN client must FAIL CLOSED (#516)
  assert.equal(
    isTrustedBridgeRequest(loopbackReq('POST', {
      origin: 'dsh-app://app',
      ...desktopHeaders,
      'x-forwarded-for': '192.168.1.150',
    })),
    false,
    'POST with dsh-app Origin proxied from remote LAN must be refused'
  );

  // Non-loopback remoteAddress is refused even with desktop UA or valid Origin
  assert.equal(
    isTrustedBridgeRequest({
      method: 'POST',
      headers: { host: '127.0.0.1:3000', ...desktopHeaders },
      socket: { remoteAddress: '192.168.1.150' },
    }),
    false
  );
});

test('Issue #516: /auto-import fails closed on invalid body and unauthenticated LAN client', async () => {
  const routes = new Map();
  let mutatedSettings = false;

  const mockSettings = {
    describe: () => [{
      ns: 'dsh-key-rotation',
      revision: 1,
      value: { providers: [] },
    }],
    mutate: async () => {
      mutatedSettings = true;
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
    credentials: {
      get: async (ref) => ({ key: `secret-${ref}` }),
    },
  };

  registerKeyRoutes(ctx, {
    poolState: new Map(),
    buildRuntime: () => ({
      pools: [],
      cfg0: { providers: [] },
    }),
  });

  const autoImportHandler = routes.get(AUTO_IMPORT_PATH);
  assert.ok(autoImportHandler, 'auto-import handler must be registered');

  const makeReqRes = (bodyRaw, headers = {}, method = 'POST', ip = '127.0.0.1') => {
    const stream = Readable.from(bodyRaw !== null ? [Buffer.from(bodyRaw)] : []);
    stream.method = method;
    stream.headers = { host: '127.0.0.1:3000', ...headers };
    stream.socket = { remoteAddress: ip };

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

  // 1. Unauthenticated request without Origin or Desktop shell -> 403 Forbidden
  {
    mutatedSettings = false;
    const { req, res, getStatus, getData } = makeReqRes('{"all":true}');
    await autoImportHandler(req, res);
    assert.equal(getStatus(), 403);
    assert.equal(getData().error.code, 'forbidden');
    assert.equal(mutatedSettings, false, 'settings must not be mutated on 403');
  }

  // 2. Request from LAN via proxy without Origin -> 403 Forbidden (#516)
  {
    mutatedSettings = false;
    const { req, res, getStatus, getData } = makeReqRes('{"all":true}', {
      'x-forwarded-for': '192.168.1.150',
      'user-agent': 'Mozilla/5.0 @deepseek-ai/dsh-desktop/0.2.1-rc.2',
      cookie: 'dsh-auth-session=fake',
    });
    await autoImportHandler(req, res);
    assert.equal(getStatus(), 403);
    assert.equal(getData().error.code, 'forbidden');
    assert.equal(mutatedSettings, false, 'settings must not be mutated on proxied LAN request');
  }

  const authHeaders = {
    origin: 'http://127.0.0.1:3000',
  };

  // 3. Non-JSON body "x" -> 400 Bad Request (reproducer for issue #516 incident)
  {
    mutatedSettings = false;
    const { req, res, getStatus, getData } = makeReqRes('x', authHeaders);
    await autoImportHandler(req, res);
    assert.equal(getStatus(), 400);
    assert.equal(getData().error.code, 'bad-request');
    assert.equal(mutatedSettings, false, 'settings must not be mutated on invalid JSON body');
  }

  // 4. Empty JSON body "{}" -> 400 Bad Request (requires refs or all: true)
  {
    mutatedSettings = false;
    const { req, res, getStatus, getData } = makeReqRes('{}', authHeaders);
    await autoImportHandler(req, res);
    assert.equal(getStatus(), 400);
    assert.equal(getData().error.code, 'bad-request');
    assert.ok(getData().error.message.includes('refs'));
    assert.equal(mutatedSettings, false, 'settings must not be mutated on empty object');
  }

  // 5. Body with { all: false } -> 400 Bad Request
  {
    mutatedSettings = false;
    const { req, res, getStatus, getData } = makeReqRes(JSON.stringify({ all: false }), authHeaders);
    await autoImportHandler(req, res);
    assert.equal(getStatus(), 400);
    assert.equal(mutatedSettings, false);
  }

  // 6. Body with { all: true } -> 200 OK (performs import when all: true is explicit)
  {
    mutatedSettings = false;
    const prevKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'sk-test-fake-key-516';
    try {
      const { req, res, getStatus, getData } = makeReqRes(JSON.stringify({ all: true }), authHeaders);
      await autoImportHandler(req, res);
      assert.equal(getStatus(), 200);
      assert.equal(getData().ok, true);
      assert.ok(typeof getData().importedCount === 'number');
      assert.equal(mutatedSettings, true, 'settings must be mutated when all: true is explicit');
    } finally {
      if (prevKey !== undefined) process.env.DEEPSEEK_API_KEY = prevKey;
      else delete process.env.DEEPSEEK_API_KEY;
    }
  }
});

// test/bridge-trust.test.mjs — the loopback/same-origin guard on the HTTP bridge.
//
// Regression guard for the "Provider list unavailable" bug: browsers do not
// attach `Origin` to same-origin GET/HEAD requests (Fetch standard), so requiring
// it made every read route answer 403 for the Settings card itself.
//
// The guard is exercised through a real HTTP server so the request objects are
// genuine Node `IncomingMessage` instances, exactly as the routes see them.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { isTrustedBridgeRequest } from '../lib/pool.js';

/** Start a throwaway server that reports the guard verdict for each request. */
async function withServer(run) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ trusted: isTrustedBridgeRequest(req) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Raw request with full control over headers and method. */
function raw(port, { method = 'GET', path = '/', headers = {}, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = { ...headers };
    if (host !== null) outgoing.host = host;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: outgoing, setHost: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('a same-origin GET with no Origin is trusted (the reported bug)', async () => {
  await withServer(async (port) => {
    // Exactly what Chrome sends for a same-origin fetch() GET: no Origin.
    const res = await raw(port, {
      headers: { accept: 'application/json', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
    });
    assert.equal(res.body.trusted, true, 'Origin-less same-origin GET must be accepted');
  });
});

test('a same-origin GET with no Origin and no Fetch Metadata is trusted', async () => {
  // Non-browser local tools (curl, scripts) send neither header. The socket and
  // Host are loopback, so the request is local by construction.
  await withServer(async (port) => {
    const res = await raw(port, { headers: { accept: 'application/json' } });
    assert.equal(res.body.trusted, true);
  });
});

test('an Origin-less mutation is accepted when peer and Host are loopback (#465 / GitHub #22)', async () => {
  await withServer(async (port) => {
    // Official Desktop shell forwardWebRequest strips Origin. Peer socket & Host are verified loopback.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await raw(port, { method, headers: { accept: 'application/json' } });
      assert.equal(res.body.trusted, true, `${method} without Origin on verified loopback must be trusted`);
    }
  });
});

test('an Origin-bearing mutation is accepted when it is same-origin', async () => {
  await withServer(async (port) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await raw(port, { method, headers: { origin: `http://127.0.0.1:${port}` } });
      assert.equal(res.body.trusted, true, `${method} with a same-origin Origin must be accepted`);
    }
  });
});

test('an Origin-bearing same-origin request is trusted', async () => {
  await withServer(async (port) => {
    const res = await raw(port, {
      headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(res.body.trusted, true);
  });
  await withServer(async (port) => {
    const res = await raw(port, { headers: { origin: `http://localhost:${port}` }, host: `localhost:${port}` });
    assert.equal(res.body.trusted, true, 'the localhost alias is accepted');
  });
});

test('cross-site requests are refused even without Origin', async () => {
  await withServer(async (port) => {
    // A cross-origin no-cors GET carries no Origin but does carry this header.
    const res = await raw(port, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(res.body.trusted, false, 'cross-site must stay fail-closed');
  });
  await withServer(async (port) => {
    const res = await raw(port, { method: 'POST', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    assert.equal(res.body.trusted, false, 'a cross-site POST is refused');
  });
  await withServer(async (port) => {
    // A same-origin-*looking* Origin cannot rescue a cross-site signal.
    const res = await raw(port, { method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' } });
    assert.equal(res.body.trusted, false);
  });
});

test('a mismatched Origin is refused', async () => {
  await withServer(async (port) => {
    const res = await raw(port, { headers: { origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-origin' } });
    assert.equal(res.body.trusted, false, 'the Origin host must equal Host');
  });
  await withServer(async (port) => {
    const res = await raw(port, { headers: { origin: 'https://evil.example' } });
    assert.equal(res.body.trusted, false, 'a non-loopback Origin is refused');
  });
  await withServer(async (port) => {
    // An Origin that is a different loopback port is a different origin.
    const res = await raw(port, { headers: { origin: `http://127.0.0.1:${port + 1}` } });
    assert.equal(res.body.trusted, false);
  });
});

test('a malformed Origin is refused rather than ignored', async () => {
  await withServer(async (port) => {
    for (const origin of ['not-a-url', 'file:///etc/passwd', 'null', 'https://evil.example', '//evil.example']) {
      const res = await raw(port, { headers: { origin } });
      assert.equal(res.body.trusted, false, `origin ${JSON.stringify(origin)} must be refused`);
    }
  });
});

test('an explicit empty Origin value is refused as malformed/untrusted', async () => {
  await withServer(async (port) => {
    const get = await raw(port, { headers: { origin: '', 'sec-fetch-site': 'same-origin' } });
    assert.equal(get.body.trusted, false, 'an empty Origin is not trusted');
    const post = await raw(port, { method: 'POST', headers: { origin: '' } });
    assert.equal(post.body.trusted, false, 'an empty Origin on POST is not trusted');
  });
});

test('a non-loopback Host is refused even with no Origin (DNS rebinding)', async () => {
  await withServer(async (port) => {
    // With Origin optional, Host is the only browser-supplied identity left, so
    // a rebound hostname pointing at 127.0.0.1 must not be accepted.
    const res = await raw(port, { headers: { accept: 'application/json' }, host: `attacker.example:${port}` });
    assert.equal(res.body.trusted, false, 'a non-loopback Host must be refused');
  });
});

test('a missing Host is refused', () => {
  // Node's own HTTP parser rejects an HTTP/1.1 request without Host before the
  // handler runs, so the guard is exercised directly here.
  assert.equal(isTrustedBridgeRequest({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), false);
  assert.equal(isTrustedBridgeRequest({ headers: { 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: '127.0.0.1' } }), false);
  // An empty Host is present but meaningless, and must not pass the loopback check.
  assert.equal(isTrustedBridgeRequest({ headers: { host: '' }, socket: { remoteAddress: '127.0.0.1' } }), false);
});

test('the guard needs a genuine loopback peer address', () => {
  // Synthesised request objects: the socket must be loopback regardless of headers.
  const base = { headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' } };
  assert.equal(isTrustedBridgeRequest({ ...base, socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(isTrustedBridgeRequest({ ...base, socket: { remoteAddress: '::1' } }), true);
  assert.equal(isTrustedBridgeRequest({ ...base, socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(isTrustedBridgeRequest({ ...base, socket: { remoteAddress: '192.168.1.10' } }), false);
  assert.equal(isTrustedBridgeRequest({ ...base, socket: { remoteAddress: '10.0.0.5' } }), false);
  assert.equal(isTrustedBridgeRequest({ ...base, socket: {} }), false);
  assert.equal(isTrustedBridgeRequest({ ...base, socket: null }), false);
  assert.equal(isTrustedBridgeRequest(undefined), false);
});

test('IPv6 and port handling in the Host header', () => {
  assert.equal(isTrustedBridgeRequest({ headers: { host: '[::1]:19387' }, socket: { remoteAddress: '::1' } }), true);
  assert.equal(isTrustedBridgeRequest({ headers: { host: '[::1]' }, socket: { remoteAddress: '::1' } }), true);
  assert.equal(isTrustedBridgeRequest({ headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(isTrustedBridgeRequest({ headers: { host: 'localhost:8080' }, socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(isTrustedBridgeRequest({ headers: { host: '[::2]:80' }, socket: { remoteAddress: '::1' } }), false);
});

test('the read routes the Settings card calls are all reachable without Origin', async () => {
  // The card performs same-origin GETs against these paths; a regression here is
  // what produced "Provider list unavailable".
  const paths = [
    '/dsh-key-rotation/config',
    '/dsh-key-rotation/status',
    '/dsh-key-rotation/health',
    '/dsh-key-rotation/usage',
    '/dsh-key-rotation/sandbox-cache',
  ];
  await withServer(async (port) => {
    for (const path of paths) {
      const res = await raw(port, { path, headers: { accept: 'application/json' } });
      assert.equal(res.body.trusted, true, `${path} must be reachable from the same-origin card`);
    }
  });
});

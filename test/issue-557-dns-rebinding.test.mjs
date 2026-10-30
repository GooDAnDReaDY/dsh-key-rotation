// test/issue-557-dns-rebinding.test.mjs — verify connect-time SSRF DNS rebinding prevention (#557).
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import nodeDns from 'node:dns';
import { fileURLToPath } from 'node:url';
import { safeFetchJson, createSafeLookup } from '../lib/safe-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keyPath = path.join(__dirname, 'fixtures', 'rebind-key.pem');
const certPath = path.join(__dirname, 'fixtures', 'rebind-cert.pem');

test('Issue #557: DNS rebinding is blocked at TCP connect time before sending HTTP request', async () => {
  const key = fs.readFileSync(keyPath);
  const cert = fs.readFileSync(certPath);

  let hits = 0;
  const server = https.createServer({ key, cert }, (_req, res) => {
    hits++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ internal: true }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // Simulate DNS rebinding:
    // Precheck lookupImpl returns public IP 8.8.8.8 (passing assertSafeUrl)
    // But connect-time lookup resolves to 127.0.0.1 (local server)
    const fakePrecheckLookup = async () => [{ address: '8.8.8.8', family: 4 }];
    const fakeConnectLookup = (hostname, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    };

    let caughtError = null;
    try {
      const safeLookup = createSafeLookup({ lookupImpl: fakeConnectLookup });
      await safeFetchJson(`https://rebind.test:${port}/`, {
        lookupImpl: fakePrecheckLookup,
        dispatcher: {
          connect: {
            lookup: safeLookup,
          },
        },
        ca: cert,
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, 'Request must throw an error');
    assert.equal(hits, 0, 'HTTPS server must receive 0 requests');
    assert.match(caughtError.message, /SSRF_BLOCKED|private or reserved/);
  } finally {
    server.close();
  }
});

test('Issue #557: Exact auditor scenario with monkey-patched dns.lookup and zero dispatcher', async () => {
  const key = fs.readFileSync(keyPath);
  const cert = fs.readFileSync(certPath);

  let hits = 0;
  const server = https.createServer({ key, cert }, (_req, res) => {
    hits++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ internal: true }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const origLookup = nodeDns.lookup;
  nodeDns.lookup = (host, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const options = typeof opts === 'function' ? {} : opts;
    if (host === 'rebind-auditor.test') {
      if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    } else {
      origLookup(host, opts, cb);
    }
  };

  try {
    let caughtError = null;
    try {
      await safeFetchJson(`https://rebind-auditor.test:${port}/`, {
        lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
        ca: cert,
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, 'Request must fail');
    assert.equal(hits, 0, 'Auditor scenario: local server must never receive the request');
    assert.match(caughtError.message, /SSRF_BLOCKED|private or reserved/);
  } finally {
    nodeDns.lookup = origLookup;
    server.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { encryptSecret, decryptSecret } from '../lib/crypto-storage.js';
import { registerKeyRoutes } from '../lib/ops-keys.js';
import { KEY_PATH } from '../lib/ops-paths.js';

function makeMockContext(credentialsMap) {
  const routes = [];
  return {
    routes,
    logger: { debug: () => {} },
    get(name) {
      if (name === 'credentials') {
        return {
          set: async (ref, val) => { credentialsMap.set(ref, val); },
          unset: async (ref) => { credentialsMap.delete(ref); },
        };
      }
      return undefined;
    },
    effect(fn) { fn(); },
    webServer: {
      register(entry) { routes.push(entry); },
    },
  };
}

function makeMockRequest(body) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  stream.method = 'PUT';
  stream.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };
  stream.socket = { remoteAddress: '127.0.0.1' };
  return stream;
}

test('crypto-storage: PUT /key encrypts credentials at rest when DSH_KEY_SECRET is configured', async () => {
  const prevSecret = process.env.DSH_KEY_SECRET;
  process.env.DSH_KEY_SECRET = 'super-secret-crypto-master-key';

  try {
    const creds = new Map();
    const ctx = makeMockContext(creds);
    const poolState = new Map();
    registerKeyRoutes(ctx, { poolState });

    const keyRoute = ctx.routes.find(r => r.path === KEY_PATH);
    assert.ok(keyRoute, 'KEY_PATH route registered');

    const req = makeMockRequest({ ref: 'TEST_API_KEY', value: 'sk-ant-live-secret-token-12345' });

    let statusCode = 0;
    let resBody = null;
    const res = {
      writeHead(code, headers) { statusCode = code; },
      end(chunk) { if (chunk) resBody = JSON.parse(chunk); },
    };

    await keyRoute.handler(req, res);

    assert.equal(statusCode, 200);
    assert.equal(resBody?.ok, true);
    assert.equal(resBody?.ref, 'TEST_API_KEY');
    assert.equal(resBody?.tail, '12345');

    // Verify stored value in credentials service is encrypted (enc:v1:...)
    const stored = creds.get('TEST_API_KEY');
    assert.ok(stored.startsWith('enc:v1:'), 'stored value must be encrypted at rest');
    assert.notEqual(stored, 'sk-ant-live-secret-token-12345');

    // Verify decryption recovers original secret
    const decrypted = decryptSecret(stored, process.env.DSH_KEY_SECRET);
    assert.equal(decrypted, 'sk-ant-live-secret-token-12345');
  } finally {
    if (prevSecret === undefined) {
      delete process.env.DSH_KEY_SECRET;
    } else {
      process.env.DSH_KEY_SECRET = prevSecret;
    }
  }
});

test('crypto-storage: PUT /key stores plaintext when DSH_KEY_SECRET is absent', async () => {
  const prevSecret = process.env.DSH_KEY_SECRET;
  delete process.env.DSH_KEY_SECRET;

  try {
    const creds = new Map();
    const ctx = makeMockContext(creds);
    const poolState = new Map();
    registerKeyRoutes(ctx, { poolState });

    const keyRoute = ctx.routes.find(r => r.path === KEY_PATH);
    const req = makeMockRequest({ ref: 'TEST_PLAIN_KEY', value: 'sk-plain-credential-98765' });

    let statusCode = 0;
    let resBody = null;
    const res = {
      writeHead(code) { statusCode = code; },
      end(chunk) { if (chunk) resBody = JSON.parse(chunk); },
    };

    await keyRoute.handler(req, res);

    assert.equal(statusCode, 200);
    assert.equal(resBody?.ok, true);
    assert.equal(resBody?.tail, '98765');

    const stored = creds.get('TEST_PLAIN_KEY');
    assert.equal(stored, 'sk-plain-credential-98765');
  } finally {
    if (prevSecret !== undefined) process.env.DSH_KEY_SECRET = prevSecret;
  }
});

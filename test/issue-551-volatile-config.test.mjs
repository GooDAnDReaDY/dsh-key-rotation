import test from 'node:test';
import assert from 'node:assert/strict';
import { unwrapVolatileConfig, createConfigReader } from '../lib/config-compat.js';
import { handleConfigBridge } from '../lib/http-bridge.js';

test('issue #551 - unwrapVolatileConfig unwraps volatile getters and keeps plain values', () => {
  const volatileBox1 = { get: () => 'apiKey-123' };
  const volatileBox2 = { get: () => ({ enabled: true, timeout: 5000 }) };
  const plainValue = 42;

  const rawConfig = {
    apiKey: volatileBox1,
    settings: volatileBox2,
    threshold: plainValue,
    regularStr: 'constant',
  };

  const unwrapped = unwrapVolatileConfig(rawConfig);

  assert.equal(unwrapped.apiKey, 'apiKey-123');
  assert.deepEqual(unwrapped.settings, { enabled: true, timeout: 5000 });
  assert.equal(unwrapped.threshold, 42);
  assert.equal(unwrapped.regularStr, 'constant');
});

test('issue #551 - unwrapVolatileConfig handles falsy and non-object values safely', () => {
  assert.deepEqual(unwrapVolatileConfig(null), {});
  assert.deepEqual(unwrapVolatileConfig(undefined), {});
  assert.deepEqual(unwrapVolatileConfig('string'), {});
  assert.deepEqual(unwrapVolatileConfig(123), {});
});

test('issue #551 - handleConfigBridge sets X-DSH-Deprecated and Deprecation headers', async () => {
  const headers = {};
  const res = {
    setHeader(name, val) {
      headers[name.toLowerCase()] = val;
    },
    writeHead(status, head = {}) {
      for (const [k, v] of Object.entries(head)) {
        headers[k.toLowerCase()] = v;
      }
    },
    end() {},
  };

  const req = {
    method: 'GET',
    headers: { host: '127.0.0.1:3000' },
    socket: { remoteAddress: '127.0.0.1' },
  };

  const fakeCtx = {
    get() {
      return {
        describe() { return []; },
        writable: true,
      };
    },
  };

  await handleConfigBridge(fakeCtx, req, res, () => []);

  assert.equal(headers['x-dsh-deprecated'], 'true');
  assert.ok(headers['deprecation']?.includes('v0.8.79'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedUpdateRequest } from '../lib/plugin-updater.js';

function req({ remote = '127.0.0.1', headers = {} } = {}) {
  return { socket: { remoteAddress: remote }, headers };
}

test('updater: rejects without update header', () => {
  assert.equal(isTrustedUpdateRequest(req({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } })), false);
});

test('updater: rejects non-loopback remote', () => {
  assert.equal(isTrustedUpdateRequest(req({
    remote: '10.0.0.5',
    headers: { 'x-dsh-plugin-update': '1', origin: 'http://10.0.0.5:3080', host: '10.0.0.5:3080' },
  })), false);
});

test('updater: rejects cross-site fetch', () => {
  assert.equal(isTrustedUpdateRequest(req({
    headers: {
      'x-dsh-plugin-update': '1',
      'sec-fetch-site': 'cross-site',
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
    },
  })), false);
});

test('updater: accepts same-origin loopback', () => {
  assert.equal(isTrustedUpdateRequest(req({
    headers: {
      'x-dsh-plugin-update': '1',
      'sec-fetch-site': 'same-origin',
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
    },
  })), true);
});

test('updater: rejects origin/host mismatch', () => {
  assert.equal(isTrustedUpdateRequest(req({
    headers: {
      'x-dsh-plugin-update': '1',
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:9999',
    },
  })), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackAddress, isTrustedBridgeRequest } from '../lib/pool.js';

test('isLoopbackAddress: v4 loopback', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
});

test('isLoopbackAddress: v6 loopback', () => {
  assert.equal(isLoopbackAddress('::1'), true);
});

test('isLoopbackAddress: v6-mapped v4 loopback', () => {
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
});

test('isLoopbackAddress: non-loopback rejected', () => {
  assert.equal(isLoopbackAddress('192.168.1.50'), false);
  assert.equal(isLoopbackAddress('10.0.0.1'), false);
  assert.equal(isLoopbackAddress('::ffff:192.168.1.50'), false);
});

test('isLoopbackAddress: undefined / null / empty rejected', () => {
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackAddress(null), false);
  assert.equal(isLoopbackAddress(''), false);
});

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('isTrustedBridgeRequest: rejects non-loopback even with matching Origin', () => {
  assert.equal(isTrustedBridgeRequest(req('192.168.1.50', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })), false);
});

test('isTrustedBridgeRequest: rejects cross-site even from loopback', () => {
  assert.equal(isTrustedBridgeRequest(req('127.0.0.1', { host: '127.0.0.1:3080', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' })), false);
});

test('isTrustedBridgeRequest: accepts loopback + same-origin', () => {
  assert.equal(isTrustedBridgeRequest(req('127.0.0.1', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })), true);
});

test('isTrustedBridgeRequest: rejects loopback with no Origin header (#353 fail-closed)', () => {
  assert.equal(isTrustedBridgeRequest(req('127.0.0.1', { host: '127.0.0.1:3080' })), false);
});

test('isTrustedBridgeRequest: rejects loopback with missing Host header', () => {
  assert.equal(isTrustedBridgeRequest(req('127.0.0.1', { origin: 'http://127.0.0.1:3080' })), false);
});

test('isTrustedBridgeRequest: rejects loopback when Origin host does not match', () => {
  assert.equal(isTrustedBridgeRequest(req('127.0.0.1', { host: '127.0.0.1:3080', origin: 'http://localhost:9000' })), false);
});

test('isTrustedBridgeRequest: rejects loopback when Origin is malformed', () => {
  assert.equal(isTrustedBridgeRequest(req('127.0.0.1', { host: '127.0.0.1:3080', origin: 'not-a-url' })), false);
});

test('isTrustedBridgeRequest: rejects non-http/https origin protocol', () => {
  assert.equal(isTrustedBridgeRequest(req('127.0.0.1', { host: '127.0.0.1:3080', origin: 'file:///etc/passwd' })), false);
});

test('isTrustedBridgeRequest: rejects non-loopback hostname in origin', () => {
  assert.equal(isTrustedBridgeRequest(req('127.0.0.1', { host: 'evil.com', origin: 'http://evil.com' })), false);
});

test('isTrustedBridgeRequest: accepts ipv6 loopback [::1]', () => {
  assert.equal(isTrustedBridgeRequest(req('::1', { host: '[::1]:3080', origin: 'http://[::1]:3080' })), true);
});

test('isTrustedBridgeRequest: accepts localhost', () => {
  assert.equal(isTrustedBridgeRequest(req('127.0.0.1', { host: 'localhost:3080', origin: 'http://localhost:3080' })), true);
});

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

test('isTrustedBridgeRequest: accepts loopback with no Origin header', () => {
  assert.equal(isTrustedBridgeRequest(req('127.0.0.1', { host: '127.0.0.1:3080' })), true);
});

test('isTrustedBridgeRequest: rejects loopback when Origin host does not match', () => {
  assert.equal(isTrustedBridgeRequest(req('127.0.0.1', { host: '127.0.0.1:3080', origin: 'http://localhost:9000' })), false);
});

test('isTrustedBridgeRequest: rejects loopback when Origin is malformed', () => {
  assert.equal(isTrustedBridgeRequest(req('127.0.0.1', { host: '127.0.0.1:3080', origin: 'not-a-url' })), false);
});

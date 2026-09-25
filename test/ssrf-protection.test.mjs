// test/ssrf-protection.test.mjs
// Comprehensive test suite for SSRF protection and safe URL fetching (#354)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPrivateOrReservedIp,
  assertSafeUrl,
  readBoundedJson,
  safeFetchJson,
  MAX_IMPORT_BYTES,
} from '../lib/safe-fetch.js';

test('isPrivateOrReservedIp: correctly identifies private and reserved IPv4 addresses', () => {
  // Loopback (127.0.0.0/8)
  assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('127.255.255.255'), true);
  assert.equal(isPrivateOrReservedIp('127.0.1.1'), true);

  // Private RFC 1918
  assert.equal(isPrivateOrReservedIp('10.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('10.255.255.255'), true);
  assert.equal(isPrivateOrReservedIp('172.16.0.1'), true);
  assert.equal(isPrivateOrReservedIp('172.31.255.255'), true);
  assert.equal(isPrivateOrReservedIp('192.168.0.1'), true);
  assert.equal(isPrivateOrReservedIp('192.168.1.100'), true);

  // Public in 172.x range
  assert.equal(isPrivateOrReservedIp('172.15.255.255'), false);
  assert.equal(isPrivateOrReservedIp('172.32.0.1'), false);

  // Link-local RFC 3927 (169.254.0.0/16)
  assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
  assert.equal(isPrivateOrReservedIp('169.254.1.1'), true);

  // Carrier-grade NAT (100.64.0.0/10)
  assert.equal(isPrivateOrReservedIp('100.64.0.1'), true);
  assert.equal(isPrivateOrReservedIp('100.127.255.255'), true);
  assert.equal(isPrivateOrReservedIp('100.128.0.1'), false);

  // Current network, benchmarking, documentation, multicast, broadcast
  assert.equal(isPrivateOrReservedIp('0.0.0.0'), true);
  assert.equal(isPrivateOrReservedIp('192.0.2.1'), true); // TEST-NET-1
  assert.equal(isPrivateOrReservedIp('198.51.100.1'), true); // TEST-NET-2
  assert.equal(isPrivateOrReservedIp('203.0.113.1'), true); // TEST-NET-3
  assert.equal(isPrivateOrReservedIp('198.18.0.1'), true); // Benchmarking
  assert.equal(isPrivateOrReservedIp('224.0.0.1'), true); // Multicast
  assert.equal(isPrivateOrReservedIp('240.0.0.1'), true); // Reserved
  assert.equal(isPrivateOrReservedIp('255.255.255.255'), true); // Broadcast

  // Valid public IPs
  assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
  assert.equal(isPrivateOrReservedIp('1.1.1.1'), false);
  assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);
});

test('isPrivateOrReservedIp: correctly identifies private and reserved IPv6 addresses', () => {
  // Loopback & unspecified
  assert.equal(isPrivateOrReservedIp('::1'), true);
  assert.equal(isPrivateOrReservedIp('::'), true);
  assert.equal(isPrivateOrReservedIp('0:0:0:0:0:0:0:1'), true);
  assert.equal(isPrivateOrReservedIp('0:0:0:0:0:0:0:0'), true);

  // Link-local (fe80::/10)
  assert.equal(isPrivateOrReservedIp('fe80::1'), true);
  assert.equal(isPrivateOrReservedIp('fe80::200:5aee:feaa:20a2'), true);

  // Unique local address (fc00::/7)
  assert.equal(isPrivateOrReservedIp('fc00::1'), true);
  assert.equal(isPrivateOrReservedIp('fd12:3456:789a::1'), true);

  // Multicast (ff00::/8)
  assert.equal(isPrivateOrReservedIp('ff02::1'), true);

  // Documentation & discard
  assert.equal(isPrivateOrReservedIp('2001:db8::1'), true);
  assert.equal(isPrivateOrReservedIp('100::1'), true);

  // IPv4-mapped IPv6
  assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:192.168.1.1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:8.8.8.8'), false);

  // Public IPv6
  assert.equal(isPrivateOrReservedIp('2606:4700:4700::1111'), false);
});

test('assertSafeUrl: rejects non-HTTPS protocols', async () => {
  await assert.rejects(assertSafeUrl('http://example.com/pools.json'), /only HTTPS URLs are allowed/);
  await assert.rejects(assertSafeUrl('ftp://example.com/pools.json'), /only HTTPS URLs are allowed/);
  await assert.rejects(assertSafeUrl('file:///etc/passwd'), /only HTTPS URLs are allowed/);
  await assert.rejects(assertSafeUrl('gopher://example.com/'), /only HTTPS URLs are allowed/);
  await assert.rejects(assertSafeUrl('invalid-url'), /invalid URL/);
});

test('assertSafeUrl: rejects private IP literals directly', async () => {
  await assert.rejects(assertSafeUrl('https://127.0.0.1/pools.json'), /private or reserved/);
  await assert.rejects(assertSafeUrl('https://10.0.0.5/pools.json'), /private or reserved/);
  await assert.rejects(assertSafeUrl('https://192.168.1.1/pools.json'), /private or reserved/);
  await assert.rejects(assertSafeUrl('https://169.254.169.254/latest/meta-data'), /private or reserved/);
  await assert.rejects(assertSafeUrl('https://[::1]/pools.json'), /private or reserved/);
  await assert.rejects(assertSafeUrl('https://[fe80::1]/pools.json'), /private or reserved/);
});

test('assertSafeUrl: rejects domain resolving to private IP via DNS (DNS rebinding guard)', async () => {
  const fakeLookup = async (hostname) => {
    if (hostname === 'rebinding.attacker.com') {
      return [{ address: '127.0.0.1', family: 4 }];
    }
    if (hostname === 'internal.cloud.com') {
      return [{ address: '169.254.169.254', family: 4 }];
    }
    return [{ address: '93.184.216.34', family: 4 }];
  };

  await assert.rejects(
    assertSafeUrl('https://rebinding.attacker.com/pools.json', { lookupImpl: fakeLookup }),
    /resolves to private or reserved IP 127\.0\.0\.1/
  );

  await assert.rejects(
    assertSafeUrl('https://internal.cloud.com/pools.json', { lookupImpl: fakeLookup }),
    /resolves to private or reserved IP 169\.254\.169\.254/
  );

  // Public domain passes
  const urlObj = await assertSafeUrl('https://valid.public.com/pools.json', { lookupImpl: fakeLookup });
  assert.equal(urlObj.hostname, 'valid.public.com');
});

test('readBoundedJson: caps response body to maxBytes', async () => {
  // 1. Content-Length header check
  const headerOversized = {
    headers: new Headers({ 'content-length': String(MAX_IMPORT_BYTES + 100) }),
  };
  await assert.rejects(readBoundedJson(headerOversized), /response exceeds maximum size/);

  // 2. Body stream size cap
  const bigPayload = 'x'.repeat(MAX_IMPORT_BYTES + 50);
  const streamOversized = new Response(bigPayload);
  await assert.rejects(readBoundedJson(streamOversized), /response exceeds maximum size/);

  // 3. Valid JSON within limit
  const validData = [{ provider: 'test', keys: ['KEY_1'] }];
  const validResp = new Response(JSON.stringify(validData));
  const parsed = await readBoundedJson(validResp);
  assert.deepEqual(parsed, validData);
});

test('safeFetchJson: rejects redirects to private destinations or non-HTTPS', async () => {
  const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  // Redirect to HTTP
  const mockFetchHttpRedirect = async (url) => {
    return {
      status: 302,
      headers: new Headers({ location: 'http://example.com/pools.json' }),
    };
  };
  await assert.rejects(
    safeFetchJson('https://example.com/start', { fetchImpl: mockFetchHttpRedirect, lookupImpl: fakeLookup }),
    /only HTTPS URLs are allowed/
  );

  // Redirect to loopback
  const mockFetchLoopbackRedirect = async (url) => {
    return {
      status: 302,
      headers: new Headers({ location: 'https://127.0.0.1/secret.json' }),
    };
  };
  await assert.rejects(
    safeFetchJson('https://example.com/start', { fetchImpl: mockFetchLoopbackRedirect, lookupImpl: fakeLookup }),
    /private or reserved/
  );

  // Too many redirects
  const mockInfiniteRedirect = async (url) => {
    return {
      status: 302,
      headers: new Headers({ location: 'https://example.com/start' }),
    };
  };
  await assert.rejects(
    safeFetchJson('https://example.com/start', { fetchImpl: mockInfiniteRedirect, lookupImpl: fakeLookup }),
    /too many redirects/
  );
});

test('safeFetchJson: succeeds on safe redirect to valid HTTPS target', async () => {
  const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  let calls = 0;
  const mockFetch = async (url) => {
    calls++;
    if (calls === 1) {
      return {
        status: 301,
        headers: new Headers({ location: 'https://cdn.example.com/final-pools.json' }),
      };
    }
    return new Response(JSON.stringify([{ provider: 'redirected-prov', keys: ['KEY_R'] }]), { status: 200 });
  };

  const data = await safeFetchJson('https://example.com/start', { fetchImpl: mockFetch, lookupImpl: fakeLookup });
  assert.equal(data.length, 1);
  assert.equal(data[0].provider, 'redirected-prov');
});

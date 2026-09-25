// lib/safe-fetch.js — SSRF-protected HTTP fetch with DNS and IP validation (#354).
import net from 'node:net';
import dns from 'node:dns/promises';

export const MAX_IMPORT_BYTES = 1024 * 1024; // 1 MB limit
export const MAX_REDIRECTS = 5;

/**
 * Checks if an IPv4 or IPv6 address is private, loopback, link-local, multicast, or reserved.
 * @param {string} ip
 * @returns {boolean} true if private/reserved/loopback
 */
export function isPrivateOrReservedIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const kind = net.isIP(ip);
  if (kind === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b, c, d] = parts;
    if (a === 0) return true; // 0.0.0.0/8 current network
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol
    if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
    if (a >= 224) return true; // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved & broadcast
    return false;
  }
  if (kind === 6) {
    const norm = ip.toLowerCase();
    if (norm === '::' || norm === '::1' || norm === '0:0:0:0:0:0:0:0' || norm === '0:0:0:0:0:0:0:1') return true;
    if (norm.startsWith('::ffff:') || norm.startsWith('0:0:0:0:0:ffff:')) {
      const last = norm.split(':').pop();
      if (net.isIP(last) === 4) return isPrivateOrReservedIp(last);
    }
    if (/^fe[89ab][0-9a-f]:/i.test(norm)) return true; // fe80::/10 link-local
    if (/^f[cd][0-9a-f]{2}:/i.test(norm)) return true; // fc00::/7 unique local
    if (/^ff[0-9a-f]{2}:/i.test(norm)) return true; // ff00::/8 multicast
    if (/^(?:00)?2001:(?:0)?db8:/i.test(norm)) return true; // 2001:db8::/32 documentation
    if (/^(?:00)?100:/i.test(norm)) return true; // 100::/64 discard
    return false;
  }
  return true;
}

/**
 * Validates a target URL and its hostname/IP against SSRF.
 * @param {string} urlString
 * @param {object} options
 */
export async function assertSafeUrl(urlString, { lookupImpl = dns.lookup } = {}) {
  let urlObj;
  try {
    urlObj = new URL(urlString);
  } catch {
    const err = new Error('dsh-key-rotation: invalid URL');
    err.code = 'INVALID_URL';
    throw err;
  }

  if (urlObj.protocol !== 'https:') {
    const err = new Error('dsh-key-rotation: only HTTPS URLs are allowed');
    err.code = 'DISALLOWED_PROTOCOL';
    throw err;
  }

  const hostname = urlObj.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) {
    const err = new Error('dsh-key-rotation: missing hostname');
    err.code = 'INVALID_HOST';
    throw err;
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      const err = new Error(`dsh-key-rotation: target IP ${hostname} is private or reserved`);
      err.code = 'SSRF_BLOCKED';
      throw err;
    }
    return urlObj;
  }

  let records;
  try {
    records = await lookupImpl(hostname, { all: true });
  } catch (dnsErr) {
    const err = new Error(`dsh-key-rotation: DNS resolution failed for ${hostname}: ${dnsErr.message}`);
    err.code = 'DNS_FAILED';
    throw err;
  }

  if (!records || records.length === 0) {
    const err = new Error(`dsh-key-rotation: no DNS records found for ${hostname}`);
    err.code = 'DNS_FAILED';
    throw err;
  }

  for (const rec of records) {
    const addr = typeof rec === 'string' ? rec : rec.address;
    if (isPrivateOrReservedIp(addr)) {
      const err = new Error(`dsh-key-rotation: host ${hostname} resolves to private or reserved IP ${addr}`);
      err.code = 'SSRF_BLOCKED';
      throw err;
    }
  }

  return urlObj;
}

/**
 * Reads a response safely, capping byte size to maxBytes before parsing JSON.
 * @param {Response} resp
 * @param {number} maxBytes
 * @returns {Promise<any>}
 */
export async function readBoundedJson(resp, maxBytes = MAX_IMPORT_BYTES) {
  const clHeader = resp.headers?.get?.('content-length');
  if (clHeader) {
    const len = Number(clHeader);
    if (!isNaN(len) && len > maxBytes) {
      const err = new Error(`dsh-key-rotation: response exceeds maximum size of ${maxBytes} bytes`);
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
  }

  if (resp.body && typeof resp.body.getReader === 'function') {
    const reader = resp.body.getReader();
    let total = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          reader.cancel();
          const err = new Error(`dsh-key-rotation: response exceeds maximum size of ${maxBytes} bytes`);
          err.code = 'PAYLOAD_TOO_LARGE';
          throw err;
        }
        chunks.push(value);
      }
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') throw e;
      throw new Error(`dsh-key-rotation: error reading response body: ${e.message}`);
    }
    const fullBuffer = Buffer.concat(chunks);
    return JSON.parse(fullBuffer.toString('utf8'));
  }

  if (typeof resp.text === 'function') {
    const text = await resp.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      const err = new Error(`dsh-key-rotation: response exceeds maximum size of ${maxBytes} bytes`);
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    return JSON.parse(text);
  }

  if (typeof resp.json === 'function') {
    return await resp.json();
  }

  throw new Error('dsh-key-rotation: unable to read response as JSON');
}

/**
 * Fetches JSON from a URL with SSRF protection, redirect verification, and size bounding.
 * @param {string} url
 * @param {object} options
 */
export async function safeFetchJson(url, {
  signal,
  fetchImpl = globalThis.fetch,
  lookupImpl = dns.lookup,
  maxBytes = MAX_IMPORT_BYTES,
  redirectsLeft = MAX_REDIRECTS,
} = {}) {
  let currentUrl = url;
  while (true) {
    await assertSafeUrl(currentUrl, { lookupImpl });
    const resp = await fetchImpl(currentUrl, {
      signal,
      redirect: 'manual',
    });

    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      if (redirectsLeft <= 0) {
        const err = new Error('dsh-key-rotation: too many redirects');
        err.code = 'TOO_MANY_REDIRECTS';
        throw err;
      }
      redirectsLeft--;
      const loc = resp.headers?.get?.('location');
      if (!loc) {
        const err = new Error('dsh-key-rotation: redirect missing Location header');
        err.code = 'BAD_REDIRECT';
        throw err;
      }
      currentUrl = new URL(loc, currentUrl).href;
      continue;
    }

    if (!resp.ok) {
      const err = new Error(`dsh-key-rotation: fetch returned ${resp.status}`);
      err.code = 'FETCH_FAILED';
      err.status = resp.status;
      throw err;
    }

    return await readBoundedJson(resp, maxBytes);
  }
}

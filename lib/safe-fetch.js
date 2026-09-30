// lib/safe-fetch.js — SSRF-protected HTTP fetch with DNS and IP validation (#354, #411).
import net from 'node:net';
import dns from 'node:dns/promises';
import nodeDns from 'node:dns';
import { Agent } from 'undici';

export const MAX_IMPORT_BYTES = 1024 * 1024; // 1 MB limit
export const MAX_REDIRECTS = 5;

/**
 * Parses an IPv6 string into an array of 8 16-bit integers (words).
 * Supports standard hex, compressed `::`, and embedded dotted IPv4 (e.g. `::ffff:127.0.0.1`).
 * @param {string} ip
 * @returns {number[]|null}
 */
export function parseIpv6Words(ip) {
  if (typeof ip !== 'string') return null;
  let s = ip.toLowerCase().trim().replace(/^\[|\]$/g, '');
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1) {
    const tail = s.slice(lastColon + 1);
    if (net.isIP(tail) === 4) {
      const parts = tail.split('.').map(Number);
      if (parts.length === 4 && !parts.some(n => isNaN(n) || n < 0 || n > 255)) {
        const w6 = ((parts[0] << 8) | parts[1]) & 0xffff;
        const w7 = ((parts[2] << 8) | parts[3]) & 0xffff;
        s = s.slice(0, lastColon) + ':' + w6.toString(16) + ':' + w7.toString(16);
      }
    }
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').map(x => parseInt(x, 16)) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').map(x => parseInt(x, 16)) : [];
  if (left.some(isNaN) || right.some(isNaN)) return null;
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const middle = new Array(missing).fill(0);
  return [...left, ...middle, ...right];
}

/**
 * Checks if an IPv4 or IPv6 address is private, loopback, link-local, multicast, or reserved.
 * Canonicalizes IPv6 addresses including hex and dotted-quad IPv4-mapped forms (#411).
 * @param {string} ip
 * @returns {boolean} true if private/reserved/loopback
 */
export function isPrivateOrReservedIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const cleaned = ip.trim().replace(/^\[|\]$/g, '');
  const kind = net.isIP(cleaned);
  if (kind === 4) {
    const parts = cleaned.split('.').map(Number);
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
    const words = parseIpv6Words(cleaned);
    if (!words || words.length !== 8) return true;
    const [w0, w1, w2, w3, w4, w5, w6, w7] = words;
    // Unspecified :: or loopback ::1
    if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0) {
      if (w7 === 0 || w7 === 1) return true;
    }
    // IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), or NAT64 (64:ff9b::/96)
    const isMapped = (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff);
    const isCompat = (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0);
    const isNat64 = (w0 === 0x0064 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0);
    if (isMapped || isCompat || isNat64) {
      const a = (w6 >> 8) & 0xff;
      const b = w6 & 0xff;
      const c = (w7 >> 8) & 0xff;
      const d = w7 & 0xff;
      return isPrivateOrReservedIp(`${a}.${b}.${c}.${d}`);
    }
    if ((w0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((w0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((w0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (w0 === 0x2001 && w1 === 0x0db8) return true; // 2001:db8::/32 documentation
    if (w0 === 0x0100 && w1 === 0) return true; // 100::/64 discard
    return false;
  }
  return true;
}

/**
 * Creates an undici Agent with connect-time lookup validation against DNS rebinding / TOCTOU (#411).
 * @param {object} [opts]
 * @param {Function} [opts.lookupImpl]
 * @returns {Agent}
 */
export function createSafeDispatcher({ lookupImpl = nodeDns.lookup } = {}) {
  return new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        const opts = typeof options === 'function' ? {} : options;
        lookupImpl(hostname, { ...opts, all: true }, (err, addresses) => {
          if (err) return cb(err);
          const list = Array.isArray(addresses) ? addresses : [addresses];
          for (const item of list) {
            const addr = typeof item === 'string' ? item : item.address;
            if (isPrivateOrReservedIp(addr)) {
              const ssrfErr = new Error(`dsh-key-rotation: connect blocked: host ${hostname} resolves to private or reserved IP ${addr}`);
              ssrfErr.code = 'SSRF_BLOCKED';
              return cb(ssrfErr);
            }
          }
          if (typeof options === 'function') {
            const first = list[0];
            const addr = typeof first === 'string' ? first : first.address;
            const fam = typeof first === 'object' && first.family ? first.family : (net.isIP(addr) || 4);
            return cb(null, addr, fam);
          }
          return cb(null, addresses);
        });
      },
    },
  });
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
 * Fetches JSON from a URL with SSRF protection, connect-time rebinding guard, redirect verification, and size bounding.
 * @param {string} url
 * @param {object} options
 */
export async function safeFetchJson(url, {
  signal,
  fetchImpl = globalThis.fetch,
  lookupImpl = dns.lookup,
  maxBytes = MAX_IMPORT_BYTES,
  redirectsLeft = MAX_REDIRECTS,
  dispatcher,
} = {}) {
  const safeDispatcher = dispatcher ?? (fetchImpl === globalThis.fetch ? createSafeDispatcher() : undefined);
  let currentUrl = url;
  while (true) {
    await assertSafeUrl(currentUrl, { lookupImpl });
    const fetchOpts = {
      signal,
      redirect: 'manual',
    };
    if (safeDispatcher) fetchOpts.dispatcher = safeDispatcher;
    const resp = await fetchImpl(currentUrl, fetchOpts);

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

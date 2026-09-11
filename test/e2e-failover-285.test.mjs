import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CircuitBreaker, BREAKER_OPEN, BREAKER_HALF_OPEN, BREAKER_CLOSED } from '../lib/circuit-breaker.js';
import { recordFailure, applyCooldown, isSwitchableError } from '../lib/pool.js';
import { classifyFailure } from '../lib/error-taxonomy.js';
import { sanitizeSnapshot } from '../lib/sanitize-snapshot.js';

/** Minimal mock upstream that can fail with 429 then succeed. */
function startMockUpstream() {
  let mode = 'fail429';
  const server = http.createServer((req, res) => {
    if (mode === 'fail429') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    if (mode === 'fail500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        setMode: (m) => { mode = m; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('e2e: 429 is switchable and triggers cooldown classification', async () => {
  const up = await startMockUpstream();
  try {
    const res = await fetch(up.url + '/v1/models');
    assert.equal(res.status, 429);
    const body = await res.json();
    const payload = { status: res.status, code: '429', message: body?.error?.message || 'rate limited' };
    assert.equal(isSwitchableError(payload, new Set(['429', 'RATE_LIMIT', 'QUOTA', 'insufficient_quota'])), true);
    const cls = classifyFailure(payload);
    assert.ok(cls.action === 'switch' || cls.action === 'cooldown', `unexpected action ${cls.action}`);
  } finally {
    await up.close();
  }
});

test('e2e: after mode flip, same upstream returns success (failover target healthy)', async () => {
  const up = await startMockUpstream();
  try {
    up.setMode('ok');
    const res = await fetch(up.url + '/v1/models');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  } finally {
    await up.close();
  }
});

test('e2e: circuit opens after threshold, half-open recovers after openMs', async () => {
  let now = 1000;
  const br = new CircuitBreaker({ threshold: 2, openMs: 100, halfOpenProbes: 1, now: () => now });
  assert.equal(br.canRequest('p'), true);
  br.onFailure('p');
  assert.equal(br.state('p'), BREAKER_CLOSED);
  br.onFailure('p');
  assert.equal(br.state('p'), BREAKER_OPEN);
  assert.equal(br.canRequest('p'), false);
  now += 150; // openMs is floored to >=100 in CircuitBreaker
  assert.equal(br.canRequest('p'), true); // half-open probe allowed
  assert.equal(br.state('p'), BREAKER_HALF_OPEN);
  br.onSuccess('p');
  assert.equal(br.state('p'), BREAKER_CLOSED);
});

test('e2e: sanitize status after failover path has no negative remaining', () => {
  const s = sanitizeSnapshot({
    providers: [{
      provider: 'p',
      healthScore: 40,
      switches: 1,
      keys: [
        { ref: 'A', present: true, cooldownMsLeft: 1200, usage: 3 },
        { ref: 'B', present: true, cooldownMsLeft: -20, usage: 1 },
      ],
    }],
  });
  for (const k of s.providers[0].keys) {
    assert.ok(k.cooldownMsLeft >= 0);
  }
});

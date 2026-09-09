// test/stability-080.test.mjs — 0.8.0 stability block (#260-#269)
import test from 'node:test';
import assert from 'node:assert/strict';
import { nowMono, nowWall } from '../lib/clock.js';
import { BoundedMap } from '../lib/bounded-map.js';
import { CircuitBreaker, BREAKER_OPEN, BREAKER_CLOSED, BREAKER_HALF_OPEN } from '../lib/circuit-breaker.js';
import { classifyFailure, shouldSwitch } from '../lib/error-taxonomy.js';
import { safeParseJson, atomicWriteFile, safeReadJson, atomicWriteJson } from '../lib/atomic-io.js';
import { NotifyQueue } from '../lib/notify-queue.js';
import { isSwitchableError } from '../lib/pool.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('clock: nowMono is finite and near wall clock', () => {
  const m = nowMono();
  const w = nowWall();
  assert.ok(Number.isFinite(m));
  assert.ok(Math.abs(m - w) < 60_000, `mono ${m} wall ${w}`);
});

test('bounded-map: evicts oldest past max and respects TTL', () => {
  const bm = new BoundedMap({ max: 2, ttlMs: 1000 });
  bm.set('a', 1, 0);
  bm.set('b', 2, 0);
  bm.set('c', 3, 0);
  assert.equal(bm.size, 2);
  assert.equal(bm.get('a', 0), undefined);
  assert.equal(bm.get('b', 0), 2);
  assert.equal(bm.get('c', 0), 3);
  // TTL
  const t = new BoundedMap({ max: 10, ttlMs: 100 });
  t.set('x', 9, 0);
  assert.equal(t.get('x', 50), 9);
  assert.equal(t.get('x', 150), undefined);
});

test('bounded-map: LRU refresh on get', () => {
  const bm = new BoundedMap({ max: 2 });
  bm.set('a', 1, 0);
  bm.set('b', 2, 0);
  bm.get('a', 0); // a becomes most-recent
  bm.set('c', 3, 0); // evicts b
  assert.equal(bm.get('a', 0), 1);
  assert.equal(bm.get('b', 0), undefined);
  assert.equal(bm.get('c', 0), 3);
});

test('circuit-breaker: opens after threshold, half-open then closed', () => {
  let t = 0;
  const cb = new CircuitBreaker({ threshold: 3, openMs: 1000, halfOpenProbes: 1, now: () => t });
  assert.equal(cb.canRequest('p'), true);
  cb.onFailure('p');
  cb.onFailure('p');
  assert.equal(cb.state('p'), BREAKER_CLOSED);
  cb.onFailure('p');
  assert.equal(cb.state('p'), BREAKER_OPEN);
  assert.equal(cb.canRequest('p'), false);
  t = 1000;
  assert.equal(cb.canRequest('p'), true); // half-open probe
  assert.equal(cb.state('p'), BREAKER_HALF_OPEN);
  cb.onSuccess('p');
  assert.equal(cb.state('p'), BREAKER_CLOSED);
});

test('circuit-breaker: half-open failure re-opens', () => {
  let t = 0;
  const cb = new CircuitBreaker({ threshold: 2, openMs: 500, halfOpenProbes: 1, now: () => t });
  cb.onFailure('x'); cb.onFailure('x');
  assert.equal(cb.state('x'), BREAKER_OPEN);
  t = 500;
  assert.equal(cb.canRequest('x'), true);
  cb.onFailure('x');
  assert.equal(cb.state('x'), BREAKER_OPEN);
  assert.equal(cb.canRequest('x'), false);
});

test('error-taxonomy: full HTTP/socket/gRPC table', () => {
  assert.equal(classifyFailure({ status: 429 }).action, 'switch');
  assert.equal(classifyFailure({ status: 408 }).action, 'switch');
  assert.equal(classifyFailure({ status: 425 }).action, 'switch');
  assert.equal(classifyFailure({ status: 500 }).soft, true);
  assert.equal(classifyFailure({ status: 503 }).action, 'switch');
  assert.equal(classifyFailure({ status: 400 }).action, 'surface');
  assert.equal(classifyFailure({ status: 404 }).action, 'surface');
  assert.equal(classifyFailure({ code: 'ECONNRESET' }).action, 'switch');
  assert.equal(classifyFailure({ code: 'ETIMEDOUT' }).action, 'switch');
  assert.equal(classifyFailure({ code: 'UNAVAILABLE' }).action, 'switch');
  assert.equal(classifyFailure({ code: 'ABORTED' }).action, 'switch');
  assert.equal(classifyFailure({ code: 'INVALID_ARGUMENT' }).action, 'surface');
  assert.equal(shouldSwitch({ status: 429 }), true);
  assert.equal(shouldSwitch({ status: 400 }), false);
});

test('error-taxonomy aligns with isSwitchableError for common cases', () => {
  const cases = [
    { status: 429 }, { status: 401 }, { status: 503 },
    { code: 'RESOURCE_EXHAUSTED' }, { code: 'UNAVAILABLE' },
  ];
  for (const c of cases) {
    assert.equal(shouldSwitch(c), isSwitchableError(c), JSON.stringify(c));
  }
});

test('atomic-io: safeParseJson never wipes on corrupt', () => {
  assert.deepEqual(safeParseJson('{"a":1}', {}), { a: 1 });
  assert.deepEqual(safeParseJson('not-json', { keep: true }), { keep: true });
  assert.deepEqual(safeParseJson('', { keep: 1 }), { keep: 1 });
  assert.deepEqual(safeParseJson(null, { keep: 2 }), { keep: 2 });
  assert.deepEqual(safeParseJson('null', { keep: 3 }), { keep: 3 });
});

test('atomic-io: atomic write + read roundtrip', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kr-atomic-'));
  const file = path.join(dir, 'state.json');
  await atomicWriteJson(file, { ok: true, n: 1 });
  const got = await safeReadJson(file, null);
  assert.deepEqual(got, { ok: true, n: 1 });
  // corrupt file → fallback (previous)
  await fs.writeFile(file, '{broken', 'utf8');
  const fallback = await safeReadJson(file, { previous: true });
  assert.deepEqual(fallback, { previous: true });
  await atomicWriteFile(file, 'hello');
  assert.equal(await fs.readFile(file, 'utf8'), 'hello');
  await fs.rm(dir, { recursive: true, force: true });
});

test('notify-queue: non-blocking enqueue and drop when full', async () => {
  let calls = 0;
  const q = new NotifyQueue({
    send: async () => { calls++; return { sent: true }; },
    maxDepth: 2,
  });
  const a = q.enqueue('http://x', { n: 1 });
  assert.equal(a.queued, true);
  // busy processing first; next enqueues
  const b = q.enqueue('http://x', { n: 2 });
  const c = q.enqueue('http://x', { n: 3 });
  assert.equal(b.queued, true);
  // one may be dropped if depth exceeded while busy — allow either full or queued
  assert.ok(c.queued === true || c.reason === 'full');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls >= 1);
  const st = q.stats();
  assert.ok(st.sent + st.failed + st.depth <= 3);
});

test('notify-queue: failure bumps backoff without throw', async () => {
  let n = 0;
  const q = new NotifyQueue({
    send: async () => { n++; return { sent: false }; },
    baseBackoffMs: 1,
    maxBackoffMs: 4,
  });
  q.enqueue('http://y', { a: 1 });
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(n >= 1);
  assert.ok(q.stats().failed >= 1);
});

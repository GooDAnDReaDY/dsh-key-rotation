// test/webhook.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebhookSender } from '../lib/webhook.js';

function fixedFetch(impl) {
  return async (...args) => impl(...args);
}

test('WebhookSender: requires fetchImpl', () => {
  assert.throws(() => new WebhookSender({}), /fetchImpl required/);
});

test('WebhookSender: send returns sent=false for empty url', async () => {
  const r = new WebhookSender({ fetchImpl: fixedFetch(async () => ({ ok: true })) });
  const res = await r.send('', { a: 1 });
  assert.equal(res.sent, false);
  const res2 = await r.send(null, { a: 1 });
  assert.equal(res2.sent, false);
});

test('WebhookSender: 200 marks throttled on same URL', async () => {
  let calls = 0;
  const r = new WebhookSender({ fetchImpl: fixedFetch(async () => { calls += 1; return { ok: true, status: 200 }; }) });
  const res1 = await r.send('http://x', { a: 1 }, 1000);
  assert.equal(res1.sent, true);
  assert.equal(res1.status, 200);
  const res2 = await r.send('http://x', { a: 2 }, 1500);
  assert.equal(res2.sent, false);
  assert.equal(res2.throttled, true);
  assert.equal(calls, 1);
  const res3 = await r.send('http://x', { a: 3 }, 1000 + 60_000);
  assert.equal(res3.sent, true);
  assert.equal(calls, 2);
});

test('WebhookSender: 5xx retried once, final ok', async () => {
  let calls = 0;
  const r = new WebhookSender({ fetchImpl: fixedFetch(async () => { calls += 1; return { ok: calls >= 2, status: calls === 1 ? 503 : 200 }; }) });
  const res = await r.send('http://x', { a: 1 }, 10_000_000);
  assert.equal(res.sent, true);
  assert.equal(calls, 2);
});

test('WebhookSender: 5xx retry also 5xx → not sent, not throttled', async () => {
  let calls = 0;
  const r = new WebhookSender({ fetchImpl: fixedFetch(async () => { calls += 1; return { ok: false, status: 503 }; }) });
  const res = await r.send('http://x', { a: 1 }, 10_000_000);
  assert.equal(res.sent, false);
  assert.equal(calls, 2);
  // Failure doesn't mark throttle — future send allowed.
  const res2 = await r.send('http://x', { a: 2 }, 10_000_000 + 100);
  assert.equal(res2.throttled, undefined);
});

test('WebhookSender: 4xx no retry, not sent', async () => {
  let calls = 0;
  const r = new WebhookSender({ fetchImpl: fixedFetch(async () => { calls += 1; return { ok: false, status: 400 }; }) });
  const res = await r.send('http://x', { a: 1 }, 10_000_000);
  assert.equal(res.sent, false);
  assert.equal(calls, 1);
});

test('WebhookSender: AbortController timeout', async () => {
  const r = new WebhookSender({ fetchImpl: fixedFetch(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }) });
  const res = await r.send('http://x', { a: 1 }, 10_000_000);
  assert.equal(res.sent, false);
  assert.equal(res.error, 'timeout');
});

test('WebhookSender: network error', async () => {
  const r = new WebhookSender({ fetchImpl: fixedFetch(async () => { throw new Error('ECONNREFUSED'); }) });
  const res = await r.send('http://x', { a: 1 }, 10_000_000);
  assert.equal(res.sent, false);
  assert.equal(res.error, 'network');
});

test('WebhookSender: per-URL throttle window', async () => {
  let calls = 0;
  const r = new WebhookSender({ fetchImpl: fixedFetch(async () => { calls += 1; return { ok: true, status: 200 }; }) });
  await r.send('http://x', { a: 1 }, 1000);
  await r.send('http://y', { a: 1 }, 1100);
  assert.equal(calls, 2);
});

test('WebhookSender: send accepts raw string body (passes url+opts through)', async () => {
  let receivedUrl = '';
  let receivedBody = '';
  const r = new WebhookSender({ fetchImpl: fixedFetch(async (url, opts) => { receivedUrl = url; receivedBody = opts.body; return { ok: true, status: 200 }; }) });
  await r.send('http://example.test', 'raw text', 10_000_000);
  assert.equal(receivedUrl, 'http://example.test');
  assert.equal(receivedBody, 'raw text');
});

test('WebhookSender: snapshot and reset', async () => {
  const r = new WebhookSender({ fetchImpl: fixedFetch(async () => ({ ok: true, status: 200 })) });
  await r.send('http://x', { a: 1 }, 10_000_000);
  const s = r.snapshot();
  assert.equal(s['http://x'], 10_000_000);
  r.reset('http://x');
  assert.equal(r.snapshot()['http://x'], undefined);
  await r.send('http://y', { a: 2 }, 20_000_000);
  r.reset();
  assert.deepEqual(r.snapshot(), {});
});

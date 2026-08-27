// test/incident.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncidentReporter } from '../lib/incident.js';

function fixedFetch(impl) {
  return async () => impl();
}

test('IncidentReporter: requires token/baseUrl/repo', () => {
  assert.throws(() => new IncidentReporter({}), /token required/);
  assert.throws(() => new IncidentReporter({ token: 'x' }), /baseUrl required/);
  assert.throws(() => new IncidentReporter({ token: 'x', baseUrl: 'http://x' }), /repo/);
});

test('shouldReport: false when exhausted too recently', () => {
  const r = new IncidentReporter({ token: 't', baseUrl: 'http://x', repo: 'o/n' });
  assert.equal(r.shouldReport('A', 1000, 1000), false, 'no time passed');
  assert.equal(r.shouldReport('A', 1000, 1000 + 60_000), false, 'under threshold');
});

test('shouldReport: true after threshold and no recent incident', () => {
  const r = new IncidentReporter({ token: 't', baseUrl: 'http://x', repo: 'o/n' });
  const now = 1000 + 6 * 60_000;
  assert.equal(r.shouldReport('A', 1000, now), true);
});

test('shouldReport: false during cooldown after incident', () => {
  const r = new IncidentReporter({ token: 't', baseUrl: 'http://x', repo: 'o/n' });
  const exhausted = 0;
  r.markReported('A', 1000);
  assert.equal(r.shouldReport('A', exhausted, 1000 + 10 * 60_000), false);
  assert.equal(r.shouldReport('A', exhausted, 1000 + 31 * 60_000), true);
});

test('shouldReport: missing provider or non-finite exhaustedSince', () => {
  const r = new IncidentReporter({ token: 't', baseUrl: 'http://x', repo: 'o/n' });
  assert.equal(r.shouldReport('', 0), false);
  assert.equal(r.shouldReport('A', NaN), false);
  assert.equal(r.shouldReport('A', undefined), false);
});

test('open: success path marks reported and returns number', async () => {
  let calls = 0;
  const r = new IncidentReporter({
    token: 't',
    baseUrl: 'http://x',
    repo: 'o/n',
    thresholdMs: 0,
    fetchImpl: fixedFetch(async () => {
      calls += 1;
      return { ok: true, status: 201, json: async () => ({ number: 42, html_url: 'http://x/issues/42' }) };
    }),
  });
  const res = await r.open('A', 0, 1_000_000);
  assert.equal(res.reported, true);
  assert.equal(res.number, 42);
  assert.match(res.url, /\/42$/);
  assert.equal(calls, 1);
  const res2 = await r.open('A', 0, 1_000_000 + 60_000);
  assert.equal(res2.reported, false);
});

test('open: failure (non-ok response) does NOT mark reported', async () => {
  const r = new IncidentReporter({
    token: 't',
    baseUrl: 'http://x',
    repo: 'o/n',
    thresholdMs: 0,
    fetchImpl: fixedFetch(async () => ({ ok: false, status: 500 })),
  });
  const res = await r.open('A', 0, 1_000_000);
  assert.equal(res.reported, false);
  assert.equal(res.status, 500);
  const res2 = await r.open('A', 0, 2_000_000);
  assert.equal(res2.reported, false);
});

test('open: network error returns reported=false', async () => {
  const r = new IncidentReporter({
    token: 't',
    baseUrl: 'http://x',
    repo: 'o/n',
    thresholdMs: 0,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  const res = await r.open('A', 0, 1_000_000);
  assert.equal(res.reported, false);
});

test('resetCooldown: clears specific entry, others unaffected', () => {
  const r = new IncidentReporter({ token: 't', baseUrl: 'http://x', repo: 'o/n' });
  r.markReported('A', 1000);
  r.markReported('B', 2000);
  r.resetCooldown('A');
  // A's last is gone — fresh, can report
  assert.equal(r.shouldReport('A', 0, 1000 + 10 * 60_000), true);
  // B's last is still 2000 — at 2000+10min = within cooldown
  assert.equal(r.shouldReport('B', 0, 2000 + 10 * 60_000), false);
  // clear all
  r.resetCooldown();
  assert.equal(r.shouldReport('B', 0, 10_000_000), true);
});

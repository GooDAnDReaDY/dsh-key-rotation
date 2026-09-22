import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { computeBackoff, recordFailure } from '../lib/pool.js';
import { createRotate } from '../lib/rotate.js';
import { pushEvent } from '../lib/notify-events.js';

const NOW = 1790049754447;
const RESET = 1790121600000;
async function fail(code, message, window = { type: 'midnight_utc', hour: 0 }) {
  const original = { type: 'finish', reason: { kind: 'error', failure: { code, message } } };
  const pool = { base: 'demo', refs: ['DUMMY_KEY'], state: { failedUntil: new Map(), events: [], lastUsed: 'DUMMY_KEY' } };
  const runtime = { switchCodes: ['QUOTA', 'RATE_LIMIT', 'TIMEOUT', 'SERVER', 'RESOURCE_EXHAUSTED'], cooldownMs: 60000, concurrencyLimit: 0, quotaResetWindow: window };
  const rotate = createRotate({
    ctx: { get: () => ({ stream: async function* () { yield original; } }) },
    dispatchStorage: new AsyncLocalStorage(), buildRuntime: () => runtime, pushEvent,
    notifySwitch: () => {}, notifyExhaustion: () => {}, recordLatency: () => {},
    concurrencyTracker: { isEnabled: () => false }, MARKER: '__test',
    finishError: (code, message) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } }),
    setRotateStartMs: () => {}, now: () => NOW,
  });
  const out = []; for await (const c of rotate({ provider: 'demo' }, pool)) out.push(c);
  assert.deepEqual(out.at(-1), original, 'classification must not mask the original error');
  return pool.state;
}

test('ordinary exponential backoff and default cap stay unchanged', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(n => computeBackoff(1000, n)), [1000, 2000, 4000, 8000, 8000]);
});
test('32nd failure saturates at cap rather than becoming negative', () => {
  assert.equal(computeBackoff(60000, 32, 480000), 480000);
});
test('33rd and later failures never wrap back to the initial delay', () => {
  for (const n of [33, 64, 65, 100, 1025, 100000]) assert.equal(computeBackoff(1000, n, 16000), 16000, String(n));
});
test('zero base remains zero even after exponent overflow', () => {
  assert.equal(computeBackoff(0, 100000), 0);
});
test('explicit zero and low caps remain respected', () => {
  assert.equal(computeBackoff(1000, 32, 0), 0); assert.equal(computeBackoff(1000, 100000, 500), 500);
});
test('transient soft failures retain the existing ten-second bound', () => {
  assert.equal(computeBackoff(60000, 100000, undefined, true), 10000);
});
test('recordFailure cannot write an already-expired cooldown after 32 failures', () => {
  const pool = { state: { failedUntil: new Map(), failCounts: new Map([['DUMMY_KEY', 31]]) } };
  assert.equal(recordFailure(pool, 'DUMMY_KEY', NOW, 60000, 480000), 480000);
  assert.equal(pool.state.failedUntil.get('DUMMY_KEY'), NOW + 480000);
});
for (const [code, message] of [
  ['RATE_LIMIT', 'rate limit exceeded'], ['TIMEOUT', 'deadline exceeded'],
  ['SERVER', 'maximum retry count exceeded'], ['RESOURCE_EXHAUSTED', 'requests per minute exceeded'],
  ['RATE_LIMIT', 'quota remaining: 100; rate limit exceeded'],
]) test(`${code}: ${message} stays on a short cooldown`, async () => {
  const state = await fail(code, message); const until = state.failedUntil.get('DUMMY_KEY');
  assert.ok(until > NOW && until < NOW + 70000, String(until));
  assert.equal(state.quotaWindows?.has('DUMMY_KEY') ?? false, false);
});
for (const [code, message] of [
  ['QUOTA', 'provider-defined quota code'], ['RESOURCE_EXHAUSTED', 'quota exhausted'],
  ['RATE_LIMIT', 'You exceeded your current quota, please check billing'],
  ['RATE_LIMIT', 'insufficient_quota'], ['RESOURCE_EXHAUSTED', 'Quota is exhausted'],
]) test(`${code}: explicit quota exhaustion still uses calendar reset (${message})`, async () => {
  const state = await fail(code, message);
  assert.equal(state.failedUntil.get('DUMMY_KEY'), RESET); assert.equal(state.quotaWindows.get('DUMMY_KEY'), RESET);
});
test('disabling the calendar window leaves real QUOTA on normal backoff', async () => {
  const state = await fail('QUOTA', 'quota exhausted', false);
  assert.ok(state.failedUntil.get('DUMMY_KEY') < NOW + 70000);
});

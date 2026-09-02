// test/canary.test.mjs - issue #196 canary probing
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanaryProber } from '../lib/canary.js';

function makeRunner(impl) {
  return { probeModels: async (ref, key) => impl(ref, key) };
}

test('CanaryProber: requires sandboxRunner', () => {
  assert.throws(() => new CanaryProber({}), /sandboxRunner required/);
});

test('CanaryProber: probe success stores result', async () => {
  const prober = new CanaryProber({ sandboxRunner: makeRunner(async () => ({ ok: true, code: 'ok', latencyMs: 50 })) });
  const r = await prober.probe('REF1', 'key1');
  assert.equal(r.ok, true);
  assert.equal(prober.isHealthy('REF1'), true);
  assert.ok(prober.lastResult('REF1').at > 0);
});

test('CanaryProber: probe failure stores not-ok', async () => {
  const prober = new CanaryProber({ sandboxRunner: makeRunner(async () => ({ ok: false, code: 'auth', latencyMs: 20 })) });
  await prober.probe('REF2', 'key2');
  assert.equal(prober.isHealthy('REF2'), false);
});

test('CanaryProber: probe dedupes in-flight (second probe returns null)', async () => {
  let calls = 0;
  const prober = new CanaryProber({ sandboxRunner: makeRunner(async () => { calls += 1; await new Promise(r => setTimeout(r, 50)); return { ok: true }; }) });
  const p1 = prober.probe('REF3', 'k');
  const p2 = await prober.probe('REF3', 'k');
  assert.equal(p2, null, 'second probe while in flight resolves to null');
  const r1 = await p1;
  assert.ok(r1);
  assert.equal(calls, 1);
});

test('CanaryProber: probe exception returns error result', async () => {
  const prober = new CanaryProber({ sandboxRunner: makeRunner(async () => { throw new Error('boom'); }) });
  const r = await prober.probe('REF4', 'k');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'error');
});

test('CanaryProber: clear by ref or all', async () => {
  const prober = new CanaryProber({ sandboxRunner: makeRunner(async () => ({ ok: true })) });
  await prober.probe('A', 'k');
  await prober.probe('B', 'k');
  prober.clear('A');
  assert.equal(prober.lastResult('A'), null);
  assert.ok(prober.lastResult('B'));
  prober.clear();
  assert.equal(prober.snapshot().A, undefined);
});

test('CanaryProber: snapshot returns all results', async () => {
  const prober = new CanaryProber({ sandboxRunner: makeRunner(async () => ({ ok: true, code: 'ok' })) });
  await prober.probe('X', 'k');
  await prober.probe('Y', 'k');
  const s = prober.snapshot();
  assert.equal(Object.keys(s).length, 2);
});

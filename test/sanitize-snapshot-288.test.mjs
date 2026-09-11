import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSnapshot, sanitizeKeyStatus } from '../lib/sanitize-snapshot.js';

test('sanitizeKeyStatus clamps negative remaining to 0', () => {
  const k = sanitizeKeyStatus({ ref: 'A', cooldownMsLeft: -50, usage: -1 }, Date.now());
  assert.equal(k.cooldownMsLeft, 0);
  assert.equal(k.usage, 0);
});

test('sanitizeKeyStatus drops NaN usage', () => {
  const k = sanitizeKeyStatus({ ref: 'A', usage: Number.NaN, failures: Number.NaN }, Date.now());
  assert.equal(k.usage, 0);
  assert.equal(k.failures, 0);
});

test('sanitizeKeyStatus zeroes absolute timestamps in the past', () => {
  const now = 1_700_000_000_000;
  const k = sanitizeKeyStatus({ ref: 'A', cooldownMsLeft: now - 1 }, now);
  assert.equal(k.cooldownMsLeft, 0);
});

test('sanitizeSnapshot clamps healthScore into 0..100', () => {
  const s = sanitizeSnapshot({
    providers: [
      { provider: 'p', healthScore: 250, switches: -3, keys: [{ ref: 'K', usage: Number.NaN, cooldownMsLeft: -1 }] },
      { provider: 'q', healthScore: -5, keys: [] },
    ],
  });
  assert.equal(s.providers[0].healthScore, 100);
  assert.equal(s.providers[0].switches, 0);
  assert.equal(s.providers[0].keys[0].usage, 0);
  assert.equal(s.providers[1].healthScore, 0);
});

test('sanitizeSnapshot handles empty / non-object input', () => {
  assert.deepEqual(sanitizeSnapshot(null), { providers: [] });
  assert.deepEqual(sanitizeSnapshot(undefined), { providers: [] });
});

test('sanitizeSnapshot does not mutate input', () => {
  const input = { providers: [{ provider: 'p', healthScore: 999, keys: [] }] };
  const out = sanitizeSnapshot(input);
  assert.equal(input.providers[0].healthScore, 999);
  assert.equal(out.providers[0].healthScore, 100);
});

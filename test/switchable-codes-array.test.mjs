// test/switchable-codes-array.test.mjs — regression: switch codes arrive as an
// array, not a Set. `cfg.switchCodes` is a schema array (lib/index.js
// `Schema.array(...).default([...DEFAULT_SWITCH_CODES])`) and buildRuntime()
// passes it straight through to isSwitchableError(), which called
// `switchCodes.has(...)`. On arrays that is a TypeError
// ("switchCodes.has is not a function"), so EVERY switchable failure — a
// rate-limited or exhausted key, exactly when rotation is needed — crashed the
// turn instead of rotating to the next key. Fixed by normalizing array input
// to a Set inside isSwitchableError().
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSwitchableError, DEFAULT_SWITCH_CODES } from '../lib/pool.js';

test('isSwitchableError accepts an array of switch codes (the runtime shape)', () => {
  const codes = ['QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'];
  assert.equal(isSwitchableError({ code: 'RATE_LIMIT' }, codes), true);
  assert.equal(isSwitchableError({ status: 429 }, codes), true);
  assert.equal(isSwitchableError({ code: 'SERVER' }, codes), true);
  assert.equal(isSwitchableError({ code: 'TRANSPORT' }, codes), true);
  assert.equal(isSwitchableError({ code: 'FOO' }, codes), false);
  assert.equal(isSwitchableError({ status: 401 }, codes), false);
});

test('isSwitchableError accepts DEFAULT_SWITCH_CODES itself (an array)', () => {
  assert.equal(isSwitchableError({ code: 'QUOTA' }, DEFAULT_SWITCH_CODES), true);
  assert.equal(isSwitchableError({ code: 'AUTH' }, DEFAULT_SWITCH_CODES), true);
});

test('isSwitchableError still accepts a Set', () => {
  assert.equal(isSwitchableError({ code: 'QUOTA' }, new Set(['QUOTA'])), true);
  assert.equal(isSwitchableError({ code: 'FOO' }, new Set(['QUOTA'])), false);
});

test('isSwitchableError default-argument path still works', () => {
  assert.equal(isSwitchableError({ code: 'TIMEOUT' }), true);
  assert.equal(isSwitchableError({ code: 'FOO' }), false);
  assert.equal(isSwitchableError(null), false);
});

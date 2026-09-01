import test from 'node:test';
import assert from 'node:assert/strict';
import { envValue } from '../lib/pool.js';

test('envValue: returns value when env var is set', () => {
  process.env['TEST_ENV_BOOTSTRAP_A'] = 'sk-test-123';
  assert.equal(envValue('TEST_ENV_BOOTSTRAP_A'), 'sk-test-123');
  delete process.env['TEST_ENV_BOOTSTRAP_A'];
});

test('envValue: returns undefined when not set', () => {
  delete process.env['TEST_ENV_BOOTSTRAP_NOT_SET'];
  assert.equal(envValue('TEST_ENV_BOOTSTRAP_NOT_SET'), undefined);
});

test('envValue: returns undefined for empty string', () => {
  process.env['TEST_ENV_BOOTSTRAP_EMPTY'] = '';
  assert.equal(envValue('TEST_ENV_BOOTSTRAP_EMPTY'), undefined);
  delete process.env['TEST_ENV_BOOTSTRAP_EMPTY'];
});

test('envValue: does not leak to other refs', () => {
  process.env['TEST_ENV_BOOTSTRAP_X'] = 'val';
  assert.equal(envValue('TEST_ENV_BOOTSTRAP_Y'), undefined);
  delete process.env['TEST_ENV_BOOTSTRAP_X'];
});

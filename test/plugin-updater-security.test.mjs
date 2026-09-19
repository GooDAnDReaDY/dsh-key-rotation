// test/plugin-updater-security.test.mjs — regression for GitHub #6
// Validates packageSpec to guard against command-option injection in installExact().
import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidPackageSpec, PACKAGE_SPEC_PATTERN } from '../lib/plugin-updater.js';

test('isValidPackageSpec accepts valid package specs', () => {
  assert.equal(isValidPackageSpec('@goodandready/dsh-key-rotation@0.8.13'), true);
  assert.equal(isValidPackageSpec('@goodandready/dsh-key-rotation'), true);
  assert.equal(isValidPackageSpec('dsh-key-rotation@1.0.0'), true);
  assert.equal(isValidPackageSpec('dsh-key-rotation'), true);
  assert.equal(isValidPackageSpec('@scope/package@v1.2.3-alpha.1'), true);
});

test('isValidPackageSpec rejects option injections and malicious inputs', () => {
  assert.equal(isValidPackageSpec('--extra-flag'), false);
  assert.equal(isValidPackageSpec('-f'), false);
  assert.equal(isValidPackageSpec('--config.minimumReleaseAge=0'), false);
  assert.equal(isValidPackageSpec('@goodandready/dsh-key-rotation; rm -rf /'), false);
  assert.equal(isValidPackageSpec('pkg with spaces'), false);
  assert.equal(isValidPackageSpec(''), false);
  assert.equal(isValidPackageSpec(null), false);
  assert.equal(isValidPackageSpec(undefined), false);
});

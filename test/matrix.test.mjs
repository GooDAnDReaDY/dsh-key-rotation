// test/matrix.test.mjs - issue #198 Health Matrix endpoint
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

const matrixIdx = SRC.indexOf("path: TEST_MATRIX_PATH");

test('matrix: /test-matrix endpoint is registered', () => {
  assert.ok(matrixIdx > 0, 'TEST_MATRIX_PATH must be used in a webServer.register handler');
});

test('matrix: endpoint uses POST method', () => {
  const snippet = SRC.slice(matrixIdx, matrixIdx + 1500);
  assert.match(snippet, /req\.method !== 'POST'/);
});

test('matrix: endpoint is local-only (isTrustedBridgeRequest)', () => {
  const snippet = SRC.slice(matrixIdx, matrixIdx + 1500);
  assert.match(snippet, /isTrustedBridgeRequest/);
});

test('matrix: endpoint uses SandboxRunner', () => {
  const snippet = SRC.slice(matrixIdx, matrixIdx + 2000);
  assert.match(snippet, /probeModels|ensureSandboxRunner/);
});

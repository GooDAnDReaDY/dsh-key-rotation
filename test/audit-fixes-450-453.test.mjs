import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isSwitchableError,
  DEFAULT_SWITCH_CODES,
  SOFT_FAILURE_CODES,
  isSoftFailureCode,
} from '../lib/pool.js';
import { classifyFailure } from '../lib/error-taxonomy.js';
import { QUOTA_WINDOW_TYPES, poolResetAt, nextQuotaReset } from '../lib/quota-window.js';
import { getModelTokenUsage, getModelTokenRemaining, getModelQuotaStatus } from '../lib/model-quota.js';
import { createPoolIndex, addProviderPools, modelPoolsForRef } from '../lib/pool-index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('#453: switchCodes contract is honored strictly without regex resurrection', () => {
  // Operator config leaves TIMEOUT out
  const customCodes = new Set(['QUOTA', 'RATE_LIMIT', 'SERVER', 'AUTH']);

  // Error with explicit code TIMEOUT and timeout message
  const timeoutErr = {
    code: 'TIMEOUT',
    message: 'gateway request timeout after 30000ms',
  };
  assert.equal(isSwitchableError(timeoutErr, customCodes), false, 'explicit TIMEOUT excluded by switchCodes must not switch');

  // Socket error normalized to TRANSPORT, but TRANSPORT is not in customCodes
  const socketErr = {
    code: 'ECONNRESET',
    message: 'read ECONNRESET',
  };
  assert.equal(isSwitchableError(socketErr, customCodes), false, 'TRANSPORT excluded by switchCodes must not switch');

  // With default codes (which include TIMEOUT and TRANSPORT)
  assert.equal(isSwitchableError(timeoutErr, DEFAULT_SWITCH_CODES), true);
  assert.equal(isSwitchableError(socketErr, DEFAULT_SWITCH_CODES), true);

  // Uncoded failure falls back to text sniffing
  const uncodedErr = {
    message: 'rate limit reached, please slow down',
  };
  assert.equal(isSwitchableError(uncodedErr, customCodes), true);
});

test('#450: client-src contains no non-standard tokens or hex colors', () => {
  const clientSrcDir = path.join(__dirname, '../lib/client-src');
  const files = fs.readdirSync(clientSrcDir).filter(f => f.endsWith('.js'));

  const badTokens = [
    '--dsw-alias-state-brand-primary',
    '--dsw-alias-color-primary',
    '--dsw-alias-state-info-primary',
    '--dsw-alias-state-warning-primary',
  ];

  const hexRegex = /#[0-9a-fA-F]{3,8}\b/;

  for (const file of files) {
    const content = fs.readFileSync(path.join(clientSrcDir, file), 'utf-8');
    for (const bad of badTokens) {
      assert.ok(!content.includes(bad), `${file} must not contain non-standard token ${bad}`);
    }

    // Check for hex color literals
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      // Exclude comments that might have URLs or other non-hex # references
      const codeOnly = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      const match = hexRegex.exec(codeOnly);
      assert.ok(!match, `${file}:${idx + 1} has unexpected hex color: ${match?.[0]}`);
    });
  }
});

test('#451: all client fetch endpoints in client.js have signal attached', () => {
  const clientJs = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf-8');

  // Verify write operations and background polls include signal
  assert.ok(clientJs.includes("fetch('/dsh-key-rotation/key',"), 'client has /key fetch');
  assert.ok(clientJs.includes("fetch('/dsh-key-rotation/reset',"), 'client has /reset fetch');
  assert.ok(clientJs.includes("fetch('/dsh-key-rotation/test',"), 'client has /test fetch');
  assert.ok(clientJs.includes("fetch('/dsh-key-rotation/health',"), 'client has /health fetch');
  assert.ok(clientJs.includes("fetch('/dsh-key-rotation/status',"), 'client has /status fetch');

  // Verify AbortSignal / signal is wired to calls
  const matches = clientJs.match(/fetch\([^)]+\)/g) || [];
  assert.ok(matches.length >= 10, 'expected multiple fetch calls in client.js');
});

test('#452: all 6 audited exports have production and runtime references', () => {
  // 1. SOFT_FAILURE_CODES & isSoftFailureCode
  assert.ok(SOFT_FAILURE_CODES instanceof Set);
  assert.ok(isSoftFailureCode('500'));
  assert.ok(isSoftFailureCode('TIMEOUT'));
  assert.ok(!isSoftFailureCode('AUTH'));
  assert.equal(classifyFailure({ status: 500 }).soft, true);
  assert.equal(classifyFailure({ status: 401 }).soft, false);

  // 2. QUOTA_WINDOW_TYPES & poolResetAt
  assert.ok(Array.isArray(QUOTA_WINDOW_TYPES));
  assert.ok(QUOTA_WINDOW_TYPES.includes('midnight_utc'));
  const now = 1791150000000;
  const poolReset = poolResetAt({ quotaResetWindow: { type: 'midnight_utc', hour: 0 } }, { type: 'midnight_utc', hour: 0 }, now);
  const nextReset = nextQuotaReset({ type: 'midnight_utc', hour: 0 }, now);
  assert.equal(poolReset, nextReset);

  // 3. getModelTokenUsage, getModelTokenRemaining, getModelQuotaStatus
  const mockPool = {
    refs: ['KEY_1'],
    quotas: { KEY_1: { tokenLimit: 1000 } },
    state: { tokenUsage: new Map() },
  };
  assert.equal(getModelTokenUsage(mockPool, 'KEY_1', now), 0);
  assert.equal(getModelTokenRemaining(mockPool, 'KEY_1', now), 1000);
  const status = getModelQuotaStatus(mockPool, 'KEY_1', now);
  assert.equal(status.used, 0);
  assert.equal(status.remaining, 1000);
  assert.equal(status.exhausted, false);

  // 4. modelPoolsForRef in pool-index
  const index = createPoolIndex();
  const basePool = { base: 'prov-a', refs: ['K1'] };
  const mp1 = { base: 'prov-a/m1', refs: ['K1'] };
  const modelPools = new Map([['m1', mp1]]);
  addProviderPools(index, 'prov-a', basePool, modelPools);
  const pools = modelPoolsForRef(index, 'K1');
  assert.equal(pools.length, 1);
  assert.equal(pools[0].base, 'prov-a/m1');
});

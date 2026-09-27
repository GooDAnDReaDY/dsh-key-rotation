// test/stability-080.test.mjs — 0.8.0 stability block (#260-#269)
import test from 'node:test';
import assert from 'node:assert/strict';
import {nowMono, nowWall} from '../lib/clock.js';
import {CircuitBreaker, BREAKER_OPEN, BREAKER_CLOSED, BREAKER_HALF_OPEN} from '../lib/circuit-breaker.js';

import {safeParseJson, atomicWriteFile, safeReadJson, atomicWriteJson} from '../lib/atomic-io.js';
import {NotifyQueue} from '../lib/notify-queue.js';
import {isSwitchableError} from '../lib/pool.js';
import {classifyFailure} from '../lib/error-taxonomy.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('clock: nowMono is finite and near wall clock', () => {
  const m = nowMono();
  const w = nowWall();
  assert.ok(Number.isFinite(m));
  assert.ok(Math.abs(m - w) < 60_000, `mono ${m} wall ${w}`);
});


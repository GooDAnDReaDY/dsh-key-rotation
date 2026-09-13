import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoUnbreakBrokenKeys } from '../lib/heal.js';

test('autoUnbreakBrokenKeys: recovers broken key when probe succeeds', async () => {
  const pool = {
    base: 'deepseek',
    state: {
      brokenUntil: new Map([['ds-key-1', Date.now() + 86400000]]),
      failedUntil: new Map([['ds-key-1', Date.now() + 86400000]]),
      authFailCounts: new Map([['ds-key-1', 3]]),
      failCounts: new Map([['ds-key-1', 5]]),
      events: [],
    },
  };

  const probeMock = async (ref) => {
    if (ref === 'ds-key-1') return { ok: true, models: ['deepseek-chat'] };
    return { ok: false, code: 'auth' };
  };

  const healed = await autoUnbreakBrokenKeys([pool], probeMock);
  assert.equal(healed.length, 1);
  assert.equal(healed[0].ref, 'ds-key-1');
  assert.equal(healed[0].ok, true);
  assert.equal(pool.state.brokenUntil.has('ds-key-1'), false);
  assert.equal(pool.state.failedUntil.has('ds-key-1'), false);
  assert.equal(pool.state.authFailCounts.has('ds-key-1'), false);
  assert.equal(pool.state.events.length, 1);
  assert.equal(pool.state.events[0].reason, 'auto-unbreak');
  assert.equal(pool.state.events[0].type, 'heal');
});

test('autoUnbreakBrokenKeys: leaves key broken when probe fails', async () => {
  const pool = {
    base: 'deepseek',
    state: {
      brokenUntil: new Map([['ds-broken', Date.now() + 86400000]]),
      failedUntil: new Map([['ds-broken', Date.now() + 86400000]]),
      authFailCounts: new Map([['ds-broken', 3]]),
      events: [],
    },
  };

  const probeMock = async () => ({ ok: false, code: '401' });

  const healed = await autoUnbreakBrokenKeys([pool], probeMock);
  assert.equal(healed.length, 1);
  assert.equal(healed[0].ok, false);
  assert.equal(pool.state.brokenUntil.has('ds-broken'), true);
  assert.equal(pool.state.failedUntil.has('ds-broken'), true);
  assert.equal(pool.state.events.length, 0);
});

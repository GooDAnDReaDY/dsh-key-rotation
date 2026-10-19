import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSyncableConfig,
  syncCloneProfile,
  synchronizeClones,
  CloneLifecycleManager,
  CLONE_SYNC_FIELDS,
} from '../lib/clone-lifecycle.js';

import {
  markKeyDraining,
  isKeyDraining,
  cancelKeyDrain,
  getDrainingStatus,
} from '../lib/key-drain.js';

test('clone-lifecycle: extractSyncableConfig extracts baseUrl, headers, timeout, and models', () => {
  const baseProfile = {
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    baseURL: 'https://api.openai.com/v1',
    headers: { 'X-Custom-Header': 'foobar' },
    timeout: 30000,
    systemPrompt: 'You are an AI assistant',
    models: ['gpt-4o', 'gpt-4o-mini'],
    unrelatedField: 'should-not-sync',
  };

  const syncable = extractSyncableConfig(baseProfile);
  assert.equal(syncable.baseUrl, 'https://api.openai.com/v1');
  assert.equal(syncable.baseURL, 'https://api.openai.com/v1');
  assert.deepEqual(syncable.headers, { 'X-Custom-Header': 'foobar' });
  assert.equal(syncable.timeout, 30000);
  assert.equal(syncable.systemPrompt, 'You are an AI assistant');
  assert.deepEqual(syncable.models, ['gpt-4o', 'gpt-4o-mini']);
  assert.equal(syncable.unrelatedField, undefined);
});

test('clone-lifecycle: syncCloneProfile copies base provider settings onto clone', () => {
  const baseProfile = {
    baseUrl: 'https://api.anthropic.com',
    headers: { 'anthropic-version': '2023-06-01' },
    timeout: 45000,
  };

  const cloneProfile = {
    apiKeyEnv: 'ANTHROPIC_KEY_2',
  };

  const synced = syncCloneProfile(baseProfile, cloneProfile);
  assert.equal(synced.apiKeyEnv, 'ANTHROPIC_KEY_2');
  assert.equal(synced.baseUrl, 'https://api.anthropic.com');
  assert.deepEqual(synced.headers, { 'anthropic-version': '2023-06-01' });
  assert.equal(synced.timeout, 45000);
  assert.equal(synced.isClone, true);
});

test('clone-lifecycle: synchronizeClones updates all clone IDs matching base provider', () => {
  const profiles = {
    'openai': {
      baseUrl: 'https://api.openai.com/v1',
      headers: { 'User-Agent': 'dsh' },
      timeout: 25000,
    },
    'openai-2': { apiKeyEnv: 'OPENAI_KEY_2' },
    'openai-3': { apiKeyEnv: 'OPENAI_KEY_3' },
    'anthropic-2': { apiKeyEnv: 'ANTHROPIC_KEY_2' },
  };

  const cloneIds = new Set(['openai-2', 'openai-3', 'anthropic-2']);
  const result = synchronizeClones({
    baseProvider: 'openai',
    cloneIds,
    profiles,
  });

  assert.deepEqual(result.updated, ['openai-2', 'openai-3']);
  assert.equal(result.cloned['openai-2'].baseUrl, 'https://api.openai.com/v1');
  assert.equal(result.cloned['openai-3'].timeout, 25000);
  assert.equal(result.cloned['anthropic-2'], undefined);
});

test('clone-lifecycle: CloneLifecycleManager drains removed clones gracefully before deregistering', () => {
  const mockTracker = {
    inFlight: new Map(),
    getActive(ref) { return this.inFlight.get(ref) ?? 0; },
    getInFlight(ref) { return this.inFlight.get(ref) ?? 0; },
  };

  const manager = new CloneLifecycleManager({ concurrencyTracker: mockTracker });
  let deregistered = null;

  // Active in-flight stream on clone 'openai-3'
  mockTracker.inFlight.set('openai-3', 1);

  // Pool key count reduced: previous had openai-2 and openai-3, current only has openai-2
  manager.reconcileClones(
    'openai',
    ['openai-2', 'openai-3'],
    ['openai-2'],
    (cloneId, provider) => { deregistered = { cloneId, provider }; },
  );

  // Clone must be marked as draining
  assert.equal(manager.isDraining('openai-3'), true);
  assert.equal(deregistered, null, 'Clone must not be deregistered while streams are active');

  // Once in-flight stream finishes (count -> 0), drain completes
  mockTracker.inFlight.set('openai-3', 0);
  manager._checkDrainCompletion('openai-3');

  assert.equal(manager.isDraining('openai-3'), false);
  assert.deepEqual(deregistered, { cloneId: 'openai-3', provider: 'openai' });

  manager.destroy();
});

test('key-drain: getDrainingStatus handles concurrencyTracker.getActive cleanly', () => {
  markKeyDraining('DRAIN_KEY_1', 'groq');

  const tracker = {
    getActive(ref) { return ref === 'DRAIN_KEY_1' ? 2 : 0; },
  };

  const status = getDrainingStatus('DRAIN_KEY_1', tracker);
  assert.ok(status);
  assert.equal(status.ref, 'DRAIN_KEY_1');
  assert.equal(status.inFlight, 2);
  assert.equal(status.canComplete, false);

  cancelKeyDrain('DRAIN_KEY_1');
});

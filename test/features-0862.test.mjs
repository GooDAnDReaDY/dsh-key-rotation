import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sortAttemptList,
  setSessionSticky,
  getSessionSticky,
  clearSessionSticky,
  MAX_SESSION_STICKY_ENTRIES,
} from '../lib/pool.js';
import { createResolver } from '../lib/resolver.js';
import { inferProviderFromRef, discoverUnconfiguredKeys } from '../lib/ops-keys.js';
import { initializePoolState } from '../lib/pool-state.js';

test('Issue #489: Session-aware sticky affinity LRU helpers', () => {
  const pool = { state: initializePoolState() };
  assert.equal(getSessionSticky(pool, 'sess-1'), null);

  setSessionSticky(pool, 'sess-1', 'KEY_A');
  assert.equal(getSessionSticky(pool, 'sess-1'), 'KEY_A');

  setSessionSticky(pool, 'sess-2', 'KEY_B');
  assert.equal(getSessionSticky(pool, 'sess-2'), 'KEY_B');
  assert.equal(getSessionSticky(pool, 'sess-1'), 'KEY_A');

  clearSessionSticky(pool, 'sess-1');
  assert.equal(getSessionSticky(pool, 'sess-1'), null);
  assert.equal(getSessionSticky(pool, 'sess-2'), 'KEY_B');

  // Test LRU bounds
  for (let i = 0; i < MAX_SESSION_STICKY_ENTRIES + 10; i++) {
    setSessionSticky(pool, `session-${i}`, `KEY_${i % 3}`);
  }
  assert.ok(pool.state.sessionSticky.size <= MAX_SESSION_STICKY_ENTRIES);
  // Oldest should have been evicted
  assert.equal(getSessionSticky(pool, 'session-0'), null);
  // Newest exists
  assert.ok(getSessionSticky(pool, `session-${MAX_SESSION_STICKY_ENTRIES + 9}`) !== null);
});

test('Issue #489: sortAttemptList prioritizes sessionSticky over global lastUsed', () => {
  const refs = ['KEY_1', 'KEY_2', 'KEY_3'];
  const pool = {
    state: initializePoolState({
      lastUsed: 'KEY_1',
    }),
  };
  setSessionSticky(pool, 'session-A', 'KEY_3');

  // Request for session-A should stick to KEY_3
  const listA = sortAttemptList(refs, 'sticky', {
    pool,
    sessionId: 'session-A',
    sessionSticky: getSessionSticky(pool, 'session-A'),
    lastUsed: pool.state.lastUsed,
  });
  assert.equal(listA[0], 'KEY_3', 'session-A must stick to KEY_3');

  // Request for session-B (unassigned) falls back to pool.state.lastUsed (KEY_1)
  const listB = sortAttemptList(refs, 'sticky', {
    pool,
    sessionId: 'session-B',
    sessionSticky: getSessionSticky(pool, 'session-B'),
    lastUsed: pool.state.lastUsed,
  });
  assert.equal(listB[0], 'KEY_1', 'unassigned session falls back to global lastUsed');
});

test('Issue #489: createResolver records sessionSticky upon credential resolve', async () => {
  const state = initializePoolState();
  const pool = {
    provider: 'deepseek',
    refs: ['KEY_1', 'KEY_2'],
    routingStrategy: 'sticky',
    state,
  };

  const runtime = {
    index: {
      poolByRef: new Map([['KEY_1', pool], ['KEY_2', pool]]),
      allPools: [pool],
    },
    providerToPool: new Map([['deepseek', pool]]),
    pools: [pool],
  };

  let activeSession = 'sess-100';
  const resolver = createResolver({
    buildRuntime: () => runtime,
    currentPool: () => pool,
    currentSession: () => activeSession,
  });

  const orig = async (ref) => ({ value: `secret-${ref}` });

  // First resolution for sess-100 picks KEY_1 and sets sessionSticky
  const r1 = await resolver('KEY_1', orig);
  assert.equal(r1.value, 'secret-KEY_1');
  assert.equal(getSessionSticky(pool, 'sess-100'), 'KEY_1');

  // Change sess-200 to KEY_2
  activeSession = 'sess-200';
  pool.state.lastUsed = 'KEY_2';
  setSessionSticky(pool, 'sess-200', 'KEY_2');

  // Now resolve for sess-100 again: should resolve to KEY_1 despite lastUsed being KEY_2
  const r2 = await resolver('KEY_1', orig, { sessionId: 'sess-100' });
  assert.equal(r2.value, 'secret-KEY_1');
  assert.equal(getSessionSticky(pool, 'sess-100'), 'KEY_1');
  assert.equal(getSessionSticky(pool, 'sess-200'), 'KEY_2');
});

test('Issue #491: inferProviderFromRef recognizes standard and indexed provider keys', () => {
  assert.equal(inferProviderFromRef('DEEPSEEK_API_KEY'), 'deepseek');
  assert.equal(inferProviderFromRef('OPENCODE_GO_API_KEY_3'), 'opencode');
  assert.equal(inferProviderFromRef('OPENAI_API_KEY'), 'openai');
  assert.equal(inferProviderFromRef('ANTHROPIC_API_KEY_BACKUP'), 'anthropic');
  assert.equal(inferProviderFromRef('GROQ_API_KEY'), 'groq');
  assert.equal(inferProviderFromRef('GEMINI_API_KEY'), 'gemini');
  assert.equal(inferProviderFromRef('GOOGLE_API_KEY'), 'gemini');
  assert.equal(inferProviderFromRef('OLLAMA_API_KEY_2'), 'ollama');

  // Ignored internal keys
  assert.equal(inferProviderFromRef('GITEA_TOKEN'), null);
  assert.equal(inferProviderFromRef('KANBAN_WEBHOOK_SECRET'), null);
  assert.equal(inferProviderFromRef('DSH_KEY_SECRET'), null);
  assert.equal(inferProviderFromRef('SESSION_SECRET'), null);
});

test('Issue #491: discoverUnconfiguredKeys excludes existing pool keys', async () => {
  const mockCtx = {
    get: (svc) => null,
  };

  // Simulate existing pool having OPENCODE_GO_API_KEY
  const runtimePools = [
    {
      provider: 'opencode',
      refs: ['OPENCODE_GO_API_KEY', 'OPENCODE_GO_API_KEY_2'],
    },
  ];

  // Set env vars
  process.env.GROQ_API_KEY = 'gsk_test12345678';
  process.env.OPENCODE_GO_API_KEY = 'oc_already_configured';

  const discovered = await discoverUnconfiguredKeys(mockCtx, runtimePools);
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;

  const foundRefs = discovered.map((d) => d.ref);
  assert.ok(foundRefs.includes('GROQ_API_KEY'), 'Must discover unconfigured GROQ_API_KEY');
  assert.ok(!foundRefs.includes('OPENCODE_GO_API_KEY'), 'Must NOT discover already configured OPENCODE_GO_API_KEY');
});

test('Issue #490 & #491: Client bundle includes test-matrix and discovery tokens and signals', () => {
  const clientJs = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

  // Localization tokens
  assert.ok(clientJs.includes('testAllKeys:'), 'en has testAllKeys');
  assert.ok(clientJs.includes('discoverBannerTitle:'), 'en has discoverBannerTitle');
  assert.ok(clientJs.includes('autoImportBtn:'), 'en has autoImportBtn');

  // Endpoints and signals
  assert.ok(clientJs.includes("fetch('/dsh-key-rotation/discover',"), 'client fetches /discover');
  assert.ok(clientJs.includes("fetch('/dsh-key-rotation/test-matrix',"), 'client fetches /test-matrix');
  assert.ok(clientJs.includes("fetch('/dsh-key-rotation/auto-import',"), 'client fetches /auto-import');

  // Clean CSS verification (no rgba or hex)
  assert.doesNotMatch(clientJs, /rgba\(|#[0-9a-fA-F]{6}/, 'client.js must not contain hardcoded rgba or 6-digit hex colors');
});

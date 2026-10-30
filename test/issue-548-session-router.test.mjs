import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionRouter,
  MAX_SESSIONS,
  SESSION_TTL_MS,
} from '../lib/session-router.js';
import {
  sortAttemptList,
  setSessionSticky,
  getSessionSticky,
  clearSessionSticky,
  unstickFailedKey,
} from '../lib/pool-selection.js';

test('issue #548: SessionRouter LRU eviction caps storage size to maxSessions', () => {
  let currentTime = 1000;
  const router = new SessionRouter({
    maxSessions: 10,
    sessionTtlMs: 100000,
    now: () => currentTime,
  });

  // Insert 10 sessions
  for (let i = 1; i <= 10; i++) {
    currentTime += 10;
    router.setSession(`sess-${i}`, `KEY_${i % 2}`);
  }
  assert.equal(router.sessions.size, 10);

  // Add 11th session -> should evict sess-1 (oldest lastUsedAt)
  currentTime += 10;
  router.setSession('sess-11', 'KEY_0');
  assert.equal(router.sessions.size, 10);
  assert.equal(router.getSession('sess-1'), null, 'sess-1 must be evicted by LRU');
  assert.equal(router.getSession('sess-11'), 'KEY_0');
  assert.equal(router.getSession('sess-2'), 'KEY_0');
});

test('issue #548: SessionRouter TTL eviction expires stale sessions', () => {
  let currentTime = 1000000;
  const router = new SessionRouter({
    maxSessions: 100,
    sessionTtlMs: 60000, // 1 minute
    now: () => currentTime,
  });

  router.setSession('sess-live', 'KEY_A');
  router.setSession('sess-stale', 'KEY_B');

  // Fast-forward 65 seconds
  currentTime += 65000;

  // Stale session must expire upon getSession
  assert.equal(router.getSession('sess-stale'), null);

  // Re-pin live session
  router.setSession('sess-live', 'KEY_A');
  assert.equal(router.getSession('sess-live'), 'KEY_A');

  // Prune removes expired sessions
  router.setSession('sess-old', 'KEY_C');
  currentTime += 65000;
  const evicted = router.prune(currentTime);
  assert.ok(evicted >= 1);
  assert.equal(router.sessions.size, 0);
});

test('issue #548: Least-Used Initial Assignment balances new sessions across available keys', () => {
  const router = new SessionRouter({ now: () => 1000 });
  const available = ['KEY_1', 'KEY_2', 'KEY_3'];

  // Session 1 picks KEY_1 (first lowest)
  const r1 = router.resolveSessionKey('sess-1', available);
  assert.equal(r1.keyRef, 'KEY_1');
  assert.equal(r1.reason, 'new_session_assigned');

  // Session 2 picks KEY_2 (least used)
  const r2 = router.resolveSessionKey('sess-2', available);
  assert.equal(r2.keyRef, 'KEY_2');

  // Session 3 picks KEY_3
  const r3 = router.resolveSessionKey('sess-3', available);
  assert.equal(r3.keyRef, 'KEY_3');

  // Subsequent call for sess-1 stays pinned to KEY_1
  const r1_again = router.resolveSessionKey('sess-1', available);
  assert.equal(r1_again.keyRef, 'KEY_1');
  assert.equal(r1_again.reason, 'sticky_pinned');

  // Session 4 balances to KEY_1 (now all keys have 1 session)
  const r4 = router.resolveSessionKey('sess-4', available);
  assert.equal(r4.keyRef, 'KEY_1');
});

test('issue #548: Proactive unsticking unpins sessions on key failure/cooldown', () => {
  const router = new SessionRouter({ now: () => 1000 });
  const pool = {
    state: {
      sessionSticky: new Map(),
      sessionRouter: router,
    },
  };

  setSessionSticky(pool, 'user-A', 'KEY_BAD');
  setSessionSticky(pool, 'user-B', 'KEY_BAD');
  setSessionSticky(pool, 'user-C', 'KEY_GOOD');

  assert.equal(getSessionSticky(pool, 'user-A'), 'KEY_BAD');
  assert.equal(getSessionSticky(pool, 'user-B'), 'KEY_BAD');
  assert.equal(getSessionSticky(pool, 'user-C'), 'KEY_GOOD');

  // Key KEY_BAD fails -> unstickFailedKey must unpin user-A and user-B, leaving user-C
  const unpinned = unstickFailedKey(pool, 'KEY_BAD');
  assert.equal(unpinned, 2);

  assert.equal(getSessionSticky(pool, 'user-A'), null, 'user-A must be unpinned from failed key');
  assert.equal(getSessionSticky(pool, 'user-B'), null, 'user-B must be unpinned from failed key');
  assert.equal(getSessionSticky(pool, 'user-C'), 'KEY_GOOD', 'user-C on good key remains pinned');

  // On next request, user-A resolves to KEY_GOOD automatically via sortAttemptList
  const list = sortAttemptList(['KEY_GOOD', 'KEY_BACKUP'], 'sticky', {
    pool,
    sessionId: 'user-A',
  });
  assert.equal(list[0], 'KEY_BACKUP', 'Least-Used balances to key with 0 sessions');
});


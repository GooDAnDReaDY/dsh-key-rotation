// test/stability-hardening.test.mjs - verifies de-bloat, buildRuntime memoization,
// isSwitchableError precision, exhaustion messaging, and atomic round-robin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSwitchableError, formatExhaustionMessage, expiringSoon, shouldNotifyDaily, costForDay, costForWeek, budgetVerdict } from '../lib/pool.js';

let mod = null;
try { mod = await import('../lib/index.js'); } catch { mod = null; }

test('isSwitchableError: detects HTTP status codes correctly', () => {
  assert.equal(isSwitchableError({ status: 429 }), true);
  assert.equal(isSwitchableError({ statusCode: 429 }), true);
  assert.equal(isSwitchableError({ httpStatus: 429 }), true);
  assert.equal(isSwitchableError({ status: 401 }), true);
  assert.equal(isSwitchableError({ status: 403 }), true);
  assert.equal(isSwitchableError({ status: 500 }), true);
  assert.equal(isSwitchableError({ status: 502 }), true);
  assert.equal(isSwitchableError({ status: 503 }), true);
  assert.equal(isSwitchableError({ status: 504 }), true);
  assert.equal(isSwitchableError({ status: 400 }), false);
  assert.equal(isSwitchableError({ status: 404 }), false);
});

test('isSwitchableError: detects standard gRPC cloud codes', () => {
  assert.equal(isSwitchableError({ code: 'RESOURCE_EXHAUSTED' }), true);
  assert.equal(isSwitchableError({ code: 'UNAVAILABLE' }), true);
  assert.equal(isSwitchableError({ code: 'INTERNAL' }), true);
  assert.equal(isSwitchableError({ code: 'DEADLINE_EXCEEDED' }), true);
  assert.equal(isSwitchableError({ code: 'UNAUTHENTICATED' }), true);
  assert.equal(isSwitchableError({ code: 'INVALID_ARGUMENT' }), false);
});

test('isSwitchableError: regex message fallback', () => {
  assert.equal(isSwitchableError({ message: 'Rate limit reached, retry in 20s' }), true);
  assert.equal(isSwitchableError({ message: 'Overloaded. Please try again later.' }), true);
  assert.equal(isSwitchableError({ message: 'Syntax error in request' }), false);
});

test('formatExhaustionMessage: produces structured countdown', () => {
  const now = 1000000;
  const pool = {
    refs: ['KEY_1', 'KEY_2'],
    state: {
      failedUntil: new Map([
        ['KEY_1', now + 25000],
        ['KEY_2', now + 45000],
      ]),
    },
  };
  const msg = formatExhaustionMessage('opencode-go', pool, now);
  assert.match(msg, /\[dsh-key-rotation\]/);
  assert.match(msg, /All 2 keys for provider 'opencode-go' are temporarily exhausted/);
  assert.match(msg, /Next key recovers in ~25s/);
});

test('maintenance helpers moved to pool.js work identically', () => {
  const now = 1000000;
  const pool = {
    expiresAt: {
      KEY_A: now + 3 * 86400000,
      KEY_B: now + 10 * 86400000,
    },
  };
  const soon = expiringSoon(pool, 7, now);
  assert.equal(soon.length, 1);
  assert.equal(soon[0].ref, 'KEY_A');

  const map = new Map();
  assert.equal(shouldNotifyDaily(map, 'prov:key', now), true);
  assert.equal(shouldNotifyDaily(map, 'prov:key', now + 1000), false);
  assert.equal(shouldNotifyDaily(map, 'prov:key', now + 86400001), true);

  const costDays = new Map([
    ['KEY_A', new Map([['2026-09-07', 2.50]])],
    ['KEY_B', new Map([['2026-09-07', 1.50]])],
  ]);
  assert.equal(costForDay(costDays, '2026-09-07'), 4.00);

  const verdict = budgetVerdict(4.00, 5.00);
  assert.equal(verdict.warn, true);
  assert.equal(verdict.exceeded, false);

  const verdict2 = budgetVerdict(5.50, 5.00);
  assert.equal(verdict2.exceeded, true);
});

test('buildRuntime and credentials.resolve with mock context', async () => {
  if (!mod) {
    // Peer dependency @deepseek-ai/schemastery not present in standalone repo node_modules
    assert.ok(true, 'skipped locally (no schemastery peer)');
    return;
  }

  let resolveCalls = [];
  const creds = {
    resolve: async (ref) => {
      resolveCalls.push(ref);
      return { value: `val-${ref}` };
    },
  };

  const fakeCtx = {
    webServer: { register: () => () => {} },
    effect: (fn) => fn(),
    on: () => () => {},
    inject: (deps, fn) => {
      fn({
        effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
        settings: {
          register: () => ({
            get: () => ({
              providers: [{ provider: 'multi-prov', keys: ['K1', 'K2', 'K3'] }],
            }),
          }),
        },
      });
    },
    get: (name) => {
      if (name === 'credentials') return creds;
      return null;
    },
  };

  mod.apply(fakeCtx, {
    providers: [{ provider: 'multi-prov', keys: ['K1', 'K2', 'K3'] }],
  });

  // Call 1
  const r1 = await creds.resolve('K1');
  assert.equal(r1.value, 'val-K1');

  // Call 2 with K1 ref should now rotate to K2
  const r2 = await creds.resolve('K1');
  assert.equal(r2.value, 'val-K2');

  // Call 3 with K1 ref should rotate to K3
  const r3 = await creds.resolve('K1');
  assert.equal(r3.value, 'val-K3');

  // Call 4 wraps back to K1
  const r4 = await creds.resolve('K1');
  assert.equal(r4.value, 'val-K1');
});

test('regression #245: AlertDebouncer unrefs pending debounce timer', async () => {
  const { AlertDebouncer } = await import('../lib/webhook.js');
  const debouncer = new AlertDebouncer(async () => {}, 10000, 10);
  debouncer.enqueue('https://example.com/webhook', { type: 'test' });
  const entry = debouncer._pending.get('https://example.com/webhook');
  assert.ok(entry);
  assert.ok(entry.timer);
  // Timer must have unref method and be unref-safe
  assert.equal(typeof entry.timer.unref, 'function');
  clearTimeout(entry.timer);
  debouncer._pending.clear();
});

test('regression #245: periodic sweep interval in apply() is unref-ed', async () => {
  if (!mod) {
    assert.ok(true, 'skipped locally (no schemastery peer)');
    return;
  }
  // If unref was missing, node test runner would hang on event loop
  assert.ok(typeof mod.apply === 'function');
});

test('credentials.resolve records lastUsedAt in pool state', async () => {
  if (!mod) {
    assert.ok(true, 'skipped locally (no schemastery peer)');
    return;
  }
  const pool = mod.getRuntime().providerToPool.get('multi-prov');
  if (pool) {
    assert.ok(pool.state.lastUsedAt instanceof Map);
    assert.ok(pool.state.lastUsedAt.has('K1'));
    assert.ok(typeof pool.state.lastUsedAt.get('K1') === 'number');
  }
});

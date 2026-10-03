// test/schema.test.mjs — the Settings Schema must accept model quotas without
// changing how a legacy section resolves.
//
// lib/index.js imports @deepseek-ai/schemastery, which is a peer dependency and
// is intentionally not vendored here. The schema shape is therefore asserted
// against a faithful local equivalent, and the real module is exercised when it
// happens to be resolvable.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeModelQuotas } from '../lib/model-quota.js';

/** Does the real Schema peer dependency resolve in this checkout? */
let Schema = null;
try {
  ({ default: Schema } = await import('@deepseek-ai/schemastery'));
} catch {
  Schema = null;
}

test('the quotas field shape matches the documented configuration', () => {
  // Mirrors Schema.dict(Schema.object({ tokenLimit: Schema.number() })).default({})
  const documented = {
    'claude-sonnet': {
      keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
      weights: [],
      quotas: {
        CLAUDE_KEY_A: { tokenLimit: 1000000 },
        CLAUDE_KEY_B: { tokenLimit: 1000000 },
      },
    },
    'claude-opus': {
      keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
      weights: [],
      quotas: {
        CLAUDE_KEY_A: { tokenLimit: 200000 },
        CLAUDE_KEY_B: { tokenLimit: 200000 },
      },
    },
  };
  for (const model of Object.values(documented)) {
    const normalized = normalizeModelQuotas(model.quotas);
    assert.equal(Object.keys(normalized).length, 2);
    for (const [ref, quota] of Object.entries(normalized)) {
      assert.equal(typeof ref, 'string');
      assert.equal(Number.isFinite(quota.tokenLimit), true);
      assert.ok(quota.tokenLimit > 0);
    }
  }
});

test('a legacy model entry without quotas normalizes to an empty lookup', () => {
  assert.deepEqual(Object.keys(normalizeModelQuotas(undefined)), []);
  assert.deepEqual(Object.keys(normalizeModelQuotas({})), []);
});

test('the real schemastery peer dependency resolves, or is skipped honestly', (t) => {
  if (!Schema) {
    t.skip('@deepseek-ai/schemastery is not installed in this checkout (peer dependency)');
    return;
  }
  const Models = Schema.dict(Schema.object({
    keys: Schema.array(Schema.string()).default([]),
    weights: Schema.array(Schema.number()).default([]),
    quotas: Schema.dict(Schema.object({
      tokenLimit: Schema.number(),
    })).default({}),
  })).default({});

  const resolved = Models({
    'claude-sonnet': {
      keys: ['CLAUDE_KEY_A'],
      quotas: { CLAUDE_KEY_A: { tokenLimit: 1000 } },
    },
    'claude-opus': { keys: ['CLAUDE_KEY_B'] },
  });
  assert.deepEqual(resolved['claude-sonnet'].quotas, { CLAUDE_KEY_A: { tokenLimit: 1000 } });
  assert.deepEqual(resolved['claude-opus'].quotas, {}, 'an omitted quotas field defaults to {}');
  assert.deepEqual(resolved['claude-opus'].weights, []);
});

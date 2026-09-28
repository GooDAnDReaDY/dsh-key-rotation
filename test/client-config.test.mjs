// test/client-config.test.mjs — the Settings card's model/quotas editing helpers.
//
// lib/client.js is a browser bundle: it registers itself with the DSH module
// loader and requires `react` at load time. The test therefore provides a minimal
// loader + require shim, loads the real file, and asserts against the helpers the
// card exposes through its documented test seam. Nothing else in the bundle is
// executed, so no DOM is needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** Minimal React stand-in: only createElement is touched at module scope. */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useSyncExternalStore: () => null,
  Component: class {},
};

let loaded = null;
function loadBundle() {
  if (loaded) return loaded;
  const source = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
  const which = require('node:module');
  const g = globalThis;
  const previousLoader = g.__ModuleLoader__;
  g.__ModuleLoader__ = {
    load({ factory }) {
      factory((spec) => {
        if (spec === 'react') return fakeReact;
        // Optional UI primitive packages are resolved inside a try/catch by the
        // bundle; throwing models their absence faithfully.
        if (spec.startsWith('@deepseek-ai/')) throw new Error('not installed in test');
        return which.createRequire(import.meta.url)(spec);
      });
    },
  };
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'navigator', source)(g, undefined, undefined);
  } finally {
    if (previousLoader === undefined) delete g.__ModuleLoader__;
    else g.__ModuleLoader__ = previousLoader;
  }
  loaded = g.__dshKeyRotationClientInternals;
  return loaded;
}

const internals = loadBundle();
const { quotaMapOf, withQuotas, modelEntriesOf, isValidModelId, formatCountdown, validatePoolDraft } = internals;

test('the bundle loads and exposes its config helpers', () => {
  assert.ok(internals, 'test seam is present');
  for (const fn of ['quotaMapOf', 'withQuotas', 'modelEntriesOf', 'isValidModelId', 'formatCountdown', 'validatePoolDraft']) {
    assert.equal(typeof internals[fn], 'function', fn + ' is exported');
  }
});

test('quotaMapOf normalises the documented quota shape', () => {
  assert.deepEqual(quotaMapOf({ quotas: { KEY_A: { tokenLimit: 1000 } } }), { KEY_A: { tokenLimit: 1000 } });
  // Shorthand numbers are accepted, as the host accepts them.
  assert.deepEqual(quotaMapOf({ quotas: { KEY_A: 2000 } }), { KEY_A: { tokenLimit: 2000 } });
  // Non-positive, non-numeric and unsafe entries are dropped.
  assert.deepEqual(quotaMapOf({ quotas: { A: { tokenLimit: 0 }, B: { tokenLimit: -1 }, C: { tokenLimit: 'x' }, D: {} } }), {});
  assert.deepEqual(quotaMapOf(undefined), {});
  assert.deepEqual(quotaMapOf({ quotas: [] }), {});
  const proto = quotaMapOf(JSON.parse('{"quotas":{"__proto__":{"tokenLimit":5}}}'));
  assert.equal(Object.prototype.hasOwnProperty.call(proto, '__proto__'), false);
});

test('withQuotas removes a limit instead of storing zero', () => {
  const entry = { keys: ['A'], quotas: { A: { tokenLimit: 10 } } };
  // Clearing the input must delete the entry — a stored zero would read as a
  // budget of zero, not as "unlimited".
  const cleared = withQuotas(entry, {});
  assert.equal('quotas' in cleared, false);
  const set = withQuotas(entry, { A: 500, B: 0, C: NaN });
  assert.deepEqual(set.quotas, { A: { tokenLimit: 500 } });
  // The source entry is never mutated.
  assert.deepEqual(entry.quotas, { A: { tokenLimit: 10 } });
});

test('setting then clearing a token limit round-trips to unlimited', () => {
  let mp = { keys: ['KEY_A'] };
  mp = withQuotas(mp, { KEY_A: 1000 });
  assert.deepEqual(quotaMapOf(mp), { KEY_A: { tokenLimit: 1000 } });
  mp = withQuotas(mp, {});
  assert.deepEqual(quotaMapOf(mp), {}, 'back to unlimited');
});

test('modelEntriesOf only yields well-formed entries', () => {
  const entry = { models: { a: { keys: ['X'] }, b: null, c: [], d: { keys: [] } } };
  assert.deepEqual(modelEntriesOf(entry).map(([m]) => m), ['a', 'd']);
  assert.deepEqual(modelEntriesOf({}), []);
  assert.deepEqual(modelEntriesOf({ models: [] }), []);
});

test('model ids are validated as config keys', () => {
  assert.equal(isValidModelId('claude-sonnet'), true);
  assert.equal(isValidModelId('gpt-4o'), true);
  for (const bad of ['', '   ', '__proto__', 'constructor', 'prototype', null, undefined, 42]) {
    assert.equal(isValidModelId(bad), false, String(bad) + ' is rejected');
  }
});

test('validatePoolDraft accepts model pools with quotas', () => {
  const ok = [{
    provider: 'anthropic',
    keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
    models: {
      'claude-sonnet': {
        keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
        quotas: { CLAUDE_KEY_A: { tokenLimit: 1000000 }, CLAUDE_KEY_B: { tokenLimit: 1000000 } },
      },
      'claude-opus': {
        keys: ['CLAUDE_KEY_A', 'CLAUDE_KEY_B'],
        quotas: { CLAUDE_KEY_A: { tokenLimit: 200000 } },
      },
    },
  }];
  assert.doesNotThrow(() => validatePoolDraft(ok));
});

test('validatePoolDraft still accepts a legacy provider with no models', () => {
  assert.doesNotThrow(() => validatePoolDraft([{ provider: 'anthropic', keys: ['KEY_A'] }]));
});

test('validatePoolDraft rejects a quota for a credential outside the model pool', () => {
  assert.throws(() => validatePoolDraft([{
    provider: 'anthropic',
    keys: ['KEY_A', 'KEY_B'],
    models: { m: { keys: ['KEY_A'], quotas: { KEY_B: { tokenLimit: 10 } } } },
  }]), /token limit/i);
});

test('validatePoolDraft rejects malformed model pools', () => {
  // A `__proto__` model id cannot be written as an object literal, so it is
  // built structurally to prove the reserved-name guard actually fires.
  const reserved = {};
  Object.defineProperty(reserved, '__proto__', {
    value: { keys: ['KEY_A'] }, enumerable: true, configurable: true,
  });

  const cases = [
    [{ provider: 'p', keys: ['KEY_A'], models: { '': { keys: ['KEY_A'] } } }],
    [{ provider: 'p', keys: ['KEY_A'], models: { '   ': { keys: ['KEY_A'] } } }],
    [{ provider: 'p', keys: ['KEY_A'], models: reserved }],
    [{ provider: 'p', keys: ['KEY_A'], models: { m: { keys: ['not a ref'] } } }],
    [{ provider: 'p', keys: ['KEY_A'], models: { m: { keys: ['A', 'A'] } } }],
    [{ provider: 'p', keys: ['KEY_A'], models: { m: { keys: 'A' } } }],
    [{ provider: 'p', keys: ['KEY_A'], models: { m: {} } }],
  ];
  for (const draft of cases) {
    const label = (() => { try { return JSON.stringify(draft); } catch { return '[structural]'; } })();
    assert.throws(() => validatePoolDraft(draft), /model|credential/i, label.slice(0, 90));
  }
});

test('formatCountdown renders a stable zero-padded clock', () => {
  assert.equal(formatCountdown(0), '00:00:00');
  assert.equal(formatCountdown(-5), '00:00:00');
  assert.equal(formatCountdown(NaN), '00:00:00');
  assert.equal(formatCountdown(1000), '00:00:01');
  assert.equal(formatCountdown(3 * 3600000 + 14 * 60000 + 22000), '03:14:22');
  assert.equal(formatCountdown(86400000), '24:00:00');
});

test('the card never reads or transmits a secret value', () => {
  const src = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
  // The model/quota editor must key everything by credential ref. Guard against a
  // future field that would carry a raw key value into the config payload.
  const editorStart = src.indexOf('per-model sub-pools: keys + token quotas');
  assert.ok(editorStart > 0, 'the model editor section is present');
  const editor = src.slice(editorStart, editorStart + 8000);
  assert.equal(/apiKey|secretValue|\.value\s*:\s*key\b/.test(editor), false,
    'no secret-carrying field in the model quota editor');
});

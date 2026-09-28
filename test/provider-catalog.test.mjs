// test/provider-catalog.test.mjs — provider discovery for the Settings picker
// across DSH core generations.
//
// On newer cores `llm` members are resolved through the host's service layer and
// some are remote (RPC-backed): a call may return a promise, or the method may be
// absent entirely. Both cases previously threw out of the config GET handler and
// surfaced to the user as "Provider list unavailable".

import test from 'node:test';
import assert from 'node:assert/strict';

import { providerCatalog } from '../lib/http-bridge.js';

/** ctx whose `get('llm')` returns the supplied service (or throws). */
const ctxWith = (llm, { getThrows = false } = {}) => ({
  get(name) {
    if (getThrows) throw new Error('service unavailable');
    return name === 'llm' ? llm : undefined;
  },
});

test('lists providers from a synchronous listProviders()', () => {
  const llm = { listProviders: () => [{ id: 'anthropic', name: 'Anthropic' }, { id: 'openai', name: 'OpenAI' }] };
  assert.deepEqual(providerCatalog(ctxWith(llm), new Set()), [
    { id: 'anthropic', name: 'Anthropic' },
    { id: 'openai', name: 'OpenAI' },
  ]);
});

test('a provider without a display name falls back to its id', () => {
  const llm = { listProviders: () => [{ id: 'claude' }] };
  assert.deepEqual(providerCatalog(ctxWith(llm), new Set()), [{ id: 'claude', name: 'claude' }]);
});

test('a promise-returning (remote) listProviders() does not crash or hang', () => {
  const llm = {
    listProviders: () => Promise.resolve([{ id: 'remote', name: 'Remote' }]),
    listConfigurableProviders: () => [{ provider: 'anthropic', displayName: 'Anthropic' }],
  };
  const out = providerCatalog(ctxWith(llm), new Set());
  assert.equal(Array.isArray(out), true, 'a promise is never returned to the caller');
  assert.equal(out.some((p) => p.id === 'remote'), false, 'an unresolved promise contributes nothing');
  assert.deepEqual(out, [{ id: 'anthropic', name: 'Anthropic' }], 'the sync directory fills the gap');
});

test('falls back to listConfigurableProviders when listProviders is absent', () => {
  const llm = { listConfigurableProviders: () => [{ provider: 'grok', displayName: 'Grok' }] };
  assert.deepEqual(providerCatalog(ctxWith(llm), new Set()), [{ id: 'grok', name: 'Grok' }]);
});

test('a throwing listProviders falls back instead of propagating', () => {
  const llm = {
    listProviders: () => { throw new Error('remote call failed'); },
    listConfigurableProviders: () => [{ provider: 'fallback', displayName: 'Fallback' }],
  };
  assert.deepEqual(providerCatalog(ctxWith(llm), new Set()), [{ id: 'fallback', name: 'Fallback' }]);
});

test('a throwing fallback yields an empty list, never an exception', () => {
  const llm = {
    listProviders: () => { throw new Error('nope'); },
    listConfigurableProviders: () => { throw new Error('also nope'); },
  };
  assert.deepEqual(providerCatalog(ctxWith(llm), new Set()), []);
});

test('a missing llm service yields an empty list', () => {
  assert.deepEqual(providerCatalog(ctxWith(undefined), new Set()), []);
  assert.deepEqual(providerCatalog(ctxWith(null), new Set()), []);
  assert.deepEqual(providerCatalog({}, new Set()), []);
});

test('a throwing ctx.get yields an empty list', () => {
  assert.deepEqual(providerCatalog(ctxWith(null, { getThrows: true }), new Set()), []);
});

test('malformed provider entries are skipped, not surfaced as broken ids', () => {
  const llm = {
    listProviders: () => [
      { id: 'ok', name: 'OK' },
      null,
      'string',
      { name: 'no id' },
      { id: '' },
      { id: 42 },
      { provider: 'fromProvider' },
    ],
  };
  assert.deepEqual(providerCatalog(ctxWith(llm), new Set()), [
    { id: 'ok', name: 'OK' },
    { id: 'fromProvider', name: 'fromProvider' },
  ]);
});

test('clone ids and duplicates are excluded', () => {
  const llm = {
    listProviders: () => [
      { id: 'anthropic', name: 'Anthropic' },
      { id: 'anthropic', name: 'Duplicate' },
      { id: 'anthropic-2', name: 'Clone' },
    ],
  };
  assert.deepEqual(providerCatalog(ctxWith(llm), new Set(['anthropic-2'])), [
    { id: 'anthropic', name: 'Anthropic' },
  ]);
});

test('a non-array return value is tolerated', () => {
  for (const value of [undefined, null, 'nope', 42, {}]) {
    const llm = { listProviders: () => value };
    assert.deepEqual(providerCatalog(ctxWith(llm), new Set()), [], `tolerates ${JSON.stringify(value)}`);
  }
});

test('an empty live catalog matches what this desktop host actually returns', () => {
  // Shape observed on DSH desktop 0.1.7-rc.2: listProviders() returns
  // { id, name } pairs. The bridge must pass them through unchanged.
  const llm = {
    listProviders: () => [
      { id: 'volcengine', name: '火山引擎' },
      { id: 'deepseek-official', name: 'DeepSeek' },
      { id: 'claude', name: 'claude' },
    ],
  };
  assert.deepEqual(providerCatalog(ctxWith(llm), new Set()), [
    { id: 'volcengine', name: '火山引擎' },
    { id: 'deepseek-official', name: 'DeepSeek' },
    { id: 'claude', name: 'claude' },
  ]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  providerOfBase,
  basePoolForBase,
  basePoolOf,
  createPoolIndex,
  addProviderPools,
  allPools,
  resolveRefPool,
  modelPoolsForRef,
} from '../lib/pool-index.js';

test('providerOfBase: extracts provider prefix correctly', () => {
  assert.equal(providerOfBase('anthropic::claude-sonnet'), 'anthropic');
  assert.equal(providerOfBase('openai::gpt-4o-mini'), 'openai');
  assert.equal(providerOfBase('google::gemini-1.5-pro'), 'google');
  assert.equal(providerOfBase('deepseek'), 'deepseek');
  assert.equal(providerOfBase('custom-provider'), 'custom-provider');
  assert.equal(providerOfBase(''), '');
  assert.equal(providerOfBase(null), '');
  assert.equal(providerOfBase(undefined), '');
  assert.equal(providerOfBase(123), '');
});

test('basePoolForBase and basePoolOf: resolves base pool correctly', () => {
  const index = createPoolIndex();
  const basePool = {
    provider: 'anthropic',
    base: 'anthropic',
    refs: ['KEY_1', 'KEY_2'],
  };
  const sonnetPool = {
    provider: 'anthropic',
    model: 'claude-sonnet',
    base: 'anthropic::claude-sonnet',
    refs: ['KEY_SONNET'],
  };
  const opusPool = {
    provider: 'anthropic',
    model: 'claude-opus',
    base: 'anthropic::claude-opus',
    refs: ['KEY_OPUS'],
  };

  const modelPools = new Map([
    ['claude-sonnet', sonnetPool],
    ['claude-opus', opusPool],
  ]);

  addProviderPools(index, 'anthropic', basePool, modelPools);

  // basePoolOf
  assert.equal(basePoolOf(index, basePool), basePool);
  assert.equal(basePoolOf(index, sonnetPool), basePool);
  assert.equal(basePoolOf(index, opusPool), basePool);
  assert.equal(basePoolOf(index, null), null);

  // basePoolForBase
  assert.equal(basePoolForBase(index, 'anthropic'), basePool);
  assert.equal(basePoolForBase(index, 'anthropic::claude-sonnet'), basePool);
  assert.equal(basePoolForBase(index, 'anthropic::claude-opus'), basePool);
  assert.equal(basePoolForBase(index, 'nonexistent'), null);
});

test('pool-index: resolves ref pools and model pools for ref', () => {
  const index = createPoolIndex();
  const basePool = {
    provider: 'openai',
    base: 'openai',
    refs: ['OAI_SHARED', 'OAI_BASE_ONLY'],
  };
  const miniPool = {
    provider: 'openai',
    model: 'gpt-4o-mini',
    base: 'openai::gpt-4o-mini',
    refs: ['OAI_SHARED', 'OAI_MINI_ONLY'],
  };
  const modelPools = new Map([['gpt-4o-mini', miniPool]]);

  addProviderPools(index, 'openai', basePool, modelPools);

  assert.equal(allPools(index).length, 2);

  // Resolve with no requested pool
  assert.equal(resolveRefPool(index, 'OAI_SHARED'), basePool);
  assert.equal(resolveRefPool(index, 'OAI_MINI_ONLY'), miniPool);
  assert.equal(resolveRefPool(index, 'UNKNOWN'), null);
  assert.equal(resolveRefPool(index, ''), null);

  // Resolve with requested model pool
  assert.equal(resolveRefPool(index, 'OAI_SHARED', miniPool), miniPool);
  assert.equal(resolveRefPool(index, 'OAI_MINI_ONLY', miniPool), miniPool);

  // modelPoolsForRef
  const sharedModels = modelPoolsForRef(index, 'OAI_SHARED');
  assert.equal(sharedModels.length, 1);
  assert.equal(sharedModels[0], miniPool);

  const unknownModels = modelPoolsForRef(index, 'UNKNOWN');
  assert.deepEqual(unknownModels, []);
});

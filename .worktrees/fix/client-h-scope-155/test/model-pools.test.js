import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPool } from '../lib/pool.js';

test('selectPool: model sub-pool wins over base', () => {
  const base = { base: 'p', refs: ['A','B'] };
  const expensive = { base: 'p::expensive', refs: ['X','Y'] };
  const modelPoolByProvider = new Map([['p', new Map([['expensive-model', expensive]])]]);
  const providerToPool = new Map([['p', base]]);
  assert.equal(selectPool(modelPoolByProvider, providerToPool, 'p', 'expensive-model'), expensive);
});

test('selectPool: unknown model falls back to base pool', () => {
  const base = { base: 'p', refs: ['A','B'] };
  const modelPoolByProvider = new Map([['p', new Map([['expensive-model', { base: 'p::x', refs: ['X'] }]])]]);
  const providerToPool = new Map([['p', base]]);
  assert.equal(selectPool(modelPoolByProvider, providerToPool, 'p', 'cheap-model'), base);
});

test('selectPool: no sub-pools at all uses base', () => {
  const base = { base: 'p', refs: ['A'] };
  assert.equal(selectPool(new Map(), new Map([['p', base]]), 'p', 'm'), base);
});

test('selectPool: no pool for provider returns null', () => {
  assert.equal(selectPool(new Map(), new Map(), 'unknown', 'm'), null);
});

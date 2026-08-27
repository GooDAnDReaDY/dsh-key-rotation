// test/region.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RegionMap, REGION_GLOBAL } from '../lib/region.js';

test('RegionMap: set/get', () => {
  const r = new RegionMap();
  r.set('openrouter', 'global');
  r.set('ollama', 'eu');
  assert.equal(r.get('openrouter'), 'global');
  assert.equal(r.get('ollama'), 'eu');
  assert.equal(r.get('unknown'), 'global');
});

test('RegionMap: empty region defaults to global', () => {
  const r = new RegionMap();
  r.set('A', '');
  assert.equal(r.get('A'), 'global');
});

test('RegionMap: set ignores empty provider', () => {
  const r = new RegionMap();
  r.set('', 'eu');
  assert.equal(r.size, 0);
});

test('RegionMap: pickFallback in same region', () => {
  const r = new RegionMap();
  r.set('openrouter', 'global');
  r.set('deepseek', 'global');
  r.set('ollama', 'eu');
  // openrouter (global) → returns deepseek (same)
  assert.equal(r.pickFallback('openrouter'), 'deepseek');
  // ollama (eu) → no eu fallback
  assert.equal(r.pickFallback('ollama'), null);
  // deepseek → openrouter (same global)
  assert.equal(r.pickFallback('deepseek'), 'openrouter');
});

test('RegionMap: pickFallback returns null for unknown provider', () => {
  const r = new RegionMap();
  r.set('openrouter', 'global');
  assert.equal(r.pickFallback('unknown'), null);
});

test('RegionMap: snapshot and clear', () => {
  const r = new RegionMap();
  r.set('A', 'eu');
  r.set('B', 'us');
  const s = r.snapshot();
  assert.equal(s.A, 'eu');
  assert.equal(s.B, 'us');
  r.clear();
  assert.equal(r.size, 0);
  assert.deepEqual(r.snapshot(), {});
});

test('RegionMap: pickFallback picks deterministic first match (insertion order)', () => {
  const r = new RegionMap();
  r.set('primary', 'eu');
  r.set('backup1', 'eu');
  r.set('backup2', 'eu');
  // insertion order: primary excluded, then backup1, backup2
  assert.equal(r.pickFallback('primary'), 'backup1');
});

test('RegionMap: REGION_GLOBAL is the default', () => {
  assert.equal(REGION_GLOBAL, 'global');
});

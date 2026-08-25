import test from 'node:test';
import assert from 'node:assert/strict';
import { nextKeyRef, formatAgo } from '../lib/client-helpers.js';

test('nextKeyRef: first key for provider', () => {
  assert.equal(nextKeyRef('my-provider', [], []), 'MY_PROVIDER_API_KEY');
});

test('nextKeyRef: next suffix when base taken', () => {
  assert.equal(nextKeyRef('p', ['MY_API_KEY'], ['MY_API_KEY']), 'MY_API_KEY_2');
  assert.equal(nextKeyRef('p', ['MY_API_KEY', 'MY_API_KEY_2'], ['MY_API_KEY', 'MY_API_KEY_2']), 'MY_API_KEY_3');
});

test('nextKeyRef: uses existing base stripped of suffix', () => {
  assert.equal(nextKeyRef('p', ['FOO_API_KEY_2'], ['FOO_API_KEY_2']), 'FOO_API_KEY');
  assert.equal(nextKeyRef('p', ['FOO_API_KEY'], ['FOO_API_KEY', 'FOO_API_KEY_2']), 'FOO_API_KEY_3');
});

test('formatAgo: just now', () => {
  const t = (k) => k;
  assert.equal(formatAgo(t, Date.now()), 'justNow');
  assert.equal(formatAgo(t, Date.now() - 30*1000), 'justNow');
});

test('formatAgo: minutes', () => {
  const t = (k) => k === 'minutesAgo' ? '{n} min' : k;
  assert.equal(formatAgo(t, Date.now() - 90*1000), '2 min');
});

test('formatAgo: hours', () => {
  const t = (k) => k === 'hoursAgo' ? '{n} h' : k;
  assert.equal(formatAgo(t, Date.now() - 7200*1000), '2 h');
});

test('formatAgo: empty when no at', () => {
  const t = (k) => k;
  assert.equal(formatAgo(t, null), '');
  assert.equal(formatAgo(t, undefined), '');
});

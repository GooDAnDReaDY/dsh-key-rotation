// test/shadow.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShadowRouter, SHADOW_BUCKET } from '../lib/shadow.js';

test('ShadowRouter: disabled when percent=0', () => {
  const r = new ShadowRouter({ primary: 'A', secondary: 'B' });
  assert.equal(r.isEnabled(), false);
});

test('ShadowRouter: disabled when primary == secondary', () => {
  const r = new ShadowRouter({ primary: 'X', secondary: 'X', percent: 50 });
  assert.equal(r.isEnabled(), false);
});

test('ShadowRouter: enabled at percent > 0 with distinct primary/secondary', () => {
  const r = new ShadowRouter({ primary: 'A', secondary: 'B', percent: 5 });
  assert.equal(r.isEnabled(), true);
});

test('ShadowRouter: pick samples at given percent (statistical)', () => {
  const r = new ShadowRouter({ primary: 'A', secondary: 'B', percent: 30 });
  let shadowed = 0;
  for (let i = 0; i < 1000; i++) {
    const p = r.pick();
    if (p.sampled) shadowed += 1;
  }
  // Should be roughly 30%, allow +/-5%
  assert.ok(shadowed > 250 && shadowed < 350, `unexpected ${shadowed}/1000`);
});

test('ShadowRouter: pick returns primary always when disabled', () => {
  const r = new ShadowRouter({ primary: 'A', secondary: 'B' }); // percent=0
  for (let i = 0; i < 100; i++) {
    const p = r.pick();
    assert.equal(p.primary, 'A');
    assert.equal(p.secondary, null);
    assert.equal(p.sampled, false);
  }
});

test('ShadowRouter: stable hash gives deterministic sampling per request id', () => {
  const r = new ShadowRouter({ primary: 'A', secondary: 'B', percent: 50 });
  const a = r.pick('request-abc');
  const b = r.pick('request-abc');
  assert.equal(a.sampled, b.sampled, 'same request id → same sample');
});

test('ShadowRouter: recordLatency tracks primary vs secondary separately', () => {
  const r = new ShadowRouter({ primary: 'A', secondary: 'B', percent: 50 });
  r.recordLatency('A', 100);
  r.recordLatency('A', 200);
  r.recordLatency('B', 50);
  const s = r.snapshot();
  assert.equal(s.avgLatencyMs.primary, 150);
  assert.equal(s.avgLatencyMs.secondary, 50);
});

test('ShadowRouter: recordLatency ignores invalid', () => {
  const r = new ShadowRouter({ primary: 'A', secondary: 'B', percent: 50 });
  r.recordLatency('A', NaN);
  r.recordLatency('A', -1);
  r.recordLatency('B', 'string');
  const s = r.snapshot();
  assert.equal(s.avgLatencyMs.primary, null);
  assert.equal(s.avgLatencyMs.secondary, null);
});

test('ShadowRouter: snapshot and reset', () => {
  const r = new ShadowRouter({ primary: 'A', secondary: 'B', percent: 50 });
  r.pick(); r.pick('r1'); r.pick('r2');
  r.recordLatency('A', 100);
  let s = r.snapshot();
  assert.equal(s.sent, 3);
  assert.equal(s.avgLatencyMs.primary, 100);
  r.reset();
  s = r.snapshot();
  assert.equal(s.sent, 0);
  assert.equal(s.avgLatencyMs.primary, null);
});

test('ShadowRouter: invalid percent clamped to SHADOW_BUCKET', () => {
  const r = new ShadowRouter({ primary: 'A', secondary: 'B', percent: 200 });
  assert.equal(r._percent, SHADOW_BUCKET);
});

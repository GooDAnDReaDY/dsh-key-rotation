import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBackoff, recordFailure, recordSuccess } from '../lib/pool.js';

test('computeBackoff: 1st failure = base', () => {
  assert.equal(computeBackoff(60000, 1), 60000);
});
test('computeBackoff: 2nd = base*2', () => {
  assert.equal(computeBackoff(60000, 2), 120000);
});
test('computeBackoff: 3rd = base*4', () => {
  assert.equal(computeBackoff(60000, 3), 240000);
});
test('computeBackoff: 4th = base*8 capped', () => {
  assert.equal(computeBackoff(60000, 4), 480000);
});
test('computeBackoff: 5th stays capped', () => {
  assert.equal(computeBackoff(60000, 5), 480000);
  assert.equal(computeBackoff(60000, 10), 480000);
});
test('computeBackoff: custom maxMs overrides cap', () => {
  assert.equal(computeBackoff(60000, 4, 100000), 100000);
  assert.equal(computeBackoff(60000, 2, 100000), 100000);
});
test('computeBackoff: base 30000 curve', () => {
  assert.equal(computeBackoff(30000, 1), 30000);
  assert.equal(computeBackoff(30000, 2), 60000);
  assert.equal(computeBackoff(30000, 3), 120000);
  assert.equal(computeBackoff(30000, 4), 240000);
});

function freshPool(refs=['A','B']){
  return { refs, state: { failedUntil: new Map(), failCounts: new Map(), pointer:0 } };
}

test('recordFailure: first failure sets failedUntil = now+base', () => {
  const p=freshPool();
  const backoff=recordFailure(p,'A',1000,60000);
  assert.equal(backoff,60000);
  assert.equal(p.state.failedUntil.get('A'),61000);
  assert.equal(p.state.failCounts.get('A'),1);
});

test('recordFailure: second failure doubles', () => {
  const p=freshPool();
  recordFailure(p,'A',1000,60000);
  const b2=recordFailure(p,'A',2000,60000);
  assert.equal(b2,120000);
  assert.equal(p.state.failedUntil.get('A'),122000);
  assert.equal(p.state.failCounts.get('A'),2);
});

test('recordFailure: third and fourth grow then cap', () => {
  const p=freshPool();
  recordFailure(p,'A',0,60000);
  recordFailure(p,'A',0,60000);
  const b3=recordFailure(p,'A',0,60000);
  assert.equal(b3,240000);
  const b4=recordFailure(p,'A',0,60000);
  assert.equal(b4,480000);
  const b5=recordFailure(p,'A',0,60000);
  assert.equal(b5,480000);
});

test('recordFailure: different refs have independent counters', () => {
  const p=freshPool(['A','B']);
  recordFailure(p,'A',0,60000);
  recordFailure(p,'A',0,60000);
  recordFailure(p,'B',0,60000);
  assert.equal(p.state.failCounts.get('A'),2);
  assert.equal(p.state.failCounts.get('B'),1);
});

test('recordSuccess: clears cooldown and resets counter', () => {
  const p=freshPool();
  recordFailure(p,'A',0,60000);
  recordFailure(p,'A',0,60000);
  assert.equal(p.state.failCounts.get('A'),2);
  recordSuccess(p,'A');
  assert.equal(p.state.failCounts.has('A'),false);
  assert.equal(p.state.failedUntil.has('A'),false);
});

test('recordSuccess: after reset, next failure starts from base again', () => {
  const p=freshPool();
  recordFailure(p,'A',0,60000);
  recordFailure(p,'A',0,60000);
  recordSuccess(p,'A');
  const b=recordFailure(p,'A',1000,60000);
  assert.equal(b,60000);
  assert.equal(p.state.failCounts.get('A'),1);
});

// test/agent-budget.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentBudget } from '../lib/agent-budget.js';

test('AgentBudget: disabled when limit=0', () => {
  const b = new AgentBudget({ limit: 0 });
  for (let i = 0; i < 1000; i++) {
    assert.equal(b.check('agent-A').allowed, true);
  }
});

test('AgentBudget: limits correctly within window', () => {
  const b = new AgentBudget({ limit: 3, windowMs: 1000 });
  assert.equal(b.check('A', 1000).allowed, true);
  assert.equal(b.check('A', 1100).allowed, true);
  assert.equal(b.check('A', 1200).allowed, true);
  const r = b.check('A', 1300);
  assert.equal(r.allowed, false);
  assert.equal(r.remaining, 0);
});

test('AgentBudget: window slides — old hits expire (strict < cutoff)', () => {
  const b = new AgentBudget({ limit: 2, windowMs: 100 });
  b.check('A', 0);   // hits=[0]
  b.check('A', 50);  // hits=[0, 50]
  assert.equal(b.check('A', 100).allowed, false, 'at limit');
  // At t=151 hit at 50 expired (cutoff=51, 50<51 strict)
  assert.equal(b.check('A', 151).allowed, true, 'one slot freed');
  assert.equal(b.check('A', 160).allowed, true, 'second slot consumed');
  assert.equal(b.check('A', 170).allowed, false, 'at limit again');
});

test('AgentBudget: per-agent isolation', () => {
  const b = new AgentBudget({ limit: 2, windowMs: 1000 });
  b.check('A', 1000);
  b.check('A', 1100);
  assert.equal(b.check('A', 1200).allowed, false);
  assert.equal(b.check('B', 1200).allowed, true);
  assert.equal(b.check('B', 1300).allowed, true);
});

test('AgentBudget: empty agentId denied when enabled', () => {
  const b = new AgentBudget({ limit: 5 });
  assert.equal(b.check('').allowed, false);
  assert.equal(b.check(undefined).allowed, false);
  assert.equal(b.check(null).allowed, false);
});

test('AgentBudget: reset by agent or all', () => {
  const b = new AgentBudget({ limit: 1 });
  b.check('A', 0);
  assert.equal(b.check('A', 1).allowed, false);
  b.reset('A');
  assert.equal(b.check('A', 2).allowed, true);
  b.check('B', 0);
  b.reset();
  assert.equal(b.check('B', 3).allowed, true);
});

test('AgentBudget: peek does not record', () => {
  const b = new AgentBudget({ limit: 2 });
  b.check('A', 0);
  const p = b.peek('A', 0);
  assert.equal(p.remaining, 1);
  const p2 = b.peek('A', 0);
  assert.equal(p2.remaining, 1, 'peek does not consume');
});

test('AgentBudget: invalid window/limit fall back to defaults', () => {
  const b = new AgentBudget({ windowMs: 0, limit: -5 });
  assert.equal(b.isEnabled(), false);
});

test('AgentBudget: snapshot returns hits count per agent', () => {
  const b = new AgentBudget({ limit: 5 });
  b.check('A', 0);
  b.check('A', 1);
  const s = b.snapshot();
  assert.equal(s.A.hits, 2);
});

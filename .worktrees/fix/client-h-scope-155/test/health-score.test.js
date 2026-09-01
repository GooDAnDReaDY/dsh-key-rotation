import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHealthScore } from '../lib/pool.js';

test('healthScore: fresh state = 100', () => {
  assert.equal(computeHealthScore({}), 100);
});
test('healthScore: 2 switches -> 90', () => {
  assert.equal(computeHealthScore({ switches: 2 }), 90);
});
test('healthScore: exhaustion -> -10', () => {
  assert.equal(computeHealthScore({ exhaustionCount: 1 }), 90);
});
test('healthScore: broken key -> -15', () => {
  assert.equal(computeHealthScore({ brokenUntil: new Map([['A', 1]]) }), 85);
});
test('healthScore: clamps at 0', () => {
  assert.equal(computeHealthScore({ switches: 50, exhaustionCount: 20 }), 0);
});
test('healthScore: undefined/null -> 100', () => {
  assert.equal(computeHealthScore(null), 100);
});

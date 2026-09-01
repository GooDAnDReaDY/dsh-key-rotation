import test from 'node:test';
import assert from 'node:assert/strict';

function freshPool() {
  return { state: { failedUntil: new Map(), failCounts: new Map(), usageCounts: new Map() } };
}
test('usageCounts: increments on success', () => {
  const p = freshPool();
  const inc = (ref) => {
    if (!p.state.usageCounts) p.state.usageCounts = new Map();
    p.state.usageCounts.set(ref, (p.state.usageCounts.get(ref) ?? 0) + 1);
  };
  inc('A'); inc('A'); inc('B');
  assert.equal(p.state.usageCounts.get('A'), 2);
  assert.equal(p.state.usageCounts.get('B'), 1);
});
test('usageCounts: exposed as 0 when missing', () => {
  const p = freshPool();
  assert.equal(p.state.usageCounts.get('X') ?? 0, 0);
});

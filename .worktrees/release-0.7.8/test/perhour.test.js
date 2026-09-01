import test from 'node:test';
import assert from 'node:assert/strict';

function freshPool(perHour) {
  return { perHour, state: { failedUntil: new Map(), quotaWindows: new Map() } };
}
function canUse(pool, ref, now) {
  if (!pool.perHour) return true;
  let win = pool.state.quotaWindows.get(ref);
  if (!win || now - win.start >= 3600000) win = { count: 0, start: now };
  if (win.count >= pool.perHour) return false;
  return true;
}
test('perHour: allows up to limit', () => {
  const p = freshPool(2);
  p.state.quotaWindows.set('A', { count: 1, start: 0 });
  assert.equal(canUse(p, 'A', 1000), true);
  p.state.quotaWindows.set('A', { count: 2, start: 0 });
  assert.equal(canUse(p, 'A', 1000), false);
  // new window
  assert.equal(canUse(p, 'A', 3600001), true);
});
test('perHour: undefined means no limit', () => {
  const p = freshPool(undefined);
  assert.equal(canUse(p, 'A', 0), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';

function incDay(usageDays, ref, day) {
  if (!usageDays) usageDays = new Map();
  let m = usageDays.get(ref) || new Map();
  m.set(day, (m.get(day) ?? 0) + 1);
  usageDays.set(ref, m);
  return usageDays;
}
function toObj(usageDays, ref) {
  return usageDays && usageDays.get(ref) ? Object.fromEntries(usageDays.get(ref)) : {};
}

test('usageDays: aggregates by day per key', () => {
  let m = new Map();
  m = incDay(m, 'KEY_1', '2026-08-25');
  m = incDay(m, 'KEY_1', '2026-08-25');
  m = incDay(m, 'KEY_1', '2026-08-26');
  m = incDay(m, 'KEY_2', '2026-08-25');
  assert.deepEqual(toObj(m, 'KEY_1'), { '2026-08-25': 2, '2026-08-26': 1 });
  assert.deepEqual(toObj(m, 'KEY_2'), { '2026-08-25': 1 });
  assert.deepEqual(toObj(m, 'KEY_NONE'), {});
});

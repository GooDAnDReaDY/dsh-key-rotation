import test from 'node:test';
import assert from 'node:assert/strict';

// byModel aggregation logic (#121)
function incByModel(byModel, ref, model) {
  if (!byModel) byModel = new Map();
  let byRef = byModel.get(ref);
  if (!byRef) { byRef = new Map(); byModel.set(ref, byRef); }
  byRef.set(model, (byRef.get(model) ?? 0) + 1);
  return byModel;
}
function toObj(byModel, ref) {
  return byModel && byModel.get(ref) ? Object.fromEntries(byModel.get(ref)) : {};
}

test('byModel: aggregates per model per key', () => {
  let m = new Map();
  m = incByModel(m, 'KEY_1', 'deepseek-v4-flash');
  m = incByModel(m, 'KEY_1', 'deepseek-v4-flash');
  m = incByModel(m, 'KEY_1', 'mimo-v2.5');
  m = incByModel(m, 'KEY_2', 'groq');
  assert.deepEqual(toObj(m, 'KEY_1'), { 'deepseek-v4-flash': 2, 'mimo-v2.5': 1 });
  assert.deepEqual(toObj(m, 'KEY_2'), { groq: 1 });
  assert.deepEqual(toObj(m, 'KEY_NONE'), {});
});

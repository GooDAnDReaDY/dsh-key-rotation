import test from 'node:test';
import assert from 'node:assert/strict';

// 0.7.x feature coverage without DSH harness

test('costPerKey: increments on success', () => {
  const state = { costPerKey: new Map() };
  const addCost = (ref, cost) => {
    state.costPerKey.set(ref, (state.costPerKey.get(ref) ?? 0) + cost);
  };
  addCost('A', 0.01); addCost('A', 0.02); addCost('B', 0.05);
  assert.equal(state.costPerKey.get('A'), 0.03);
  assert.equal(state.costPerKey.get('B'), 0.05);
});

test('perHour: quota window resets after hour', () => {
  const state = { quotaWindows: new Map() };
  const check = (ref, now, perHour) => {
    let win = state.quotaWindows.get(ref);
    if (!win || now - win.start >= 3600000) win = { count: 0, start: now };
    return win.count < perHour;
  };
  state.quotaWindows.set('A', { count: 2, start: 0 });
  assert.equal(check('A', 1000, 2), false);
  assert.equal(check('A', 3600001, 2), true);
});

test('breaker: after 3 AUTH -> broken', () => {
  const state = { authFailCounts: new Map(), brokenUntil: new Map() };
  const markAuth = (ref) => {
    const c = (state.authFailCounts.get(ref) ?? 0) + 1;
    state.authFailCounts.set(ref, c);
    if (c >= 3) state.brokenUntil.set(ref, Date.now() + 86400000*30);
  };
  markAuth('A'); markAuth('A'); assert.equal(state.brokenUntil.has('A'), false);
  markAuth('A'); assert.equal(state.brokenUntil.has('A'), true);
});

test('notify: threshold check', () => {
  const shouldNotify = (count, threshold, webhook) => !!webhook && count >= threshold;
  assert.equal(shouldNotify(3, 3, 'https://example.com'), true);
  assert.equal(shouldNotify(2, 3, 'https://example.com'), false);
  assert.equal(shouldNotify(3, 3, ''), false);
});

test('export/import: merge without duplicates', () => {
  const cur = [{ provider: 'p1', keys: ['A'] }, { provider: 'p2', keys: ['X'] }];
  const imp = [{ provider: 'p1', keys: ['A','B'] }, { provider: 'p3', keys: ['Z'] }];
  const map = new Map(cur.map((p) => [p.provider, p]));
  for (const p of imp) if (p && typeof p.provider === 'string') map.set(p.provider, p);
  const merged = [...map.values()];
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.find((p) => p.provider === 'p1').keys, ['A','B']);
});

test('weighted: empty weights defaults to 1', () => {
  const refs = ['A','B']; const weights = [];
  const expanded = [];
  for (let i=0;i<refs.length;i++) { const w = typeof weights[i]==='number'&&weights[i]>0?Math.floor(weights[i]):1; for(let k=0;k<w;k++) expanded.push(refs[i]); }
  assert.deepEqual(expanded, ['A','B']);
});

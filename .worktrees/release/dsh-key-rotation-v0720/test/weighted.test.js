import test from 'node:test';
import assert from 'node:assert/strict';

function expand(refs, weights) {
  const out=[];
  for(let i=0;i<refs.length;i++){ const w=typeof weights[i]==='number'&&weights[i]>0?Math.floor(weights[i]):1; for(let k=0;k<w;k++) out.push(refs[i]); }
  return out;
}
test('weightedRefs: expands correctly', () => {
  assert.deepEqual(expand(['A','B'], [2,1]), ['A','A','B']);
  assert.deepEqual(expand(['A','B'], []), ['A','B']);
  assert.deepEqual(expand(['A'], [3]), ['A','A','A']);
  assert.deepEqual(expand(['A','B'], [0, -1]), ['A','B']); // invalid weights default to 1
});
test('weighted pick: round-robin over weighted list', () => {
  const list = expand(['A','B'], [2,1]); // A,A,B
  let pointer=0;
  const picks=[];
  for(let i=0;i<6;i++){ picks.push(list[pointer]); pointer=(pointer+1)%list.length; }
  assert.deepEqual(picks, ['A','A','B','A','A','B']);
});

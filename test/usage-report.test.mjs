import test from 'node:test';
import assert from 'node:assert/strict';
import { usageRows, usageCsv } from '../lib/usage-report.js';

const NOW = Date.parse('2026-09-01T12:00:00Z');
const DAY = 86400000;

function makePool() {
  return {
    refs: ['A', 'B'],
    state: {
      lastUsed: 'A',
      usageDays: new Map([
        ['A', new Map([['2026-09-01', 5], ['2026-08-31', 2]])],
        ['B', new Map([['2026-08-31', 1]])],
      ]),
      costDays: new Map([
        ['A', new Map([['2026-09-01', 1.234]])],
      ]),
    },
  };
}

test('usageRows: requests/cost per ref over the window', () => {
  const rows = usageRows(makePool(), 7, NOW);
  const a = rows.find((r) => r.ref === 'A');
  const b = rows.find((r) => r.ref === 'B');
  assert.equal(a.requests, 7); // 5 today + 2 yesterday
  assert.equal(b.requests, 1);
  assert.equal(a.cost, 1.23);  // rounded
  assert.equal(b.cost, 0);
  assert.equal(a.active, true);
  assert.equal(b.active, false);
  assert.equal(a.usageByDay['2026-09-01'], 5);
});

test('usageRows: days=1 limits the window', () => {
  const rows = usageRows(makePool(), 1, NOW);
  assert.equal(rows.find((r) => r.ref === 'A').requests, 5);
});

test('usageRows: empty pool state is safe', () => {
  const rows = usageRows({ refs: ['X'], state: {} }, 3, NOW);
  assert.equal(rows[0].requests, 0);
  assert.equal(Object.keys(rows[0].usageByDay).length, 3);
  assert.ok(Object.values(rows[0].usageByDay).every((v) => v === 0));
});

test('usageCsv: header + rows, day columns sorted', () => {
  const csv = usageCsv(usageRows(makePool(), 7, NOW));
  const lines = csv.split('\n');
  assert.equal(lines[0], 'ref,requests,cost,active,2026-08-26,2026-08-27,2026-08-28,2026-08-29,2026-08-30,2026-08-31,2026-09-01');
  assert.ok(lines[1].startsWith('A,7,1.23,yes'));
  assert.ok(lines[2].startsWith('B,1,0,no'));
});

test('usageCsv: escapes commas and quotes', () => {
  const csv = usageCsv([{ ref: 'A,B"2', requests: 1, cost: 0, active: false, usageByDay: {} }]);
  assert.ok(csv.includes('"A,B""2"'));
});

// Tests for assets/reads.js (EPCReads): per-browser read counter and estimate.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const EPCReads = require('../assets/reads.js');

const DAY_END = 1_800_000_000_000;      // pretend reset moment (ms)
let now = DAY_END - 3600_000;           // an hour before the reset
function fakeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
function fresh() {
  now = DAY_END - 3600_000;
  EPCReads._init({ now: () => now, storage: fakeStorage(), nextReset: () => DAY_END });
}

test('spent accumulates and used reads it back', () => {
  fresh();
  EPCReads.spent(2, 'a');
  EPCReads.spent(3, 'b');
  assert.equal(EPCReads.used(), 5);
  assert.deepEqual(EPCReads.byLabel(), { a: 2, b: 3 });
});

test('countSnap counts an empty snapshot as 1', () => {
  fresh();
  const snap = { size: 0 };
  assert.equal(EPCReads.countSnap(snap, 'x'), snap);
  assert.equal(EPCReads.used(), 1);
});

test('used resets after the day boundary', () => {
  fresh();
  EPCReads.spent(5, 'a');
  now = DAY_END + 1;
  assert.equal(EPCReads.used(), 0);
});

test('estimate: saved copy present costs 2 (+1 per extra 1,000)', () => {
  fresh();
  const state = { uid: 'me', saved: { purchases: { uid: 'me', at: now, count: 2500 } }, counts: {}, daysCached: new Set() };
  const r = EPCReads.estimate([{ saved: 'purchases' }], state);
  assert.equal(r.reads, 4);
  assert.equal(r.breakdown[0].note, 'change check');
});

test('estimate ignores a copy saved for another user', () => {
  fresh();
  const state = { uid: 'me', saved: { productMaster: { uid: 'other', at: now, count: 10 } }, counts: { productMaster: 4700 }, daysCached: new Set() };
  const r = EPCReads.estimate([{ saved: 'productMaster' }], state);
  assert.equal(r.reads, 4700);
  assert.equal(r.breakdown[0].note, 'first load on this browser');
});

test('estimate ignores a copy older than 7 days', () => {
  fresh();
  const old = now - 8 * 86400_000;
  const state = { uid: 'me', saved: { expenses: { uid: 'me', at: old, count: 10 } }, counts: { expenses: 1500 }, daysCached: new Set() };
  assert.equal(EPCReads.estimate([{ saved: 'expenses' }], state).reads, 1500);
});

test('estimate uses FALLBACK when nothing is known', () => {
  fresh();
  const state = { uid: 'me', saved: {}, counts: {}, daysCached: new Set() };
  assert.equal(EPCReads.estimate([{ saved: 'productMaster' }], state).reads, EPCReads.FALLBACK.productMaster);
  assert.equal(EPCReads.FALLBACK.productMaster, 5000);
});

test('estimate: days not cached cost 1 each, cached range costs 2', () => {
  fresh();
  const cached = new Set(['2026-11-01', '2026-11-02', '2026-11-03']);
  const state = { uid: 'me', saved: {}, counts: {}, daysCached: cached };
  assert.equal(EPCReads.estimate([{ days: 'salesDaily', from: '2026-11-01', to: '2026-11-10' }], state).reads, 7);
  const all = new Set(EPCReads.daysBetween('2026-11-01', '2026-11-10'));
  assert.equal(EPCReads.estimate([{ days: 'salesDaily', from: '2026-11-01', to: '2026-11-10' }], { ...state, daysCached: all }).reads, 2);
});

test('estimate: fixed parts add up', () => {
  fresh();
  const state = { uid: 'me', saved: {}, counts: {}, daysCached: new Set() };
  assert.equal(EPCReads.estimate([{ fixed: 3, label: 'x' }, { fixed: 4, label: 'y' }], state).reads, 7);
});

test('shouldConfirm thresholds', () => {
  assert.equal(EPCReads.shouldConfirm(1000, 0), false);
  assert.equal(EPCReads.shouldConfirm(1001, 0), true);
  assert.equal(EPCReads.shouldConfirm(10, 49995), true);
});

test('format wording', () => {
  assert.equal(EPCReads.format(1, 0), '≈ 1 read · 0 used today on this browser');
  assert.equal(EPCReads.format(12000, 1240), '≈ 12,000 reads · 1,240 used today on this browser');
});

test('daysBetween is inclusive and zero-padded', () => {
  assert.deepEqual(EPCReads.daysBetween('2026-01-30', '2026-02-02'), ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
});

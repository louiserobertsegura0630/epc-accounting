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

test('watchGet counts every successful get() on a prototype', async () => {
  fresh();
  class FakeQuery { constructor(path) { this.path = path; } async get() { return { size: 3 }; } }
  EPCReads.watchGet(FakeQuery.prototype, q => q.path);
  const snap = await new FakeQuery('purchases').get();
  assert.equal(snap.size, 3);
  assert.equal(EPCReads.used(), 3);
  assert.deepEqual(EPCReads.byLabel(), { purchases: 3 });
});

test('watchGet does not count a get() that fails', async () => {
  fresh();
  class FakeQuery { async get() { throw new Error('offline'); } }
  EPCReads.watchGet(FakeQuery.prototype, () => 'x');
  await assert.rejects(() => new FakeQuery().get(), /offline/);
  assert.equal(EPCReads.used(), 0);
});

test('watchGet counts a single document read as 1', async () => {
  fresh();
  class FakeDoc { async get() { return { exists: true }; } }   // no .size on a document snapshot
  EPCReads.watchGet(FakeDoc.prototype, () => 'doc');
  await new FakeDoc().get();
  assert.equal(EPCReads.used(), 1);
});

test('line() writes the cost text into the element using the saved-copy metadata', async () => {
  fresh();
  const g = globalThis;
  g.EPCSaved = { meta: async () => ({ purchases: { uid: 'me', at: now, count: 10 } }) };
  g.firebase = { auth: () => ({ currentUser: { uid: 'me' } }) };
  const el = { textContent: '', title: '' };
  EPCReads.spent(7, 'earlier');
  await EPCReads.line(el, () => [{ saved: 'purchases' }, { saved: 'expenses' }]);
  assert.equal(el.textContent, `≈ ${(2 + EPCReads.FALLBACK.expenses).toLocaleString('en-US')} reads · 7 used today on this browser`);
  assert.match(el.title, /purchases: 2 \(change check\)/);
  delete g.EPCSaved; delete g.firebase;
});

test('confirm() resolves true without a pop-up for a small load', async () => {
  fresh();
  const g = globalThis;
  g.EPCSaved = { meta: async () => ({}) };
  g.firebase = { auth: () => ({ currentUser: { uid: 'me' } }) };
  g.document = { createElement: () => { throw new Error('no pop-up expected'); } };
  assert.equal(await EPCReads.confirm([{ fixed: 5, label: 'x' }]), true);
  delete g.EPCSaved; delete g.firebase; delete g.document;
});

test('format says 0 reads (offline) in Offline mode', () => {
  assert.equal(EPCReads.format(123, 45, { offline: true }), '0 reads (offline)');
});

test('pesos estimates the paid cost of reads beyond the free allowance', () => {
  assert.equal(EPCReads.pesos(10000), '₱0.35');
  assert.equal(EPCReads.pesos(430000), '₱15.05');
  assert.equal(EPCReads.pesos(0), '₱0.00');
});

test('paidPart says how many reads of a load fall beyond the free allowance', () => {
  assert.equal(EPCReads.paidPart(300, 49900), 200);
  assert.equal(EPCReads.paidPart(300, 10), 0);
  assert.equal(EPCReads.paidPart(300, 60000), 300);
});

test('the paid-reads bar writes its lines into its own text slots, not the icon', () => {
  const src = require('fs').readFileSync(require.resolve('../assets/reads.js'), 'utf8');
  assert.match(src, /epc-quota-msg/);
  assert.doesNotMatch(src, /paidBar\.querySelector\('span'\)/);
});

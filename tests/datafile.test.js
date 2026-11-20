// Tests for assets/datafile.js (EPCDataFile): download all saved data, load it on another browser.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const EPCDataFile = require('../assets/datafile.js');

const saved = {
  purchases: { v: 1, uid: 'me', at: 1, stamp: { s: 1, n: 0 }, docs: { a: { total: 1 }, b: { total: 2 } } },
  expenses: { v: 1, uid: 'me', at: 1, stamp: { s: 1, n: 0 }, docs: { x: { amount: 5 } } },
};
const days = {
  salesDaily: { stamp: { s: 2, n: 0 }, covered: ['2026-11-01', '2026-11-02', '2026-11-03'], days: { '2026-11-01': { totals: { revenue: 1 } }, '2026-11-03': { totals: { revenue: 3 } } } },
  inventoryDaily: { stamp: null, covered: [], days: {} },
};

test('build has version 1 and the uid', () => {
  const file = EPCDataFile.build('me', saved, days, 1_800_000_000_000);
  assert.equal(file.v, 1);
  assert.equal(file.uid, 'me');
  assert.equal(file.at, 1_800_000_000_000);
  assert.equal(file.saved.purchases.docs.b.total, 2);
  assert.equal(file.days.salesDaily.days['2026-11-03'].totals.revenue, 3);
});

test('describe counts records and the day range', () => {
  const d = EPCDataFile.describe(EPCDataFile.build('me', saved, days, 1));
  assert.deepEqual(d, { records: 3, days: 2, from: '2026-11-01', to: '2026-11-03' });
});

test('importFile refuses another user\'s file', async () => {
  const file = EPCDataFile.build('someone-else', saved, days, 1);
  assert.deepEqual(EPCDataFile.validate(file, 'me'), { ok: false, reason: 'This file was downloaded by another account.' });
  const writes = [];
  await assert.rejects(
    () => EPCDataFile.importInto(file, 'me', { importSaved: async (s) => writes.push(s), importDays: async (d) => writes.push(d) }),
    /another account/);
  assert.equal(writes.length, 0);
});

test('validate rejects an unknown version', () => {
  assert.deepEqual(EPCDataFile.validate({ v: 2, uid: 'me' }, 'me'), { ok: false, reason: 'This is not an EPC data file.' });
  assert.deepEqual(EPCDataFile.validate(null, 'me'), { ok: false, reason: 'This is not an EPC data file.' });
  assert.deepEqual(EPCDataFile.validate(EPCDataFile.build('me', saved, days, 1), 'me'), { ok: true });
});

test('importInto writes the saved copies and the day store for the right user', async () => {
  const file = EPCDataFile.build('me', saved, days, 1);
  const writes = {};
  await EPCDataFile.importInto(file, 'me', { importSaved: async (s) => { writes.saved = s; }, importDays: async (d) => { writes.days = d; } });
  assert.deepEqual(Object.keys(writes.saved), ['purchases', 'expenses']);
  assert.deepEqual(Object.keys(writes.days), ['salesDaily', 'inventoryDaily']);
});

test('fullLoadParts prices every saved copy and the chosen range of sales and inventory days', () => {
  const parts = EPCDataFile.fullLoadParts(['purchases', 'expenses'], '2026-01-01', '2026-01-03');
  assert.deepEqual(parts, [
    { saved: 'purchases' }, { saved: 'expenses' },
    { days: 'salesDaily', from: '2026-01-01', to: '2026-01-03' },
    { days: 'inventoryDaily', from: '2026-01-01', to: '2026-01-03' },
  ]);
});

test('restrictDays keeps only the chosen dates in the file', () => {
  const out = EPCDataFile.restrictDays(days, '2026-11-02', '2026-11-03');
  assert.deepEqual(Object.keys(out.salesDaily.days), ['2026-11-03']);
  assert.deepEqual(out.salesDaily.covered, ['2026-11-02', '2026-11-03']);
  assert.deepEqual(out.salesDaily.stamp, { s: 2, n: 0 });
  assert.deepEqual(out.inventoryDaily.days, {});
});

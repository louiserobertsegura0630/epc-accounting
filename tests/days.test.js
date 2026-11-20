// Tests for assets/days.js (EPCDays): salesDaily/inventoryDaily reader with a saved day store.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const EPCDays = require('../assets/days.js');
const EPCReads = require('../assets/reads.js');

// ── fakes ─────────────────────────────────────────────────────────────────────
class Timestamp { constructor(s, n) { this.seconds = s; this.nanoseconds = n || 0; } toDate() { return new Date(this.seconds * 1000); } }
const fakeFirebase = { firestore: { Timestamp, FieldPath: { documentId: () => '__name__' } } };
function fakeStore() {
  const m = new Map();
  return { m, get: async k => m.get(k), put: async (k, v) => { m.set(k, v); } };
}
// A fake Firestore holding day docs: { 'salesDaily': { '2026-11-01': {...} } }.
// Records every get() so a test can count the reads a call made.
function fakeDb(data) {
  const calls = [];
  function query(coll, f) {
    const filters = f || { from: null, to: null, changedAfter: null, limit: null, order: null };
    const q = {
      orderBy: (field, dir) => query(coll, { ...filters, order: { field, dir } }),
      startAt: v => query(coll, { ...filters, from: v }),
      endAt: v => query(coll, { ...filters, to: v }),
      where: (field, op, v) => {
        if (field === 'lastUpdated') return query(coll, { ...filters, changedAfter: v, changedOp: op });
        if (op === '>=') return query(coll, { ...filters, from: v });
        if (op === '<=') return query(coll, { ...filters, to: v });
        throw new Error(`unexpected where ${field} ${op}`);
      },
      limit: n => query(coll, { ...filters, limit: n }),
      async get() {
        calls.push({ coll, ...filters });
        let ids = Object.keys(data[coll] || {}).sort();
        if (filters.from) ids = ids.filter(id => id >= filters.from);
        if (filters.to) ids = ids.filter(id => id <= filters.to);
        if (filters.changedAfter) ids = ids.filter(id => {
          const ts = data[coll][id].lastUpdated;
          if (!ts) return false;
          return filters.changedOp === '>=' ? ts.seconds >= filters.changedAfter.seconds : ts.seconds > filters.changedAfter.seconds;
        });
        if (filters.order && filters.order.dir === 'desc') ids.reverse();
        if (filters.limit) ids = ids.slice(0, filters.limit);
        const docs = ids.map(id => ({ id, data: () => data[coll][id] }));
        return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn) };
      },
    };
    return q;
  }
  return { calls, collection: coll => query(coll) };
}
function setup(data, opts = {}) {
  const store = fakeStore();
  const db = fakeDb(data);
  const counts = { calls: 0 };
  EPCReads._init({ now: () => 1_800_000_000_000, storage: { getItem: () => null, setItem: () => {} }, nextReset: () => 1_900_000_000_000 });
  EPCDays._init({
    db, store, firebase: fakeFirebase, uid: 'me', now: () => new Date('2026-11-20T10:00:00+08:00'),
    firestoreCount: async (q) => { counts.calls++; return (await q.get()).size; },
    localStorage: { getItem: () => null, setItem: () => {} },
    ...opts,
  });
  return { store, db, counts };
}
const day = (rev, s) => ({ products: { A: { name: 'Apple', units: 2, revenue: rev } }, totals: { units: 2, revenue: rev }, lastUpdated: new Timestamp(s, 0) });

// ── pure helpers ──────────────────────────────────────────────────────────────
test('monthParts splits across months and years', () => {
  assert.deepEqual(EPCDays.monthParts('2025-12-15', '2026-02-03'), [
    ['2025-12-15', '2025-12-31'], ['2026-01-01', '2026-01-31'], ['2026-02-01', '2026-02-03'],
  ]);
});

test('missingDays lists dates in the range that were never loaded', () => {
  const covered = new Set(['2026-11-01', '2026-11-02']);
  assert.deepEqual(EPCDays.missingDays(covered, '2026-11-01', '2026-11-04'), ['2026-11-03', '2026-11-04']);
});

test('newestStamp picks the latest lastUpdated', () => {
  const days = { a: { lastUpdated: new Timestamp(5, 0) }, b: { lastUpdated: new Timestamp(9, 3) }, c: {} };
  assert.deepEqual(EPCDays.newestStamp(days), { s: 9, n: 3 });
  assert.equal(EPCDays.newestStamp({}), null);
});

// ── reading ───────────────────────────────────────────────────────────────────
test('first read fetches the range month by month and stores it', async () => {
  const { store, db } = setup({ salesDaily: { '2026-10-30': day(10, 1), '2026-11-02': day(20, 2) } });
  const r = await EPCDays.docs('salesDaily', '2026-10-29', '2026-11-03');
  assert.deepEqual(Object.keys(r.days), ['2026-10-30', '2026-11-02']);
  assert.deepEqual(r.missing, []);
  assert.equal(db.calls.length, 2);                                   // one query per month
  const saved = store.m.get('days:salesDaily');
  assert.equal(saved.uid, 'me');
  assert.deepEqual(saved.stamp, { s: 2, n: 0 });
  assert.equal(saved.covered.length, 6);                              // every calendar day in the range
});

test('a second read of a covered range makes only the change check and the day count', async () => {
  const data = { salesDaily: { '2026-11-01': day(10, 1), '2026-11-02': day(20, 2) } };
  const { db, counts } = setup(data);
  await EPCDays.docs('salesDaily', '2026-11-01', '2026-11-03');
  db.calls.length = 0; counts.calls = 0;
  const r = await EPCDays.docs('salesDaily', '2026-11-01', '2026-11-03');
  assert.equal(db.calls.filter(c => c.changedAfter).length, 1);       // lastUpdated > stamp
  assert.equal(counts.calls, 1);                                      // the count
  assert.equal(Object.keys(r.days).length, 2);
});

test('a day changed since the last read is picked up by the change check', async () => {
  const data = { salesDaily: { '2026-11-01': day(10, 1), '2026-11-02': day(20, 2) } };
  setup(data);
  await EPCDays.docs('salesDaily', '2026-11-01', '2026-11-02');
  data.salesDaily['2026-11-02'] = day(99, 7);
  const r = await EPCDays.docs('salesDaily', '2026-11-01', '2026-11-02');
  assert.equal(r.days['2026-11-02'].totals.revenue, 99);
});

test('a deleted day is noticed by the count and the range is read again', async () => {
  const data = { salesDaily: { '2026-11-01': day(10, 1), '2026-11-02': day(20, 2) } };
  setup(data);
  await EPCDays.docs('salesDaily', '2026-11-01', '2026-11-02');
  delete data.salesDaily['2026-11-02'];
  const r = await EPCDays.docs('salesDaily', '2026-11-01', '2026-11-02');
  assert.deepEqual(Object.keys(r.days), ['2026-11-01']);
});

test('offline lists missing days and touches no database', async () => {
  const data = { salesDaily: { '2026-11-01': day(10, 1) } };
  const { db } = setup(data);
  await EPCDays.docs('salesDaily', '2026-11-01', '2026-11-02');
  db.calls.length = 0;
  const r = await EPCDays.docs('salesDaily', '2026-11-01', '2026-11-05', { offline: true });
  assert.equal(db.calls.length, 0);
  assert.deepEqual(Object.keys(r.days), ['2026-11-01']);
  assert.deepEqual(r.missing, ['2026-11-03', '2026-11-04', '2026-11-05']);
});

test('salesRows expands day docs into one row per product per day', () => {
  const rows = EPCDays.salesRows({ '2026-11-01': { products: { A: { name: 'Apple', units: 2, revenue: 50, unit_cost: 10 } } } });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    _firestoreId: '2026-11-01__A', date: '2026-11-01', itemCode: 'A', productName: 'Apple', category: '',
    unitsSold: 2, totalRevenue: 50, sellingPrice: 25, unitCost: 10, totalCost: 20,
  });
});

test('firstDay asks once and remembers the answer', async () => {
  const mem = new Map();
  const { db } = setup({ salesDaily: { '2026-03-05': day(1, 1), '2026-11-01': day(2, 2) } },
    { localStorage: { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) } });
  assert.equal(await EPCDays.firstDay('salesDaily'), '2026-03-05');
  assert.equal(await EPCDays.firstDay('salesDaily'), '2026-03-05');
  assert.equal(db.calls.length, 1);
});

test('a day changed before a new day was added is still picked up (regression)', async () => {
  const data = { salesDaily: { '2026-11-01': day(10, 1), '2026-11-02': day(20, 2), '2026-11-03': day(30, 3) } };
  setup(data);
  await EPCDays.docs('salesDaily', '2026-11-01', '2026-11-03');
  data.salesDaily['2026-11-02'] = day(99, 5);      // re-uploaded
  data.salesDaily['2026-11-04'] = day(40, 6);      // a new day
  const first = await EPCDays.docs('salesDaily', '2026-11-01', '2026-11-04');
  assert.equal(first.days['2026-11-02'].totals.revenue, 99, 'first load after the change');
  const second = await EPCDays.docs('salesDaily', '2026-11-01', '2026-11-04');
  assert.equal(second.days['2026-11-02'].totals.revenue, 99, 'second load');
});

test('a day written in the same moment as the newest stamp is still picked up', async () => {
  const data = { salesDaily: { '2026-11-01': day(10, 1), '2026-11-02': day(20, 2) } };
  setup(data);
  await EPCDays.docs('salesDaily', '2026-11-01', '2026-11-02');
  data.salesDaily['2026-11-01'] = day(77, 2);      // same seconds as the newest stamp (one batch commit)
  const r = await EPCDays.docs('salesDaily', '2026-11-01', '2026-11-02');
  assert.equal(r.days['2026-11-01'].totals.revenue, 77);
});

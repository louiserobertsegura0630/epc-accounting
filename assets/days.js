/* ─── EPC Accounting Portal — day docs reader (EPCDays) ───────────────────────
 * One reader for the per-day summaries: salesDaily/{YYYY-MM-DD} (sales) and
 * inventoryDaily/{YYYY-MM-DD} (inventory). Every day read is kept in a saved
 * day store (IndexedDB epc-cache, key days:<collection>, per signed-in user), so:
 *   - a range read before costs about 2 reads (changed days + a day count);
 *   - days never read cost 1 read each, fetched one query per month;
 *   - Offline mode (opts.offline) uses the store only and lists missing days.
 * Both importers stamp lastUpdated on every day they write; a deleted upload is
 * caught by the count. Pure helpers run in Node for the tests.
 */
(function (global) {
  const KEY = (c) => `days:${c}`;
  const VERSION = 1;
  const memory = {};     // collection -> store value for this page view
  const inFlight = {};

  let deps = {
    db: null, store: null, firebase: null, uid: null, now: () => new Date(),
    firestoreCount: null, localStorage: null, reads: null,
  };
  function _init(overrides) {
    deps = { ...deps, ...overrides };
    Object.keys(memory).forEach((k) => delete memory[k]);   // tests: a fresh page view
  }
  const fb = () => deps.firebase || global.firebase;
  const db = () => deps.db || (typeof global.getFirestoreDB === 'function' ? global.getFirestoreDB() : null);
  const ls = () => { if (deps.localStorage) return deps.localStorage; try { return global.localStorage; } catch (e) { return null; } };
  async function uid() {
    if (deps.uid) return deps.uid;
    const auth = fb() && typeof fb().auth === 'function' ? fb().auth() : null;
    if (auth && auth.currentUser) return auth.currentUser.uid;
    return new Promise((resolve, reject) => {
      if (!auth) { reject(new Error('Sign-in is not available.')); return; }
      const off = auth.onAuthStateChanged((user) => { if (user) { off(); resolve(user.uid); } });
    });
  }
  function store() {
    if (deps.store) return deps.store;
    const cs = global.EPCSaved && global.EPCSaved._cacheStore;
    if (!cs) return { get: async () => null, put: async () => {} };
    return {
      get: (k) => cs('readonly', (s) => s.get(k)).catch(() => null),
      put: (k, v) => cs('readwrite', (s) => s.put(v, k)).catch(() => {}),
    };
  }
  const codec = () => (global.EPCSaved && global.EPCSaved._codec) || { encode: (v) => v, decode: (v) => v };
  async function countQuery(q, label) {
    if (deps.firestoreCount) return deps.firestoreCount(q, label);
    if (typeof global.firestoreCount === 'function') return global.firestoreCount(q, label);
    return null;
  }

  // ── pure helpers ──────────────────────────────────────────────────────────
  const pad = (n) => String(n).padStart(2, '0');
  function isoToday() {
    const d = deps.now();
    // Manila calendar day, whatever the computer's zone.
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    return parts;
  }
  function daysBetween(from, to) {
    const out = [];
    if (!from || !to || from > to) return out;
    const d = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
    return out;
  }
  // [[from, to], ...] one pair per calendar month touched by the range.
  function monthParts(from, to) {
    const parts = [];
    if (!from || !to || from > to) return parts;
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    for (;;) {
      const ym = `${y}-${pad(m)}`;
      if (ym > to.slice(0, 7)) break;
      const a = ym === from.slice(0, 7) ? from : `${ym}-01`;
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const b = ym === to.slice(0, 7) ? to : `${ym}-${pad(last)}`;
      parts.push([a, b]);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return parts;
  }
  function missingDays(covered, from, to) {
    return daysBetween(from, to).filter((d) => !covered.has(d));
  }
  // Contiguous runs of dates -> [[from, to], ...]
  function runs(dates) {
    const out = [];
    let start = null; let prev = null;
    dates.forEach((d) => {
      if (prev && daysBetween(prev, d).length === 2) { prev = d; return; }
      if (start) out.push([start, prev]);
      start = d; prev = d;
    });
    if (start) out.push([start, prev]);
    return out;
  }
  function stampOf(ts) {
    return ts && typeof ts.seconds === 'number' ? { s: ts.seconds, n: ts.nanoseconds || 0 } : null;
  }
  function newer(a, b) { return !!a && (!b || a.s > b.s || (a.s === b.s && a.n > b.n)); }
  function newestStamp(days) {
    let best = null;
    Object.keys(days || {}).forEach((k) => {
      const st = stampOf((days[k] || {}).lastUpdated);
      if (newer(st, best)) best = st;
    });
    return best;
  }

  // ── the store ─────────────────────────────────────────────────────────────
  async function load(collection) {
    const user = await uid();
    if (memory[collection] && memory[collection].uid === user) return memory[collection];
    let saved = null;
    try { saved = await store().get(KEY(collection)); } catch (e) { saved = null; }
    if (!saved || saved.v !== VERSION || saved.uid !== user || !saved.days) {
      saved = { v: VERSION, uid: user, stamp: null, covered: [], days: {} };
    } else {
      saved = { ...saved, days: codec().decode(saved.days) };
    }
    saved._covered = new Set(saved.covered || []);
    memory[collection] = saved;
    return saved;
  }
  async function save(collection, saved) {
    saved.covered = [...saved._covered].sort();
    const { _covered, ...plain } = saved;
    await store().put(KEY(collection), { ...plain, days: codec().encode(plain.days) });
  }
  function addDoc(saved, doc) {
    const data = doc.data() || {};
    saved.days[doc.id] = data;
    saved._covered.add(doc.id);
    const st = stampOf(data.lastUpdated);
    if (newer(st, saved.stamp)) saved.stamp = st;
  }
  function idPath() { return fb().firestore.FieldPath.documentId(); }

  async function fetchRange(saved, collection, from, to) {
    const base = () => db().collection(collection).orderBy(idPath());
    const snaps = await Promise.all(monthParts(from, to).map(([a, b]) => base().startAt(a).endAt(b).get()));
    // Drop what we had for these days first: a deleted day must disappear.
    daysBetween(from, to).forEach((d) => { delete saved.days[d]; saved._covered.add(d); });
    snaps.forEach((snap) => snap.forEach((doc) => addDoc(saved, doc)));
  }
  // Days changed since `stamp` (>=, so a day written in the same moment as the
  // newest stamp, e.g. one batch commit, is not missed), then a count of the range.
  async function checkChanges(saved, collection, from, to, stamp) {
    let touched = false;
    if (stamp) {
      const since = new (fb().firestore.Timestamp)(stamp.s, stamp.n);
      const changed = await db().collection(collection).where('lastUpdated', '>=', since).get();
      changed.forEach((doc) => { addDoc(saved, doc); touched = true; });
    }
    // Deleted days leave no trace: compare the number of days in the range.
    let q = db().collection(collection).where(idPath(), '>=', from).where(idPath(), '<=', to);
    const counted = await countQuery(q, `${collection} day count`);
    const have = Object.keys(saved.days).filter((d) => d >= from && d <= to).length;
    if (counted != null && counted !== have) { await fetchRange(saved, collection, from, to); touched = true; }
    return touched;
  }

  // Day docs for a range: { days: { date: data }, missing: [dates never loaded] }.
  async function docs(collection, from, to, opts = {}) {
    const key = `${collection}|${from}|${to}|${opts.offline ? 'off' : 'on'}|${opts.force ? 'f' : ''}`;
    if (!inFlight[key]) inFlight[key] = run(collection, from, to, opts).finally(() => { delete inFlight[key]; });
    return inFlight[key];
  }
  async function run(collection, from, to, opts) {
    const saved = await load(collection);
    const pick = () => {
      const out = {};
      Object.keys(saved.days).sort().forEach((d) => { if (d >= from && d <= to) out[d] = saved.days[d]; });
      return out;
    };
    if (opts.offline) return { days: pick(), missing: missingDays(saved._covered, from, to) };
    if (!db()) throw new Error('The database is not available.');
    let changed = false;
    if (opts.force) daysBetween(from, to).forEach((d) => saved._covered.delete(d));
    const prior = saved.stamp;                 // newest stamp BEFORE this call: changes are checked from here
    const hadDays = saved._covered.size > 0;
    const missing = missingDays(saved._covered, from, to);
    if (missing.length) {
      for (const [a, b] of runs(missing)) await fetchRange(saved, collection, a, b);
      changed = true;
    }
    // Days held from before may have been re-uploaded or cost-matched since.
    if (hadDays && await checkChanges(saved, collection, from, to, prior)) changed = true;
    if (changed) await save(collection, saved);
    return { days: pick(), missing: [] };
  }
  async function firstDay(collection) {
    const k = `epc_first_day:${collection}`;
    const s = ls();
    const known = s ? s.getItem(k) : null;
    if (known) return known;
    const snap = await db().collection(collection).orderBy(idPath()).limit(1).get();
    const first = snap.empty ? isoToday() : snap.docs[0].id;
    try { if (s) s.setItem(k, first); } catch (e) { /* storage off */ }
    return first;
  }
  // The first day if this browser already knows it (no read), else null.
  function firstDayKnown(collection) {
    const s = ls();
    return (s && s.getItem(`epc_first_day:${collection}`)) || null;
  }
  async function all(collection, opts = {}) {
    return docs(collection, await firstDay(collection), isoToday(), opts);
  }
  async function cachedDates(collection) {
    try { return [...(await load(collection))._covered]; } catch (e) { return []; }
  }
  function estimateParts(collection, from, to) { return [{ days: collection, from, to }]; }
  // Parts for "every day since the first upload" without reading the first day on page open.
  function allParts(collection) {
    const first = firstDayKnown(collection);
    if (first) return estimateParts(collection, first, isoToday());
    return [{ fixed: 600, label: collection, note: 'first load on this browser: every sales day, about 600' }];
  }

  // ── row expanders (the shape the report pipeline and pages expect) ───────
  function salesRows(days) {
    const rows = [];
    Object.keys(days || {}).sort().forEach((date) => {
      const products = (days[date] || {}).products || {};
      Object.keys(products).forEach((code) => {
        const p = products[code] || {};
        const units = Number(p.units) || 0;
        const revenue = Number(p.revenue) || 0;
        const unitCost = Number(p.unit_cost) || 0;
        rows.push({
          _firestoreId: `${date}__${code}`, date, itemCode: code, productName: p.name || code, category: p.category || '',
          unitsSold: units, totalRevenue: revenue,
          sellingPrice: units > 0 ? Math.round((revenue / units) * 10000) / 10000 : 0,
          unitCost, totalCost: (p.cost != null ? Number(p.cost) : unitCost * units) || 0,
        });
      });
    });
    return rows;
  }
  function inventoryRows(days) {
    const rows = [];
    Object.keys(days || {}).sort().forEach((date) => {
      const items = (days[date] || {}).items || {};
      Object.keys(items).forEach((code) => {
        const it = items[code] || {};
        rows.push({
          _firestoreId: `${date}__${code}`, dateDelivered: date, date, type: 'Incoming', itemCode: code,
          description: it.name || '', category: '', supplier: it.supplier || '',
          unitCost: Number(it.unit_cost) || 0, qty: Number(it.qty) || 0, totalCost: Number(it.total_cost) || 0,
        });
      });
    });
    return rows;
  }

  // ── data file (Task 10) ───────────────────────────────────────────────────
  async function exportAll() {
    const out = {};
    for (const c of ['salesDaily', 'inventoryDaily']) {
      const saved = await load(c);
      out[c] = { stamp: saved.stamp, covered: [...saved._covered].sort(), days: codec().encode(saved.days) };
    }
    return out;
  }
  async function importAll(obj) {
    const user = await uid();
    for (const c of Object.keys(obj || {})) {
      const v = obj[c] || {};
      const saved = { v: VERSION, uid: user, stamp: v.stamp || null, covered: v.covered || [], days: v.days || {} };
      await store().put(KEY(c), saved);
      delete memory[c];
    }
  }

  const api = {
    docs, all, firstDay, firstDayKnown, cachedDates, estimateParts, allParts, salesRows, inventoryRows, exportAll, importAll,
    monthParts, missingDays, newestStamp, daysBetween, isoToday, _init,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.EPCDays = api;
})(typeof window !== 'undefined' ? window : globalThis);

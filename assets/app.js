/* ─── EPC Accounting Portal — Shared App JS ─────────────────────────────── */

// ─── Report gating ────────────────────────────────────────────────────────────
// Defer paid Firestore reads until the user clicks a "Generate Report" button.
// Pages call EPCReportGate.wire({ button, status, load }) where `load` is the
// existing async loader. On first click it runs the loader (button disabled +
// "Loading…"), then relabels the button to "Refresh" for manual reloads. Each
// click = paid reads, so the button stays disabled for the duration of the fetch.
window.EPCReportGate = window.EPCReportGate || (() => {
  function wire(opts) {
    const btn = typeof opts.button === 'string'
      ? document.getElementById(opts.button) : opts.button;
    if (!btn) {
      console.warn('[EPCReportGate] button not found:', opts.button);
      return { run: async () => {}, hasLoaded: () => false };
    }
    const status = opts.status
      ? (typeof opts.status === 'string' ? document.getElementById(opts.status) : opts.status)
      : null;
    const load = opts.load;
    const idleLabel = opts.idleLabel || 'Generate Report';
    const loadingLabel = opts.loadingLabel || 'Loading…';
    const refreshLabel = opts.refreshLabel || 'Refresh';
    let loaded = false;
    let running = false;
    // Loading pop-up (bouncing bars) while the report loads. Pages that show
    // their own loader (dashboard, reports progress bar) pass popup: false.
    const popupLabel = opts.popup === false ? null : (opts.popupLabel || 'Loading report…');
    // Cost line ("≈ 2 reads · 1,240 used today on this browser") beside the button,
    // and a confirm pop-up before big loads. opts.estimate() returns the parts
    // EPCReads.estimate understands; opts.costLine is the element (or id) to write.
    const estimate = typeof opts.estimate === 'function' ? opts.estimate : null;
    const costLine = opts.costLine
      ? (typeof opts.costLine === 'string' ? document.getElementById(opts.costLine) : opts.costLine)
      : null;
    function paintCost() {
      if (costLine && estimate && window.EPCReads) EPCReads.line(costLine, estimate);
    }
    if (costLine && estimate) {
      paintCost();
      window.addEventListener('epc-cost-change', paintCost);
      window.addEventListener('epc-reads-change', paintCost);
    }

    if (btn.textContent.trim() === '') btn.textContent = idleLabel;

    async function run() {
      if (running) return;              // guard against double-clicks (paid reads)
      if (estimate && window.EPCReads && !(await EPCReads.confirm(estimate))) return;   // "Not now"
      running = true;
      const prevLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = loadingLabel;
      if (status) status.textContent = 'Loading data…';
      if (popupLabel) EPCLoading.show(popupLabel);
      const startedAt = Date.now();
      try {
        await load();
        loaded = true;
        btn.textContent = refreshLabel;
        if (status) status.textContent = '';
        EPCQuota.ok(startedAt);
        paintCost();
      } catch (err) {
        console.error('[EPCReportGate] load failed:', err);
        btn.textContent = loaded ? refreshLabel : (prevLabel || idleLabel);
        if (status) {
          status.textContent = EPCQuota.report(err)
            ? `Daily read limit reached. Try again after ${EPCQuota.resetText()}.`
            : 'Could not load data. Try again.';
        }
      } finally {
        if (popupLabel) EPCLoading.hide();
        btn.disabled = false;
        running = false;
      }
    }

    btn.addEventListener('click', run);
    return { run, hasLoaded: () => loaded };
  }
  return { wire };
})();

// ─── Loading pop-up (shared) ──────────────────────────────────────────────────
// One overlay per page, created on first use. Counted, so overlapping loads
// keep it up until the last one finishes.
window.EPCLoading = window.EPCLoading || (() => {
  let el = null;
  let count = 0;
  function ensure() {
    if (el) return el;
    el = document.createElement('div');
    el.className = 'epc-loading-overlay';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    el.innerHTML = '<div class="epc-loading-card">' +
      '<div class="epc-loader" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>' +
      '<div class="epc-loading-msg"></div>' +
      '<div class="epc-loading-sub">Please wait. This can take a few seconds.</div></div>';
    document.body.appendChild(el);
    return el;
  }
  return {
    show(message) {
      const o = ensure();
      count += 1;
      o.querySelector('.epc-loading-msg').textContent = message || 'Loading…';
      o.hidden = false;
    },
    hide() {
      count = Math.max(0, count - 1);
      if (el && count === 0) el.hidden = true;
    },
    // Show the pop-up while fn() runs (fn may return a promise).
    async run(message, fn) {
      this.show(message);
      try { return await fn(); } finally { this.hide(); }
    },
  };
})();

// ─── Daily read limit warning (shared) ───────────────────────────────────────
// The Firebase project is on the free Spark plan: 50,000 Firestore reads per
// day for the whole portal. When they run out, loads fail or come back partial.
// Any code that catches a load error passes it to EPCQuota.report(err); if it is
// the quota, a warning bar appears with the reset time. The hit is remembered on
// this browser until the reset, so the bar shows again on every page load
// without spending a read. A load that works again clears it (EPCQuota.ok()).
window.EPCQuota = window.EPCQuota || (() => {
  const KEY = 'epc_quota_hit';
  let el = null;
  let hit = null;        // { at, reset } in ms, or null
  let hidden = false;    // "Hide" lasts for this page view only
  let timer = null;

  function isQuotaError(err) {
    const code = String((err && err.code) ?? '').toLowerCase();
    const msg = String((err && err.message) || err || '').toLowerCase();
    return code.includes('resource-exhausted') || msg.includes('resource_exhausted') ||
      msg.includes('resource-exhausted') || msg.includes('quota exceeded');
  }
  // The free quota resets at midnight US Pacific time (3 or 4 PM in Manila).
  function nextReset(from) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(from));
    const n = type => Number(parts.find(p => p.type === type).value);
    const elapsed = (n('hour') % 24) * 3600 + n('minute') * 60 + n('second');  // midnight can come back as "24"
    return from - (from % 1000) + (86400 - elapsed) * 1000;
  }
  function manila(ms, opts) {
    return new Date(ms).toLocaleString('en-US', { timeZone: 'Asia/Manila', ...opts });
  }
  const clock = ms => manila(ms, { hour: 'numeric', minute: '2-digit' });
  const day = ms => manila(ms, { year: 'numeric', month: 'numeric', day: 'numeric' });
  // "about 4:00 PM today (Philippine time)"
  function resetText() {
    const reset = hit ? hit.reset : nextReset(Date.now());
    return `about ${clock(reset)} ${day(reset) === day(Date.now()) ? 'today' : 'tomorrow'} (Philippine time)`;
  }
  function countdown(ms) {
    const mins = Math.max(1, Math.ceil(ms / 60000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return (h ? `${h} hr ` : '') + (m || !h ? `${m} min` : '').trim();
  }

  function paint() {
    if (hit && Date.now() >= hit.reset) clear();
    if (!hit || hidden) { if (el) el.hidden = true; return; }
    if (!document.body) { document.addEventListener('DOMContentLoaded', paint, { once: true }); return; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'epc-quota';
      el.setAttribute('role', 'alert');
      el.innerHTML = '<span class="epc-quota-icon" aria-hidden="true">⚠️</span>' +
        '<div class="epc-quota-text"><strong>Firebase’s free daily read limit is used up</strong>' +
        '<span class="epc-quota-msg"></span></div>' +
        '<button type="button" class="epc-quota-hide">Hide</button>';
      el.querySelector('.epc-quota-hide').addEventListener('click', () => { hidden = true; paint(); });
      document.body.appendChild(el);
    }
    el.querySelector('.epc-quota-msg').textContent =
      `Totals and reports may be incomplete or fail to load until the limit resets at ${resetText()}, ` +
      `in ${countdown(hit.reset - Date.now())}. Your records are safe. ` +
      `Please wait until then before clicking Generate Report or Refresh. First noticed at ${clock(hit.at)}.`;
    el.hidden = false;
    if (!timer) timer = setInterval(paint, 60000);
  }
  function clear() {
    hit = null;
    try { localStorage.removeItem(KEY); } catch (e) { /* storage off */ }
    if (timer) { clearInterval(timer); timer = null; }
  }

  // Pass any load error here. Returns true (and shows the bar) if it is the quota.
  function report(err) {
    if (!isQuotaError(err)) return false;
    const now = Date.now();
    if (!hit || now >= hit.reset) {
      hit = { at: now, reset: nextReset(now) };
      try { localStorage.setItem(KEY, JSON.stringify(hit)); } catch (e) { /* storage off */ }
    }
    hit.seen = now;
    hidden = false;
    paint();
    return true;
  }
  // A read worked. With `since`, keep the bar if the quota was hit after that time.
  function ok(since) {
    if (!hit || (since && hit.seen >= since)) return;
    clear();
    paint();
  }

  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && saved.reset > Date.now()) hit = { at: saved.at, reset: saved.reset, seen: 0 };
    else if (saved) localStorage.removeItem(KEY);
  } catch (e) { /* storage off */ }
  if (hit) paint();
  // Loads that nobody catches still raise the bar.
  window.addEventListener('unhandledrejection', e => { report(e.reason); });

  return { report, ok, isQuotaError, resetText, nextReset, active: () => !!hit };
})();

// ─── Saved copies of whole collections (shared) ──────────────────────────────
// Reports and the Dashboard need every record of some collections. Reading a
// whole collection on every Generate click is what used up the free daily
// reads. So each browser keeps a saved copy in IndexedDB (`epc-cache`, per
// signed-in user) and EPCSaved.rows(name) only fetches what changed: records
// stamped after the saved copy (1 read each, 1 read when there are none) plus
// a count to catch deleted records (1 read per 1,000 records). The whole
// collection is read again only on the first load on a browser, when the count
// does not match, when the copy is over a week old, or with { force: true }.
//
// Every site write to a collection listed in SOURCES must be stamped, or other
// browsers will not notice the change: wrap the data in epcStamp() (itemCost
// and salesDaily already stamp `lastUpdated`).
function epcStamp(data) {
  return { ...data, changedAt: firebase.firestore.FieldValue.serverTimestamp() };
}
window.EPCSaved = window.EPCSaved || (() => {
  const SOURCES = {
    purchases: {}, expenses: {}, suppliesData: {}, eSalesRecords: {}, productMaster: {},
    // Only the figures the reports use are kept from these two.
    itemCost: { stampField: 'lastUpdated', pick: d => ({ unit_cost: Number(d.unit_cost) || 0 }) },
    salesDayTotals: {
      collection: 'salesDaily', stampField: 'lastUpdated',
      pick: d => ({ revenue: Number((d.totals || {}).revenue) || 0 }),
    },
  };
  const CACHE_DB = 'epc-cache';      // same IndexedDB database as the Sales Pulse
  const CACHE_STORE = 'kv';
  const VERSION = 1;
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // safety net for writes that were not stamped
  const memory = {};     // name -> saved copy, for this page view
  const inFlight = {};   // name -> promise, so two callers share one load

  function cacheStore(mode, action) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(CACHE_DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(CACHE_STORE);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const idb = open.result;
        const tx = idb.transaction(CACHE_STORE, mode);
        const req = action(tx.objectStore(CACHE_STORE));
        tx.oncomplete = () => { idb.close(); resolve(req.result); };
        tx.onerror = tx.onabort = () => { idb.close(); reject(tx.error); };
      };
    });
  }
  // IndexedDB keeps a Firestore Timestamp as a plain object (no toDate()), so
  // mark timestamps on the way in and rebuild them on the way out.
  function encode(value) {
    if (!value || typeof value !== 'object') return value;
    if (typeof value.toDate === 'function' && typeof value.seconds === 'number') return { __ts: [value.seconds, value.nanoseconds || 0] };
    if (Array.isArray(value)) return value.map(encode);
    const out = {};
    Object.keys(value).forEach((k) => { out[k] = encode(value[k]); });
    return out;
  }
  function decode(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(decode);
    if (Array.isArray(value.__ts)) return new firebase.firestore.Timestamp(value.__ts[0], value.__ts[1]);
    const out = {};
    Object.keys(value).forEach((k) => { out[k] = decode(value[k]); });
    return out;
  }
  // saved = { v, uid, at, stamp:{s,n}, docs:{id:data} }. stamp is the newest
  // change stamp seen, kept exactly so the next check asks only for later ones.
  async function readSaved(name, uid) {
    try {
      const saved = await cacheStore('readonly', (store) => store.get(`saved:${name}`));
      if (saved && saved.v === VERSION && saved.uid === uid && saved.stamp && saved.docs) {
        return { ...saved, docs: decode(saved.docs) };
      }
    } catch (e) { /* storage off or blocked */ }
    return null;
  }
  async function writeSaved(name, saved) {
    try {
      await cacheStore('readwrite', (store) => store.put({ ...saved, docs: encode(saved.docs) }, `saved:${name}`));
    } catch (e) { console.warn('[EPCSaved] could not save', name, e); /* storage off: read again next time */ }
  }
  function signedIn() {
    return new Promise((resolve, reject) => {
      const auth = typeof getFirebaseAuth === 'function' ? getFirebaseAuth() : null;
      if (!auth) { reject(new Error('Sign-in is not available.')); return; }
      const off = auth.onAuthStateChanged((user) => { if (user) { off(); resolve(user); } });
    });
  }
  const source = (name) => {
    if (!SOURCES[name]) throw new Error(`EPCSaved: unknown collection "${name}"`);
    return { collection: name, stampField: 'changedAt', pick: (d) => d, ...SOURCES[name] };
  };
  function addDoc(saved, src, doc) {
    const data = doc.data() || {};
    saved.docs[doc.id] = src.pick(data);
    const ts = data[src.stampField];
    if (!ts || typeof ts.seconds !== 'number') return;
    const cur = saved.stamp;
    if (!cur || ts.seconds > cur.s || (ts.seconds === cur.s && ts.nanoseconds > cur.n)) {
      saved.stamp = { s: ts.seconds, n: ts.nanoseconds || 0 };
    }
  }
  async function fetchAll(db, name, uid) {
    const src = source(name);
    const saved = { v: VERSION, uid, at: Date.now(), stamp: null, docs: {} };
    (await db.collection(src.collection).get()).forEach((doc) => addDoc(saved, src, doc));
    // No stamps at all (records from before stamping): start a day back, to allow for a wrong clock on this computer.
    if (!saved.stamp) saved.stamp = { s: Math.floor(saved.at / 1000) - 86400, n: 0 };
    await writeSaved(name, saved);
    if (window.EPCReads) EPCReads.rememberCount(name, Object.keys(saved.docs).length);
    return saved;
  }
  // Bring a saved copy up to date.
  async function sync(db, name, saved) {
    const src = source(name);
    const col = db.collection(src.collection);
    const since = new firebase.firestore.Timestamp(saved.stamp.s, saved.stamp.n);
    const changed = await col.where(src.stampField, '>', since).get();
    changed.forEach((doc) => addDoc(saved, src, doc));
    // Deleted records leave no trace, so compare the number of records.
    // (firestoreCount: this SDK build has no query.count(). null = could not count; check again next time.)
    const counted = await firestoreCount(col, `${name} count`);
    if (counted != null && window.EPCReads) EPCReads.rememberCount(name, counted);
    if (counted != null && counted !== Object.keys(saved.docs).length) return fetchAll(db, name, saved.uid);
    if (!changed.empty) await writeSaved(name, saved);
    return saved;
  }
  async function load(name, force) {
    const db = typeof getFirestoreDB === 'function' ? getFirestoreDB() : null;
    if (!db) throw new Error('The database is not available.');
    const user = await signedIn();
    let saved = null;
    if (!force) {
      saved = memory[name] && memory[name].uid === user.uid ? memory[name] : await readSaved(name, user.uid);
      if (saved && Date.now() - saved.at > MAX_AGE_MS) saved = null;
    }
    saved = saved ? await sync(db, name, saved) : await fetchAll(db, name, user.uid);
    memory[name] = saved;
    // Fresh row objects each time, in document-id order like a plain .get().
    return Object.keys(saved.docs).sort().map((id) => ({ _firestoreId: id, ...saved.docs[id] }));
  }
  // Every record of a collection, as [{ _firestoreId, ...fields }].
  function rows(name, { force = false } = {}) {
    if (!inFlight[name]) {
      inFlight[name] = load(name, force).finally(() => { delete inFlight[name]; });
    }
    return inFlight[name];
  }

  // What is saved on this browser, for the cost estimate: { name: { uid, at, count } }.
  async function meta() {
    const out = {};
    for (const name of Object.keys(SOURCES)) {
      let saved = memory[name];
      if (!saved) {
        try { saved = await cacheStore('readonly', (store) => store.get(`saved:${name}`)); } catch (e) { saved = null; }
      }
      if (saved && saved.v === VERSION && saved.docs) out[name] = { uid: saved.uid, at: saved.at, count: Object.keys(saved.docs).length };
    }
    return out;
  }

  return { rows, meta, SOURCES, _codec: { encode, decode }, _cacheStore: cacheStore };
})();

// ─── Pastel 3D chart style (shared) ──────────────────────────────────────────
// Turns the plain bright colours that page code passes to Chart.js into the
// dashboard's pastel gradients: rounded bars with a soft drop shadow, pastel
// pie/donut slices, softer lines. Colours a page already made as gradients or
// functions are left alone (the dashboard's own charts).
const EPC_PASTELS = {
  teal:  ['#a8e2d4', '#3fae96'],
  lime:  ['#d6efa0', '#8fc23a'],
  blue:  ['#bcd3fb', '#4f7fe8'],
  lav:   ['#c9caf7', '#6f72e0'],
  pink:  ['#f7bcc3', '#e0566b'],
  peach: ['#f9d3a8', '#e08a35'],
  slate: ['#dbe1ea', '#8a99ad'],
};
function epcPastelFor(color) {
  if (typeof color !== 'string') return null;
  let r, g, b;
  const c = color.trim().toLowerCase();
  let m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else if ((m = c.match(/^rgba?\(([^)]+)\)/))) {
    [r, g, b] = m[1].split(',').map(v => parseFloat(v));
  } else return null;
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (sat < 0.18 || l > 0.93) return EPC_PASTELS.slate;
  let hue;
  const R = r / 255, G = g / 255, B = b / 255;
  if (max === R) hue = 60 * (((G - B) / d) % 6);
  else if (max === G) hue = 60 * ((B - R) / d + 2);
  else hue = 60 * ((R - G) / d + 4);
  if (hue < 0) hue += 360;
  if (hue < 15 || hue >= 330) return EPC_PASTELS.pink;
  if (hue < 50) return EPC_PASTELS.peach;
  if (hue < 95) return EPC_PASTELS.lime;
  if (hue < 185) return EPC_PASTELS.teal;
  if (hue < 245) return EPC_PASTELS.blue;
  return EPC_PASTELS.lav;
}
function epcGradientFill(pair, vertical) {
  return (ctx) => {
    const chart = ctx.chart;
    const area = chart && chart.chartArea;
    if (!area) return pair[1];
    const g = vertical
      ? chart.ctx.createLinearGradient(0, area.top, 0, area.bottom)
      : chart.ctx.createLinearGradient(area.left, 0, area.right, 0);
    g.addColorStop(0, pair[0]);
    g.addColorStop(1, pair[1]);
    return g;
  };
}
const EPC_CHART_PASTEL = {
  id: 'epcPastel',
  beforeUpdate(chart) {
    const type = chart.config.type;
    const horizontal = chart.options && chart.options.indexAxis === 'y';
    (chart.data.datasets || []).forEach((ds) => {
      if (ds.__epcPastel) return;
      ds.__epcPastel = true;
      const dsType = ds.type || type;
      const bg = ds.backgroundColor;
      // Chart.js can't use a function inside a colour list, so a list of
      // colours becomes ONE function that picks the right gradient per item.
      const mapColors = (value, vertical) => {
        if (typeof value === 'string') {
          const pair = epcPastelFor(value);
          return pair ? epcGradientFill(pair, vertical) : value;
        }
        if (Array.isArray(value) && value.length && value.every(v => typeof v === 'string')) {
          const fills = value.map((col) => { const p = epcPastelFor(col); return p ? epcGradientFill(p, vertical) : null; });
          if (!fills.some(Boolean)) return value;
          return (ctx) => {
            const i = ctx.dataIndex == null ? 0 : ctx.dataIndex % value.length;
            return fills[i] ? fills[i](ctx) : value[i];
          };
        }
        return value;
      };
      if (dsType === 'bar') {
        ds.backgroundColor = mapColors(bg, !horizontal);
        // Pages often ask for square or barely-rounded bars (0-4px): round them like the dashboard.
        if (ds.borderRadius == null || (typeof ds.borderRadius === 'number' && ds.borderRadius <= 4)) ds.borderRadius = 12;
        if (ds.borderSkipped == null) ds.borderSkipped = false;
        if (ds.borderWidth == null) ds.borderWidth = 0;
        if (ds.maxBarThickness == null) ds.maxBarThickness = 56;
      } else if (dsType === 'doughnut' || dsType === 'pie' || dsType === 'polarArea') {
        ds.backgroundColor = mapColors(bg, true);
        if (ds.borderColor == null) ds.borderColor = '#fff';
        if (ds.borderWidth == null) ds.borderWidth = 3;
        if (ds.borderRadius == null) ds.borderRadius = 8;
        if (ds.hoverOffset == null) ds.hoverOffset = 8;
      } else if (dsType === 'line') {
        const pair = epcPastelFor(ds.borderColor);
        if (pair) {
          ds.borderColor = pair[1];
          if (ds.pointBackgroundColor == null) ds.pointBackgroundColor = '#fff';
          if (ds.pointBorderColor == null) ds.pointBorderColor = pair[1];
          if (typeof bg === 'string' && epcPastelFor(bg)) ds.backgroundColor = pair[0] + '66';
        }
        if (ds.borderWidth == null) ds.borderWidth = 3;
      }
    });
  },
  // Soft shadow under bars and slices: the "3D" lift.
  beforeDatasetsDraw(chart) {
    const t = chart.config.type;
    chart.$epcShadow = (t === 'bar' || t === 'doughnut' || t === 'pie') &&
      !(chart.canvas && chart.canvas.closest && chart.canvas.closest('.dash2'));   // dashboard styles its own
    if (!chart.$epcShadow) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.shadowColor = 'rgba(13,59,53,.18)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 6;
  },
  afterDatasetsDraw(chart) {
    if (!chart.$epcShadow) return;
    chart.ctx.restore();
  },
};

// ─── 3D hover tilt + chart look (shared) ─────────────────────────────────────
// KPI, chart and summary cards lean toward the mouse, like the dashboard.
// Works for cards added later too (event delegation). Off for touch screens
// and "reduce motion".
(function initThemeMotion() {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (!reduce && fine) {
    const SEL = '.kpi-card, .chart-card, .summary-card';
    let current = null;
    const reset = (el) => {
      el.classList.remove('is-tilting');
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
    };
    document.addEventListener('pointermove', (ev) => {
      const el = ev.target && ev.target.closest ? ev.target.closest(SEL) : null;
      if (current && current !== el) { reset(current); current = null; }
      if (!el || el.closest('.dash2')) return;   // the dashboard has its own tilt
      current = el;
      el.classList.add('t-tilt', 'is-tilting');
      const r = el.getBoundingClientRect();
      const x = (ev.clientX - r.left) / r.width;
      const y = (ev.clientY - r.top) / r.height;
      el.style.setProperty('--ry', `${((x - 0.5) * 6).toFixed(2)}deg`);
      el.style.setProperty('--rx', `${((0.5 - y) * 5).toFixed(2)}deg`);
    }, { passive: true });
    document.addEventListener('pointerleave', () => { if (current) { reset(current); current = null; } });
  }
  // Charts: same font, rounded bars and smooth grow-in as the dashboard.
  const applyChartDefaults = () => {
    if (typeof Chart === 'undefined' || Chart.__epcTheme) return;
    Chart.__epcTheme = true;
    Chart.defaults.font.family = "'Figtree', sans-serif";
    Chart.defaults.color = '#5b706b';
    Chart.defaults.borderColor = 'rgba(13,59,53,.07)';
    Chart.defaults.elements.bar.borderRadius = 8;
    Chart.defaults.elements.arc.borderRadius = 6;
    Chart.defaults.elements.line.tension = 0.35;
    Chart.defaults.elements.point.radius = 3;
    if (reduce) Chart.defaults.animation = false;
    else { Chart.defaults.animation.duration = 900; Chart.defaults.animation.easing = 'easeOutQuart'; }
    Chart.defaults.font.size = 13;
    if (Chart.register) Chart.register(EPC_CHART_PASTEL);
    if (Chart.defaults.plugins && Chart.defaults.plugins.tooltip) {
      Object.assign(Chart.defaults.plugins.tooltip, {
        backgroundColor: '#0d3b35', padding: 10, cornerRadius: 12, displayColors: true, boxPadding: 4,
      });
    }
  };
  applyChartDefaults();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyChartDefaults);
})();

// ─── Info tips: description lines become an "i" icon (shared) ────────────────
// Grey description lines under titles are hidden and replaced by a small "i"
// button next to the title; hovering (or tapping/focusing) it shows the text.
// The original element stays in the page (hidden), so page code can keep
// updating its text and the tip always shows the current wording.
(function initInfoTips() {
  // Description lines that sit right after a title: icon goes next to the title.
  const ATTACH = [
    '.section-subtitle', '.chart-subtitle', '.dash-sub', '.dash-caption',
    '.prod-chart-caption', '.esales-summary-subtitle', '#report-subtitle',
    '.info-def',   // a definition: any element with this class becomes an "i" beside the label before it
  ].join(',');
  // Free-standing explanation notes: icon takes the note's place.
  const INLINE = [
    '.tax-liability-note', '.tax-cogs-note', '.tax-input-note',
    '.cf-coverage-note:not(.cf-coverage-none)',
  ].join(',');
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();

  let pop = null;
  function showPop(btn) {
    const text = clean(btn._src && btn._src.textContent);
    if (!text) return;
    if (!pop) {
      pop = document.createElement('div');
      pop.className = 'info-pop';
      pop.setAttribute('role', 'tooltip');
      pop.id = 'epc-info-pop';
      document.body.appendChild(pop);
    }
    pop.textContent = text;
    pop.classList.add('show');
    btn.setAttribute('aria-describedby', pop.id);
    const r = btn.getBoundingClientRect();
    const w = Math.min(300, window.innerWidth - 24);
    pop.style.maxWidth = `${w}px`;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - pw - 12));
    let top = r.top - ph - 10;
    pop.classList.toggle('below', top < 8);
    if (top < 8) top = r.bottom + 10;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }
  function hidePop(btn) {
    if (pop) pop.classList.remove('show');
    if (btn) btn.removeAttribute('aria-describedby');
  }
  function makeBtn(src) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'info-tip';
    b.setAttribute('aria-label', 'More info');
    b.textContent = 'i';
    b._src = src;
    b.addEventListener('pointerenter', () => showPop(b));
    b.addEventListener('pointerleave', () => hidePop(b));
    b.addEventListener('focus', () => showPop(b));
    b.addEventListener('blur', () => hidePop(b));
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showPop(b); });
    return b;
  }
  function attach(src, inline) {
    if (src._tipBtn && src._tipBtn.isConnected) return;
    src.classList.add('info-src');
    const btn = makeBtn(src);
    src._tipBtn = btn;
    const title = inline ? null : src.previousElementSibling;
    if (title && !title.classList.contains('info-src')) {
      // Wrap the title so the icon sits beside it without touching the title's
      // own text (page code often sets title.textContent).
      let wrap = title.parentElement && title.parentElement.classList.contains('info-wrap') ? title.parentElement : null;
      if (!wrap) {
        wrap = document.createElement('span');
        wrap.className = 'info-wrap';
        title.parentNode.insertBefore(wrap, title);
        wrap.appendChild(title);
      }
      wrap.appendChild(btn);
    } else {
      src.parentNode.insertBefore(btn, src);
    }
  }
  function syncAll() {
    document.querySelectorAll('.info-tip').forEach((b) => {
      b.hidden = !(b._src && b._src.isConnected && clean(b._src.textContent));
      if (b._src && !b._src.isConnected) b.remove();
    });
  }
  function scan() {
    document.querySelectorAll(ATTACH).forEach((el) => attach(el, false));
    document.querySelectorAll(INLINE).forEach((el) => attach(el, true));
    syncAll();
  }
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  };
  const start = () => {
    scan();
    new MutationObserver(queue).observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('scroll', () => hidePop(), { passive: true, capture: true });
    document.addEventListener('click', () => hidePop());
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

// ─── AI assistant chat widget (shared) ──────────────────────────────────────
// Floating "Ask the assistant" button + chat panel on every signed-in page.
// Messages go to the chat API on the Hostinger VPS (chat-server/server.js),
// which holds the Anthropic API key on the server; the browser only sends the
// user's Firebase ID token. The conversation is kept for this browser tab only.
// The button stays hidden until EPC_CHAT_URL is set.
const EPC_CHAT_URL = 'https://epc-chat.187-127-124-15.sslip.io/api/chat';   // printed by chat-server/setup-vps.sh

// Report pages share what they already loaded so the assistant can analyse it
// ("Ask about this report"): EPCChatContext.set('Income Statement, Oct 1–31',
// () => ({ ...compact summary... })). Nothing extra is read from Firestore.
window.EPCChatContext = window.EPCChatContext || (() => {
  let current = null;   // { label, build }
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => { try { fn(current); } catch (e) { /* ignore */ } });
  return {
    set(label, build) { current = label && typeof build === 'function' ? { label: String(label), build } : null; notify(); },
    clear() { current = null; notify(); },
    get() { return current; },
    onChange(fn) { listeners.add(fn); },
  };
})();
(function initChatWidget() {
  const STORE_KEY = 'epc_chat_v1';
  const GREETING = 'Hi! I can help you use the portal, or explain accounting and tax topics. What would you like to know?';
  let msgs = [];
  try { msgs = JSON.parse(sessionStorage.getItem(STORE_KEY) || '[]') || []; } catch (e) { msgs = []; }
  const save = () => { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(msgs.slice(-40))); } catch (e) { /* storage off */ } };

  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Tiny, safe markdown: escape first, then **bold**, `code`, "- " lists, paragraphs.
  function render(text) {
    const lines = esc(text).split('\n');
    let html = ''; let inList = false;
    const inline = (l) => l.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    lines.forEach((line) => {
      const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (m) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(m[1])}</li>`; return; }
      if (inList) { html += '</ul>'; inList = false; }
      if (line.trim()) html += `<p>${inline(line.replace(/^#+\s*/, ''))}</p>`;
    });
    if (inList) html += '</ul>';
    return html;
  }

  function pageName() {
    const t = document.querySelector('.section-title') || document.querySelector('.nav-item.active');
    if (t) return t.textContent.trim();
    return document.title.split(' - ')[0].trim();
  }

  function start() {
    if (!EPC_CHAT_URL) return;                                     // chat API not set up yet
    if (!document.getElementById('sidebar-container')) return;   // app pages only (not login)
    if (document.getElementById('epc-chat')) return;

    const root = document.createElement('div');
    root.id = 'epc-chat';
    root.className = 'epc-chat';
    root.innerHTML = `
      <button type="button" class="epc-chat-fab" aria-label="Open the assistant" aria-expanded="false" aria-controls="epc-chat-panel">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12Z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/></svg>
      </button>
      <section class="epc-chat-panel" id="epc-chat-panel" role="dialog" aria-label="Assistant" hidden>
        <header class="epc-chat-head">
          <div>
            <strong>EPC Assistant</strong>
            <span>Answers about the portal, accounting and tax</span>
          </div>
          <div class="epc-chat-head-btns">
            <button type="button" class="epc-chat-icon" data-act="clear" aria-label="Start a new chat" title="New chat">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
            </button>
            <button type="button" class="epc-chat-icon" data-act="size" aria-label="Enlarge the assistant" title="Enlarge" aria-pressed="false">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>
            </button>
            <button type="button" class="epc-chat-icon" data-act="close" aria-label="Close the assistant">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
            </button>
          </div>
        </header>
        <div class="epc-chat-context" hidden>
          <span class="epc-chat-context-label"></span>
          <label class="epc-chat-context-toggle"><input type="checkbox" checked> Use it</label>
        </div>
        <div class="epc-chat-log" aria-live="polite"></div>
        <form class="epc-chat-form">
          <textarea class="epc-chat-input" rows="1" maxlength="4000" placeholder="Ask a question…" aria-label="Your question"></textarea>
          <button type="submit" class="epc-chat-send" aria-label="Send">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </form>
        <p class="epc-chat-note">AI answers can be wrong. Check important figures in the reports.</p>
      </section>`;
    document.body.appendChild(root);

    const fab = root.querySelector('.epc-chat-fab');
    const panel = root.querySelector('.epc-chat-panel');
    const log = root.querySelector('.epc-chat-log');
    const form = root.querySelector('.epc-chat-form');
    const input = root.querySelector('.epc-chat-input');
    const send = root.querySelector('.epc-chat-send');
    const ctxBox = root.querySelector('.epc-chat-context');
    const ctxLabel = root.querySelector('.epc-chat-context-label');
    const ctxUse = root.querySelector('.epc-chat-context-toggle input');
    let busy = false;

    // Show which loaded report (if any) the assistant will analyse.
    function showContext(ctx) {
      ctxBox.hidden = !ctx;
      if (ctx) ctxLabel.textContent = `📊 Using: ${ctx.label}`;
    }
    EPCChatContext.onChange(showContext);
    showContext(EPCChatContext.get());
    // The summary of the report on screen, kept under ~150 KB.
    function contextPayload() {
      const ctx = EPCChatContext.get();
      if (!ctx || !ctxUse.checked) return null;
      try {
        const data = ctx.build();
        let json = JSON.stringify(data);
        if (json.length > 150000) json = json.slice(0, 150000);
        return { label: ctx.label, data: json };
      } catch (e) { return null; }
    }

    function bubble(role, html, extra = '') {
      const div = document.createElement('div');
      div.className = `epc-chat-msg ${role} ${extra}`.trim();
      div.innerHTML = html;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      return div;
    }
    function paint() {
      log.innerHTML = '';
      bubble('assistant', render(GREETING));
      msgs.forEach((m) => bubble(m.role, m.role === 'user' ? `<p>${esc(m.content).replace(/\n/g, '<br>')}</p>` : render(m.content)));
    }
    function open(show) {
      panel.hidden = !show;
      fab.setAttribute('aria-expanded', String(show));
      root.classList.toggle('open', show);
      if (show) { paint(); setTimeout(() => input.focus(), 50); }
    }
    function autosize() {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    }

    async function ask(question) {
      if (busy) return;
      busy = true; send.disabled = true;
      msgs.push({ role: 'user', content: question }); save();
      bubble('user', `<p>${esc(question).replace(/\n/g, '<br>')}</p>`);
      const typing = bubble('assistant', '<span class="epc-chat-dots"><i></i><i></i><i></i></span>', 'typing');
      try {
        const authUser = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
        if (!authUser) throw new Error('Please sign in again to use the assistant.');
        const token = await authUser.getIdToken();
        const resp = await fetch(EPC_CHAT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ messages: msgs.slice(-24), page: pageName(), context: contextPayload() }),
        });
        let data = {};
        try { data = await resp.json(); } catch (e) { /* non-JSON error page */ }
        if (!resp.ok) throw new Error(data.error || (resp.status === 404
          ? 'The assistant is not switched on yet. Please tell the administrator.'
          : 'The assistant could not answer right now. Please try again.'));
        typing.remove();
        msgs.push({ role: 'assistant', content: data.reply }); save();
        bubble('assistant', render(data.reply));
      } catch (err) {
        typing.remove();
        msgs.pop(); save();                        // let them resend the same question
        bubble('assistant', `<p>${esc(err.message || 'Something went wrong. Please try again.')}</p>`, 'error');
        input.value = question; autosize();
      } finally {
        busy = false; send.disabled = false; input.focus();
      }
    }

    // Enlarge / shrink the panel; the choice is remembered on this browser.
    const sizeBtn = root.querySelector('[data-act="size"]');
    function setLarge(large) {
      root.classList.toggle('large', large);
      sizeBtn.setAttribute('aria-pressed', String(large));
      sizeBtn.setAttribute('aria-label', large ? 'Shrink the assistant' : 'Enlarge the assistant');
      sizeBtn.title = large ? 'Shrink' : 'Enlarge';
      try { localStorage.setItem('epc_chat_large', large ? '1' : ''); } catch (e) { /* storage off */ }
      log.scrollTop = log.scrollHeight;
    }
    let startLarge = false;
    try { startLarge = localStorage.getItem('epc_chat_large') === '1'; } catch (e) { /* storage off */ }
    setLarge(startLarge);
    sizeBtn.addEventListener('click', () => setLarge(!root.classList.contains('large')));

    fab.addEventListener('click', () => open(panel.hidden));
    root.querySelector('[data-act="close"]').addEventListener('click', () => { open(false); fab.focus(); });
    root.querySelector('[data-act="clear"]').addEventListener('click', () => { msgs = []; save(); paint(); input.focus(); });
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { open(false); fab.focus(); } });
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q || busy) return;
      input.value = ''; autosize();
      ask(q);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

// ─── Storage Helpers ────────────────────────────────────────────────────────
// Large shared collections live in Firestore. Keep only an in-memory view for
// synchronous rendering; never serialize these datasets into localStorage.
const FIRESTORE_ONLY_KEYS = new Set([
  'productMaster', 'productmaster', 'product_master', 'products',
  'salesData', 'underReviewData', 'importHistory', 'inventoryData',
  'inventory_movements', 'suppliers', 'purchaseSuppliers', 'expenseAccounts', 'eSalesRecords', 'auditLog'
]);
const _runtimeData = Object.create(null);
[
  'productMaster', 'productmaster', 'product_master', 'products',
  'salesData', 'underReviewData', 'importHistory', 'inventoryData',
  'inventory_movements', 'suppliers', 'purchaseSuppliers', 'expenseAccounts', 'eSalesRecords', 'auditLog'
].forEach(key => localStorage.removeItem(key));

const DB = {
  get(key) {
    if (FIRESTORE_ONLY_KEYS.has(key)) return _runtimeData[key] || [];
    try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
  },
  getObj(key, d={}) { try { return JSON.parse(localStorage.getItem(key)) || d;  } catch { return d;  } },
  set(key, val) {
    if (FIRESTORE_ONLY_KEYS.has(key)) {
      _runtimeData[key] = val;
      return;
    }
    localStorage.setItem(key, JSON.stringify(val));
  },
  push(key, item)   { const a = DB.get(key); a.push(item); DB.set(key, a); return a; },
  update(key, id, upd) {
    const a = DB.get(key);
    const i = a.findIndex(x => x.id === id);
    if (i !== -1) a[i] = { ...a[i], ...upd };
    DB.set(key, a);
    return a;
  },
  remove(key, id) {
    const a = DB.get(key).filter(x => x.id !== id);
    DB.set(key, a);
    return a;
  }
};

// ─── Firebase / Product Master bridge ──────────────────────────────────────
// Product Master keeps an in-memory cache because existing pages use
// synchronous reads while rendering. Firestore is the shared source of truth.
const EPC_FIREBASE_CONFIG = {
  apiKey:            'AIzaSyBLS0j1JHbErA-FuhDJHyDbnrS6QGKeTzA',
  authDomain:        'inventory-system-1fb4d.firebaseapp.com',
  projectId:         'inventory-system-1fb4d',
  storageBucket:     'inventory-system-1fb4d.firebasestorage.app',
  messagingSenderId: '662813830984',
  appId:             '1:662813830984:web:20d397824ca57f6bbf0d7d',
  measurementId:     'G-BDXKE5EC0F'
};
const EPC_FIRESTORE_EMULATOR_HOST = 'localhost';
const EPC_FIRESTORE_EMULATOR_PORT = 8080;
let _firestoreEmulatorConnected = false;
let _firestoreConnectionLogged = false;
let _firestoreSettingsApplied = false;
let _firestoreReadSuccessLogged = false;

function isLocalhostRuntime() {
  if (typeof window === 'undefined') return false;
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname);
}

function isFirestoreEmulatorActive() {
  return _firestoreEmulatorConnected && isLocalhostRuntime();
}

function connectFirestoreEmulatorIfLocal(db) {
  if (!db) return;
  const currentUrl = typeof window !== 'undefined' ? window.location.href : '';
  const currentHostname = typeof window !== 'undefined' ? window.location.hostname : '';
  if (!isLocalhostRuntime()) {
    if (!_firestoreConnectionLogged) {
      console.log('Firestore URL:', currentUrl);
      console.log('Firestore hostname:', currentHostname || '(empty)');
      console.log('Firestore emulator active:', false);
      _firestoreConnectionLogged = true;
    }
    return;
  }
  if (_firestoreEmulatorConnected) return;
  if (typeof db.useEmulator === 'function') {
    db.useEmulator(EPC_FIRESTORE_EMULATOR_HOST, EPC_FIRESTORE_EMULATOR_PORT);
    _firestoreEmulatorConnected = true;
    console.log('Firestore URL:', currentUrl);
    console.log('Firestore hostname:', currentHostname);
    console.log('Firestore emulator active:', true);
    console.log("✅ CONNECTED TO FIRESTORE EMULATOR");
    _firestoreConnectionLogged = true;
  }
}

function configureFirestoreDB(db) {
  if (!db) return null;
  if (!_firestoreSettingsApplied && typeof db.settings === 'function') {
    db.settings({ experimentalAutoDetectLongPolling: true, merge: true });
    _firestoreSettingsApplied = true;
  }
  connectFirestoreEmulatorIfLocal(db);
  return db;
}

function logFirestoreReadSuccess(label = 'read') {
  if (_firestoreReadSuccessLogged || isFirestoreEmulatorActive()) return;
  console.log(`[Firestore] production ${label} succeeded`);
  _firestoreReadSuccessLogged = true;
}

function logFirestoreReadFailure(err) {
  console.error('[Firestore] reads failing — client offline / channel blocked', err);
}

function showDatabaseConnectionBanner(message) {
  if (typeof document === 'undefined') return;
  const text = message || "Can't reach the database — connection blocked. Try Chrome or disable tracking prevention for this site.";
  const existing = document.getElementById('firestore-offline-banner');
  if (existing) {
    const label = existing.querySelector('[data-firestore-banner-message]');
    if (label) label.textContent = text;
    return;
  }

  const banner = document.createElement('div');
  banner.id = 'firestore-offline-banner';
  banner.className = 'alert alert-danger';
  banner.style.cssText = 'display:flex;align-items:center;gap:12px;justify-content:space-between;margin:0 0 16px 0;flex-wrap:wrap';
  banner.innerHTML = `
    <span data-firestore-banner-message>${text}</span>
    <button type="button" class="btn btn-outline-gray btn-sm" id="firestore-offline-retry">Retry</button>
  `;
  banner.querySelector('#firestore-offline-retry').addEventListener('click', () => location.reload());

  const target = document.querySelector('.page-body') || document.querySelector('.main-content') || document.body;
  if (target.firstChild) target.insertBefore(banner, target.firstChild);
  else target.appendChild(banner);
}

function firestoreIndexUrlFromError(err) {
  const msg = String(err?.message || err || '');
  const match = msg.match(/https:\/\/console\.firebase\.google\.com[^\s)]+/);
  return match ? match[0] : '';
}

function clampRecordsLoadLimit(inputId, { syncInput = true } = {}) {
  const input = typeof document !== 'undefined' ? document.getElementById(inputId) : null;
  const raw = input ? Number(input.value) : 200;
  const parsed = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 200;
  const clamped = Math.min(1000, Math.max(50, parsed));
  if (input && syncInput) input.value = String(clamped);
  return clamped;
}

function reportFirestoreAggregateError(err, label = 'aggregate query') {
  console.error(`[Firestore] ${label} real aggregate error:`, err);
  if (EPCQuota.report(err)) return;
  const indexUrl = firestoreIndexUrlFromError(err);
  if (indexUrl) {
    console.error(`[Firestore] ${label} needs an index: ${indexUrl}`, err);
    alert(`Firestore needs an index for this ${label}. Open this link to create it:\n\n${indexUrl}`);
    return;
  }
  console.error(`[Firestore] ${label} failed:`, err);
}

// Build a Firestore REST runAggregationQuery request from a compat query.
// The compat query's ._delegate._query is a __PRIVATE_QueryImpl with:
//   .path          — ResourcePath (segments array, .get(i) or ._segments)
//   .filters       — array of FieldFilter with .field.canonicalString(), .op, .value
//   .explicitOrderBy — array with .field.canonicalString(), .dir
//   .collectionGroup — non-null for collectionGroup queries
//
// We serialize this to structuredQuery JSON that runAggregationQuery accepts.
function _compatQueryToStructured(q) {
  const inner = (q._delegate ?? q)._query;  // __PRIVATE_QueryImpl

  // Collection path: inner.path is a ResourcePath; get its segments.
  const segs = inner.path._segments ?? inner.path.segments ?? [];
  // The parent is everything up to the last segment; collectionId is the last.
  const colId = inner.collectionGroup ?? segs[segs.length - 1] ?? '';
  // Parent resource name up to (but not including) the collection segment.
  const parentSegs = inner.collectionGroup ? segs : segs.slice(0, -1);
  // parentPath is the document path part after databases/(default)/documents
  const parentPath = parentSegs.join('/');

  const structured = {};
  structured.from = [{ collectionId: colId, allDescendants: !!inner.collectionGroup }];

  if (inner.filters && inner.filters.length) {
    const filters = inner.filters.map(f => {
      const field = f.field.canonicalString();
      // Map SDK op enum strings to REST op strings
      const opMap = { '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL', '>': 'GREATER_THAN',
                      '>=': 'GREATER_THAN_OR_EQUAL', '==': 'EQUAL', '!=': 'NOT_EQUAL',
                      'array-contains': 'ARRAY_CONTAINS', 'in': 'IN',
                      'not-in': 'NOT_IN', 'array-contains-any': 'ARRAY_CONTAINS_ANY' };
      const op = opMap[f.op] ?? f.op;
      return { fieldFilter: { field: { fieldPath: field }, op, value: f.value } };
    });
    structured.where = filters.length === 1
      ? filters[0]
      : { compositeFilter: { op: 'AND', filters } };
  }

  if (inner.explicitOrderBy && inner.explicitOrderBy.length) {
    structured.orderBy = inner.explicitOrderBy.map(o => ({
      field: { fieldPath: o.field.canonicalString() },
      direction: o.dir === 'desc' ? 'DESCENDING' : 'ASCENDING'
    }));
  }

  return { structured, parentPath };
}

async function _runAggregationRest(query, aggregations, label) {
  const user = firebase.auth().currentUser;
  const token = user ? (await user.getIdToken()) : null;
  const projectId = EPC_FIREBASE_CONFIG.projectId;

  const { structured, parentPath } = _compatQueryToStructured(query);
  const parent = `projects/${projectId}/databases/(default)/documents` +
                 (parentPath ? `/${parentPath}` : '');

  const body = JSON.stringify({
    structuredAggregationQuery: {
      structuredQuery: structured,
      aggregations
    }
  });

  // Support emulator (also catch the case where the flag isn't set yet but we're on localhost)
  const useEmulator = _firestoreEmulatorConnected || isLocalhostRuntime();
  const baseUrl = useEmulator
    ? `http://${EPC_FIRESTORE_EMULATOR_HOST}:${EPC_FIRESTORE_EMULATOR_PORT}/v1/${parent}:runAggregationQuery`
    : `https://firestore.googleapis.com/v1/${parent}:runAggregationQuery`;

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // Emulator also accepts x-goog-request-params for project but doesn't require auth
  const res = await fetch(baseUrl, { method: 'POST', headers, body });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`[Firestore REST] ${label} HTTP ${res.status}: ${txt}`);
  }
  EPCQuota.ok();
  const rows = await res.json();
  if (window.EPCReads) {
    const first = Array.isArray(rows) ? rows[0] : null;
    const c = first && first.result && first.result.aggregateFields && first.result.aggregateFields.c;
    const counted = c ? Number(c.integerValue ?? c.doubleValue) : 0;
    EPCReads.spent(Math.max(1, Math.ceil((counted || 0) / 1000)), `${label || 'aggregate'}`);
  }
  return rows;
}

async function firestoreCount(query, label = 'count') {
  if (!query) return null;
  try {
    const rows = await _runAggregationRest(query, [{ alias: 'c', count: {} }], label);
    const val = rows[0]?.result?.aggregateFields?.c?.integerValue
             ?? rows[0]?.result?.aggregateFields?.c?.doubleValue;
    return val != null ? Number(val) : null;
  } catch (err) {
    reportFirestoreAggregateError(err, label);
    return null;
  }
}

async function firestoreSum(query, field, label = 'sum') {
  if (!query) return null;
  try {
    const rows = await _runAggregationRest(
      query,
      [{ alias: 's', sum: { field: { fieldPath: field } } }],
      label
    );
    const val = rows[0]?.result?.aggregateFields?.s?.integerValue
             ?? rows[0]?.result?.aggregateFields?.s?.doubleValue;
    return val != null ? Number(val) : null;
  } catch (err) {
    reportFirestoreAggregateError(err, label);
    return null;
  }
}

// Initialize immediately so any page script can call firebase.auth() /
// firebase.firestore() directly without going through the lazy helpers first.
if (typeof firebase !== 'undefined' && !firebase.apps.length) {
  firebase.initializeApp(EPC_FIREBASE_CONFIG);
}
if (typeof firebase !== 'undefined' && typeof firebase.firestore === 'function') {
  configureFirestoreDB(firebase.firestore());
}
// Count every Firestore read this browser makes (EPCReads, assets/reads.js):
// the SDK's Query / DocumentReference / AggregateQuery .get() are wrapped once.
if (typeof firebase !== 'undefined' && window.EPCReads) EPCReads.watchFirestore(firebase);
let _productMasterWriteQueue = Promise.resolve();

function getFirestoreDB() {
  if (typeof firebase === 'undefined') return null;
  if (!firebase.apps.length) firebase.initializeApp(EPC_FIREBASE_CONFIG);
  if (typeof firebase.firestore !== 'function') return null;
  return configureFirestoreDB(firebase.firestore());
}

function cacheProductMasterRows(rows) {
  DB.set('productMaster', rows);
}

function getCachedProductMasterRows() {
  return DB.get('productMaster');
}

function normalizeCostHistoryEntry(entry) {
  const unitCost = Number(entry?.unitCost) || 0;
  if (unitCost <= 0) return null;
  return {
    date: String(entry?.date || todayISO()).slice(0, 10),
    unitCost,
    supplier: String(entry?.supplier || '').trim()
  };
}

function normalizeProductCostData(product) {
  const normalized = { ...product };
  let history = Array.isArray(product.costHistory)
    ? product.costHistory.map(normalizeCostHistoryEntry).filter(Boolean)
    : [];
  if (!history.length) {
    const legacyCost = Number(product.latestCost ?? product.unitCost ?? product.cost) || 0;
    if (legacyCost > 0) {
      history = [{
        date: String(product.latestDate || product.updatedAt || todayISO()).slice(0, 10),
        unitCost: legacyCost,
        supplier: String(product.supplier || '').trim()
      }];
    }
  }
  history.sort((a, b) => a.date.localeCompare(b.date));
  const latest = history[history.length - 1];
  const averageCost = history.length
    ? history.reduce((sum, entry) => sum + entry.unitCost, 0) / history.length
    : 0;
  normalized.costHistory = history;
  normalized.latestCost = latest?.unitCost || 0;
  normalized.latestDate = latest?.date || '';
  normalized.averageCost = averageCost;
  normalized.unitCost = normalized.latestCost;
  normalized.cost = normalized.latestCost;
  return normalized;
}

function cleanFirestoreProduct(row) {
  const clean = normalizeProductCostData(row);
  delete clean._firestoreId;
  return clean;
}

function productMasterFirestoreDocId(row) {
  return String(row.itemCode || row.code || '').trim();
}

async function replaceProductMasterInFirestore(rows) {
  const db = getFirestoreDB();
  if (!db) return;
  const snap = await db.collection('productMaster').get();
  const BATCH_SIZE = 499;

  for (let i = 0; i < snap.docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    let pendingWrites = 0;
    snap.docs.slice(i, i + BATCH_SIZE).forEach(doc => {
      batch.delete(doc.ref);
      pendingWrites += 1;
    });
    if (pendingWrites > 0) await batch.commit();
  }
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = db.batch();
    let pendingWrites = 0;
    rows.slice(i, i + BATCH_SIZE).forEach(row => {
      const docId = productMasterFirestoreDocId(row);
      if (docId) {
        batch.set(db.collection('productMaster').doc(docId), epcStamp(cleanFirestoreProduct(row)));
        pendingWrites += 1;
      }
    });
    if (pendingWrites > 0) await batch.commit();
  }
}

function syncProductMasterToFirestore(rows) {
  const snapshot = rows.map(row => ({ ...row }));
  _productMasterWriteQueue = _productMasterWriteQueue
    .catch(() => {})
    .then(() => replaceProductMasterInFirestore(snapshot))
    .catch(err => console.error('[Product Master] Firestore sync failed:', err));
  return _productMasterWriteQueue;
}

async function loadProductMasterFromFirestore(orderByField = '', seedIfEmpty = true) {
  const db = getFirestoreDB();
  if (!db) return getCachedProductMasterRows();
  let query = db.collection('productMaster');
  if (orderByField) query = query.orderBy(orderByField);
  const snap = await query.get();
  if (snap.empty) {
    cacheProductMasterRows([]);
    return [];
  }
  const rows = snap.docs.map(doc => normalizeProductCostData({ _firestoreId: doc.id, ...doc.data() }));
  cacheProductMasterRows(rows);
  return rows;
}

async function upsertProductMasterRowsInFirestore(rows, onProgress, options = {}) {
  const db = getFirestoreDB();
  const normalizedRows = rows.map(row => Object.assign(row, normalizeProductCostData(row)));
  if (!normalizedRows.length) return normalizedRows;
  const BATCH_SIZE = options.batchSize || 499;
  const commitBatch = options.commitBatch || ((batch) => batch.commit());
  const delay = options.delay || (() => Promise.resolve());
  if (db) {
    let written = 0;
    const legacyDocIds = new Set();
    for (let i = 0; i < normalizedRows.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = normalizedRows.slice(i, i + BATCH_SIZE);
      let pendingWrites = 0;
      chunk.forEach(row => {
        const docId = productMasterFirestoreDocId(row);
        if (!docId) return;
        if (row._firestoreId && row._firestoreId !== docId) legacyDocIds.add(row._firestoreId);
        const ref = db.collection('productMaster').doc(docId);
        row._firestoreId = ref.id;
        batch.set(ref, epcStamp(cleanFirestoreProduct(row)), { merge: true });
        pendingWrites += 1;
      });
      if (pendingWrites > 0) {
        await commitBatch(batch, Math.min(i + BATCH_SIZE, normalizedRows.length));
        await delay();
      }
      written += chunk.length;
      if (onProgress) onProgress(written, normalizedRows.length);
    }
    const staleIds = [...legacyDocIds];
    for (let i = 0; i < staleIds.length; i += BATCH_SIZE) {
      const batch = db.batch();
      let pendingWrites = 0;
      staleIds.slice(i, i + BATCH_SIZE).forEach(id => {
        batch.delete(db.collection('productMaster').doc(id));
        pendingWrites += 1;
      });
      if (pendingWrites > 0) {
        await commitBatch(batch, normalizedRows.length);
        await delay();
      }
    }
  }
  const cachedRows = getCachedProductMasterRows();
  const byCode = new Map(cachedRows.map(row => [String(row.itemCode || row.code || '').trim().toLowerCase(), row]));
  normalizedRows.forEach(row => byCode.set(String(row.itemCode || row.code || '').trim().toLowerCase(), row));
  cacheProductMasterRows([...byCode.values()]);
  return normalizedRows;
}

async function loadSuppliersFromFirestore() {
  const db = getFirestoreDB();
  if (!db) return DB.get('suppliers');
  const snap = await db.collection('suppliers').get();
  const rows = snap.docs.map(doc => ({ _firestoreId: doc.id, ...doc.data() }));
  DB.set('suppliers', rows);
  return rows;
}

async function loadInventoryFromFirestore() {
  const db = getFirestoreDB();
  if (!db) return DB.get('inventory_movements');
  const snap = await db.collection('inventoryData').get();
  const rows = snap.docs.map(doc => ({ _firestoreId: doc.id, ...doc.data() }));
  DB.set('inventory_movements', rows);
  return rows;
}

// Purchases live in the Firestore 'purchases' collection. On first run against
// an empty collection, any existing local purchases are migrated up so nothing
// is lost. The local cache stays only for synchronous rendering.
async function loadPurchasesFromFirestore() {
  const localRows = DB.get('purchases');
  const db = getFirestoreDB();
  if (!db) return localRows;
  const snap = await db.collection('purchases').get();
  const firestoreRows = snap.docs.map(doc => ({ _firestoreId: doc.id, ...doc.data() }));
  if (firestoreRows.length) {
    DB.set('purchases', firestoreRows);
    return firestoreRows;
  }
  for (const row of localRows) {
    const docId = row.id || genId();
    row.id = docId;
    const clean = { ...row };
    delete clean._firestoreId;
    await db.collection('purchases').doc(docId).set(epcStamp(clean), { merge: true });
    row._firestoreId = docId;
  }
  if (localRows.length) DB.set('purchases', localRows);
  return localRows;
}

// ─── Utilities ──────────────────────────────────────────────────────────────
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

function formatPeso(n) {
  const num = parseFloat(n) || 0;
  return '₱' + num.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatNum(n) {
  const num = parseFloat(n) || 0;
  return num.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function parsePeso(s) {
  if (typeof s === 'number') return s;
  return parseFloat(String(s).replace(/[₱,\s]/g, '')) || 0;
}
function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-PH', { year:'numeric', month:'short', day:'numeric' });
}
function todayISO() { return new Date().toISOString().slice(0,10); }

function pct(num, den) {
  if (!den) return '0.0%';
  return ((num / den) * 100).toFixed(1) + '%';
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvDate(value) {
  if (!value) return '';
  const iso = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return `${String(parsed.getMonth() + 1).padStart(2, '0')}/${String(parsed.getDate()).padStart(2, '0')}/${parsed.getFullYear()}`;
}

function exportRowsToCSV(filename, columns, rows) {
  const header = columns.map(col => csvCell(col.label)).join(',');
  const body = rows.map(row => columns.map(col => {
    const value = typeof col.value === 'function' ? col.value(row) : row[col.value || col.key];
    return csvCell(value);
  }).join(','));
  const blob = new Blob([[header, ...body].join('\n')], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return rows.length;
}

// ─── Word (.doc) export helpers ───────────────────────────────────────────────
// Generates an HTML-based .doc that Microsoft Word opens natively (no library).
function wordEsc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A table cell's text for exports, without the "i" info buttons.
function exportCellText(cell) {
  const tips = [...cell.querySelectorAll('.info-tip')];
  tips.forEach(tip => { tip.style.display = 'none'; });
  const text = cell.innerText.replace(/\s+/g, ' ').trim();
  tips.forEach(tip => { tip.style.display = ''; });
  return text;
}

// Serialize a rendered <table> to clean HTML, dropping filter/input rows.
function serializeTableToWord(table) {
  if (!table) return '';
  const trs = [...table.rows].filter(tr => !tr.querySelector('input, select'));
  const body = trs.map(tr => `<tr>${[...tr.cells].map(cell => {
    const tag = cell.tagName.toLowerCase() === 'th' ? 'th' : 'td';
    return `<${tag}>${wordEsc(exportCellText(cell))}</${tag}>`;
  }).join('')}</tr>`).join('');
  return `<table border="1" cellspacing="0" cellpadding="4">${body}</table>`;
}

// Serialize a table for Excel, forcing every cell to TEXT so long numeric codes
// (e.g. 4800361410816) aren't mangled into scientific notation (4.8E+12).
function serializeTableToExcel(table) {
  if (!table) return '';
  const trs = [...table.rows].filter(tr => !tr.querySelector('input, select'));
  const body = trs.map(tr => `<tr>${[...tr.cells].map(cell => {
    const tag = cell.tagName.toLowerCase() === 'th' ? 'th' : 'td';
    return `<${tag} style="mso-number-format:'\\@'">${wordEsc(exportCellText(cell))}</${tag}>`;
  }).join('')}</tr>`).join('');
  return `<table>${body}</table>`;
}

// ─── PDF export (in-page print-to-PDF, no library, no popup window) ────────────
// Renders the report into a hidden #report-print-area on the CURRENT page and
// calls window.print(); a print stylesheet hides everything else, so only the
// native print dialog appears (user picks "Save as PDF"). Graphs fit the page.
function ensurePrintArea() {
  let area = document.getElementById('report-print-area');
  if (area) return area;
  area = document.createElement('div');
  area.id = 'report-print-area';
  document.body.appendChild(area);
  const style = document.createElement('style');
  style.textContent = `
    #report-print-area { display:none; }
    #report-print-area h1 { font-size:20px; margin:0 0 4px; }
    #report-print-area p.meta { color:#64748b; font-size:12px; margin:0 0 12px; }
    #report-print-area img { max-width:100%; height:auto; display:block; margin:12px 0; }
    #report-print-area table { border-collapse:collapse; width:100%; margin:12px 0; font-size:0.75rem; }
    #report-print-area th, #report-print-area td { border:1px solid #999; padding:4px 6px; text-align:left; }
    #report-print-area th { background:#f1f5f9; }
    @media print {
      @page { size:A4; margin:14mm; }
      body > *:not(#report-print-area) { display:none !important; }
      #report-print-area { display:block !important; }
      #report-print-area table { page-break-inside:auto; }
      #report-print-area tr { page-break-inside:avoid; }
      #report-print-area thead { display:table-header-group; }
    }`;
  document.head.appendChild(style);
  return area;
}

function printReportPDF(title, bodyHtml) {
  const area = ensurePrintArea();
  area.innerHTML = `${bodyHtml}<p class="meta">Generated ${new Date().toLocaleString('en-PH')} — EPC Commercial Corporation</p>`;
  const prevTitle = document.title;   // the saved-PDF filename defaults to the title
  document.title = title;
  window.print();
  document.title = prevTitle;
}

// ─── Excel export (HTML-based .xls, no library) ───────────────────────────────
function downloadExcel(title, bodyHtml) {
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${wordEsc(String(title).slice(0, 31))}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>table{border-collapse:collapse} th,td{border:1px solid #999;padding:4px 8px} th{background:#f1f5f9;font-weight:bold}</style>
</head><body>${bodyHtml}</body></html>`;
  const blob = new Blob(['﻿', html], { type:'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${String(title).replace(/[^\w]+/g, '-').toLowerCase().replace(/^-|-$/g, '')}-${todayISO()}.xls`;
  link.click();
  URL.revokeObjectURL(url);
}

// ─── Number input auto-format ────────────────────────────────────────────────
function initNumberFormatting(container) {
  const root = container || document;
  root.querySelectorAll('input[data-currency]').forEach(el => {
    el.addEventListener('blur', function() {
      const v = parsePeso(this.value);
      if (this.value !== '') this.value = formatNum(v);
    });
    el.addEventListener('focus', function() {
      const v = parsePeso(this.value);
      this.value = v || '';
    });
  });
}

// ─── Confirmation Dialog ────────────────────────────────────────────────────
function confirmDelete(msg, cb) {
  const el = document.createElement('div');
  el.className = 'confirm-dialog';
  el.innerHTML = `<div class="confirm-card">
    <h3>Confirm Delete</h3>
    <p>${msg || 'This action cannot be undone.'}</p>
    <div class="confirm-buttons">
      <button class="btn btn-outline-gray btn-sm" id="_cc">Cancel</button>
      <button class="btn btn-danger btn-sm" id="_co">Delete</button>
    </div></div>`;
  document.body.appendChild(el);
  el.querySelector('#_cc').onclick = () => el.remove();
  el.querySelector('#_co').onclick = () => { el.remove(); cb(); };
  el.addEventListener('click', e => { if (e.target === el) el.remove(); });
}

// ─── Modal Helpers ──────────────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.add('open'); el.querySelector('.modal-card')?.scrollTo(0,0); }
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}
function initModals() {
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('open'); });
  });
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', function() {
      const m = this.closest('.modal-overlay');
      if (m) m.classList.remove('open');
    });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const open = document.querySelector('.modal-overlay.open');
      if (open) open.classList.remove('open');
    }
  });
}

// ─── Category Dropdown ──────────────────────────────────────────────────────
// ─── Shared custom categories (Firestore-backed so every computer sees them) ──
// Custom categories added via the "+ Add Category" dialog are stored in the
// Firestore `categories` collection, one doc per storageKey (exp/inv/prod/sup)
// holding a `names` array. localStorage keeps a synchronous mirror under
// `<storageKey>_cats` because the dropdowns render synchronously.
function categoriesFirestoreDocId(storageKey) {
  return String(storageKey || '').trim() || 'default';
}

// Load a page's custom categories from Firestore into the localStorage mirror.
// Call this before initializing category dropdowns so newly-synced categories
// added on other computers appear here too. Safe to await; falls back to the
// local mirror when Firestore is unavailable.
async function loadCategoriesFromFirestore(storageKey) {
  const db = getFirestoreDB();
  if (!db) return DB.get(storageKey + '_cats');
  try {
    const snap = await db.collection('categories').doc(categoriesFirestoreDocId(storageKey)).get();
    const names = (snap.exists && Array.isArray(snap.data().names)) ? snap.data().names : [];
    DB.set(storageKey + '_cats', names);
    return names;
  } catch (err) {
    console.warn('[categories] load failed for', storageKey, err);
    return DB.get(storageKey + '_cats');
  }
}

// Persist a newly-added custom category to Firestore (merged into the names
// array) and the localStorage mirror. Returns the updated list.
async function addSharedCategory(storageKey, name) {
  const clean = String(name || '').trim();
  const cats = DB.get(storageKey + '_cats');
  if (clean && !cats.includes(clean)) { cats.push(clean); DB.set(storageKey + '_cats', cats); }
  const db = getFirestoreDB();
  if (db && clean) {
    try {
      await db.collection('categories').doc(categoriesFirestoreDocId(storageKey))
        .set({ names: cats }, { merge: true });
    } catch (err) {
      console.warn('[categories] save failed for', storageKey, err);
    }
  }
  return cats;
}

function refreshCatDropdown(sel, storageKey, defaults, selected) {
  const extras = DB.get(storageKey + '_cats');
  const all = [...defaults, ...extras.filter(e => !defaults.includes(e))];
  const cur = selected !== undefined ? selected : sel.value;
  // The user-facing term ("Category" or, for Expenses, "Account") is set via
  // initCatDropdown opts.term and stashed on the <select>. Data is unchanged.
  const term = sel._catTerm || 'Category';
  sel.innerHTML = `<option value="">Select ${term.toLowerCase()}...</option>` +
    all.map(c => `<option value="${c}"${c===cur?' selected':''}>${c}</option>`).join('') +
    `<option value="__add">+ Add ${term}</option>`;
}
function initCatDropdown(sel, storageKey, defaults, opts = {}) {
  if (!sel) return;
  sel._catTerm = opts.term || 'Category';
  refreshCatDropdown(sel, storageKey, defaults);
  // Pull categories added on other computers, then re-render (preserving the
  // current selection). Non-blocking so the dropdown is usable immediately.
  loadCategoriesFromFirestore(storageKey)
    .then(() => refreshCatDropdown(sel, storageKey, defaults, sel.value))
    .catch(() => {});
  sel.addEventListener('focus', function() { this._prev = this.value; });
  sel.addEventListener('change', function() {
    if (this.value === '__add') showAddCatModal(this, storageKey, defaults);
  });
}
function showAddCatModal(sel, storageKey, defaults) {
  const term = sel._catTerm || 'Category';
  const el = document.createElement('div');
  el.className = 'mini-modal';
  el.innerHTML = `<div class="mini-modal-card">
    <h3>Add New ${term}</h3>
    <div class="form-group">
      <label class="form-label">${term} Name</label>
      <input type="text" class="form-input" id="_catinput" placeholder="e.g. Beverages">
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
      <button class="btn btn-outline-gray btn-sm" id="_catcancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="_catsave">Add</button>
    </div></div>`;
  document.body.appendChild(el);
  const inp = el.querySelector('#_catinput');
  inp.focus();
  el.querySelector('#_catcancel').onclick = () => { sel.value = sel._prev||''; el.remove(); };
  el.querySelector('#_catsave').onclick = async () => {
    const name = inp.value.trim();
    if (!name) { inp.focus(); return; }
    const saveBtn = el.querySelector('#_catsave');
    saveBtn.disabled = true;
    await addSharedCategory(storageKey, name);
    refreshCatDropdown(sel, storageKey, defaults, name);
    el.remove();
  };
  el.addEventListener('click', e => { if (e.target===el) { sel.value = sel._prev||''; el.remove(); } });
  inp.addEventListener('keydown', e => {
    if (e.key==='Enter') el.querySelector('#_catsave').click();
    if (e.key==='Escape') el.querySelector('#_catcancel').click();
  });
}

// ─── Supplier Dropdown ──────────────────────────────────────────────────────
function populateSupplierDropdown(sel, allowNew=true) {
  if (!sel) return;
  const suppliers = DB.get('suppliers');
  sel.innerHTML = '<option value="">Select supplier...</option>' +
    suppliers.map(s => `<option value="${s.name}">${s.name}</option>`).join('') +
    (allowNew ? '<option value="__new">+ Add New Supplier</option>' : '');
}

function supplierPickerEsc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// storeKey is BOTH the localStorage DB key and the Firestore collection name.
// Default 'suppliers' = the shared Suppliers page list. Purchases passes
// 'purchaseSuppliers' so it keeps its own separate list, untouched by (and not
// touching) the Suppliers page.
async function ensureSharedSupplier(name, storeKey = 'suppliers') {
  const cleanName = String(name || '').trim();
  if (!cleanName) return null;
  const key = cleanName.toLowerCase();
  const existing = DB.get(storeKey)
    .find(supplier => String(supplier.name || '').trim().toLowerCase() === key);
  if (existing) return existing;

  const supplier = { id:genId(), name:cleanName, category:'', status:'Active' };
  const db = getFirestoreDB();
  if (db) await db.collection(storeKey).doc(supplier.id).set(supplier, { merge:true });
  DB.push(storeKey, supplier);
  logAudit('Create', storeKey === 'suppliers' ? 'Supplier' : 'Purchase Supplier', `Added supplier ${cleanName}`);
  return supplier;
}

// Load a supplier list (default the shared 'suppliers' collection) from Firestore
// into its localStorage mirror. Pass 'purchaseSuppliers' for the Purchases list.
async function loadSupplierListFromFirestore(storeKey = 'suppliers') {
  const db = getFirestoreDB();
  if (!db) return DB.get(storeKey);
  try {
    const snap = await db.collection(storeKey).get();
    const rows = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    DB.set(storeKey, rows);
    return rows;
  } catch (err) {
    console.warn('[Suppliers] load failed for', storeKey, err);
    return DB.get(storeKey);
  }
}

// opts.storeKey (default 'suppliers'): which list this picker reads from and adds
// to. Purchases passes { storeKey: 'purchaseSuppliers' } for its separate list.
function initSupplierPicker(valueId, searchId, resultsId, opts = {}) {
  const storeKey = opts.storeKey || 'suppliers';
  const valueEl = document.getElementById(valueId);
  const searchEl = document.getElementById(searchId);
  const resultsEl = document.getElementById(resultsId);
  if (!valueEl || !searchEl || !resultsEl || searchEl._supplierPickerReady) return;
  searchEl._supplierPickerReady = true;

  function setValue(value = '') {
    valueEl.value = value;
    searchEl.value = value;
    resultsEl.innerHTML = '';
    const emptyMessage = document.getElementById(`${valueId}-empty`);
    if (emptyMessage) emptyMessage.style.display = DB.get(storeKey).length ? 'none' : '';
  }

  function render() {
    const typed = searchEl.value.trim();
    const query = typed.toLowerCase();
    const matches = DB.get(storeKey)
      .filter(supplier => String(supplier.name || '').toLowerCase().includes(query))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
      .slice(0, 8);
    const hasExact = matches.some(supplier => String(supplier.name || '').toLowerCase() === query);
    resultsEl.innerHTML = matches.map(supplier => {
      const encoded = encodeURIComponent(supplier.name);
      const pick = `<button type="button" data-supplier="${encoded}">${supplierPickerEsc(supplier.name)}</button>`;
      // opts.onEdit opts this picker into an inline "Edit" action per supplier.
      if (!opts.onEdit) return pick;
      return `<div class="supplier-picker-row">${pick}` +
        `<button type="button" class="supplier-picker-edit" data-edit-supplier="${encoded}" ` +
        `title="Edit ${supplierPickerEsc(supplier.name)}">Edit</button></div>`;
    }).join('') + (typed && !hasExact
      ? `<button type="button" class="supplier-picker-add" data-add-supplier="${encodeURIComponent(typed)}">+ Add "${supplierPickerEsc(typed)}" as new supplier</button>`
      : '');
  }

  searchEl.addEventListener('input', () => {
    valueEl.value = '';
    render();
  });
  searchEl.addEventListener('focus', render);
  resultsEl.addEventListener('click', async event => {
    const option = event.target.closest('[data-supplier],[data-add-supplier],[data-edit-supplier]');
    if (!option) return;
    if (option.dataset.editSupplier) {
      const name = decodeURIComponent(option.dataset.editSupplier);
      const supplier = DB.get(storeKey)
        .find(item => String(item.name || '').trim().toLowerCase() === name.trim().toLowerCase());
      if (supplier) opts.onEdit(supplier, { storeKey, setValue, refresh: render });
    } else if (option.dataset.addSupplier) {
      try {
        const supplier = await ensureSharedSupplier(decodeURIComponent(option.dataset.addSupplier), storeKey);
        if (supplier) setValue(supplier.name);
      } catch (err) {
        console.error('[Suppliers] Inline add failed:', err);
        alert('Could not add the supplier. Please try again.');
      }
    } else {
      setValue(decodeURIComponent(option.dataset.supplier));
    }
  });
  searchEl._setSupplierValue = setValue;
}

function setSupplierPickerValue(valueId, value = '') {
  const valueEl = document.getElementById(valueId);
  const searchEl = document.getElementById(`${valueId}-search`);
  const resultsEl = document.getElementById(`${valueId}-results`);
  if (!valueEl || !searchEl || !resultsEl) return;
  valueEl.value = value;
  searchEl.value = value;
  resultsEl.innerHTML = '';
  const emptyMessage = document.getElementById(`${valueId}-empty`);
  if (emptyMessage) emptyMessage.style.display = DB.get('suppliers').length ? 'none' : '';
}

// ─── Table Search ───────────────────────────────────────────────────────────
function initTableSearch(inputSel, tbodySel) {
  const inp = typeof inputSel==='string' ? document.getElementById(inputSel) : inputSel;
  const tbd = typeof tbodySel==='string' ? document.getElementById(tbodySel) : tbodySel;
  if (!inp || !tbd) return;
  inp.addEventListener('input', function() {
    const q = this.value.toLowerCase();
    tbd.querySelectorAll('tr').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

// ─── Sidebar ────────────────────────────────────────────────────────────────
const ICONS = {
  grid:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
  bag:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>`,
  receipt:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16l3-2 3 2 3-2 3 2V4a2 2 0 00-2-2z"/><line x1="8" y1="9" x2="14" y2="9"/><line x1="8" y1="13" x2="14" y2="13"/></svg>`,
  card:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`,
  upload:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/></svg>`,
  package:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
  layers:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
  doc:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  pct:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>`,
  box:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>`,
  truck:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`,
  chart:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
  users:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>`,
  calc:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="10" y2="14"/><line x1="14" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="10" y2="18"/><line x1="14" y1="18" x2="16" y2="18"/></svg>`,
  book:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>`
};

const NAV = [
  { section:'OVERVIEW' },
  { href:'dashboard.html', icon:'grid',    label:'Dashboard',         key:'dashboard' },
  { section:'TRANSACTIONS' },
  { href:'pos-import.html',icon:'upload',  label:'Sales',             key:'pos-import' },
  { href:'purchases-ewt.html', icon:'bag', label:'Purchases',         key:'purchases' },
  { href:'expenses.html',  icon:'card',    label:'Expenses',          key:'expenses' },
  { section:'TRACKING' },
  { href:'inventory-tracking.html', icon:'package', label:'Inventory Tracking', key:'inventory-tracking' },
  { href:'potential-revenue.html', icon:'chart', label:'Potential Revenue', key:'potential-revenue' },
  { href:'supplies-tracking.html', icon:'layers', label:'Supplies Tracking', key:'supplies' },
  { section:'FINANCIAL' },
  { href:'tax-monitoring.html',   icon:'pct', label:'Tax Monitoring',   key:'tax-monitoring' },
  { href:'e-sales.html',          icon:'chart', label:'E-Sales Records', key:'e-sales' },
  { section:'MASTER DATA' },
  { href:'product-master.html', icon:'box',   label:'Product Master', key:'product-master' },
  { href:'suppliers.html',      icon:'truck',  label:'Suppliers',      key:'suppliers' },
  { href:'chart-of-accounts.html', icon:'receipt', label:'Chart of Accounts', key:'chart-of-accounts' },
  { section:'REPORTS' },
  { href:'reports.html',        icon:'chart',  label:'Reports',        key:'reports' },
  { section:'SYSTEM' },
  { href:'settings.html',       icon:'users',  label:'Settings',       key:'settings' },
  { href:'audit-log.html',      icon:'receipt', label:'Audit Log',     key:'audit-log' },
];

const AUDIT_LOG_KEY = 'auditLog';
const EPC_AUTH_DOMAIN = '@palogrocerette.local';

// Canonical role tokens that match firestore.rules ('accountant'|'limited'|'viewer').
// Accepts any casing or spacing the admin may have typed in the Firestore console.
function _normalizeRole(raw) {
  switch (String(raw || '').trim().toLowerCase()) {
    case 'accountant':                  return 'accountant';
    case 'limited':
    case 'limited access':
    case 'limited-access':             return 'limited';
    default:                           return 'viewer';
  }
}

// Human-readable label used in the sidebar and Settings page role field.
function roleDisplayName(role) {
  switch (role) {
    case 'accountant': return 'Accountant';
    case 'limited':    return 'Limited Access';
    default:           return 'Viewer';
  }
}

function userRoleDocumentPath(uid) {
  return `users/${uid}`;
}

function logLocalUserRoleSeedInfo(firebaseUser) {
  if (!isFirestoreEmulatorActive() || !firebaseUser?.uid) return;
  const username = String(firebaseUser.email || '').replace(EPC_AUTH_DOMAIN, '');
  console.log('Firestore user role path:', userRoleDocumentPath(firebaseUser.uid));
  console.log(
    'Seed local Accountant role:',
    `node scripts/seed-local-accountant.js ${firebaseUser.uid} ${username}`
  );
}

function logLoadedUserRole(firebaseUser, snap, data, normalizedRole) {
  const path = userRoleDocumentPath(firebaseUser.uid);
  console.log('Loaded Firestore user role path:', path);
  console.log('Loaded Firestore user role document exists:', snap.exists);
  console.log('Loaded Firestore user role raw value:', data.role);
  console.log('Loaded Firestore user role normalized value:', normalizedRole);
  if (isFirestoreEmulatorActive() && normalizedRole === 'viewer') {
    console.warn(
      'Local emulator role is Viewer. Seed the emulator user doc shown above, then refresh the app.'
    );
  }
}

// In-memory user state — populated once by onAuthStateChanged inside initSidebar.
// login.html never calls initSidebar, so _currentEPCUser stays null there (intentional).
let _currentEPCUser = null;

// Remove any legacy credentials left by the old fake-auth system on every page load.
['epc_users', 'epc_current_user'].forEach(k => localStorage.removeItem(k));

function getFirebaseAuth() {
  if (typeof firebase === 'undefined') return null;
  if (!firebase.apps.length) firebase.initializeApp(EPC_FIREBASE_CONFIG);
  return firebase.auth();
}

function getCurrentUser() {
  return _currentEPCUser || { uid:'', username:'', firstName:'', middleName:'', lastName:'', role:'viewer' };
}

function hasEPCSession() {
  return Boolean(_currentEPCUser);
}

function logoutEPCUser() {
  logAudit('Logout', 'User Session', `${currentUserFullName()} logged out`);
  _currentEPCUser = null;
  sessionStorage.setItem('epc_signed_out_at', String(Date.now()));
  const auth = getFirebaseAuth();
  const doRedirect = () => { location.replace('login.html'); };
  if (auth) auth.signOut().then(doRedirect).catch(doRedirect);
  else doRedirect();
}

function currentUserFullName(user = getCurrentUser()) {
  return [user.firstName, user.middleName, user.lastName].filter(Boolean).join(' ');
}

function currentUserInitials(user = getCurrentUser()) {
  const first = String(user.firstName || user.username || 'U').trim()[0] || 'U';
  const last = String(user.lastName || '').trim()[0] || '';
  return (first + last).toUpperCase();
}

function auditUserName(user = getCurrentUser()) {
  return currentUserFullName(user) || user.username || roleDisplayName(user.role);
}

function canCurrentUserEdit(activeKey) {
  const role = getCurrentUser().role;                       // already normalized to lowercase token
  if (role === 'accountant') return true;
  if (role === 'limited') return activeKey !== 'pos-import'; // edit all pages except sales
  return activeKey === 'settings';                           // viewer: own settings only
}

function applyRolePermissions(activeKey) {
  if (canCurrentUserEdit(activeKey)) return;
  const mutationPattern = /(add|save|delete|remove|import|upload|confirm|assign|update|edit|clear-all|remit|browse)/i;
  document.querySelectorAll('button, input[type="file"]').forEach(element => {
    const signature = `${element.id || ''} ${element.className || ''} ${element.getAttribute('onclick') || ''} ${element.textContent || ''}`;
    if (element.closest('.sidebar')) return;
    if (element.matches('[data-report-tab], .tab-btn, .page-btn, .purchase-page-btn')) return;
    if (mutationPattern.test(signature)) {
      element.disabled = true;
      element.classList.add('role-disabled');
      element.title = 'View-only access';
    }
  });
  document.querySelectorAll('.action-btns, .bulk-action-bar, .purchase-bulk-toolbar, .pm-select-all-banner, #esales-bulk-toolbar, #esales-select-all-banner')
    .forEach(element => element.style.display = 'none');
}

function logAudit(action, target, details) {
  const entry = {
    id: genId(),
    timestamp: new Date().toISOString(),
    user: auditUserName(),
    uid: getCurrentUser().uid || '',
    role: getCurrentUser().role,
    action: String(action || '').trim(),
    target: String(target || '').trim(),
    details: String(details || '').trim()
  };

  const db = getFirestoreDB();
  if (db) {
    db.collection(AUDIT_LOG_KEY).doc(entry.id).set(entry)
      .catch(err => console.error('[Audit Log] Firestore write failed:', err));
  }
}

function buildSidebar(activeKey) {
  const user = getCurrentUser();
  const nav = NAV.map(item => {
    if (item.section) return `<div class="nav-section-label">${item.section}</div>`;
    const active = item.key === activeKey ? ' active' : '';
    return `<a class="nav-item${active}" href="${item.href}" data-label="${item.label}">${ICONS[item.icon]||''}<span>${item.label}</span></a>`;
  }).join('');

  return `<aside class="sidebar">
    <div class="sidebar-logo">
      <img src="../logo.jpeg" alt="EPC Commercial Corporation" class="logo-img"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="logo-monogram" style="display:none">EPC</div>
      <div class="logo-text">
        <span class="logo-company">EPC Commercial Corporation</span>
        <span class="logo-portal">Accounting Portal</span>
      </div>
    </div>
    <nav class="sidebar-nav">${nav}</nav>
    <div class="sidebar-footer">
      <div class="user-pill">
        <div class="user-avatar">${currentUserInitials(user)}</div>
        <div class="user-info">
          <span class="user-name">${currentUserFullName(user)}</span>
          <span class="user-role">${roleDisplayName(user.role)}</span>
        </div>
      </div>
      <div class="sidebar-footer-actions">
        <button class="btn-logout" onclick="logoutEPCUser()">Logout</button>
      </div>
    </div>
  </aside>
  <button class="sidebar-toggle" id="sidebar-toggle-btn" aria-label="Toggle sidebar">
    <svg id="sidebar-toggle-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  </button>`;
}

function _updateToggleIcon(collapsed) {
  const icon = document.getElementById('sidebar-toggle-icon');
  if (!icon) return;
  icon.querySelector('polyline').setAttribute('points', collapsed ? '9 18 15 12 9 6' : '15 18 9 12 15 6');
}

function rebuildSidebar(activeKey) {
  const c = document.getElementById('sidebar-container');
  if (c) c.innerHTML = buildSidebar(activeKey);
  setTimeout(() => applyRolePermissions(activeKey), 0);
  setTimeout(() => applyRolePermissions(activeKey), 500);
  setTimeout(() => applyRolePermissions(activeKey), 1500);
}

function initSidebar(activeKey) {
  // Hide body until auth resolves so no page content flashes before redirect.
  document.body.style.visibility = 'hidden';

  const auth = getFirebaseAuth();
  if (!auth) { location.replace('login.html'); return; }

  window.addEventListener('pageshow', event => {
    if (event.persisted && (sessionStorage.getItem('epc_signed_out_at') || !auth.currentUser)) {
      _currentEPCUser = null;
      location.replace('login.html');
    }
  });

  auth.onAuthStateChanged(async (firebaseUser) => {
    if (!firebaseUser) {
      location.replace('login.html');
      return;
    }
    sessionStorage.removeItem('epc_signed_out_at');

    // Load role + profile from Firestore users/{uid}
    try {
      const db = getFirestoreDB();
      if (db) {
        logLocalUserRoleSeedInfo(firebaseUser);
        const snap = await db.collection('users').doc(firebaseUser.uid).get()
          .then(result => {
            logFirestoreReadSuccess('user profile read');
            return result;
          })
          .catch(err => {
            logFirestoreReadFailure(err);
            throw err;
          });
        const data = snap.exists ? snap.data() : {};
        const normalizedRole = _normalizeRole(data.role);
        logLoadedUserRole(firebaseUser, snap, data, normalizedRole);
        _currentEPCUser = {
          uid:        firebaseUser.uid,
          username:   data.username   || firebaseUser.email.replace(EPC_AUTH_DOMAIN, ''),
          firstName:  data.firstName  || '',
          middleName: data.middleName || '',
          lastName:   data.lastName   || '',
          role:       normalizedRole,
        };
      } else {
        _currentEPCUser = {
          uid:        firebaseUser.uid,
          username:   firebaseUser.email.replace(EPC_AUTH_DOMAIN, ''),
          firstName:'', middleName:'', lastName:'', role:'viewer',
        };
      }
    } catch (err) {
      console.error('[Auth] Failed to load user profile from Firestore:', err);
      showDatabaseConnectionBanner();
      _currentEPCUser = {
        uid:        firebaseUser.uid,
        username:   firebaseUser.email.replace(EPC_AUTH_DOMAIN, ''),
        firstName:'', middleName:'', lastName:'', role:'viewer',
      };
    }

    // Build sidebar only on first auth resolution (avoids duplicate toggle listeners).
    const c = document.getElementById('sidebar-container');
    if (c && !c.dataset.built) {
      c.dataset.built = '1';
      c.innerHTML = buildSidebar(activeKey);

      const collapsed = localStorage.getItem('_sidebar_collapsed') === '1';
      if (collapsed) {
        document.body.classList.add('sidebar-collapsed');
        _updateToggleIcon(true);
      }

      const btn = document.getElementById('sidebar-toggle-btn');
      if (btn) {
        btn.addEventListener('click', () => {
          const isCollapsed = document.body.classList.toggle('sidebar-collapsed');
          localStorage.setItem('_sidebar_collapsed', isCollapsed ? '1' : '0');
          _updateToggleIcon(isCollapsed);
        });
      }
    }

    document.body.style.visibility = '';
    // Signal that auth + user profile are ready so page scripts can read getCurrentUser().
    document.dispatchEvent(new CustomEvent('epc-auth-ready'));
    setTimeout(() => applyRolePermissions(activeKey), 0);
    setTimeout(() => applyRolePermissions(activeKey), 500);
    setTimeout(() => applyRolePermissions(activeKey), 1500);
  });
}

// ─── Seed Data ──────────────────────────────────────────────────────────────
function seedData() {
  if (localStorage.getItem('_epc_seeded')) return;

  DB.set('purchases',             []);
  DB.set('expenses',              []);
  DB.set('supplies_movements',    []);
  DB.set('pos_sales',             []);
  DB.set('pos_review',            []);
  DB.set('esales',                []);
  DB.set('eSalesRecords',         []);
  DB.set('ewt_remittances',       []);
  DB.set('quarterly_tax_paid',    0);
  localStorage.setItem('_epc_seeded', '1');
}

// ─── POS Sales Aggregation Helpers ──────────────────────────────────────────
function getPOSByMonth(month) {
  // month = 'YYYY-MM'
  return DB.get('pos_sales').filter(r => r.date && r.date.startsWith(month));
}

function posGrossRevenue(row) {
  const unitsSold = Number(row?.unitsSold ?? row?.qty ?? row?.quantity) || 0;
  const sellingPrice = Number(row?.sellingPrice ?? row?.srpUnit ?? row?.srp) || 0;
  const grossFromSrp = unitsSold * sellingPrice;
  if (grossFromSrp > 0) return grossFromSrp;

  const netRevenue = Number(row?.totalRevenue ?? row?.revenue ?? row?.totalSales ?? row?.total) || 0;
  const totalDiscount = Number(row?.discount) || 0;
  return netRevenue + totalDiscount;
}

function posNetRevenue(row) {
  return Number(row?.totalRevenue ?? row?.revenue ?? row?.totalSales ?? row?.total) || 0;
}

function posSrpwdDiscount(row) {
  return Number(row?.srpwdDiscount ?? row?.srPwdDiscount ?? row?.sr_pwd_discount) || 0;
}

function posTotalDiscount(row) {
  const derivedDiscount = posGrossRevenue(row) - posNetRevenue(row);
  if (derivedDiscount > 0) return derivedDiscount;
  return Number(row?.discount) || 0;
}

function posRegularDiscount(row) {
  return Math.max(0, posTotalDiscount(row) - posSrpwdDiscount(row));
}

function getPOSTotals(rows) {
  const totals = rows.reduce((acc, r) => {
    const grossRevenue = posGrossRevenue(r);
    const netRevenue = posNetRevenue(r);
    const totalCost = Number(r.totalCost) || ((Number(r.unitCost) || 0) * (Number(r.unitsSold) || 0));
    acc.grossRevenue += grossRevenue;
    acc.netRevenue += netRevenue;
    acc.revenue += netRevenue;
    acc.srpwdDiscounts += posSrpwdDiscount(r);
    acc.cogs += totalCost;
    acc.profit += grossRevenue - totalCost;
    acc.unitsSold += r.unitsSold || 0;
    return acc;
  }, {
    grossRevenue:0,
    netRevenue:0,
    revenue:0,
    discounts:0,
    srpwdDiscounts:0,
    totalDiscounts:0,
    cogs:0,
    profit:0,
    unitsSold:0
  });
  totals.totalDiscounts = Math.max(0, totals.grossRevenue - totals.netRevenue);
  totals.discounts = Math.max(0, totals.totalDiscounts - totals.srpwdDiscounts);
  return totals;
}

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  // Version-based data flush — clears all old EPC sample data on first load
  const DATA_VERSION = 'pg_v1';
  if (localStorage.getItem('_epc_data_version') !== DATA_VERSION) {
    ['purchases','expenses','pos_sales','pos_review','esales','eSalesRecords','products','suppliers',
     'inventory_movements','supplies_movements','ewt_remittances','quarterly_tax_paid',
     '_epc_seeded','inv_cats','prod_cats','exp_cats','uom_extras'].forEach(k => localStorage.removeItem(k));
    localStorage.setItem('_epc_data_version', DATA_VERSION);
  }
  seedData();
  initModals();
  initNumberFormatting();
});

// ─── TrackingTable — shared column filter/sort engine ────────────────────────
// Used by Inventory Tracking and Supplies Tracking pages.
// cfg: { id, storageKey, dateField, theadId, tbodyId, clearBtnId,
//        quickSearchId, columns[], renderRow, emptyHtml }
// column: { key, label, sortable, filterable, filterType, filterOptions,
//           filterPlaceholder, sortVal, filterVal }
// filterType: 'text' | 'dropdown' | 'date-range' | 'num-range'
class TrackingTable {
  static _reg = {};
  static get(id) { return TrackingTable._reg[id]; }

  constructor(cfg) {
    this.cfg         = cfg;
    this.activeTab   = 'all';
    this.sortCol     = null;
    this.sortDir     = 'asc';
    this.filters     = {};
    this.quickSearch = '';
    this.page        = 1;
    this.pageSize    = 100;
    this.remoteTotal = null;
    TrackingTable._reg[cfg.id] = this;
    this._buildHeaders();
    this._bindQuickSearch();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────
  setTab(tab) { this.activeTab = tab; this.page = 1; this.render(); }

  setRemoteTotal(total) {
    const parsed = Number(total);
    this.remoteTotal = Number.isFinite(parsed) ? parsed : null;
    this.render();
  }

  setSort(colKey) {
    if (this.sortCol === colKey) {
      if (this.sortDir === 'asc') { this.sortDir = 'desc'; }
      else                        { this.sortCol = null; this.sortDir = 'asc'; }
    } else {
      this.sortCol = colKey; this.sortDir = 'asc';
    }
    this.page = 1;
    this._refreshSortIcons();
    this.render();
  }

  setFilter(colKey, val) {
    this.filters[colKey] = val;
    this.page = 1;
    this._refreshFilterDots();
    this._renderDebounced();
  }

  setRangeFilter(colKey, part, val) {
    if (!this.filters[colKey] || typeof this.filters[colKey] !== 'object')
      this.filters[colKey] = {};
    this.filters[colKey][part] = val;
    this.page = 1;
    this._refreshFilterDots();
    this._renderDebounced();
  }

  // Debounce re-render for filter typing (big datasets: avoid re-filtering the
  // whole set on every keystroke). Non-virtual tables render immediately.
  _renderDebounced() {
    if (!this.cfg.virtual) { this.render(); return; }
    clearTimeout(this._renderTimer);
    this._renderTimer = setTimeout(() => this.render(), 140);
  }

  clearAll() {
    this.filters     = {};
    this.sortCol     = null;
    this.sortDir     = 'asc';
    this.quickSearch = '';
    this.page        = 1;
    const thead = document.getElementById(this.cfg.theadId);
    thead?.querySelectorAll('.col-filter').forEach(el => { el.value = ''; });
    const qs = document.getElementById(this.cfg.quickSearchId);
    if (qs) qs.value = '';
    this._refreshSortIcons();
    this._refreshFilterDots();
    this.render();
  }

  hasActive() {
    const hasF = Object.values(this.filters).some(v => {
      if (v == null) return false;
      if (typeof v === 'object') return !!(v.from || v.to || (v.min !== '' && v.min != null) || (v.max !== '' && v.max != null));
      return String(v).trim() !== '';
    });
    return hasF || !!this.sortCol || !!this.quickSearch.trim();
  }

  render() {
    this._refreshDynamicDropdowns();
    const processed  = this._getProcessed();

    if (this.cfg.virtual) { this._renderVirtual(processed); this._refreshClearBtn(); return; }

    const totalPages = Math.max(1, Math.ceil(processed.length / this.pageSize));
    if (this.page > totalPages) this.page = totalPages;

    const start    = (this.page - 1) * this.pageSize;
    const pageRows = processed.slice(start, start + this.pageSize);

    const tbody = document.getElementById(this.cfg.tbodyId);
    if (!processed.length) {
      tbody.innerHTML = typeof this.cfg.emptyHtml === 'function'
        ? this.cfg.emptyHtml(this.activeTab)
        : this.cfg.emptyHtml;
    } else {
      tbody.innerHTML = pageRows.map(r => this.cfg.renderRow(r)).join('');
    }
    this._renderPagination(processed.length);
    this._refreshClearBtn();
  }

  // ─── Virtual scrolling ───────────────────────────────────────────────────────
  // Renders only the rows visible in the scroll viewport (+ a small overscan),
  // using top/bottom spacer rows to preserve scroll height. Keeps thousands of
  // rows smooth without paginating.
  _renderVirtual(processed) {
    const tbody = document.getElementById(this.cfg.tbodyId);
    if (!tbody) return;
    this._vRows = processed;
    const colspan = this.cfg.columns.length;

    if (!processed.length) {
      tbody.innerHTML = typeof this.cfg.emptyHtml === 'function'
        ? this.cfg.emptyHtml(this.activeTab) : this.cfg.emptyHtml;
      const pg = document.getElementById(this.cfg.paginationId);
      if (pg) pg.innerHTML = '';
      return;
    }

    const scroller = tbody.closest('.table-scroll');
    if (scroller) scroller.classList.add('vs-active');
    if (scroller && !this._vBound) {
      this._vBound = true;
      let ticking = false;
      scroller.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => { ticking = false; this._paintVirtualWindow(); });
      });
    }
    // Fixed row height estimate (px). Rows can wrap, so use a generous value and
    // let overscan absorb variance.
    this._vRowH = this._vRowH || 64;
    this._vColspan = colspan;
    this._paintVirtualWindow(true);

    // Show a simple total count where pagination used to be.
    const pg = document.getElementById(this.cfg.paginationId);
    if (pg) pg.innerHTML = `<div class="pagination-info">${processed.length.toLocaleString()} row(s)</div>`;
  }

  _paintVirtualWindow(force) {
    const tbody = document.getElementById(this.cfg.tbodyId);
    const scroller = tbody && tbody.closest('.table-scroll');
    const rows = this._vRows || [];
    if (!tbody || !scroller || !rows.length) return;
    const rowH = this._vRowH;
    const viewH = scroller.clientHeight || 600;
    const scrollTop = scroller.scrollTop;
    const overscan = 8;
    const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
    const visibleCount = Math.ceil(viewH / rowH) + overscan * 2;
    const last = Math.min(rows.length, first + visibleCount);

    if (!force && this._vFirst === first && this._vLast === last) return;
    this._vFirst = first; this._vLast = last;

    const padTop = first * rowH;
    const padBot = (rows.length - last) * rowH;
    const colspan = this._vColspan;
    const slice = rows.slice(first, last).map(r => this.cfg.renderRow(r)).join('');
    tbody.innerHTML =
      (padTop > 0 ? `<tr class="v-spacer" style="height:${padTop}px"><td colspan="${colspan}"></td></tr>` : '') +
      slice +
      (padBot > 0 ? `<tr class="v-spacer" style="height:${padBot}px"><td colspan="${colspan}"></td></tr>` : '');
    if (typeof this.cfg.onRender === 'function') this.cfg.onRender();
  }

  setPage(p) {
    this.page = p;
    this.render();
  }

  getProcessedRows() {
    return this._getProcessed();
  }

  _renderPagination(total) {
    const el = document.getElementById(this.cfg.paginationId);
    if (!el) return;
    const displayTotal = this.remoteTotal != null && this.activeTab === 'all' && !this.hasActive()
      ? this.remoteTotal
      : total;
    const { page, pageSize } = this;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (total === 0) { el.innerHTML = ''; return; }
    const from = (page - 1) * pageSize + 1;
    const to   = Math.min(page * pageSize, total);
    const id   = this.cfg.id;
    const info = displayTotal !== total
      ? `Showing ${from}–${to} of ${total.toLocaleString()} loaded (${total.toLocaleString()} shown | ${displayTotal.toLocaleString()} total)`
      : `Showing ${from}–${to} of ${total.toLocaleString()} entries`;
    const btns = this._pageWindow(page, totalPages).map(n =>
      n === '…'
        ? `<span class="page-ellipsis">…</span>`
        : `<button class="page-btn${n === page ? ' active' : ''}" onclick="TrackingTable.get('${id}').setPage(${n})">${n}</button>`
    ).join('');
    el.innerHTML = `
      <div class="pagination-info">${info}</div>
      <div class="pagination-controls">
        <button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="TrackingTable.get('${id}').setPage(${page - 1})">‹ Prev</button>
        ${btns}
        <button class="page-btn" ${page >= totalPages ? 'disabled' : ''} onclick="TrackingTable.get('${id}').setPage(${page + 1})">Next ›</button>
      </div>`;
  }

  _pageWindow(cur, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const out = [];
    let last = 0;
    for (let i = 1; i <= total; i++) {
      if (i === 1 || i === total || (i >= cur - 2 && i <= cur + 2)) {
        if (last && i - last > 1) out.push('…');
        out.push(i);
        last = i;
      }
    }
    return out;
  }

  // ─── Private ─────────────────────────────────────────────────────────────────
  _getProcessed() {
    const { storageKey, dateField } = this.cfg;
    let rows = DB.get(storageKey).sort((a, b) =>
      (b[dateField] || '').localeCompare(a[dateField] || '')
    );
    // Tab filter
    if (this.activeTab === 'incoming') rows = rows.filter(r => r.type === 'Incoming');
    if (this.activeTab === 'outgoing') rows = rows.filter(r => r.type === 'Outgoing');
    if (typeof this.cfg.tabFilter === 'function') {
      rows = rows.filter(r => this.cfg.tabFilter(r, this.activeTab));
    }
    // Quick search (across all text-filterable columns)
    if (this.quickSearch.trim()) {
      const q = this.quickSearch.trim().toLowerCase();
      const tCols = this.cfg.columns.filter(c => c.filterable && c.filterType === 'text');
      rows = rows.filter(r => tCols.some(c =>
        String(c.filterVal ? c.filterVal(r) : r[c.key] || '').toLowerCase().includes(q)));
    }
    // Column filters
    rows = rows.filter(r => this._passesFilters(r));
    // Sort
    if (this.sortCol) {
      const col = this.cfg.columns.find(c => c.key === this.sortCol);
      const dir = this.sortDir === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const va = col?.sortVal ? col.sortVal(a) : a[this.sortCol];
        const vb = col?.sortVal ? col.sortVal(b) : b[this.sortCol];
        let cmp = 0;
        if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
        else cmp = String(va ?? '').localeCompare(String(vb ?? ''));
        return cmp * dir;
      });
    }
    return rows;
  }

  _passesFilters(row) {
    return this.cfg.columns.every(col => {
      if (!col.filterable) return true;
      const fv = this.filters[col.key];
      if (fv == null || fv === '') return true;
      const value = col.filterVal ? col.filterVal(row) : row[col.key];
      if (col.filterType === 'text') {
        return !String(fv).trim() ||
          String(value || '').toLowerCase().includes(String(fv).trim().toLowerCase());
      }
      if (col.filterType === 'dropdown') {
        return !fv || value === fv;
      }
      if (col.filterType === 'date-range') {
        const d = row[col.key] || '';
        if (typeof fv === 'object') {
          if (fv.from && d < fv.from) return false;
          if (fv.to   && d > fv.to)   return false;
        }
        return true;
      }
      if (col.filterType === 'num-range') {
        const n = Number(row[col.key]) || 0;
        if (typeof fv === 'object') {
          if (fv.min !== '' && fv.min != null && !isNaN(fv.min) && n < Number(fv.min)) return false;
          if (fv.max !== '' && fv.max != null && !isNaN(fv.max) && n > Number(fv.max)) return false;
        }
        return true;
      }
      return true;
    });
  }

  _buildHeaders() {
    const thead = document.getElementById(this.cfg.theadId);
    if (!thead) return;
    const id = this.cfg.id;

    const headerCells = this.cfg.columns.map(col => {
      const sortAttr = col.sortable
        ? `class="sortable" onclick="TrackingTable.get('${id}').setSort('${col.key}')"`
        : 'class=""';
      const sortIcon = col.sortable
        ? `<span class="sort-icon" data-sort-icon="${col.key}">⇅</span>`
        : '';
      return `<th data-col="${col.key}" ${sortAttr}>
        <span class="th-label">${col.label}</span>${sortIcon}
      </th>`;
    }).join('');

    const filterCells = this.cfg.columns.map(col =>
      col.filterable
        ? `<th class="filter-cell" data-col="${col.key}">${this._buildFilterInput(col)}</th>`
        : `<th class="filter-cell-empty" data-col="${col.key}"></th>`
    ).join('');

    // Optional "Generate" row under the filters: turns the column filter row into a
    // query form. cfg.generate = { label, onClick:'globalFnName', statusId }.
    let generateRow = '';
    if (this.cfg.generate) {
      const g = this.cfg.generate;
      const span = this.cfg.columns.length;
      generateRow =
        `<tr class="generate-row"><th colspan="${span}" class="generate-cell">
          <button class="btn btn-primary btn-sm" id="${g.btnId || 'tt-generate-' + id}" type="button"
            onclick="EPCLoading.run('Loading records…', () => ${g.onClick}())">${g.label || 'Generate'}</button>
          <span class="generate-status" id="${g.statusId || 'tt-generate-status-' + id}"></span>
        </th></tr>`;
    }

    thead.innerHTML =
      `<tr class="header-row">${headerCells}</tr>` +
      `<tr class="filter-row">${filterCells}</tr>` +
      generateRow;
  }

  _buildFilterInput(col) {
    const self = `TrackingTable.get('${this.cfg.id}')`;
    if (col.filterType === 'text') {
      return `<input class="col-filter" type="text" placeholder="${col.filterPlaceholder || '…'}"
        oninput="${self}.setFilter('${col.key}', this.value)">`;
    }
    if (col.filterType === 'dropdown') {
      const opts = this._getDropdownOptions(col);
      return `<select class="col-filter" data-dyn-col="${col.key}"
        onchange="${self}.setFilter('${col.key}', this.value)">
        <option value="">All</option>${opts}</select>`;
    }
    if (col.filterType === 'date-range') {
      return `<div class="col-filter-range col-filter-range-date">
        <label class="col-filter-date-field">
          <span class="col-filter-date-label">From</span>
          <input class="col-filter" type="date" aria-label="From date"
            oninput="${self}.setRangeFilter('${col.key}','from',this.value)">
        </label>
        <label class="col-filter-date-field">
          <span class="col-filter-date-label">To</span>
          <input class="col-filter" type="date" aria-label="To date"
            oninput="${self}.setRangeFilter('${col.key}','to',this.value)">
        </label>
      </div>`;
    }
    if (col.filterType === 'num-range') {
      return `<div class="col-filter-range">
        <input class="col-filter" type="number" placeholder="Min" min="0" step="any"
          oninput="${self}.setRangeFilter('${col.key}','min',this.value)">
        <span class="range-sep">–</span>
        <input class="col-filter" type="number" placeholder="Max" min="0" step="any"
          oninput="${self}.setRangeFilter('${col.key}','max',this.value)">
      </div>`;
    }
    return '';
  }

  _getDropdownOptions(col) {
    const opts = typeof col.filterOptions === 'function' ? col.filterOptions() : (col.filterOptions || []);
    return opts.map(o => `<option value="${o}">${o}</option>`).join('');
  }

  _refreshDynamicDropdowns() {
    const thead = document.getElementById(this.cfg.theadId);
    if (!thead) return;
    this.cfg.columns.forEach(col => {
      if (col.filterable && col.filterType === 'dropdown' && typeof col.filterOptions === 'function') {
        const sel = thead.querySelector(`[data-dyn-col="${col.key}"]`);
        if (!sel) return;
        const cur = sel.value;
        sel.innerHTML = `<option value="">All</option>` + this._getDropdownOptions(col);
        if (cur) sel.value = cur;
      }
    });
  }

  _refreshSortIcons() {
    const thead = document.getElementById(this.cfg.theadId);
    if (!thead) return;
    thead.querySelectorAll('[data-sort-icon]').forEach(el => {
      const key = el.dataset.sortIcon;
      const th  = el.closest('th');
      if (this.sortCol === key) {
        el.textContent = this.sortDir === 'asc' ? '↑' : '↓';
        el.classList.add('sort-active');
        th.classList.add('is-sorted');
      } else {
        el.textContent = '⇅';
        el.classList.remove('sort-active');
        th.classList.remove('is-sorted');
      }
    });
  }

  _refreshFilterDots() {
    const thead = document.getElementById(this.cfg.theadId);
    if (!thead) return;
    this.cfg.columns.forEach(col => {
      const th = thead.querySelector(`[data-col="${col.key}"]`);
      if (!th) return;
      const fv = this.filters[col.key];
      let active = false;
      if (fv != null) {
        if (typeof fv === 'object') {
          active = !!(fv.from || fv.to ||
            (fv.min !== '' && fv.min != null) ||
            (fv.max !== '' && fv.max != null));
        } else {
          active = String(fv).trim() !== '';
        }
      }
      th.classList.toggle('has-filter', active);
    });
  }

  _refreshClearBtn() {
    const btn = document.getElementById(this.cfg.clearBtnId);
    if (btn) btn.style.display = this.hasActive() ? '' : 'none';
  }

  _bindQuickSearch() {
    const el = document.getElementById(this.cfg.quickSearchId);
    if (!el) return;
    el.addEventListener('input', e => {
      this.quickSearch = e.target.value;
      this.page = 1;
      this._refreshFilterDots();
      this.render();
    });
  }
}

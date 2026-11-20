/* ─── EPC Accounting Portal — read counter and estimate (EPCReads) ──────────
 * The Firebase project is on the free Spark plan: 50,000 Firestore reads per
 * day for everyone. Firebase does not tell the website how many were used, so
 * this keeps the browser's OWN count for the current quota day (reset at
 * midnight US Pacific, same clock as EPCQuota) and estimates what a planned
 * load will cost before the click. Pure parts run in Node for the tests;
 * browser-only parts (state, line, confirm) are added further down.
 *
 * Rule: every Firestore read on the site reports its document count with
 * EPCReads.countSnap(snap, label) or EPCReads.spent(n, label), and every
 * Generate button passes an `estimate` so the cost line can show it.
 */
(function (global) {
  const LIMIT = 50000;
  const CONFIRM_ABOVE = 1000;
  const KEY = 'epc_reads';
  const COUNTS_KEY = 'epc_counts';
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // same as EPCSaved
  // Used only until a browser has stored real counts (epc_counts).
  const FALLBACK = {
    productMaster: 5000, inventoryData: 8000, itemCost: 5000, purchases: 3000,
    expenses: 2000, suppliesData: 1000, eSalesRecords: 1000, suppliers: 200, expenseAccounts: 100,
  };

  let deps = {
    now: () => Date.now(),
    storage: null,         // { getItem, setItem }
    nextReset: null,       // ms -> ms
  };
  function storage() {
    if (deps.storage) return deps.storage;
    try { return global.localStorage; } catch (e) { return null; }
  }
  function nextReset(ms) {
    if (deps.nextReset) return deps.nextReset(ms);
    if (global.EPCQuota && typeof global.EPCQuota.nextReset === 'function') return global.EPCQuota.nextReset(ms);
    return ms + 86400000;
  }
  function _init(overrides) { deps = { ...deps, ...overrides }; }

  // { day, total, byLabel } for the current quota day; a new day starts at 0.
  function readState() {
    const s = storage();
    let st = null;
    try { st = s && JSON.parse(s.getItem(KEY) || 'null'); } catch (e) { st = null; }
    const now = deps.now();
    if (!st || typeof st.day !== 'number' || now >= st.day) {
      st = { day: nextReset(now), total: 0, byLabel: {} };
    }
    return st;
  }
  function writeState(st) {
    const s = storage();
    try { if (s) s.setItem(KEY, JSON.stringify(st)); } catch (e) { /* storage off */ }
  }

  function spent(n, label) {
    const reads = Math.max(1, Math.round(Number(n) || 0));
    const st = readState();
    st.total += reads;
    const key = String(label || 'other');
    st.byLabel[key] = (st.byLabel[key] || 0) + reads;
    writeState(st);
    if (typeof global.dispatchEvent === 'function' && typeof global.Event === 'function') {
      try { global.dispatchEvent(new global.Event('epc-reads-change')); } catch (e) { /* no DOM */ }
    }
  }
  function countSnap(snap, label) {
    spent(snap && typeof snap.size === 'number' ? snap.size : 1, label);
    return snap;
  }
  function used() { return readState().total; }
  function byLabel() { return { ...readState().byLabel }; }

  // Last known record counts per collection (set by EPCSaved after a full load or count).
  function knownCounts() {
    const s = storage();
    try { return (s && JSON.parse(s.getItem(COUNTS_KEY) || '{}')) || {}; } catch (e) { return {}; }
  }
  function rememberCount(name, count) {
    if (!(count >= 0)) return;
    const counts = knownCounts();
    counts[name] = count;
    const s = storage();
    try { if (s) s.setItem(COUNTS_KEY, JSON.stringify(counts)); } catch (e) { /* storage off */ }
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function daysBetween(from, to) {
    const out = [];
    if (!from || !to || from > to) return out;
    const d = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
    }
    return out;
  }

  // parts: [{ saved: name } | { days: collection, from, to } | { fixed: n, label }]
  // state: { uid, saved: { name: { uid, at, count } }, counts: { name: n }, daysCached: Set }
  function estimate(parts, state) {
    const st = state || { uid: null, saved: {}, counts: {}, daysCached: new Set() };
    const counts = { ...knownCounts(), ...(st.counts || {}) };
    const breakdown = [];
    (parts || []).forEach((part) => {
      if (!part) return;
      if (part.saved) {
        const copy = (st.saved || {})[part.saved];
        const usable = copy && copy.uid === st.uid && (deps.now() - (copy.at || 0)) <= MAX_AGE_MS;
        if (usable) {
          const extra = Math.max(0, Math.ceil((copy.count || 0) / 1000) - 1);
          breakdown.push({ label: part.saved, reads: 2 + extra, note: 'change check' });
        } else {
          const n = counts[part.saved] != null ? counts[part.saved] : (FALLBACK[part.saved] || 1000);
          breakdown.push({ label: part.saved, reads: Math.max(1, n), note: 'first load on this browser' });
        }
      } else if (part.days) {
        const cached = st.daysCached || new Set();
        const all = daysBetween(part.from, part.to);
        const missing = all.filter(d => !cached.has(d)).length;
        breakdown.push(missing
          ? { label: part.days, reads: missing, note: `${missing} day${missing === 1 ? '' : 's'} not loaded yet` }
          : { label: part.days, reads: 2, note: 'change check' });
      } else if (part.fixed != null) {
        breakdown.push({ label: part.label || 'other', reads: Math.max(0, Math.round(part.fixed)), note: part.note || '' });
      }
    });
    return { reads: breakdown.reduce((s, b) => s + b.reads, 0), breakdown };
  }

  function shouldConfirm(reads, usedToday) {
    return reads > CONFIRM_ABOVE || (usedToday + reads) > LIMIT;
  }
  const fmt = n => Number(n || 0).toLocaleString('en-US');
  function format(reads, usedToday, opts = {}) {
    if (opts.offline) return '0 reads (offline)';
    return `≈ ${fmt(reads)} read${reads === 1 ? '' : 's'} · ${fmt(usedToday)} used today on this browser`;
  }

  // ── Counting at the SDK level ─────────────────────────────────────────────
  // Wrap proto.get so every successful read on the site is counted, whichever
  // page made it. labelFn(obj) names the read for the by-label breakdown.
  function watchGet(proto, labelFn) {
    if (!proto || typeof proto.get !== 'function' || proto.get.__epcWatched) return;
    const original = proto.get;
    const wrapped = async function (...args) {
      const snap = await original.apply(this, args);
      let label = 'query';
      try { label = labelFn ? labelFn(this) : 'query'; } catch (e) { /* label is cosmetic */ }
      spent(snap && typeof snap.size === 'number' ? snap.size : 1, label);
      return snap;
    };
    wrapped.__epcWatched = true;
    proto.get = wrapped;
  }
  function pathOf(obj) {
    try {
      if (obj && typeof obj.path === 'string') return obj.path.split('/')[0];
      const q = obj && obj._delegate && obj._delegate._query;
      const segs = q && q.path && q.path.segments;
      if (segs && segs.length) return segs[0];
    } catch (e) { /* ignore */ }
    return 'query';
  }
  // Hook the compat SDK's Query / DocumentReference / AggregateQuery classes.
  function watchFirestore(firebase) {
    const fs = firebase && firebase.firestore;
    if (!fs) return;
    ['Query', 'CollectionReference', 'DocumentReference'].forEach((name) => {
      if (fs[name] && fs[name].prototype) watchGet(fs[name].prototype, pathOf);
    });
    if (fs.AggregateQuery && fs.AggregateQuery.prototype) {
      watchGet(fs.AggregateQuery.prototype, () => 'count');
    }
  }

  // ── Browser-only parts ────────────────────────────────────────────────────
  // state(): what estimate() needs, read from the saved copies on this browser.
  async function state() {
    const saved = global.EPCSaved && typeof global.EPCSaved.meta === 'function' ? await global.EPCSaved.meta() : {};
    let uid = null;
    try { uid = global.firebase && global.firebase.auth().currentUser ? global.firebase.auth().currentUser.uid : null; } catch (e) { uid = null; }
    const daysCached = new Set();
    try {
      if (global.EPCDays && typeof global.EPCDays.cachedDates === 'function') {
        (await global.EPCDays.cachedDates('salesDaily')).forEach(d => daysCached.add(`salesDaily:${d}`));
        (await global.EPCDays.cachedDates('inventoryDaily')).forEach(d => daysCached.add(`inventoryDaily:${d}`));
      }
    } catch (e) { /* no day store yet */ }
    return { uid, saved, counts: knownCounts(), daysCached };
  }
  // Day parts are keyed "<collection>:<date>" in daysCached so both collections fit one Set.
  function estimateWithState(parts, st) {
    const cached = st.daysCached || new Set();
    const breakdown = [];
    let reads = 0;
    (parts || []).forEach((p) => {
      if (!p) return;
      const view = p.days ? { ...st, daysCached: { has: (d) => cached.has(`${p.days}:${d}`) } } : st;
      const r = estimate([p], view);
      reads += r.reads;
      breakdown.push(...r.breakdown);
    });
    return { reads, breakdown };
  }
  async function line(el, partsFn, opts = {}) {
    const node = typeof el === 'string' ? global.document.getElementById(el) : el;
    if (!node) return;
    if (opts.offline || global.EPC_OFFLINE) { node.textContent = format(0, used(), { offline: true }); return; }
    try {
      const st = await state();
      const parts = typeof partsFn === 'function' ? await partsFn() : (partsFn || []);
      const est = estimateWithState(parts, st);
      node.textContent = format(est.reads, used());
      node.title = est.breakdown.map(b => `${b.label}: ${fmt(b.reads)}${b.note ? ` (${b.note})` : ''}`).join('\n');
    } catch (e) {
      node.textContent = format(0, used());
    }
  }
  // Resolves true when the load may go ahead. No pop-up for small loads.
  async function confirm(parts, opts = {}) {
    if (opts.offline || global.EPC_OFFLINE) return true;
    const st = await state();
    const est = estimateWithState(typeof parts === 'function' ? await parts() : parts, st);
    const usedToday = used();
    const quotaHit = global.EPCQuota && typeof global.EPCQuota.active === 'function' && global.EPCQuota.active();
    if (!quotaHit && !shouldConfirm(est.reads, usedToday)) return true;
    return new Promise((resolve) => {
      const doc = global.document;
      const overlay = doc.createElement('div');
      overlay.className = 'epc-loading-overlay epc-confirm';
      const resetText = global.EPCQuota && global.EPCQuota.resetText ? global.EPCQuota.resetText() : 'the next reset';
      const rows = est.breakdown.map(b => `<li><span>${esc(humanLabel(b.label))}</span><strong>${fmt(b.reads)}</strong>${b.note ? `<em>${esc(b.note)}</em>` : ''}</li>`).join('');
      overlay.innerHTML = `<div class="epc-loading-card epc-confirm-card" role="dialog" aria-modal="true">
        <div class="epc-loading-msg">${quotaHit ? 'The daily read limit is used up' : 'This load is big'}</div>
        <p class="epc-confirm-sum">About <strong>${fmt(est.reads)}</strong> reads. This browser has used about <strong>${fmt(usedToday)}</strong> of the team's <strong>${fmt(LIMIT)}</strong> today.</p>
        <ul class="epc-confirm-list">${rows}</ul>
        <p class="epc-confirm-reset">The limit resets at ${esc(resetText)}.</p>
        <div class="epc-confirm-actions">
          ${quotaHit
            ? `<button type="button" class="btn btn-primary" data-act="wait">Wait until ${esc(resetText.replace(/^about /, ''))}</button>`
            : `<button type="button" class="btn btn-outline-gray" data-act="no">Not now</button>
               <button type="button" class="btn btn-primary" data-act="yes">Load anyway</button>`}
        </div></div>`;
      overlay.addEventListener('click', (ev) => {
        const act = ev.target && ev.target.dataset ? ev.target.dataset.act : null;
        if (!act) return;
        overlay.remove();
        resolve(act === 'yes');
      });
      doc.body.appendChild(overlay);
    });
  }
  const LABELS = {
    productMaster: 'Products', inventoryData: 'Inventory', itemCost: 'Item costs', purchases: 'Purchases',
    expenses: 'Expenses', suppliesData: 'Supplies', eSalesRecords: 'E-Sales', suppliers: 'Suppliers',
    expenseAccounts: 'Chart of accounts', salesDaily: 'Sales days', inventoryDaily: 'Inventory days',
  };
  function humanLabel(l) { return LABELS[l] || l; }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const api = {
    LIMIT, CONFIRM_ABOVE, FALLBACK, MAX_AGE_MS,
    spent, countSnap, used, byLabel, rememberCount, knownCounts,
    daysBetween, estimate, shouldConfirm, format, _init,
    watchGet, watchFirestore, state, line, confirm, humanLabel,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.EPCReads = api;
})(typeof window !== 'undefined' ? window : globalThis);

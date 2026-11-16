initSidebar('reports');

const REPORT_DATA = {
  sales: [], purchases: [], expenses: [], supplies: [], inventory: [], suppliers: [], esales: [],
  ewtRemittances: [], productMaster: []
};
let activeReportTab = 'income';
const REPORT_COLLECTIONS = {
  sales: { collection:'salesDaily', fallback:'pos_sales', dataKey:'sales', rollup:'sales' },
  purchases: { collection:'purchases', fallback:'purchases', dataKey:'purchases' },
  expenses: { collection:'expenses', fallback:'expenses', dataKey:'expenses' },
  supplies: { collection:'suppliesData', fallback:'supplies_movements', dataKey:'supplies' },
  inventory: { collection:'inventoryDaily', fallback:'inventory_movements', dataKey:'inventory', rollup:'inventory' },
  suppliers: { collection:'suppliers', fallback:'suppliers', dataKey:'suppliers' },
  esales: { collection:'eSalesRecords', fallback:'', dataKey:'esales' },
  ewtRemittances: { collection:'ewtRemittances', fallback:'', dataKey:'ewtRemittances' },
  productMaster: { collection:'productMaster', fallback:'', dataKey:'productMaster' },
};
const REPORT_TAB_COLLECTIONS = {
  income: ['sales', 'expenses', 'supplies', 'inventory', 'productMaster'],
  sales: ['sales', 'inventory', 'productMaster'],
  purchases: ['purchases'],
  tax: ['esales', 'purchases', 'expenses', 'supplies', 'ewtRemittances'],
  inventory: ['inventory', 'sales', 'productMaster'],
  cashflow: ['sales', 'purchases', 'supplies', 'expenses'],
  custom: ['sales', 'esales', 'purchases', 'expenses', 'inventory', 'productMaster'],
};
const loadedReportCollections = new Set();
// True once the user has clicked Generate / Apply / a tab and data has actually
// been loaded. Until then, renderActiveReport() must NOT paint the report (it
// would show ₱0 from the empty cache) — it shows the "Generate Report" prompt.
let reportHasGenerated = false;
// Set when a report load FAILS (Firestore quota reached, network, etc.). When set,
// renderActiveReport() shows a visible error notice instead of a silent all-₱0
// report — so a blocked read never looks like real zero figures.
let reportLoadError = null;

// Classify a Firestore load failure into a clear, user-facing message.
function reportLoadErrorMessage(err) {
  const code = String(err && (err.code ?? '')).toLowerCase();
  const msg = String((err && err.message) || err || '').toLowerCase();
  if (code.includes('resource-exhausted') || code === '8' || msg.includes('quota') || msg.includes('resource_exhausted')) {
    return 'Daily Firestore read limit reached — reports can’t load right now. ' +
      'This resets at midnight (US Pacific). Figures are not really ₱0; the data just couldn’t be read.';
  }
  if (code.includes('permission-denied') || msg.includes('permission')) {
    return 'You don’t have permission to read the report data. Please sign in again or contact an administrator.';
  }
  if (code === 'report-timeout') {
    return 'The report took too long to load. Try a shorter date range or Generate again. This does not necessarily mean your connection is offline.';
  }
  if (code.includes('unavailable') || msg.includes('offline') || msg.includes('network')) {
    return 'Could not reach the database (network/offline). Check your connection and try Generate again.';
  }
  return 'Could not load report data. Please try Generate again.';
}

// A hung Firestore .get() (offline SDK retrying the server forever, auth never
// resolving, etc.) leaves the progress bar frozen with no error. Give up only when
// the load STOPS making progress (no checkpoint for REPORT_IDLE_TIMEOUT_MS), not
// after a fixed total time: a whole-year report is slow but still moving, and the
// old fixed 30s cap cut it off part-way. A hard cap still stops a runaway load.
const REPORT_IDLE_TIMEOUT_MS = 45000;
const REPORT_MAX_LOAD_MS = 180000;
let _reportLastProgressAt = 0;
function touchReportProgress() { _reportLastProgressAt = Date.now(); }
async function withReportLoadTimeout(promise) {
  let timer;
  const startedAt = Date.now();
  touchReportProgress();
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setInterval(() => {
          const now = Date.now();
          if (now - _reportLastProgressAt < REPORT_IDLE_TIMEOUT_MS &&
              now - startedAt < REPORT_MAX_LOAD_MS) return;
          clearInterval(timer);
          const e = new Error('Report data took too long to load (timed out). ' +
            'Try a shorter date range or Generate again.');
          e.code = 'report-timeout';
          reject(e);
        }, 1000);
      }),
    ]);
  } finally {
    clearInterval(timer);
  }
}

// Read daily rollup docs (salesDaily / inventoryDaily, id = YYYY-MM-DD) for a date
// range. Long ranges are split into one query per month and run side by side:
// a whole year downloads much faster than one giant query, and each finished
// month counts as progress for the timeout above. Same documents, same reads.
async function readDailyRollupDocs(db, collectionName, start, end) {
  const idPath = firebase.firestore.FieldPath.documentId();
  const base = () => db.collection(collectionName).orderBy(idPath);
  if (!start || !end || start > end) {
    let q = base();
    if (start) q = q.startAt(start);
    if (end) q = q.endAt(end);
    return (await q.get()).docs;
  }
  const parts = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    if (ym > end.slice(0, 7)) break;
    const from = ym === start.slice(0, 7) ? start : `${ym}-01`;
    const to = ym === end.slice(0, 7) ? end : `${ym}-31`;   // ids are strings; -31 covers any month
    parts.push([from, to]);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  const snaps = await Promise.all(parts.map(async ([from, to]) => {
    const snap = await base().startAt(from).endAt(to).get();
    touchReportProgress();
    return snap;
  }));
  return snaps.flatMap(snap => snap.docs);
}

// Run a report load, capturing any failure into reportLoadError so the render
// layer can show a notice instead of zeros. Returns true on success.
async function runReportLoad(loadFn) {
  reportLoadError = null;
  try {
    await withReportLoadTimeout(loadFn());
    return true;
  } catch (err) {
    console.error('[Reports] load failed:', err);
    reportLoadError = reportLoadErrorMessage(err);
    return false;
  }
}
let productMasterReportListenerStarted = false;
// Sales revenue for all days BEFORE the current report-start (for cash flow opening
// balance). Loaded only for Cash Flow, since REPORT_DATA.sales is now
// range-scoped and no longer contains pre-range rows.
let salesPriorInflow = { before: null, total: 0 };
const FEATURE_CUSTOM_REPORT = false;
let reportChart = null;
let purchasesBarChart = null;
let reportCategoryChart = null;
let customExportRows = [];
const CUSTOM_SOURCE_CONFIG = {
  sales:    { key:'sales',    measures:[{value:'value',label:'Total Value (₱)'},{value:'units',label:'Units Sold'},{value:'count',label:'Transaction Count'}],    dimensions:[{value:'day',label:'Day'},{value:'week',label:'Week'},{value:'month',label:'Month'},{value:'category',label:'Category'}] },
  esales:   { key:'esales',   measures:[{value:'value',label:'Total Value (₱)'},{value:'units',label:'Units Sold'},{value:'count',label:'Transaction Count'}],    dimensions:[{value:'day',label:'Day'},{value:'week',label:'Week'},{value:'month',label:'Month'},{value:'category',label:'Category'}] },
  purchases:{ key:'purchases',measures:[{value:'value',label:'Total Value (₱)'},{value:'count',label:'Transaction Count'}],                                       dimensions:[{value:'day',label:'Day'},{value:'week',label:'Week'},{value:'month',label:'Month'},{value:'category',label:'Category'},{value:'supplier',label:'Supplier'}] },
  expenses: { key:'expenses', measures:[{value:'value',label:'Total Value (₱)'},{value:'count',label:'Transaction Count'}],                                       dimensions:[{value:'day',label:'Day'},{value:'week',label:'Week'},{value:'month',label:'Month'},{value:'category',label:'Category'}] },
  inventory:{ key:'inventory',measures:[{value:'value',label:'Total Value (₱)'},{value:'units',label:'Units'},{value:'count',label:'Record Count'}],              dimensions:[{value:'day',label:'Day'},{value:'week',label:'Week'},{value:'month',label:'Month'},{value:'category',label:'Category'},{value:'supplier',label:'Supplier'}] },
};
const customState = (() => {
  const d = { source:'sales', measure:'value', groupBy:'month', chartType:'bar', barOrientation:'vertical', pieTopN:8 };
  try { return { ...d, ...JSON.parse(localStorage.getItem('customReportState') || '{}') }; }
  catch(e) { return { ...d }; }
})();
let reportSalesCategory = '';
let reportSalesFlag = '';
let reportPurchaseSupplier = '';
let salesTopN = 5;
let purchasesTopN = 5;
let salesMetric = 'revenue';            // 'revenue' | 'units'
let flaggedSourceRows = [];             // raw flagged sales rows for the current period
let salesRankedAll = [];                // full product ranking for the current period
const salesRankingFilters = {
  product: '', itemCode: '', category: '',
  totalMin: '', totalMax: '', unitsMin: '', unitsMax: '',
  marginMin: '', marginMax: '', flag: ''
};
const flaggedState = {
  page: 1, pageSize: 50, sortKey: 'date', sortDir: 'desc',
  filters: { from: '', to: '', product: '', marginMin: '', marginMax: '', flag: '' }
};
let inventoryTrendMode = 'item';        // 'item' | 'category'
let inventoryTrendSelections = [];      // [{ key, label }] — one line each
let inventoryTrendQuery = '';           // current search text
let inventoryTrendResultOpts = [];      // current dropdown matches (index-referenced)
const invMatrixState = { page: 1, pageSize: 100, sortKey: 'total', sortDir: 'desc', search: '', category: '' };
let reportProgressTimer = null;
const rankingTableSort = {
  sales:{ key:'rank', direction:'asc' },
  purchases:{ key:'rank', direction:'asc' }
};
const reportToday = new Date();
const reportCurrentMonth = `${reportToday.getFullYear()}-${String(reportToday.getMonth() + 1).padStart(2, '0')}`;
const taxRanges = {
  vat:{ from:`${reportCurrentMonth}-01`, to:lastDayOfReportMonth(reportToday.getFullYear(), reportToday.getMonth() + 1) },
  ewt:{ from:`${reportCurrentMonth}-01`, to:lastDayOfReportMonth(reportToday.getFullYear(), reportToday.getMonth() + 1) },
  income:{ from:`${reportCurrentMonth}-01`, to:lastDayOfReportMonth(reportToday.getFullYear(), reportToday.getMonth() + 1) },
};
let taxChartInstances = {};
let taxLiabilityState = { vatPayable:0, ewt:0, incomeTaxStillDue:0 };

function normalizeReportDate(value) {
  if (!value) return '';
  if (typeof value.toDate === 'function') value = value.toDate();
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }
  const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    return `${slashMatch[3]}-${slashMatch[1].padStart(2, '0')}-${slashMatch[2].padStart(2, '0')}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function firstReportValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return '';
}

function reportDate(row) {
  return normalizeReportDate(firstReportValue(row, [
    'date', 'checkVoucherDate', 'Check Voucher Date', 'dateDelivered',
    'datePurchased', 'purchaseDate', 'importedAt'
  ]));
}

function inReportRange(row) {
  const date = reportDate(row);
  const start = document.getElementById('report-start').value;
  const end = document.getElementById('report-end').value;
  return date && (!start || date >= start) && (!end || date <= end);
}

function escReport(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Expand salesDaily/{date} rollup docs into per-line rows matching the shape the
// report pipeline expects (one row per item per day). Range-scoped by the report's
// start/end dates so we only read the days in view (cheap: one read per day).
async function fetchSalesRollupRows() {
  const db = getFirestoreDB();
  if (!db) return DB.get('pos_sales') || [];
  const start = (document.getElementById('report-start') || {}).value || '';
  const end = (document.getElementById('report-end') || {}).value || '';
  const docs = await readDailyRollupDocs(db, 'salesDaily', start, end);
  const rows = [];
  docs.forEach(doc => {
    const data = doc.data() || {};
    const products = data.products || {};
    const date = doc.id;
    Object.keys(products).forEach(code => {
      const p = products[code] || {};
      const units = Number(p.units) || 0;
      const revenue = Number(p.revenue) || 0;
      const unitCost = Number(p.unit_cost) || 0;
      rows.push({
        _firestoreId: `${date}__${code}`,
        date,
        itemCode: code,
        productName: p.name || code,
        category: p.category || '',
        unitsSold: units,
        totalRevenue: revenue,
        sellingPrice: units > 0 ? Math.round((revenue / units) * 10000) / 10000 : 0,
        unitCost,
        totalCost: (p.cost != null ? Number(p.cost) : unitCost * units) || 0,
      });
    });
  });
  return rows;
}

// Expand inventoryDaily/{date} rollup docs into per-item-day rows (Incoming) for
// the report pipeline. Range-scoped: one read per day in view instead of scanning
// the tens-of-thousands-of-row raw inventoryData collection.
async function fetchInventoryRollupRows() {
  const db = getFirestoreDB();
  if (!db) return DB.get('inventory_movements') || [];
  const start = (document.getElementById('report-start') || {}).value || '';
  const end = (document.getElementById('report-end') || {}).value || '';
  const docs = await readDailyRollupDocs(db, 'inventoryDaily', start, end);
  const rows = [];
  docs.forEach(doc => {
    const items = (doc.data() || {}).items || {};
    const date = doc.id;
    Object.keys(items).forEach(code => {
      const it = items[code] || {};
      rows.push({
        _firestoreId: `${date}__${code}`,
        dateDelivered: date,
        date,
        type: 'Incoming',
        itemCode: code,
        description: it.name || '',
        category: '',
        supplier: it.supplier || '',
        unitCost: Number(it.unit_cost) || 0,
        qty: Number(it.qty) || 0,
        totalCost: Number(it.total_cost) || 0,
      });
    });
  });
  return rows;
}

// Latest unit cost per item from the itemCost/{code} rollup. Only the codes that
// actually appear in the loaded sales + inventory rows are fetched (batched
// documentId() 'in' queries) — so a 4,700-code catalog costs only as many reads
// as there are distinct items in the report window, not the whole collection.
let _reportItemCostMap = null;
async function loadReportItemCostMap() {
  if (_reportItemCostMap) return _reportItemCostMap;
  const db = getFirestoreDB();
  const map = {};
  if (!db) { _reportItemCostMap = map; return map; }

  const codes = new Set();
  (REPORT_DATA.inventory || []).forEach(r => { const c = String(r.itemCode || '').trim(); if (c) codes.add(c); });
  (REPORT_DATA.sales || []).forEach(r => { const c = String(r.itemCode || '').trim(); if (c) codes.add(c); });
  const codeList = [...codes];

  const idPath = firebase.firestore.FieldPath.documentId();
  // Up to four requests at once; retain the same scoped document reads.
  for (let i = 0; i < codeList.length; i += 120) {
    const chunks = [];
    for (let j = i; j < Math.min(i + 120, codeList.length); j += 30) {
      chunks.push(codeList.slice(j, j + 30));
    }
    await Promise.all(chunks.map(async chunk => {
      const snap = await db.collection('itemCost').where(idPath, 'in', chunk).get();
      touchReportProgress();
      snap.forEach(doc => {
        const uc = Number((doc.data() || {}).unit_cost) || 0;
        map[doc.id] = uc;
        map[String(doc.id).toUpperCase()] = uc;
      });
    }));
  }

  _reportItemCostMap = map;
  return map;
}

// Sum salesDaily.totals.revenue for all days strictly before the report start.
// Cheap: reads only the day-docs before `from`, once per range change.
async function loadSalesPriorInflow() {
  const from = (document.getElementById('report-start') || {}).value || '';
  const db = getFirestoreDB();
  if (!from || !db) { salesPriorInflow = { before: from, total: 0, earliest: null }; return; }
  const snap = await db.collection('salesDaily')
    .orderBy(firebase.firestore.FieldPath.documentId())
    .endBefore(from).get();
  let total = 0; let earliest = null;
  snap.forEach(doc => {
    const t = (doc.data() || {}).totals || {};
    total += Number(t.revenue) || 0;
    if (earliest === null) earliest = doc.id;   // ordered by id asc → first is earliest
  });
  salesPriorInflow = { before: from, total: Math.round(total * 100) / 100, earliest };
}

async function fetchReportCollection(name, fallbackKey = '') {
  const localRows = fallbackKey ? DB.get(fallbackKey) : [];
  if (name === 'purchases' && localRows.length) return localRows;
  if (name === 'salesDaily') return await fetchSalesRollupRows();
  if (name === 'inventoryDaily') return await fetchInventoryRollupRows();
  const db = getFirestoreDB();
  if (!db) return localRows;
  const snapshot = await db.collection(name).get();
  const rows = snapshot.docs.map(doc => ({ _firestoreId: doc.id, ...doc.data() }));
  if (!snapshot.empty) return rows;
  return localRows;
}

// ─── Session cache for fetched report rows ────────────────────────────────────
// Range-scoped collections (salesDaily, inventoryDaily) are keyed by the report's
// current start/end so switching tabs or re-opening the same period is instant and
// costs zero reads. Non-range collections are keyed by name alone. Cleared by an
// explicit Generate/Refresh (force) or a range change.
const _reportRowCache = new Map();
function reportCacheKey(collectionName) {
  const rangeScoped = collectionName === 'salesDaily' || collectionName === 'inventoryDaily';
  if (!rangeScoped) return collectionName;
  const start = (document.getElementById('report-start') || {}).value || '';
  const end = (document.getElementById('report-end') || {}).value || '';
  return `${collectionName}|${start}|${end}`;
}
function clearReportRowCache() {
  _reportRowCache.clear();
  _reportItemCostMap = null;
  salesPriorInflow = { before: null, total: 0 };
}

async function loadReportCollections(keys, { force = false } = {}) {
  const uniqueKeys = [...new Set(keys)].filter(key => REPORT_COLLECTIONS[key]);
  const keysToLoad = force ? uniqueKeys : uniqueKeys.filter(key => !loadedReportCollections.has(key));
  if (force) clearReportRowCache();   // refresh everything on explicit re-generate
  if (!keysToLoad.length) { reportProgressStep(86, 'Rendering report...'); return; }

  let done = 0;
  const total = keysToLoad.length;
  const loaded = await Promise.all(keysToLoad.map(async key => {
    const cfg = REPORT_COLLECTIONS[key];
    const cacheKey = reportCacheKey(cfg.collection);
    let rows = _reportRowCache.get(cacheKey);
    if (!rows) {
      rows = await fetchReportCollection(cfg.collection, cfg.fallback);
      _reportRowCache.set(cacheKey, rows);
    }
    done += 1;
    reportProgressStep(12 + Math.round((done / total) * 60), `Loading ${key}…`);
    return [cfg.dataKey, rows, key];
  }));
  loaded.forEach(([dataKey, rows, key]) => {
    REPORT_DATA[dataKey] = rows;
  });
  if (keysToLoad.includes('inventory')) {
    reportProgressStep(82, 'Loading item costs…');
    await loadReportItemCostMap();
  }
  backfillSalesCategories();
  loaded.forEach(([, , key]) => loadedReportCollections.add(key));
  reportProgressStep(86, 'Rendering report...');
  if (loadedReportCollections.has('productMaster')) startProductMasterReportListener();
}

// salesDaily rows carry no category (it lives in productMaster). Stamp it on once
// both are loaded so category filters / breakdowns / the inventory matrix work.
function backfillSalesCategories() {
  if (!Array.isArray(REPORT_DATA.sales) || !REPORT_DATA.sales.length) return;
  if (!Array.isArray(REPORT_DATA.productMaster) || !REPORT_DATA.productMaster.length) return;
  const products = reportProductMap();
  REPORT_DATA.sales.forEach(row => {
    if (row.category) return;
    const code = String(row.itemCode || row.code || '').trim();
    const p = products[code] || products[code.toUpperCase()];
    if (p && p.category) row.category = p.category;
  });
}

async function ensureActiveReportData({ force = false } = {}) {
  await loadReportCollections(REPORT_TAB_COLLECTIONS[activeReportTab] || [], { force });
  // This must also run when Sales was already cached before switching tabs.
  if (activeReportTab === 'cashflow' && needsSalesPriorInflow()) {
    reportProgressStep(84, 'Loading prior sales…');
    await loadSalesPriorInflow();
  }
  reportHasGenerated = true;   // data is now loaded — renderActiveReport may paint
}

function needsSalesPriorInflow() {
  const from = (document.getElementById('report-start') || {}).value || '';
  return salesPriorInflow.before !== from;
}

// Product Master is loaded on demand via loadReportCollections (a one-time .get()).
// The old persistent onSnapshot listener re-read the whole collection and
// re-rendered on every change — removed to keep report reads bounded and cheap.
function startProductMasterReportListener() { /* no-op: productMaster loads on demand */ }

// YYYY-MM-DD in the browser's own time zone. Do not use toISOString() for this:
// it converts to UTC, which is 8 hours behind the Philippines, so local midnight
// becomes the previous day (This Year showed 12/31/2025 to 12/30/2026).
function localReportIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function setDefaultReportDates() {
  const now = new Date();
  document.getElementById('report-start').value =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  document.getElementById('report-end').value =
    localReportIsoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
}

async function setReportPreset(preset) {
  const now = new Date();
  let start;
  let end;
  if (preset === 'last-month') {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 0);
  } else if (preset === 'quarter') {
    start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    end = new Date(start.getFullYear(), start.getMonth() + 3, 0);
  } else if (preset === 'year') {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear(), 11, 31);
  } else if (preset === 'custom') {
    document.getElementById('report-start').focus();
    return;
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  }
  document.getElementById('report-start').value = localReportIsoDate(start);
  document.getElementById('report-end').value = localReportIsoDate(end);
  // Only fill in the dates. The loaded data is for the old dates, so mark it as
  // stale and show the prompt; Generate Report (or Apply) loads the new range.
  markReportDataStale();
  reportLoadError = null;
  renderActiveReport();
}

// Forget which collections are loaded so the next Generate reads them again for
// the current dates. The row cache is kept: range-scoped rows are keyed by their
// dates, and the rest don't depend on the dates.
function markReportDataStale() {
  loadedReportCollections.clear();
  _reportItemCostMap = null;
}

async function setReportTab(tab) {
  if (tab === 'custom' && !FEATURE_CUSTOM_REPORT) return;
  activeReportTab = tab;
  document.querySelectorAll('[data-report-tab]').forEach(button => {
    button.classList.toggle('active', button.dataset.reportTab === tab);
  });
  // Switching tabs never reads data by itself (each read costs money). If this
  // tab's data is already loaded it shows right away; otherwise renderActiveReport
  // shows the "Click Generate Report" prompt and waits for the button.
  reportLoadError = null;
  renderActiveReport();
}

// True when the active tab still needs data that hasn't been loaded yet.
function activeTabNeedsLoad() {
  return (REPORT_TAB_COLLECTIONS[activeReportTab] || [])
    .some(key => !loadedReportCollections.has(key)) ||
    (activeReportTab === 'cashflow' && needsSalesPriorInflow());
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

function setReportProgress(value, label = '') {
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  document.getElementById('report-loading-fill').style.width = `${percent}%`;
  document.getElementById('report-loading-percent').textContent = `${percent}%`;
  if (label) document.getElementById('report-loading-label').textContent = label;
}

function waitReportFrame() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

// Real progress: the load pipeline calls reportProgressStep(pct, label) at genuine
// checkpoints (fetching each collection, running the item-cost map, rendering).
// Between checkpoints a gentle timer eases the bar forward a little so it never
// looks frozen, but it can't overtake the next real checkpoint.
let _reportProgressCeiling = 100;
function reportProgressStep(value, label = '') {
  touchReportProgress();
  _reportProgressCeiling = value;
  setReportProgress(value, label);
}

async function withReportProgress(label, task) {
  const loading = document.getElementById('report-loading');
  const applyButton = document.getElementById('btn-apply-report-range');
  clearInterval(reportProgressTimer);
  loading.classList.add('active');
  applyButton.disabled = true;
  _reportProgressCeiling = 12;
  setReportProgress(8, label);
  await waitReportFrame();

  // Ease toward — but never past — the latest real checkpoint.
  reportProgressTimer = setInterval(() => {
    const current = parseInt(document.getElementById('report-loading-percent').textContent, 10) || 0;
    if (current < _reportProgressCeiling - 1) {
      setReportProgress(Math.min(current + 2, _reportProgressCeiling - 1));
    }
  }, 120);

  try {
    const result = await task();
    clearInterval(reportProgressTimer);
    setReportProgress(100, 'Report ready.');
    setTimeout(() => loading.classList.remove('active'), 300);
    return result;
  } catch (error) {
    clearInterval(reportProgressTimer);
    setReportProgress(100, 'Report failed.');
    setTimeout(() => loading.classList.remove('active'), 900);
    throw error;
  } finally {
    applyButton.disabled = false;
  }
}

function renderCards(cards) {
  document.getElementById('report-summary').innerHTML = cards.map(card => `
    <div class="summary-card">
      <div class="kpi-label">${escReport(card.label)}</div>
      <div class="kpi-value ${card.cls || ''}">${card.value}</div>
      ${card.note ? `<div class="kpi-sub">${escReport(card.note)}</div>` : ''}
    </div>`).join('');
}

function renderTable(cardId, title, headers, rows) {
  const secondary = cardId === 'secondary';
  const card = document.getElementById(`report-${cardId}-card`);
  card.style.display = '';
  document.getElementById(`report-${cardId}-title`).textContent = title;
  document.getElementById(`report-${cardId}-head`).innerHTML =
    `<tr>${headers.map(header => `<th>${escReport(header)}</th>`).join('')}</tr>`;
  document.getElementById(`report-${cardId}-body`).innerHTML = rows.length
    ? rows.join('')
    : `<tr><td colspan="${headers.length}"><div class="empty-state"><p>No data for this period.</p></div></td></tr>`;
  if (!secondary) document.getElementById('report-primary-card').style.display = '';
}

function hideSecondaryTable() {
  document.getElementById('report-secondary-card').style.display = 'none';
}

function drawChart(type, labels, data, label, color = '#1a56db', chartOptions = {}) {
  const card = document.getElementById('report-chart-card');
  if (!labels.length || typeof Chart === 'undefined') {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  if (reportChart) {
    if (reportChart === purchasesBarChart) purchasesBarChart = null;
    reportChart.destroy();
  }
  const chartType = type === 'area' ? 'line' : type;
  reportChart = new Chart(document.getElementById('report-chart'), {
    type: chartType,
    data: { labels, datasets: [{ label, data, backgroundColor: color, borderColor: color,
      borderRadius:chartOptions.borderRadius || 0, fill: type === 'area', tension: 0.25 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: chartOptions.indexAxis,
      scales: chartOptions.scales || (chartOptions.forceZero ? { y:{ beginAtZero:true, min:0 } } : undefined),
      plugins: {
        legend: { display: !chartOptions.hideLegend },
        title: chartOptions.title ? { display:true, text:chartOptions.title, font:{ size:13, weight:'500' } } : undefined,
        tooltip: chartOptions.pesoTooltips ? {
          callbacks: {
            label: context => `₱${Number(context.raw || 0).toLocaleString('en-PH', {
              minimumFractionDigits:2, maximumFractionDigits:2
            })}`
          }
        } : undefined
      }
    }
  });
}

function renderCategoryChart(rows, labelFn, valueFn, title) {
  if (typeof Chart === 'undefined') return;
  const colors = ['#3b82f6', '#16a34a', '#d97706', '#dc2626', '#7c3aed',
    '#0891b2', '#db2777', '#65a30d', '#6b7280'];
  const totals = grouped(rows, labelFn, valueFn).sort((a, b) => b[1] - a[1]);
  const chartRows = totals.slice(0, 8);
  const others = totals.slice(8).reduce((total, row) => total + row[1], 0);
  if (others > 0) chartRows.push(['Others', others]);
  if (reportCategoryChart) reportCategoryChart.destroy();
  reportCategoryChart = new Chart(document.getElementById('report-category-chart'), {
    type:'doughnut',
    data:{
      labels:chartRows.map(row => row[0]),
      datasets:[{ data:chartRows.map(row => row[1]), backgroundColor:colors,
        borderWidth:2, borderColor:'#ffffff' }]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{
        legend:{ position:'right', labels:{ font:{ size:11 }, padding:12 } },
        title:{ display:true, text:title, font:{ size:13, weight:'500' } },
        tooltip:{ callbacks:{ label:context => {
          const total = context.dataset.data.reduce((sum, value) => sum + value, 0);
          const percent = total ? (context.parsed / total * 100).toFixed(1) : '0.0';
          const value = `₱${Number(context.parsed || 0).toLocaleString('en-PH', {
            minimumFractionDigits:2, maximumFractionDigits:2
          })}`;
          return ` ${context.label}: ${value} (${percent}%)`;
        } } }
      }
    }
  });
}

function shortenChartLabel(value) {
  const text = String(value);
  return text.length > 20 ? `${text.slice(0, 20)}…` : text;
}

function getRankedChartHeight(n) {
  return (n * 36) + 80;
}

function getPurchasesChartHeight(n) {
  return (n * 36) + 80;
}

function renderTopNChart(rows, title, color, selectedN, type = 'sales', opts = {}) {
  const isPurchases = type === 'purchases';
  const height = isPurchases ? getPurchasesChartHeight(selectedN) : getRankedChartHeight(selectedN);
  const container = document.getElementById(isPurchases ? 'purchases-bar-container' : 'sales-bar-container');
  document.getElementById('report-chart-card').style.height = `${height}px`;
  container.style.height = `${height - 32}px`;
  if (isPurchases && purchasesBarChart) {
    purchasesBarChart.destroy();
    if (reportChart === purchasesBarChart) reportChart = null;
    purchasesBarChart = null;
  }
  const isUnits = opts.units;
  drawChart('bar', rows.map(row => shortenChartLabel(row.name)),
    rows.map(row => opts.valueFn ? opts.valueFn(row) : row.total),
    title, color, {
      indexAxis:'y', hideLegend:true, pesoTooltips: !isUnits, borderRadius:4,
      title,
      scales:{ x:{ beginAtZero:true, ticks:{ callback: isUnits
        ? (value => Number(value).toLocaleString())
        : (value => `₱${(value / 1000000).toFixed(1)}M`) } } }
    });
  if (isPurchases) purchasesBarChart = reportChart;
}

function setReportTopN(value) {
  const selected = Math.max(1, Math.round(Number(value) || 5));
  if (activeReportTab === 'sales') salesTopN = selected;
  if (activeReportTab === 'purchases') purchasesTopN = selected;
  renderActiveReport();
}

function renderTopNControl(selected, noun, showMetric = false) {
  const metric = showMetric ? `
    <span class="report-metric-toggle">
      <button type="button" class="report-metric-btn${salesMetric==='revenue'?' on':''}" onclick="setSalesMetric('revenue')">Amount (₱)</button>
      <button type="button" class="report-metric-btn${salesMetric==='units'?' on':''}" onclick="setSalesMetric('units')">Units</button>
    </span>` : '';
  const fullReport = showMetric
    ? '<button type="button" class="btn btn-outline-gray btn-sm" onclick="openFullProductReport()">Open full report →</button>'
    : '';
  document.getElementById('report-top-n-control').innerHTML = `
    <span>Show top:</span>
    <input type="number" min="1" class="form-input" style="width:84px" value="${selected}" onchange="setReportTopN(this.value)">
    <span>${noun}</span>${metric}${fullReport}`;
}

function openFullProductReport() {
  const payload = {
    metric: salesMetric,
    topN: salesTopN,
    from: document.getElementById('report-start').value,
    to: document.getElementById('report-end').value,
    rows: salesRankedAll,   // full ranking — the full page can re-slice to any N
  };
  localStorage.setItem('salesFullReport', JSON.stringify(payload));
  window.open('reports-products.html', '_blank');
}

function reportTableLabel(table) {
  const card = table.closest('.card, section, .tax-report-section, .tax-table-block') || table.parentElement;
  const heading = card ? card.querySelector('h1, h2, h3, h4, .section-title') : null;
  return heading ? heading.textContent.trim() : '';
}

function exportActiveReportToPDF() {
  const out = document.getElementById('report-output');
  const title = document.getElementById('report-title').textContent || 'Report';
  const subtitle = document.getElementById('report-subtitle').textContent || '';
  const from = document.getElementById('report-start').value;
  const to = document.getElementById('report-end').value;
  let body = `<h1>${wordEsc(title)}</h1>`;
  if (subtitle) body += `<p class="meta">${wordEsc(subtitle)}</p>`;
  if (from || to) body += `<p class="meta">Period: ${wordEsc(from || '—')} to ${wordEsc(to || '—')}</p>`;
  let any = false;
  out.querySelectorAll('table').forEach(table => {
    if (table.offsetParent === null || !table.rows.length) return;
    const label = reportTableLabel(table);
    if (label) body += `<h3>${wordEsc(label)}</h3>`;
    body += serializeTableToWord(table);
    any = true;
  });
  if (!any) { alert('No table data to export on this tab.'); return; }
  printReportPDF(title, body);
}

function exportActiveReportToExcel() {
  const out = document.getElementById('report-output');
  const title = document.getElementById('report-title').textContent || 'Report';
  let parts = `<h3>${wordEsc(title)}</h3>`;
  let any = false;
  out.querySelectorAll('table').forEach(table => {
    if (table.offsetParent === null || !table.rows.length) return;
    const label = reportTableLabel(table);
    if (label) parts += `<p><b>${wordEsc(label)}</b></p>`;
    parts += serializeTableToExcel(table);
    any = true;
  });
  if (!any) { alert('No table data to export on this tab.'); return; }
  downloadExcel(title, parts);
}

function sortRankingRows(rows, type) {
  const sort = rankingTableSort[type];
  return [...rows].sort((a, b) => {
    const left = a[sort.key];
    const right = b[sort.key];
    const result = typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left ?? '').localeCompare(String(right ?? ''));
    return sort.direction === 'asc' ? result : -result;
  });
}

function setRankingTableSort(type, key) {
  const sort = rankingTableSort[type];
  sort.direction = sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc';
  sort.key = key;
  renderActiveReport();
}

function setSalesRankingFilter(key, value) {
  salesRankingFilters[key] = value;
  renderActiveReport();
}

function passesNumberRange(value, min, max) {
  const num = Number(value) || 0;
  return (min === '' || num >= Number(min)) && (max === '' || num <= Number(max));
}

function salesRankingFilterRows(rows) {
  const f = salesRankingFilters;
  const text = value => String(value || '').toLowerCase();
  return rows
    .filter(row => !f.product || text(row.name).includes(text(f.product)))
    .filter(row => !f.itemCode || text(row.itemCode).includes(text(f.itemCode)))
    .filter(row => !f.category || row.category === f.category)
    .filter(row => passesNumberRange(row.total, f.totalMin, f.totalMax))
    .filter(row => passesNumberRange(row.units, f.unitsMin, f.unitsMax))
    .filter(row => passesNumberRange(row.margin, f.marginMin, f.marginMax))
    .filter(row => !f.flag || row.flag === f.flag);
}

function reportFlagBadge(flag) {
  if (flag === 'Loss') return '<span class="report-flag-badge low">Low Margin</span>';
  if (flag === 'High Margin') return '<span class="report-flag-badge high">High Margin</span>';
  return '<span class="report-flag-badge normal">Normal</span>';
}

function reportMarginClass(flag) {
  if (flag === 'Loss') return 'report-margin-low';
  if (flag === 'High Margin') return 'report-margin-high';
  return 'report-margin-normal';
}

function salesRankingFilterCell(column) {
  const f = salesRankingFilters;
  const categories = [...new Set(salesRankedAll.map(row => row.category).filter(Boolean))].sort();
  const range = (minKey, maxKey) => `<div class="report-range-filter">
    <input type="number" class="form-input" placeholder="Min" value="${escReport(f[minKey])}" onchange="setSalesRankingFilter('${minKey}',this.value)">
    <span>-</span>
    <input type="number" class="form-input" placeholder="Max" value="${escReport(f[maxKey])}" onchange="setSalesRankingFilter('${maxKey}',this.value)">
  </div>`;
  if (column.key === 'name') {
    return `<input type="text" class="form-input" placeholder="Filter..." value="${escReport(f.product)}" onchange="setSalesRankingFilter('product',this.value)">`;
  }
  if (column.key === 'itemCode') {
    return `<input type="text" class="form-input" placeholder="Filter..." value="${escReport(f.itemCode)}" onchange="setSalesRankingFilter('itemCode',this.value)">`;
  }
  if (column.key === 'category') {
    return `<select class="form-select" onchange="setSalesRankingFilter('category',this.value)">
      <option value="">All Categories</option>
      ${categories.map(category => `<option value="${escReport(category)}"${category === f.category ? ' selected' : ''}>${escReport(category)}</option>`).join('')}
    </select>`;
  }
  if (column.key === 'total') return range('totalMin', 'totalMax');
  if (column.key === 'units') return range('unitsMin', 'unitsMax');
  if (column.key === 'margin') return range('marginMin', 'marginMax');
  if (column.key === 'flag') {
    return `<select class="form-select" onchange="setSalesRankingFilter('flag',this.value)">
      <option value="">All</option>
      <option value="Loss"${f.flag === 'Loss' ? ' selected' : ''}>Low Margin</option>
      <option value="High Margin"${f.flag === 'High Margin' ? ' selected' : ''}>High Margin</option>
      <option value="Normal"${f.flag === 'Normal' ? ' selected' : ''}>Normal</option>
    </select>`;
  }
  return '';
}

function renderRankingTable(title, type, columns, rows) {
  const sort = rankingTableSort[type];
  renderTable('primary', title, columns.map(column => column.label), sortRankingRows(rows, type).map(row => `
    <tr>${columns.map(column => `<td class="${column.numeric ? 'mono' : ''}">${column.render(row)}</td>`).join('')}</tr>`));
  const filterRow = type === 'sales'
    ? `<tr class="report-filter-row">${columns.map(column => `<th>${salesRankingFilterCell(column)}</th>`).join('')}</tr>`
    : '';
  document.getElementById('report-primary-head').innerHTML = `<tr>${columns.map(column => `
    <th><button class="sortable-report-header" onclick="setRankingTableSort('${type}','${column.key}')">
      ${column.label}${sort.key === column.key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}
    </button></th>`).join('')}</tr>${filterRow}`;
}

function grouped(rows, labelFn, valueFn) {
  const values = new Map();
  rows.forEach(row => {
    const label = labelFn(row);
    values.set(label, (values.get(label) || 0) + valueFn(row));
  });
  return [...values.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

function monthLabel(row) {
  return reportDate(row).slice(0, 7) || 'Unknown';
}

function salesFlag(row) {
  const margin = Number(row.margin) || 0;
  const high = Number(localStorage.getItem('marginHighThreshold') ?? 30);
  if (margin < 0) return 'Loss';
  if (margin > high) return 'High Margin';
  return 'Normal';
}

function reportInventoryCostDate(row) {
  return String(row?.dateDelivered || row?.rowDate || row?.date || row?.importedAt || '').slice(0, 10);
}

// Latest unit cost per item — served from the itemCost rollup (loaded during
// loadReportCollections). Falls back to whatever is in the loaded inventory rows.
function reportInventoryUnitCostMap() {
  if (_reportItemCostMap && Object.keys(_reportItemCostMap).length) return _reportItemCostMap;
  // Fallback: derive from loaded inventoryDaily rows if itemCost wasn't available.
  const latestByCode = {};
  (REPORT_DATA.inventory || []).forEach(row => {
    const code = String(row.itemCode || row.code || '').trim();
    const unitCost = Number(row.unitCost) || 0;
    if (!code || unitCost <= 0) return;
    if (String(row.type || 'Incoming').toLowerCase() === 'outgoing') return;
    const date = reportInventoryCostDate(row);
    const saved = latestByCode[code] || latestByCode[code.toUpperCase()];
    if (!saved || date >= saved.date) {
      const entry = { unitCost, date };
      latestByCode[code] = entry;
      latestByCode[code.toUpperCase()] = entry;
    }
  });
  return Object.fromEntries(Object.entries(latestByCode).map(([code, entry]) => [code, entry.unitCost]));
}

function reportProductMap() {
  const map = {};
  REPORT_DATA.productMaster.forEach(product => {
    const code = String(product.itemCode || product.code || '').trim();
    if (!code) return;
    map[code] = product;
    map[code.toUpperCase()] = product;
  });
  return map;
}

function reportProductCost(product, method) {
  if (!product) return 0;
  const latest = Number(product.latestCost ?? product.unitCost ?? product.cost) || 0;
  const average = Number(product.averageCost) || 0;
  return method === 'average' ? (average || latest) : (latest || average);
}

function reportCostedSales(rows) {
  const method = localStorage.getItem('costMethod') === 'average' ? 'average' : 'latest';
  const inventoryCosts = reportInventoryUnitCostMap();
  const products = reportProductMap();
  return rows.map(row => {
    const unitsSold = Number(row.unitsSold ?? row.qty ?? row.quantity) || 0;
    const totalRevenue = Number(row.totalRevenue ?? row.revenue ?? row.totalSales ?? row.total) || 0;
    const sellingPrice = Number(row.sellingPrice ?? row.srpUnit ?? row.srp) || (unitsSold > 0 ? totalRevenue / unitsSold : 0);
    const code = String(row.itemCode || row.code || '').trim();
    const product = products[code] || products[code.toUpperCase()];
    const unitCost = Number(inventoryCosts[code] || inventoryCosts[code.toUpperCase()]) ||
      Number(row.unitCost ?? row.latestCost ?? row.cost) ||
      reportProductCost(product, method);
    const totalCost = unitCost * unitsSold;
    if (!(totalRevenue > 0) || !(unitCost > 0)) return null;
    const grossProfit = sellingPrice - unitCost;
    const margin = Number(((sellingPrice - unitCost) / unitCost * 100).toFixed(4));
    return { ...row, unitsSold, sellingPrice, unitCost, totalRevenue, totalCost, grossProfit, margin, costMethod: method };
  }).filter(Boolean);
}

function renderIncomeStatement() {
  const sales = REPORT_DATA.sales.filter(inReportRange);
  const expenses = REPORT_DATA.expenses.filter(inReportRange);
  const supplies = REPORT_DATA.supplies.filter(inReportRange);
  const costedSales = reportCostedSales(sales);
  const totals = getPOSTotals(costedSales);
  const grossRevenue = totals.grossRevenue;
  const discounts = totals.discounts;
  const srpwdDiscounts = totals.srpwdDiscounts;
  const netRevenue = totals.netRevenue;
  const cogs = totals.cogs;
  const grossProfit = totals.profit;
  const margin = cogs > 0 ? ((grossRevenue - cogs) / cogs * 100).toFixed(4) : '0.0000';
  const operatingExpenses = sum(expenses, 'amount');
  const suppliesExpense = supplies.reduce((total, row) => total + (Number(row.totalCost ?? row.amount) || 0), 0);
  const totalExpenses = operatingExpenses + suppliesExpense;
  const netIncome = grossProfit - totalExpenses;
  const chartData = [
    grossRevenue, netRevenue, cogs, grossProfit, operatingExpenses, suppliesExpense, totalExpenses, netIncome
  ].map(value => Math.abs(value));
  const chartColors = [
    '#16a34a', '#16a34a', '#dc2626', '#2563eb', '#dc2626', '#d97706', '#dc2626',
    netIncome >= 0 ? '#16a34a' : '#dc2626'
  ];
  drawChart('bar',
    ['Gross Revenue', 'Net Revenue', 'COGS', 'Gross Profit', 'Op. Expenses', 'Supplies', 'Total Expenses', 'Net Income'],
    chartData,
    'Income Statement',
    chartColors,
    { forceZero:true, hideLegend:true, pesoTooltips:true });
  renderTable('primary', 'Income Statement', ['Line Item', 'Amount'], [
    `<tr class="section-header"><td colspan="2">REVENUE</td></tr>`,
    statementRow('Gross Revenue', grossRevenue),
    statementRow('Less: Discounts', -discounts, true),
    statementRow('Less: SR/PWD Discounts', -srpwdDiscounts, true),
    statementRow('Net Revenue', netRevenue, false, 'subtotal'),
    `<tr class="statement-rule"><td colspan="2"></td></tr>`,
    `<tr class="section-header"><td colspan="2">COST OF GOODS SOLD</td></tr>`,
    statementRow('COGS', cogs, true),
    `<tr class="statement-rule"><td colspan="2"></td></tr>`,
    statementRow('GROSS PROFIT', grossProfit, false, 'subtotal'),
    statementRow('MARGIN %', `${margin}%`, false),
    `<tr class="statement-spacer"><td colspan="2"></td></tr>`,
    `<tr class="section-header"><td colspan="2">OPERATING EXPENSES</td></tr>`,
    statementRow('General Expenses', operatingExpenses, true),
    statementRow('Supplies Expense', suppliesExpense, true),
    statementRow('Total Operating Expenses', totalExpenses, true, 'subtotal'),
    `<tr class="statement-rule"><td colspan="2"></td></tr>`,
    statementRow('NET INCOME', netIncome, false, 'net-income', true),
  ]);
  hideSecondaryTable();
}

function formatStatementAmount(value, parentheses = false, signedColor = false) {
  if (typeof value === 'string') return value;
  const amount = Number(value) || 0;
  const formatted = formatPeso(Math.abs(amount));
  const display = parentheses || amount < 0 ? `(${formatted})` : formatted;
  if (!signedColor) return display;
  return `<span class="${amount < 0 ? 'amount-negative' : 'amount-positive'}">${display}</span>`;
}

function statementRow(label, value, parentheses = false, rowClass = '', signedColor = false) {
  return `<tr class="${rowClass}">
    <td>${label}</td><td class="mono">${formatStatementAmount(value, parentheses, signedColor)}</td>
  </tr>`;
}

function salesFilters(rows) {
  return rows.filter(row => !reportSalesCategory || row.category === reportSalesCategory)
    .filter(row => !reportSalesFlag || salesFlag(row) === reportSalesFlag);
}

function setReportSalesCategory(value) {
  reportSalesCategory = value;
  renderActiveReport();
}

function setReportSalesFlag(value) {
  reportSalesFlag = value;
  renderActiveReport();
}

function setReportPurchaseSupplier(value) {
  reportPurchaseSupplier = value;
  renderActiveReport();
}

function salesRankAllProducts(rows) {
  const products = new Map();
  rows.forEach(row => {
    const name = row.productName || row.itemCode || 'Unknown';
    const key = `${name}\u0000${row.itemCode || ''}\u0000${row.category || 'Uncategorized'}`;
    const current = products.get(key) || {
      name, itemCode:row.itemCode || '', category:row.category || 'Uncategorized',
      total:0, grossRevenue:0, cogs:0, units:0, profit:0
    };
    const revenue = Number(row.totalRevenue) || 0;
    const grossRevenue = posGrossRevenue(row);
    const cogs = Number(row.totalCost) || 0;
    const grossProfit = Number(row.grossProfit);
    current.total += revenue;
    current.grossRevenue += grossRevenue;
    current.cogs += cogs;
    current.units += Number(row.unitsSold) || 0;
    current.profit += grossRevenue - cogs;
    products.set(key, current);
  });
  const metricVal = r => salesMetric === 'units' ? r.units : r.total;
  return [...products.values()]
    .sort((a, b) => metricVal(b) - metricVal(a))
    .map((row, index) => {
      const ranked = { ...row, rank:index + 1, margin:row.cogs ? row.profit / row.cogs * 100 : 0 };
      ranked.flag = salesFlag(ranked);
      return ranked;
    });
}

function salesRankingColumns() {
  return [
    { key:'rank', label:'Rank', numeric:true, render:row => row.rank },
    { key:'name', label:'Product Name', render:row => escReport(row.name) },
    { key:'itemCode', label:'Item Code', render:row => escReport(row.itemCode || '—') },
    { key:'category', label:'Category', render:row => escReport(row.category) },
    { key:'total', label:'Total Revenue', numeric:true, render:row => formatPeso(row.total) },
    { key:'units', label:'Units Sold', numeric:true, render:row => row.units.toLocaleString() },
    { key:'margin', label:'Avg Margin %', numeric:true, render:row => `<span class="${reportMarginClass(row.flag)}">${Number(row.margin || 0).toFixed(4)}%</span>` },
    { key:'flag', label:'Flag', render:row => reportFlagBadge(row.flag) },
  ];
}

function setSalesMetric(metric) {
  salesMetric = metric === 'units' ? 'units' : 'revenue';
  renderActiveReport();
}

function purchaseSpend(row) {
  return Number(firstReportValue(row, [
    'netAmount', 'Purchase Net of Vat', 'purchaseNetOfVat',
    'total', 'amount', 'totalCost', 'totalAmount'
  ])) || 0;
}

function purchaseGrossAmount(row) {
  const explicit = Number(firstReportValue(row, [
    'grossAmount', 'Purchase Gross of Vat', 'purchaseGrossOfVat', 'totalAmount'
  ]));
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return purchaseSpend(row) + purchaseInputVAT(row);
}

function purchaseSupplier(row) {
  return firstReportValue(row, [
    'supplier', 'Supplier', 'supplierName', 'Supplier Name', 'vendorName', 'Vendor Name'
  ]) || 'Unknown';
}

function purchasesSupplierRanking(rows) {
  const suppliers = new Map();
  rows.forEach(row => {
    const name = purchaseSupplier(row);
    const current = suppliers.get(name) || { name, total:0, transactions:0 };
    current.total += purchaseSpend(row);
    current.transactions += 1;
    suppliers.set(name, current);
  });
  return [...suppliers.values()].sort((a, b) => b.total - a.total)
    .slice(0, purchasesTopN).map((row, index) => ({
      ...row, rank:index + 1, average:row.transactions ? row.total / row.transactions : 0
    }));
}

function purchaseMetricAmount(row, keys) {
  return Number(firstReportValue(row, keys)) || 0;
}

function purchaseAdjustmentMetrics(rows) {
  const totalPurchases = rows.reduce((value, row) => value + purchaseSpend(row), 0);
  const metricDefs = [
    { key:'discounts', label:'Discounts', keys:['discounts', 'Discounts'] },
    { key:'badOrder', label:'Bad Orders', keys:['badOrder', 'badOrders', 'Bad Orders'] },
    { key:'returns', label:'Returns', keys:['returns', 'Returns'] },
    { key:'noStock', label:'No Stock', keys:['noStock', 'No Stock'] },
    { key:'lacking', label:'Lacking', keys:['lacking', 'Lacking'] },
    { key:'ewt', label:'EWT Withheld', keys:['ewtAmount', 'EWT'] },
    { key:'otherDeductions', label:'Other Deductions', keys:['otherDeduction', 'otherDeductions', 'Other Deductions'] },
    { key:'otherIncome', label:'Other Income', keys:['otherIncome', 'Other Income'] },
  ];
  return metricDefs.map(metric => {
    const amount = rows.reduce((sumValue, row) => sumValue + purchaseMetricAmount(row, metric.keys), 0);
    const affectedRows = rows.filter(row => purchaseMetricAmount(row, metric.keys) > 0).length;
    return {
      ...metric,
      amount,
      affectedRows,
      percent: totalPurchases > 0 ? amount / totalPurchases * 100 : 0
    };
  });
}

function reportPurchasesData() {
  const localPurchases = DB.get('purchases');
  if (localPurchases.length) {
    REPORT_DATA.purchases = localPurchases;
    return localPurchases;
  }
  return REPORT_DATA.purchases;
}

function renderSalesReport() {
  const rows = salesFilters(reportCostedSales(REPORT_DATA.sales.filter(inReportRange)));
  const revenue = sum(rows, 'totalRevenue');
  const units = sum(rows, 'unitsSold');
  const totals = getPOSTotals(rows);
  const profit = totals.profit;
  const flagged = rows.filter(row => salesFlag(row) !== 'Normal');
  const categories = [...new Set(REPORT_DATA.sales.map(row => row.category).filter(Boolean))].sort();
  document.getElementById('report-extra-filters').innerHTML = `
    <select class="form-select" id="report-sales-category" onchange="setReportSalesCategory(this.value)">
      <option value="">All Categories</option>${categories.map(v => `<option${v === reportSalesCategory ? ' selected' : ''}>${escReport(v)}</option>`).join('')}
    </select>
    <select class="form-select" id="report-sales-flag" onchange="setReportSalesFlag(this.value)">
      <option value="">All Flags</option><option${reportSalesFlag === 'Loss' ? ' selected' : ''}>Loss</option><option${reportSalesFlag === 'High Margin' ? ' selected' : ''}>High Margin</option><option${reportSalesFlag === 'Normal' ? ' selected' : ''}>Normal</option>
    </select>`;
  renderCards([
    { label:'Total Revenue', value:formatPeso(revenue), cls:'green' },
    { label:'Total Units Sold', value:units.toLocaleString() },
    { label:'Avg Margin %', value:`${totals.cogs ? (profit / totals.cogs * 100).toFixed(4) : '0.0000'}%`, cls:'blue' },
    { label:'Flagged Items', value:flagged.length.toLocaleString(), cls:'red' },
  ]);
  salesRankedAll = salesRankAllProducts(rows);
  flaggedSourceRows = flagged;
  renderTopNControl(salesTopN, 'products', true);

  const metricLabel = salesMetric === 'units' ? 'Units Sold' : 'Revenue';
  const rankedForDisplay = salesRankingFilterRows(salesRankedAll);
  const top = rankedForDisplay.slice(0, salesTopN);
  document.getElementById('report-category-chart-card').style.display = '';
  renderTopNChart(top, `Top ${salesTopN} Products by ${metricLabel}`, '#3b82f6', salesTopN, 'sales',
    { units: salesMetric === 'units', valueFn: row => salesMetric === 'units' ? row.units : row.total });
  renderCategoryChart(rows, row => row.category || 'Uncategorized',
    row => salesMetric === 'units' ? (Number(row.unitsSold) || 0) : (Number(row.totalRevenue) || 0),
    `${metricLabel} by Category`);
  renderRankingTable(`Top ${salesTopN} Products by ${metricLabel}`, 'sales', salesRankingColumns(), top);
  renderFlaggedItems();
}

function setFlaggedFilter(key, value) { flaggedState.filters[key] = value; flaggedState.page = 1; renderFlaggedItems(); }
function setFlaggedSort(key) {
  if (flaggedState.sortKey === key) flaggedState.sortDir = flaggedState.sortDir === 'asc' ? 'desc' : 'asc';
  else { flaggedState.sortKey = key; flaggedState.sortDir = 'asc'; }
  flaggedState.page = 1; renderFlaggedItems();
}
function goFlaggedPage(p) { flaggedState.page = p; renderFlaggedItems(); }

function renderFlaggedItems() {
  const card = document.getElementById('report-secondary-card');
  card.style.display = '';
  document.getElementById('report-secondary-title').textContent = 'Flagged Items';
  const f = flaggedState.filters;
  const rows = flaggedSourceRows.map(row => ({
    date: reportDate(row), product: row.productName || row.itemCode || 'Unknown',
    margin: Number(row.margin) || 0, flag: salesFlag(row)
  }))
    .filter(r => !f.from || r.date >= f.from)
    .filter(r => !f.to || r.date <= f.to)
    .filter(r => !f.product || r.product.toLowerCase().includes(f.product.toLowerCase()))
    .filter(r => passesNumberRange(r.margin, f.marginMin, f.marginMax))
    .filter(r => !f.flag || r.flag === f.flag);
  rows.sort((a, b) => {
    const l = a[flaggedState.sortKey], r = b[flaggedState.sortKey];
    const cmp = typeof l === 'number' && typeof r === 'number' ? l - r : String(l).localeCompare(String(r));
    return flaggedState.sortDir === 'asc' ? cmp : -cmp;
  });
  const pages = Math.max(1, Math.ceil(rows.length / flaggedState.pageSize));
  if (flaggedState.page > pages) flaggedState.page = pages;
  const startIdx = (flaggedState.page - 1) * flaggedState.pageSize;
  const visible = rows.slice(startIdx, startIdx + flaggedState.pageSize);
  const arrow = k => flaggedState.sortKey === k ? (flaggedState.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  const cols = [['date','Date'],['product','Product'],['margin','Margin'],['flag','Flag']];
  document.getElementById('report-secondary-head').innerHTML = `
    <tr>${cols.map(([k,l]) => `<th><button class="sortable-report-header" onclick="setFlaggedSort('${k}')">${l}${arrow(k)}</button></th>`).join('')}</tr>
    <tr class="flagged-filter-row">
      <th><div class="flagged-date-filter"><input type="date" class="form-input" value="${f.from}" onchange="setFlaggedFilter('from',this.value)"><input type="date" class="form-input" value="${f.to}" onchange="setFlaggedFilter('to',this.value)"></div></th>
      <th><input type="text" class="form-input" placeholder="Filter…" value="${escReport(f.product)}" onchange="setFlaggedFilter('product',this.value)"></th>
      <th><div class="report-range-filter"><input type="number" class="form-input" placeholder="Min" value="${escReport(f.marginMin)}" onchange="setFlaggedFilter('marginMin',this.value)"><span>-</span><input type="number" class="form-input" placeholder="Max" value="${escReport(f.marginMax)}" onchange="setFlaggedFilter('marginMax',this.value)"></div></th>
      <th><select class="form-select" onchange="setFlaggedFilter('flag',this.value)">
        <option value="">All</option><option value="Loss"${f.flag==='Loss'?' selected':''}>Low Margin</option><option value="High Margin"${f.flag==='High Margin'?' selected':''}>High Margin</option>
      </select></th>
    </tr>`;
  document.getElementById('report-secondary-body').innerHTML = visible.length
    ? visible.map(r => `<tr><td>${formatDate(r.date)}</td><td>${escReport(r.product)}</td><td><span class="${reportMarginClass(r.flag)}">${r.margin.toFixed(4)}%</span></td><td>${reportFlagBadge(r.flag)}</td></tr>`).join('')
    : `<tr><td colspan="4"><div class="empty-state"><p>No flagged items match the filters.</p></div></td></tr>`;
  document.getElementById('flagged-pagination')?.remove();
  const startNum = rows.length ? startIdx + 1 : 0;
  card.insertAdjacentHTML('beforeend', `<div class="inventory-pagination" id="flagged-pagination">
    <span>Showing ${startNum}–${Math.min(startIdx + flaggedState.pageSize, rows.length)} of ${rows.length} flagged items</span>
    <button class="btn btn-outline-gray btn-sm" ${flaggedState.page === 1 ? 'disabled' : ''} onclick="goFlaggedPage(${flaggedState.page - 1})">Prev</button>
    <span>Page ${flaggedState.page} / ${pages}</span>
    <button class="btn btn-outline-gray btn-sm" ${flaggedState.page === pages ? 'disabled' : ''} onclick="goFlaggedPage(${flaggedState.page + 1})">Next</button>
  </div>`);
}

function renderPurchasesReport() {
  const purchases = reportPurchasesData();
  const rows = purchases.filter(inReportRange);
  document.getElementById('report-extra-filters').innerHTML = '';
  const total = rows.reduce((value, row) => value + purchaseSpend(row), 0);
  const gross = rows.reduce((value, row) => value + purchaseGrossAmount(row), 0);
  const metrics = purchaseAdjustmentMetrics(rows);
  const deductionKeys = new Set(['discounts', 'badOrder', 'returns', 'noStock', 'lacking', 'otherDeductions']);
  const totalDeductions = metrics
    .filter(metric => deductionKeys.has(metric.key))
    .reduce((value, metric) => value + metric.amount, 0);
  const ewtTotal = metrics.find(metric => metric.key === 'ewt')?.amount || 0;
  renderCards([
    { label:'Net Purchases', value:formatPeso(total), cls:'blue' },
    { label:'Gross Purchases', value:formatPeso(gross) },
    { label:'Total Deductions', value:`${formatPeso(totalDeductions)} (${total ? (totalDeductions / total * 100).toFixed(2) : '0.00'}%)`, cls:'red' },
    { label:'EWT Withheld', value:`${formatPeso(ewtTotal)} (${total ? (ewtTotal / total * 100).toFixed(2) : '0.00'}%)`, cls:'green' },
  ]);
  const from = document.getElementById('report-start').value;
  const to = document.getElementById('report-end').value;
  const months = (from && to) ? reportMonthsBetween(from, to) : [];
  const monthlySpend = months.map(month =>
    rows.filter(row => (reportDate(row) || '').startsWith(month)).reduce((value, row) => value + purchaseSpend(row), 0));
  drawChart('line',
    months.map(reportMonthDisplay),
    monthlySpend,
    'Net Purchases',
    '#2563eb',
    {
      pesoTooltips:true,
      hideLegend:true,
      title:'Net Purchases by Month',
      scales:{ y:{ beginAtZero:true, ticks:{ callback:value => `₱${(value / 1000000).toFixed(1)}M` } } }
    });
  if (reportCategoryChart) { reportCategoryChart.destroy(); reportCategoryChart = null; }
  document.getElementById('report-category-chart-card').style.display = 'none';
  const adjCols = [
    { key:'discounts', label:'Discounts' },
    { key:'badOrder', label:'Bad Orders' },
    { key:'returns', label:'Returns' },
    { key:'noStock', label:'No Stock' },
    { key:'lacking', label:'Lacking' },
    { key:'ewt', label:'EWT Withheld' },
  ];
  const monthlyRows = months.map(month => {
    const monthRows = rows.filter(row => (reportDate(row) || '').startsWith(month));
    const monthGross = monthRows.reduce((value, row) => value + purchaseGrossAmount(row), 0);
    const percentByKey = Object.fromEntries(purchaseAdjustmentMetrics(monthRows).map(metric => [metric.key, metric.percent]));
    return `<tr>
      <td>${escReport(reportMonthDisplay(month))}</td>
      <td class="mono">${formatPeso(monthGross)}</td>
      ${adjCols.map(col => `<td class="mono">${(percentByKey[col.key] || 0).toFixed(2)}%</td>`).join('')}
    </tr>`;
  });
  renderTable('primary', 'Monthly Purchase Adjustments (% of Net Purchases)',
    ['Month', 'Gross Purchases', ...adjCols.map(col => `${col.label} %`)],
    monthlyRows);
  hideSecondaryTable();
}

function localReportISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function lastDayOfReportMonth(year, month) {
  return localReportISO(new Date(Number(year), Number(month), 0));
}

function filterTaxRange(rows, range) {
  return rows.filter(row => {
    const date = reportDate(row);
    return date && date >= range.from && date <= range.to;
  });
}

function taxPresetRange(preset) {
  const today = new Date();
  let start;
  let end;
  if (preset === 'last-month') {
    start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    end = new Date(today.getFullYear(), today.getMonth(), 0);
  } else if (preset === 'quarter') {
    start = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1);
    end = new Date(start.getFullYear(), start.getMonth() + 3, 0);
  } else if (preset === 'year') {
    start = new Date(today.getFullYear(), 0, 1);
    end = new Date(today.getFullYear(), 11, 31);
  } else {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
    end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  }
  return { from:localReportISO(start), to:localReportISO(end) };
}

function setTaxRangePreset(section, preset) {
  if (preset === 'custom') {
    document.getElementById(`tax-${section}-from`).focus();
    return;
  }
  taxRanges[section] = taxPresetRange(preset);
  renderTaxSummary();
}

function applyTaxRange(section) {
  withReportProgress('Applying tax range...', async () => {
    taxRanges[section] = {
      from:document.getElementById(`tax-${section}-from`).value,
      to:document.getElementById(`tax-${section}-to`).value
    };
    await waitReportFrame();
    renderTaxSummary();
  });
}

function taxRangeControls(section) {
  const range = taxRanges[section];
  return `${['month','last-month','quarter','year'].map(preset =>
    `<button class="btn btn-outline-gray btn-sm" type="button" onclick="setTaxRangePreset('${section}','${preset}')">${{
      month:'This Month', 'last-month':'Last Month', quarter:'This Quarter', year:'This Year'
    }[preset]}</button>`).join('')}
    <button class="btn btn-outline-gray btn-sm" type="button" onclick="setTaxRangePreset('${section}','custom')">Custom</button>
    <label>From <input class="form-input" type="date" id="tax-${section}-from" value="${range.from}"></label>
    <label>To <input class="form-input" type="date" id="tax-${section}-to" value="${range.to}"></label>
    <button class="btn btn-primary btn-sm" type="button" onclick="applyTaxRange('${section}')">Apply</button>`;
}

function getPeriodDates(periodType, periodValue) {
  if (periodType === 'monthly') {
    const [year, month] = periodValue.split('-');
    return { from:`${periodValue}-01`, to:lastDayOfReportMonth(year, month) };
  }
  if (periodType === 'quarterly') {
    const [year, quarter] = periodValue.split('-Q');
    return {
      from:`${year}-${String((Number(quarter) - 1) * 3 + 1).padStart(2, '0')}-01`,
      to:lastDayOfReportMonth(year, Number(quarter) * 3)
    };
  }
  return { from:`${periodValue}-01-01`, to:`${periodValue}-12-31` };
}

function taxCards(targetId, cards) {
  document.getElementById(targetId).innerHTML = cards.map(card => `<div class="summary-card">
    <div class="kpi-label">${card.label}</div><div class="kpi-value ${card.cls || ''}">${card.value}</div>
  </div>`).join('');
}

function replaceTaxChart(key, canvasId, config) {
  if (taxChartInstances[key]) taxChartInstances[key].destroy();
  if (typeof Chart === 'undefined') return;
  taxChartInstances[key] = new Chart(document.getElementById(canvasId), config);
}

function reportMonthsBetween(from, to) {
  const months = [];
  const cursor = new Date(`${from.slice(0, 7)}-01T00:00:00`);
  const last = to.slice(0, 7);
  while (localReportISO(cursor).slice(0, 7) <= last) {
    months.push(localReportISO(cursor).slice(0, 7));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

function reportMonthDisplay(month) {
  return new Date(`${month}-01T00:00:00`).toLocaleDateString('en-PH', { month:'short', year:'numeric' });
}

function purchaseInputVAT(row) {
  const explicit = firstReportValue(row, ['inputVAT', 'vatAmount', 'VAT']);
  if (explicit != null && explicit !== '') return Number(explicit) || 0;
  const gross = Number(firstReportValue(row, [
    'grossAmount', 'Purchase Gross of Vat', 'purchaseGrossOfVat', 'totalAmount'
  ])) || 0;
  const net = purchaseSpend(row);
  return gross > net ? gross - net : 0;
}

function purchaseEWT(row) {
  return Number(row.ewtAmount ?? row.withholdingTax ?? 0) || 0;
}

function purchaseVATNonCreditable(row) {
  return row.inputVATCreditable === false ||
    row.vatCreditable === false ||
    row.isVATCreditable === false ||
    row.inputVATCreditable === 'no' ||
    row.vatCreditable === 'no';
}

function reportExpenseIsDeductible(row) {
  return String(row.classification || '').toLowerCase() === 'business' && !(
    row.taxDeductible === false ||
    row.deductible === false ||
    row.taxTreatment === 'Non-deductible' ||
    row.deductibility === 'Non-deductible' ||
    row.taxDeductible === 'no' ||
    row.deductible === 'no'
  );
}

function calculateIncomeTax(range) {
  const revenue = sum(filterTaxRange(REPORT_DATA.esales, range), 'grossSales');
  const cogs = filterTaxRange(reportPurchasesData(), range).reduce((total, row) => total + purchaseSpend(row), 0);
  const expenses = filterTaxRange(REPORT_DATA.expenses, range)
    .filter(reportExpenseIsDeductible)
    .reduce((total, row) => total + (Number(row.amount ?? row.grossAmount ?? row.netAmount) || 0), 0);
  const supplies = filterTaxRange(REPORT_DATA.supplies, range).reduce((total, row) => total + (Number(row.totalCost ?? row.amount) || 0), 0);
  const grossProfit = revenue - cogs;
  const taxable = grossProfit - expenses - supplies;
  return { revenue, cogs, expenses, supplies, grossProfit, taxable, due:taxable > 0 ? taxable * .25 : 0 };
}

function renderTaxVATSection() {
  document.getElementById('tax-vat-controls').innerHTML = taxRangeControls('vat');
  const sales = filterTaxRange(REPORT_DATA.esales, taxRanges.vat);
  const purchases = filterTaxRange(reportPurchasesData(), taxRanges.vat);
  const vatOutput = sum(sales, 'vatAmount');
  const vatInput = purchases
    .filter(row => !purchaseVATNonCreditable(row))
    .reduce((total, row) => total + purchaseInputVAT(row), 0);
  const difference = vatOutput - vatInput;
  taxLiabilityState.vatPayable = Math.max(0, difference);
  taxCards('tax-vat-summary', [
    { label:'VAT Output', value:formatPeso(vatOutput), cls:'red' },
    { label:'VAT Input', value:formatPeso(vatInput), cls:'blue' },
    { label:difference < 0 ? 'VAT Creditable' : 'VAT Payable', value:formatPeso(Math.abs(difference)), cls:difference < 0 ? 'green' : 'red' },
  ]);
  replaceTaxChart('vatClassification', 'tax-vat-classification-chart', {
    type:'doughnut', data:{ labels:['VATable Sales','VAT Exempt','Zero Rated'], datasets:[{
      data:[sum(sales,'vatableSales'),sum(sales,'vatExempt'),sum(sales,'zeroRated')],
      backgroundColor:['#3b82f6','#d97706','#16a34a'], borderColor:'#fff', borderWidth:2
    }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{ title:{ display:true,text:'Sales Classification' } } }
  });
  const months = reportMonthsBetween(taxRanges.vat.from, taxRanges.vat.to);
  replaceTaxChart('vatTrend', 'tax-vat-trend-chart', {
    type:'bar',
    data:{
      labels:months.map(reportMonthDisplay),
      datasets:[
        {
          label:'VAT Output',
          data:months.map(month => sum(sales.filter(row => reportDate(row).startsWith(month)), 'vatAmount')),
          backgroundColor:'#dc2626'
        },
        {
          label:'VAT Input',
          data:months.map(month => purchases
            .filter(row => reportDate(row).startsWith(month) && !purchaseVATNonCreditable(row))
            .reduce((total, row) => total + purchaseInputVAT(row), 0)),
          backgroundColor:'#2563eb'
        }
      ]
    },
    options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } }, plugins:{ title:{ display:true,text:'VAT Output vs Input VAT by Month' } } }
  });
}

function ewtMonthlyRows() {
  const purchases = filterTaxRange(reportPurchasesData(), taxRanges.ewt);
  return reportMonthsBetween(taxRanges.ewt.from, taxRanges.ewt.to).map(month => {
    const rows = purchases.filter(row => reportDate(row).startsWith(month));
    const totalPurchases = rows.reduce((total, row) => total + purchaseSpend(row), 0);
    const ewt = rows.reduce((total, row) => total + purchaseEWT(row), 0);
    const stored = REPORT_DATA.ewtRemittances.find(row => row._firestoreId === month);
    return { month, totalPurchases, ewt, rate:totalPurchases ? ewt / totalPurchases * 100 : 0, status:stored?.status || 'due' };
  });
}

async function toggleEwtRemittance(month) {
  const row = REPORT_DATA.ewtRemittances.find(item => item._firestoreId === month);
  const status = row?.status === 'remitted' ? 'due' : 'remitted';
  const ewtAmount = ewtMonthlyRows().find(item => item.month === month)?.ewt || 0;
  await getFirestoreDB().collection('ewtRemittances').doc(month).set({ month, ewtAmount, status }, { merge:true });
  if (row) row.status = status; else REPORT_DATA.ewtRemittances.push({ _firestoreId:month, month, ewtAmount, status });
  renderTaxSummary();
}

function renderTaxEWTSection() {
  document.getElementById('tax-ewt-controls').innerHTML = taxRangeControls('ewt');
  const purchases = filterTaxRange(reportPurchasesData(), taxRanges.ewt);
  const months = ewtMonthlyRows();
  const totalPurchases = purchases.reduce((total,row) => total + purchaseSpend(row), 0);
  const ewt = purchases.reduce((total,row) => total + purchaseEWT(row), 0);
  taxLiabilityState.ewt = months.filter(row => row.status !== 'remitted').reduce((total, row) => total + row.ewt, 0);
  taxCards('tax-ewt-summary', [
    { label:'Total EWT Withheld', value:formatPeso(ewt), cls:'red' },
    { label:'Total Suppliers with EWT', value:new Set(purchases.filter(row => purchaseEWT(row)).map(purchaseSupplier)).size.toLocaleString() },
    { label:'Avg EWT Rate %', value:`${totalPurchases ? (ewt / totalPurchases * 100).toFixed(2) : '0.00'}%` },
  ]);
  document.getElementById('tax-ewt-remittance-body').innerHTML = months.map(row => `<tr>
    <td>${escReport(reportMonthDisplay(row.month))}</td><td class="mono">${formatPeso(row.totalPurchases)}</td><td>${row.rate.toFixed(2)}%</td>
    <td class="mono">${formatPeso(row.ewt)}</td><td><button class="tax-remittance-toggle ${row.status}" onclick="toggleEwtRemittance('${row.month}')">${row.status === 'remitted' ? 'Remitted' : 'Due'}</button></td>
  </tr>`).join('');
  replaceTaxChart('ewtMonthly', 'tax-ewt-monthly-chart', {
    type:'bar', data:{ labels:months.map(row => reportMonthDisplay(row.month)), datasets:[{ label:'EWT Withheld', data:months.map(row => row.ewt), backgroundColor:'#d97706' }] },
    options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } }, plugins:{ title:{ display:true,text:'Monthly EWT Withheld' } } }
  });
  const monthlyCard = document.getElementById('tax-ewt-monthly-chart')?.closest('.tax-chart-card');
  const supplierCard = document.getElementById('tax-ewt-suppliers-chart')?.closest('.tax-chart-card');
  if (monthlyCard) monthlyCard.style.gridColumn = '1 / -1';
  if (supplierCard) supplierCard.style.display = 'none';
  if (taxChartInstances.ewtSuppliers) {
    taxChartInstances.ewtSuppliers.destroy();
    taxChartInstances.ewtSuppliers = null;
  }
}

function renderTaxIncomeSection() {
  document.getElementById('tax-income-controls').innerHTML = taxRangeControls('income');
  const range = taxRanges.income;
  const result = calculateIncomeTax(range);
  taxLiabilityState.incomeTaxStillDue = result.due;
  taxCards('tax-income-summary', [
    { label:'Income Tax Due', value:formatPeso(result.due), cls:'red' },
    { label:'Tax Still Due', value:formatPeso(result.due), cls:'red' },
  ]);
  document.getElementById('tax-income-computation-body').innerHTML = [
    statementRow('Gross Income (E-Sales)', result.revenue), statementRow('Less: COGS (Purchases)', result.cogs, true),
    '<tr class="statement-rule"><td colspan="2"></td></tr>', statementRow('Gross Profit', result.grossProfit, false, 'subtotal'),
    statementRow('Less: General Expenses', result.expenses, true), statementRow('Less: Supplies Expense', result.supplies, true),
    '<tr class="statement-rule"><td colspan="2"></td></tr>', statementRow('Net Taxable Income', result.taxable, false, 'subtotal', true),
    '<tr><td>× Tax Rate</td><td class="mono">25%</td></tr>', statementRow('Income Tax Due', result.due, false, 'subtotal'),
    '<tr class="statement-rule"><td colspan="2"></td></tr>',
    statementRow('TAX STILL DUE', result.due, false, 'net-income', true)
  ].join('');
  const trendPeriods = reportMonthsBetween(range.from, range.to)
    .map(month => [reportMonthDisplay(month), { from:`${month}-01`, to:lastDayOfReportMonth(month.slice(0, 4), month.slice(5, 7)) }]);
  replaceTaxChart('incomeTrend', 'tax-income-trend-chart', {
    type:'line', data:{ labels:trendPeriods.map(row => row[0]), datasets:[{ label:'Income Tax Due', data:trendPeriods.map(row => calculateIncomeTax(row[1]).due), borderColor:'#7c3aed', backgroundColor:'#7c3aed', tension:.25 }] },
    options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } }, plugins:{ title:{ display:true,text:'Income Tax Due Trend' } } }
  });
}

function renderTaxLiabilitySummary() {
  const total = taxLiabilityState.vatPayable + taxLiabilityState.ewt + taxLiabilityState.incomeTaxStillDue;
  document.getElementById('tax-liability-period-note').textContent =
    `VAT ${taxRanges.vat.from} to ${taxRanges.vat.to} · EWT ${taxRanges.ewt.from} to ${taxRanges.ewt.to} · Income Tax ${taxRanges.income.from} to ${taxRanges.income.to}`;
  document.getElementById('tax-dedicated-liability-body').innerHTML = `
    <div class="tax-liability-row"><span>VAT Payable</span><strong>${formatPeso(taxLiabilityState.vatPayable)}</strong></div>
    <div class="tax-liability-row"><span>EWT to Remit (current period)</span><strong>${formatPeso(taxLiabilityState.ewt)}</strong></div>
    <div class="tax-liability-row"><span>Income Tax Still Due</span><strong>${formatPeso(taxLiabilityState.incomeTaxStillDue)}</strong></div>
    <div class="tax-liability-row tax-liability-total"><span>TOTAL TAX LIABILITY</span><span>${formatPeso(total)}</span></div>`;
}

function renderTaxSummary() {
  renderTaxVATSection();
  renderTaxEWTSection();
  renderTaxIncomeSection();
  renderTaxLiabilitySummary();
}

function renderInventoryReport() {
  const incoming = REPORT_DATA.inventory.filter(inReportRange)
    .filter(row => String(row.type || 'Incoming').toLowerCase() === 'incoming');
  const value = incoming.reduce((total, row) => total + Number(row.total ?? row.totalCost ?? 0), 0);
  const quantity = incoming.reduce((total, row) => total + Number(row.quantity ?? row.qty ?? 0), 0);
  const unique = new Set(incoming.map(row => row.itemCode).filter(Boolean)).size;
  renderCards([
    { label:'Total Incoming Value', value:formatPeso(value), cls:'green' },
    { label:'Total Items Received', value:quantity.toLocaleString() },
    { label:'Unique Products', value:unique.toLocaleString() },
  ]);
  renderInventoryTrendControls();
  renderInventorySalesTrend();
  renderInventoryMonthlyMatrix();
  hideSecondaryTable();
}

function inventoryMatrixRows() {
  const map = new Map();
  REPORT_DATA.sales.filter(inReportRange).forEach(row => {
    const code = String(row.itemCode || '').trim();
    if (!code) return;
    const month = (reportDate(row) || '').slice(0, 7);
    let rec = map.get(code);
    if (!rec) { rec = { code, name: row.productName || code, category: row.category || 'Uncategorized', monthly: {}, total: 0 }; map.set(code, rec); }
    const units = Number(row.unitsSold) || 0;
    if (month) rec.monthly[month] = (rec.monthly[month] || 0) + units;
    rec.total += units;
  });
  return [...map.values()];
}

function setInvMatrixSearch(value) { invMatrixState.search = value; invMatrixState.page = 1; renderInventoryMonthlyMatrix(); }
function setInvMatrixCategory(value) { invMatrixState.category = value; invMatrixState.page = 1; renderInventoryMonthlyMatrix(); }
function setInvMatrixSort(key) {
  if (invMatrixState.sortKey === key) invMatrixState.sortDir = invMatrixState.sortDir === 'asc' ? 'desc' : 'asc';
  else { invMatrixState.sortKey = key; invMatrixState.sortDir = ['code', 'name', 'category'].includes(key) ? 'asc' : 'desc'; }
  invMatrixState.page = 1; renderInventoryMonthlyMatrix();
}
function goInvMatrixPage(p) { invMatrixState.page = p; renderInventoryMonthlyMatrix(); }

function renderInventoryMonthlyMatrix() {
  const st = invMatrixState;
  const from = document.getElementById('report-start').value;
  const to = document.getElementById('report-end').value;
  const months = (from && to) ? reportMonthsBetween(from, to) : [];
  const allRows = inventoryMatrixRows();
  const categories = [...new Set(allRows.map(r => r.category).filter(Boolean))].sort();
  document.getElementById('report-primary-title').textContent = 'Monthly Sales by Item (Units)';
  document.getElementById('inventory-movement-controls').innerHTML = `<div class="inventory-controls-grid inventory-controls-row">
    <label>Date Range <span>${from || '—'} to ${to || '—'}</span></label>
    <label>Search <input class="form-input inventory-search" placeholder="Search item code or name…" value="${escReport(st.search)}" onchange="setInvMatrixSearch(this.value)"></label>
    <label>Category <select class="form-select" onchange="setInvMatrixCategory(this.value)"><option value="">All</option>${categories.map(c => `<option${st.category === c ? ' selected' : ''}>${escReport(c)}</option>`).join('')}</select></label>
  </div>`;
  const q = st.search.trim().toLowerCase();
  const rows = allRows
    .filter(r => !q || r.code.toLowerCase().includes(q) || String(r.name).toLowerCase().includes(q))
    .filter(r => !st.category || r.category === st.category)
    .sort((a, b) => {
      let av, bv;
      if (st.sortKey === 'code') { av = a.code; bv = b.code; }
      else if (st.sortKey === 'name') { av = a.name; bv = b.name; }
      else if (st.sortKey === 'category') { av = a.category; bv = b.category; }
      else if (st.sortKey === 'total') { av = a.total; bv = b.total; }
      else { av = a.monthly[st.sortKey] || 0; bv = b.monthly[st.sortKey] || 0; }
      const cmp = (typeof av === 'number' && typeof bv === 'number') ? av - bv : String(av).localeCompare(String(bv));
      return st.sortDir === 'asc' ? cmp : -cmp;
    });
  const pages = Math.max(1, Math.ceil(rows.length / st.pageSize));
  if (st.page > pages) st.page = pages;
  const startIdx = (st.page - 1) * st.pageSize;
  const visible = rows.slice(startIdx, startIdx + st.pageSize);
  const arrow = k => st.sortKey === k ? (st.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  const headerCols = [['code', 'Item Code'], ['name', 'Description'], ['category', 'Category'],
    ...months.map(m => [m, reportMonthDisplay(m)]), ['total', 'Total']];
  document.getElementById('report-primary-head').innerHTML =
    `<tr>${headerCols.map(([k, l]) => `<th class="sortable" onclick="setInvMatrixSort('${k}')">${escReport(l)}${arrow(k)}</th>`).join('')}</tr>`;
  document.getElementById('report-primary-body').innerHTML = visible.length
    ? visible.map(r => `<tr>
        <td class="mono">${escReport(r.code)}</td>
        <td>${escReport(r.name)}</td>
        <td>${escReport(r.category)}</td>
        ${months.map(m => `<td class="mono">${(r.monthly[m] || 0).toLocaleString()}</td>`).join('')}
        <td class="mono"><strong>${r.total.toLocaleString()}</strong></td>
      </tr>`).join('')
    : `<tr><td colspan="${headerCols.length}"><div class="empty-state"><p>No sales for the selected period.</p></div></td></tr>`;
  document.getElementById('inventory-movement-pagination')?.remove();
  const startNum = rows.length ? startIdx + 1 : 0;
  document.getElementById('report-primary-card').insertAdjacentHTML('beforeend', `<div class="inventory-pagination" id="inventory-movement-pagination">
    <span>Showing ${startNum}–${Math.min(startIdx + st.pageSize, rows.length)} of ${rows.length} items</span>
    <button class="btn btn-outline-gray btn-sm" ${st.page === 1 ? 'disabled' : ''} onclick="goInvMatrixPage(${st.page - 1})">Prev</button>
    <span>Page ${st.page} / ${pages}</span>
    <button class="btn btn-outline-gray btn-sm" ${st.page === pages ? 'disabled' : ''} onclick="goInvMatrixPage(${st.page + 1})">Next</button>
  </div>`);
}

function renderInventoryTrendControls() {
  const placeholder = inventoryTrendMode === 'category' ? 'Search category…' : 'Search item code or name…';
  document.getElementById('report-extra-filters').innerHTML = `
    <div class="inv-trend-controls">
      <select class="form-select" onchange="setInventoryTrendMode(this.value)">
        <option value="item"${inventoryTrendMode === 'item' ? ' selected' : ''}>By Item</option>
        <option value="category"${inventoryTrendMode === 'category' ? ' selected' : ''}>By Category</option>
      </select>
      <div class="inv-trend-search-wrap">
        <input class="form-input" id="inv-trend-search" placeholder="${placeholder}" autocomplete="off" oninput="onInventoryTrendSearch(this.value)">
        <div class="inv-trend-results" id="inv-trend-results"></div>
      </div>
      <div class="inv-trend-chips" id="inv-trend-chips"></div>
    </div>`;
  renderInventoryTrendChips();
}

function setInventoryTrendMode(mode) {
  inventoryTrendMode = mode === 'category' ? 'category' : 'item';
  inventoryTrendSelections = [];
  inventoryTrendQuery = '';
  inventoryTrendResultOpts = [];
  renderInventoryTrendControls();
  renderInventorySalesTrend();
}

function onInventoryTrendSearch(value) {
  inventoryTrendQuery = value;
  const el = document.getElementById('inv-trend-results');
  const q = value.trim().toLowerCase();
  if (!q) { inventoryTrendResultOpts = []; el.classList.remove('open'); el.innerHTML = ''; return; }
  const selectedKeys = new Set(inventoryTrendSelections.map(s => s.key));
  if (inventoryTrendMode === 'category') {
    const cats = [...new Set(REPORT_DATA.sales.map(r => r.category || 'Uncategorized'))].sort();
    inventoryTrendResultOpts = cats.filter(c => !selectedKeys.has(c) && c.toLowerCase().includes(q))
      .slice(0, 50).map(c => ({ key: c, label: c }));
  } else {
    const items = new Map();
    REPORT_DATA.sales.forEach(r => {
      const code = String(r.itemCode || '').trim();
      if (code && !items.has(code)) items.set(code, r.productName || code);
    });
    inventoryTrendResultOpts = [...items.entries()]
      .filter(([code, name]) => !selectedKeys.has(code) && (code.toLowerCase().includes(q) || String(name).toLowerCase().includes(q)))
      .slice(0, 50).map(([code, name]) => ({ key: code, label: name }));
  }
  el.innerHTML = inventoryTrendResultOpts.length
    ? inventoryTrendResultOpts.map((o, i) => `<button type="button" class="inv-trend-result" onmousedown="addInventoryTrendSelection(${i})">${escReport(o.label)}${inventoryTrendMode === 'item' ? ` <span style="color:#94a3b8">(${escReport(o.key)})</span>` : ''}</button>`).join('')
    : '<div class="inv-trend-result" style="color:#94a3b8;cursor:default">No matches</div>';
  el.classList.add('open');
}

function addInventoryTrendSelection(index) {
  const opt = inventoryTrendResultOpts[index];
  if (!opt) return;
  if (!inventoryTrendSelections.some(s => s.key === opt.key)) inventoryTrendSelections.push(opt);
  inventoryTrendQuery = '';
  inventoryTrendResultOpts = [];
  const input = document.getElementById('inv-trend-search');
  if (input) input.value = '';
  const results = document.getElementById('inv-trend-results');
  results.classList.remove('open');
  results.innerHTML = '';
  renderInventoryTrendChips();
  renderInventorySalesTrend();
}

function removeInventoryTrendSelection(index) {
  inventoryTrendSelections.splice(index, 1);
  renderInventoryTrendChips();
  renderInventorySalesTrend();
}

function renderInventoryTrendChips() {
  const el = document.getElementById('inv-trend-chips');
  if (!el) return;
  el.innerHTML = inventoryTrendSelections.map((s, i) =>
    `<span class="inv-trend-chip">${escReport(s.label)}<button type="button" onmousedown="removeInventoryTrendSelection(${i})" aria-label="Remove">×</button></span>`).join('');
}

const INVENTORY_TREND_PALETTE = ['#2563eb','#16a34a','#d97706','#dc2626','#7c3aed','#0891b2','#db2777','#65a30d','#f59e0b','#10b981'];

function renderInventorySalesTrend() {
  const card = document.getElementById('report-chart-card');
  card.style.display = '';
  if (typeof Chart === 'undefined') return;
  if (reportChart) { if (reportChart === purchasesBarChart) purchasesBarChart = null; reportChart.destroy(); reportChart = null; }
  const from = document.getElementById('report-start').value;
  const to = document.getElementById('report-end').value;
  const months = (from && to) ? reportMonthsBetween(from, to) : [];
  const inRangeSales = REPORT_DATA.sales.filter(inReportRange);
  const datasets = inventoryTrendSelections.map((sel, i) => {
    const color = INVENTORY_TREND_PALETTE[i % INVENTORY_TREND_PALETTE.length];
    const sales = inRangeSales.filter(row => inventoryTrendMode === 'category'
      ? (row.category || 'Uncategorized') === sel.key
      : String(row.itemCode || '').trim() === sel.key);
    const data = months.map(month =>
      sales.filter(row => (reportDate(row) || '').startsWith(month)).reduce((total, row) => total + (Number(row.unitsSold) || 0), 0));
    return { label: sel.label, data, borderColor: color, backgroundColor: color,
      tension: 0.25, fill: false, pointRadius: 3, borderWidth: 2 };
  });
  const title = datasets.length ? 'Monthly Sales (Units)'
    : 'Search and select item(s) or categories above to view monthly sales (units)';
  reportChart = new Chart(document.getElementById('report-chart'), {
    type: 'line',
    data: { labels: months.map(reportMonthDisplay), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: title, font: { size: 13, weight: '500' } },
        legend: { display: datasets.length > 0, position: 'bottom' },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${Number(ctx.parsed.y).toLocaleString()} units` } }
      },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: 'Units Sold (actual count, not in thousands)' }, ticks: { callback: v => Number(v).toLocaleString() } },
        x: { title: { display: true, text: 'Month' } }
      }
    }
  });
}

function reportInventoryProduct(itemCode) {
  const code = String(itemCode || '').trim();
  return REPORT_DATA.productMaster.find(product =>
    String(product.itemCode || product.code || '').trim() === code);
}

function reportInventoryCategory(itemCode) {
  return String(reportInventoryProduct(itemCode)?.category || '').trim() || 'Uncategorized';
}

function customSourceRows() {
  const key = (CUSTOM_SOURCE_CONFIG[customState.source] || CUSTOM_SOURCE_CONFIG.sales).key;
  return (REPORT_DATA[key] || []).filter(inReportRange);
}

function customGroupLabel(row, groupBy) {
  const date = reportDate(row);
  if (groupBy === 'day') return date || 'Unknown';
  if (groupBy === 'week') {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() - d.getDay());
    return d.toISOString().slice(0, 10);
  }
  if (groupBy === 'category') {
    if (row.category) return row.category;
    return (row.itemCode ? reportInventoryCategory(row.itemCode) : '') || 'Uncategorized';
  }
  if (groupBy === 'supplier') return row.supplier || purchaseSupplier(row) || 'Unknown';
  return (date || '').slice(0, 7) || 'Unknown';
}

function customRowValue(source, measure, row) {
  if (measure === 'count') return 1;
  if (measure === 'units') {
    if (source === 'sales') return Number(row.unitsSold) || 0;
    if (source === 'esales') return Number(row.unitsSold ?? row.qty ?? row.quantity) || 0;
    if (source === 'inventory') return Number(row.quantity ?? row.qty) || 0;
    return 1;
  }
  if (source === 'sales') return Number(row.totalRevenue) || 0;
  if (source === 'esales') return Number(row.grossSales ?? row.totalRevenue) || 0;
  if (source === 'purchases') return purchaseSpend(row);
  if (source === 'expenses') return Number(row.amount) || 0;
  return Number(row.total ?? row.totalCost) || 0;
}

function saveCustomState() {
  localStorage.setItem('customReportState', JSON.stringify(customState));
}

function customMeasureLabel() {
  const cfg = CUSTOM_SOURCE_CONFIG[customState.source] || CUSTOM_SOURCE_CONFIG.sales;
  return cfg.measures.find(m => m.value === customState.measure)?.label || 'Total Value (₱)';
}

function renderCustomSourceControls() {
  const cfg = CUSTOM_SOURCE_CONFIG[customState.source] || CUSTOM_SOURCE_CONFIG.sales;
  if (!cfg.measures.find(m => m.value === customState.measure)) customState.measure = 'value';
  if (!cfg.dimensions.find(d => d.value === customState.groupBy)) customState.groupBy = 'month';
  const mel = document.getElementById('custom-measure');
  const gel = document.getElementById('custom-group-by');
  if (mel) mel.innerHTML = cfg.measures.map(m =>
    `<option value="${m.value}"${m.value === customState.measure ? ' selected' : ''}>${m.label}</option>`).join('');
  if (gel) gel.innerHTML = cfg.dimensions.map(d =>
    `<option value="${d.value}"${d.value === customState.groupBy ? ' selected' : ''}>${d.label}</option>`).join('');
}

function renderCustomChartOptions() {
  const { chartType, barOrientation, pieTopN, groupBy } = customState;
  const el = document.getElementById('custom-chart-options');
  if (!el) return;
  if (chartType === 'bar') {
    const axisHint = barOrientation === 'horizontal' ? 'X = Measure · Y = Dimension' : 'X = Dimension · Y = Measure';
    el.innerHTML = `<div class="custom-chart-option-row">
      <label class="custom-option-label">Orientation
        <select class="form-select" id="custom-bar-orientation"
          onchange="customState.barOrientation=this.value;saveCustomState();document.getElementById('custom-axis-hint').textContent=this.value==='horizontal'?'X = Measure · Y = Dimension':'X = Dimension · Y = Measure'">
          <option value="vertical"${barOrientation === 'vertical' ? ' selected' : ''}>Vertical (columns)</option>
          <option value="horizontal"${barOrientation === 'horizontal' ? ' selected' : ''}>Horizontal (bars)</option>
        </select>
      </label>
      <span class="custom-axis-hint" id="custom-axis-hint">${axisHint}</span>
    </div>`;
  } else if (chartType === 'line' || chartType === 'area') {
    const isTime = ['day', 'week', 'month'].includes(groupBy);
    el.innerHTML = `<div class="custom-chart-option-row">
      <span class="custom-axis-hint">X = Dimension · Y = Measure</span>
      ${!isTime ? '<span class="custom-chart-hint">Line charts read best with a time dimension (Day / Week / Month)</span>' : ''}
    </div>`;
  } else if (chartType === 'pie' || chartType === 'doughnut') {
    el.innerHTML = `<div class="custom-chart-option-row">
      <label class="custom-option-label">Show top N slices
        <input class="form-input" id="custom-pie-top-n" type="number" min="2" max="50" value="${pieTopN}"
          onchange="customState.pieTopN=Math.max(2,Number(this.value)||8);saveCustomState()">
      </label>
      <span class="custom-chart-hint">Remaining slices grouped into "Other"</span>
    </div>`;
  } else {
    el.innerHTML = '';
  }
}

function onCustomSourceChange() {
  customState.source = document.getElementById('custom-source').value;
  renderCustomSourceControls();
  renderCustomChartOptions();
  saveCustomState();
}

function onCustomChartTypeChange() {
  customState.chartType = document.getElementById('custom-chart-type').value;
  renderCustomChartOptions();
  saveCustomState();
}

function onCustomDimensionChange() {
  customState.groupBy = document.getElementById('custom-group-by').value;
  if (customState.chartType === 'line' || customState.chartType === 'area') renderCustomChartOptions();
  saveCustomState();
}

function renderCustomReport() {
  document.getElementById('custom-report-controls').style.display = '';
  const sourceEl = document.getElementById('custom-source');
  const chartTypeEl = document.getElementById('custom-chart-type');
  if (sourceEl) sourceEl.value = customState.source;
  if (chartTypeEl) chartTypeEl.value = customState.chartType;
  renderCustomSourceControls();
  renderCustomChartOptions();
  const { source, measure, groupBy, chartType, barOrientation, pieTopN } = customState;
  const values = grouped(customSourceRows(), row => customGroupLabel(row, groupBy),
    row => customRowValue(source, measure, row));
  customExportRows = values.map(([group, value]) => ({ group, value }));
  const measureLabel = customMeasureLabel();
  const isPeso = measure === 'value';
  const total = values.reduce((s, x) => s + x[1], 0);
  renderCards([
    { label:'Groups', value:values.length.toLocaleString() },
    { label:`Total ${measureLabel}`, value:isPeso ? formatPeso(total) : total.toLocaleString(), cls:'blue' },
  ]);
  const card = document.getElementById('report-chart-card');
  if (!values.length || typeof Chart === 'undefined') {
    card.style.display = 'none';
  } else if (chartType === 'pie' || chartType === 'doughnut') {
    const sorted = [...values].sort((a, b) => b[1] - a[1]);
    const slices = sorted.slice(0, pieTopN);
    const otherSum = sorted.slice(pieTopN).reduce((s, x) => s + x[1], 0);
    if (otherSum > 0) slices.push(['Other', otherSum]);
    const pieTotal = slices.reduce((s, x) => s + x[1], 0);
    const palette = ['#3b82f6','#16a34a','#d97706','#dc2626','#7c3aed','#0891b2','#db2777','#65a30d','#6b7280','#f59e0b','#10b981','#ef4444'];
    card.style.display = '';
    if (reportChart) { if (reportChart === purchasesBarChart) purchasesBarChart = null; reportChart.destroy(); }
    reportChart = new Chart(document.getElementById('report-chart'), {
      type: chartType,
      data: {
        labels: slices.map(x => x[0]),
        datasets: [{ data:slices.map(x => x[1]), backgroundColor:palette.slice(0, slices.length), borderColor:'#fff', borderWidth:2 }]
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins: {
          legend:{ position:'right', labels:{ font:{ size:11 }, padding:12 } },
          title:{ display:true, text:`${measureLabel} by ${groupBy}`, font:{ size:13, weight:'500' } },
          tooltip:{ callbacks:{ label: ctx => {
            const pct = pieTotal ? (ctx.parsed / pieTotal * 100).toFixed(1) : '0.0';
            const fmt = isPeso
              ? `₱${ctx.parsed.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}`
              : ctx.parsed.toLocaleString();
            return ` ${ctx.label}: ${fmt} (${pct}%)`;
          } } }
        }
      }
    });
  } else {
    const isHorizontal = chartType === 'bar' && barOrientation === 'horizontal';
    const pesoTick = { callback: v => `₱${(v / 1000).toFixed(0)}k` };
    const scales = isHorizontal
      ? { x:{ beginAtZero:true, ...(isPeso ? { ticks:pesoTick } : {}) } }
      : (isPeso ? { y:{ beginAtZero:true, ticks:pesoTick } } : null);
    drawChart(chartType, values.map(x => x[0]), values.map(x => x[1]), measureLabel, '#2563eb', {
      indexAxis: isHorizontal ? 'y' : undefined,
      hideLegend: false, pesoTooltips: isPeso,
      forceZero: !scales, borderRadius: chartType === 'bar' ? 4 : 0,
      title: `${measureLabel} by ${groupBy}`,
      scales: scales || undefined,
    });
  }
  renderTable('primary', 'Custom Report Data', ['Group', measureLabel],
    values.map(([label, value]) => `<tr><td>${escReport(label)}</td><td class="mono">${isPeso ? formatPeso(value) : value.toLocaleString()}</td></tr>`));
  hideSecondaryTable();
  requestAnimationFrame(syncCustomHorizontalScroll);
}

// ─── Cash Flow Report ─────────────────────────────────────────────────────────
const CF_OVERRIDE_KEY = 'cfBeginOverride';

function cfComputedBeginBalance(from) {
  if (!from) return 0;
  const before = r => { const d = reportDate(r); return d && d < from; };
  // Sales inflow before the range comes from the salesDaily prior-sum (range-scoped
  // REPORT_DATA.sales no longer holds pre-range rows).
  const inflow  = (salesPriorInflow.before === from) ? salesPriorInflow.total : 0;
  const purchases = reportPurchasesData();
  const purOut  = purchases.filter(before).reduce((s,r) => s+purchaseSpend(r), 0);
  const supOut  = REPORT_DATA.supplies.filter(before).reduce((s,r) => s+(Number(r.totalCost??r.amount)||0), 0);
  return inflow - purOut - supOut;
}

function cfEarliestDate(from) {
  if (!from) return null;
  const purchases = reportPurchasesData();
  const dates = [
    (salesPriorInflow.before === from ? salesPriorInflow.earliest : null),
    ...purchases.map(r => reportDate(r)),
    ...REPORT_DATA.supplies.map(r => reportDate(r)),
  ].filter(d => d && d < from).sort();
  return dates[0] || null;
}

function clearCFOverride() {
  localStorage.removeItem(CF_OVERRIDE_KEY);
  logAudit('Settings', 'Cash Flow', 'Cleared beginning balance override');
  renderCashFlowReport();
}

function saveCFBeginOverride(value) {
  const from = document.getElementById('report-start').value;
  const num = Number(value);
  if (Number.isFinite(num) && Math.abs(num - cfComputedBeginBalance(from)) > 0.005) {
    localStorage.setItem(CF_OVERRIDE_KEY, String(num));
    logAudit('Settings', 'Cash Flow', `Updated beginning balance override to ${formatPeso(num)}`);
  } else {
    localStorage.removeItem(CF_OVERRIDE_KEY);
    logAudit('Settings', 'Cash Flow', 'Reset beginning balance override to computed value');
  }
  renderCashFlowReport();
}

function renderCFBeginSection(from) {
  const section = document.getElementById('cf-begin-section');
  if (!section) return;
  const computed    = cfComputedBeginBalance(from);
  const overrideRaw = localStorage.getItem(CF_OVERRIDE_KEY);
  const hasOverride = overrideRaw !== null;
  const displayVal  = hasOverride ? Number(overrideRaw) : computed;
  const earliest    = cfEarliestDate(from);
  function fmtD(d) {
    if (!d) return '';
    return new Date(`${d}T00:00:00`).toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'});
  }
  const fromDisplay = fmtD(from);
  const dayBefore   = from ? fmtD(new Date(new Date(`${from}T00:00:00`).getTime()-86400000).toISOString().slice(0,10)) : '';
  const coverageHtml = !earliest
    ? `<div class="cf-coverage-note cf-coverage-none">No records before ${escReport(fromDisplay)}. The computed beginning balance is ₱0. Enter a beginning balance manually if cash existed before this date.</div>`
    : `<div class="cf-coverage-note">Beginning balance computed from earliest record (${escReport(fmtD(earliest))}) through ${escReport(dayBefore)}.</div>`;
  const modeTag  = hasOverride
    ? '<span class="cf-mode-tag cf-mode-manual">Manual override</span>'
    : '<span class="cf-mode-tag cf-mode-computed">Computed</span>';
  const resetBtn = hasOverride
    ? '<button class="cf-reset-btn" onclick="clearCFOverride()">Reset to computed</button>'
    : '';
  section.style.display = '';
  section.innerHTML = `
    <div class="cf-begin-row">
      <span class="cf-begin-label">Beginning Balance</span>
      ${modeTag}
      <div class="cf-begin-field">
        <span class="cf-peso-sign">₱</span>
        <input class="form-input cf-begin-input" id="cf-begin-input" type="number" step="0.01"
          value="${displayVal.toFixed(2)}" onchange="saveCFBeginOverride(this.value)">
      </div>
      ${resetBtn}
    </div>
    ${coverageHtml}`;
}

function renderCashFlowReport() {
  const from = document.getElementById('report-start').value;
  const to = document.getElementById('report-end').value;
  renderCFBeginSection(from);
  const salesIn  = REPORT_DATA.sales.filter(inReportRange);
  const purOut   = reportPurchasesData().filter(inReportRange);
  const supOut   = REPORT_DATA.supplies.filter(inReportRange);
  const expOut   = REPORT_DATA.expenses.filter(inReportRange);
  const months   = from && to ? reportMonthsBetween(from, to) : [...new Set([
    ...salesIn.map(r => (reportDate(r)||'').slice(0,7)),
    ...purOut.map(r  => (reportDate(r)||'').slice(0,7)),
    ...supOut.map(r  => (reportDate(r)||'').slice(0,7)),
    ...expOut.map(r  => (reportDate(r)||'').slice(0,7)),
  ])].filter(Boolean).sort();
  const mInflow  = m => salesIn.filter(r=>(reportDate(r)||'').startsWith(m)).reduce((s,r)=>s+(Number(r.totalRevenue)||0),0);
  const mOutflow = m => purOut.filter(r=>(reportDate(r)||'').startsWith(m)).reduce((s,r)=>s+purchaseSpend(r),0)
                      + supOut.filter(r=>(reportDate(r)||'').startsWith(m)).reduce((s,r)=>s+(Number(r.totalCost??r.amount)||0),0)
                      + expOut.filter(r=>(reportDate(r)||'').startsWith(m)).reduce((s,r)=>s+(Number(r.amount)||0),0);
  const totalInflow  = salesIn.reduce((s,r)=>s+(Number(r.totalRevenue)||0),0);
  const totalOutflow = purOut.reduce((s,r)=>s+purchaseSpend(r),0)
                     + supOut.reduce((s,r)=>s+(Number(r.totalCost??r.amount)||0),0)
                     + expOut.reduce((s,r)=>s+(Number(r.amount)||0),0);
  const netCashFlow  = totalInflow - totalOutflow;
  const overrideRaw  = localStorage.getItem(CF_OVERRIDE_KEY);
  const beginBal     = overrideRaw !== null ? Number(overrideRaw) : cfComputedBeginBalance(from);
  const endingBal    = beginBal + netCashFlow;
  renderCards([
    { label:'Total Inflows (Sales)',  value:formatPeso(totalInflow),  cls:'green' },
    { label:'Total Outflows',         value:formatPeso(totalOutflow), cls:'red' },
    { label:'Net Cash Flow',          value:formatPeso(netCashFlow),  cls:netCashFlow>=0?'green':'red' },
    { label:'Ending Balance',         value:formatPeso(endingBal),    cls:endingBal>=0?'green':'red' },
  ]);
  const card = document.getElementById('report-chart-card');
  if (months.length && typeof Chart !== 'undefined') {
    card.style.display = '';
    card.style.height = '280px';
    if (reportChart) { if (reportChart===purchasesBarChart) purchasesBarChart=null; reportChart.destroy(); }
    reportChart = new Chart(document.getElementById('report-chart'), {
      type:'line',
      data:{
        labels: months.map(m=>new Date(`${m}-01T00:00:00`).toLocaleDateString('en-PH',{month:'short',year:'2-digit'})),
        datasets:[
          { label:'Inflows (Sales)', data:months.map(mInflow), borderColor:'#16a34a', backgroundColor:'rgba(22,163,74,0.1)', tension:0.3, fill:true, pointRadius:4, borderWidth:2 },
          { label:'Outflows (Purchases + Supplies)', data:months.map(mOutflow), borderColor:'#dc2626', backgroundColor:'rgba(220,38,38,0.1)', tension:0.3, fill:true, pointRadius:4, borderWidth:2 },
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{
          title:{ display:true, text:'Cash Inflows vs Outflows by Month', font:{size:13,weight:'500'} },
          legend:{ position:'bottom', labels:{font:{size:11},padding:14} },
          tooltip:{ callbacks:{ label:ctx=>` ${ctx.dataset.label}: ₱${ctx.parsed.y.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}` } },
        },
        scales:{ y:{ beginAtZero:true, ticks:{ callback:v=>`₱${(v/1000).toFixed(0)}k` } } },
      }
    });
  } else {
    card.style.display = 'none';
  }
  if (reportCategoryChart) { reportCategoryChart.destroy(); reportCategoryChart=null; }
  document.getElementById('report-category-chart-card').style.display = 'none';
  let runBal = beginBal;
  const tableRows = months.map(m => {
    const inflow=mInflow(m), outflow=mOutflow(m), net=inflow-outflow;
    const openBal=runBal; runBal+=net; const closeBal=runBal;
    const mLbl=new Date(`${m}-01T00:00:00`).toLocaleDateString('en-PH',{month:'long',year:'numeric'});
    return `<tr>
      <td>${escReport(mLbl)}</td>
      <td class="mono" style="color:#16a34a">${formatPeso(inflow)}</td>
      <td class="mono" style="color:#dc2626">${formatPeso(outflow)}</td>
      <td class="mono ${net>=0?'amount-positive':'amount-negative'}">${formatPeso(net)}</td>
      <td class="mono">${formatPeso(openBal)}</td>
      <td class="mono ${closeBal>=0?'amount-positive':'amount-negative'}">${formatPeso(closeBal)}</td>
    </tr>`;
  });
  renderTable('primary','Cash Flow by Period',['Period','Inflows','Outflows','Net Cash Flow','Opening Balance','Closing Balance'],tableRows);
  hideSecondaryTable();
}

const REPORT_META = {
  income:['Income Statement', 'Revenue, COGS, expenses, and net income'],
  sales:['Sales Report', 'Sales performance, product ranking, and margin flags'],
  purchases:['Purchases Report', 'Purchase deductions, EWT, and adjustment ratios'],
  tax:['Tax Summary', 'VAT and EWT obligations for the selected period'],
  inventory:['Inventory Report', 'Incoming inventory value and product quantities'],
  cashflow:['Cash Flow Report', 'Beginning balance, period inflows, outflows, and running balance'],
  custom:['Custom Report', 'Build a chart from the selected data source'],
};

function renderActiveReport() {
  // Never paint the report from an empty cache — that silently shows ₱0 figures.
  const emptyState = document.getElementById('rep-empty-state');
  const output = document.getElementById('report-output');
  // A failed load (quota/network/permission) shows a clear notice, not zeros.
  if (reportLoadError) {
    if (emptyState) {
      emptyState.style.display = '';
      emptyState.classList.add('report-load-error');
      emptyState.innerHTML = `<strong>⚠️ Report data could not be loaded</strong><br>${escReport(reportLoadError)}`;
    }
    if (output) output.style.display = 'none';
    return;
  }
  if (emptyState) emptyState.classList.remove('report-load-error');
  // Until data has been generated, show the empty-state prompt and hide the output.
  if (!reportHasGenerated || activeTabNeedsLoad()) {
    if (emptyState) {
      emptyState.style.display = '';
      const tabBtn = document.querySelector(`[data-report-tab="${activeReportTab}"]`);
      const tabName = tabBtn ? tabBtn.textContent.trim() : 'this';
      emptyState.innerHTML = `Pick the dates above, then click <strong>Generate Report</strong> to load the ${escReport(tabName)} report.`;
    }
    // The Tax tab hides the date bar once loaded; bring it back so the
    // Generate Report button is always reachable from the prompt.
    const controls = document.querySelector('.report-controls');
    if (controls) controls.style.display = '';
    if (output) output.style.display = 'none';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';
  if (output) output.style.display = '';

  const rankedBarContainer = document.getElementById('sales-bar-container') ||
    document.getElementById('purchases-bar-container');
  rankedBarContainer.id = activeReportTab === 'purchases' ? 'purchases-bar-container' : 'sales-bar-container';
  document.getElementById('report-output').classList.toggle('income-statement-layout', activeReportTab === 'income');
  document.getElementById('report-output').classList.toggle('ranking-report-layout',
    activeReportTab === 'sales' || activeReportTab === 'purchases');
  document.getElementById('report-output').classList.toggle('tax-report-layout', activeReportTab === 'tax');
  document.getElementById('report-output').classList.toggle('inventory-report-layout', activeReportTab === 'inventory');
  document.getElementById('report-output').classList.toggle('cashflow-report-layout', activeReportTab === 'cashflow');
  document.getElementById('report-output').classList.toggle('custom-report-layout', activeReportTab === 'custom');
  document.querySelector('.report-controls').style.display = activeReportTab === 'tax' ? 'none' : '';
  document.getElementById('report-chart-card').style.height = '';
  rankedBarContainer.style.height = '';
  document.getElementById('report-top-n-control').innerHTML = '';
  document.getElementById('inventory-movement-controls').innerHTML = '';
  document.getElementById('inventory-movement-pagination')?.remove();
  document.getElementById('flagged-pagination')?.remove();
  document.getElementById('cf-begin-section').style.display = 'none';
  document.getElementById('report-primary-table').classList.toggle('is-table',
    activeReportTab === 'income' || activeReportTab === 'tax');
  document.getElementById('report-extra-filters').innerHTML = '';
  document.getElementById('custom-report-controls').style.display = activeReportTab === 'custom' && FEATURE_CUSTOM_REPORT ? '' : 'none';
  const [title, subtitle] = REPORT_META[activeReportTab];
  document.getElementById('report-title').textContent = title;
  document.getElementById('report-subtitle').textContent = subtitle;
  if (activeReportTab === 'sales') renderSalesReport();
  else if (activeReportTab === 'purchases') renderPurchasesReport();
  else if (activeReportTab === 'tax') renderTaxSummary();
  else if (activeReportTab === 'inventory') renderInventoryReport();
  else if (activeReportTab === 'cashflow') renderCashFlowReport();
  else if (activeReportTab === 'custom' && FEATURE_CUSTOM_REPORT) renderCustomReport();
  else renderIncomeStatement();
}

function exportChartPNG() {
  const link = document.createElement('a');
  link.download = `palo-grocerette-${activeReportTab}-chart.png`;
  link.href = document.getElementById('report-chart').toDataURL('image/png');
  link.click();
}

function exportCustomCSV() {
  const csv = ['Group,Value', ...customExportRows.map(row => `"${String(row.group).replace(/"/g, '""')}",${row.value}`)].join('\n');
  const link = document.createElement('a');
  link.download = 'palo-grocerette-custom-report.csv';
  link.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
  link.click();
  URL.revokeObjectURL(link.href);
}

// Typing a new date makes the loaded figures out of date: show the prompt
// until Generate Report is clicked again.
['report-start', 'report-end'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => {
    markReportDataStale();
    reportLoadError = null;
    renderActiveReport();
  });
});
document.getElementById('btn-build-custom').addEventListener('click', renderCustomReport);
document.getElementById('btn-export-chart').addEventListener('click', exportChartPNG);
document.getElementById('btn-export-custom-csv').addEventListener('click', exportCustomCSV);
async function initReports() {
  setDefaultReportDates();
  if (!FEATURE_CUSTOM_REPORT) {
    const btn = document.getElementById('tab-btn-custom');
    if (btn) {
      btn.insertAdjacentHTML('afterend',
        '<span class="tab-btn tab-btn-locked" title="Contact us to enable Custom Reports">Custom<span class="tab-locked-badge">available on request</span></span>');
      btn.remove();
    }
  }
  renderActiveReport();
}

initReports();

// Pre-warm Firestore while the user is still reading the page: initialising the
// SDK, resolving auth and opening the connection is a one-time ~1–3s cost that
// otherwise lands on the first "Generate Report" click. A single 1-doc read pays
// it up front. Best-effort only — failures are swallowed and cost nothing.
(function prewarmReportsFirestore() {
  try {
    const db = getFirestoreDB();
    if (!db) return;
    db.collection('salesDaily')
      .orderBy(firebase.firestore.FieldPath.documentId())
      .limit(1).get()
      .catch(() => {});
  } catch (e) { /* ignore — the gated load will surface any real problem */ }
})();

// Data is not loaded on page open — the user must click "Generate Report".
// Each click = paid Firestore reads, so the button guards against double-clicks.
// There is ONE Generate Report button, next to the dates (the old top-right
// button and the separate "Apply" button were merged into it). Each click reads
// fresh data for the active tab and the dates shown.
EPCReportGate.wire({
  button: 'btn-apply-report-range',
  popup: false,   // this page shows its own loader
  status: 'rep-gen-status',
  idleLabel: 'Generate Report',
  refreshLabel: 'Generate Report',
  load: async () => {
    // renderActiveReport() owns the empty-state / error-notice / report visibility
    // based on whether the load succeeded — don't force-hide the prompt here.
    // Same progress bar the tabs used to show, now only on this button.
    await withReportProgress('Loading report data...', async () => {
      await runReportLoad(() => ensureActiveReportData({ force: true }));
      await waitReportFrame();
      renderActiveReport();
    });
  }
});

// Firebase is already initialized by app.js (EPC_FIREBASE_CONFIG).
const db = getFirestoreDB();

initSidebar('pos-import');

// ─── Local data cache (populated from Firestore on page load) ─────────────────
let _salesData     = [];   // { _id, date, itemCode, productName, … }
let _reviewData    = [];   // { _id, date, itemCode, productName, … }
let costMethod     = localStorage.getItem('costMethod') === 'average' ? 'average' : 'latest';
let cogsRecomputeInProgress = false;
let marginHighThreshold = Number(localStorage.getItem('marginHighThreshold') ?? 30);
let marginLowThreshold  = Number(localStorage.getItem('marginLowThreshold') ?? 0);
if (!Number.isFinite(marginHighThreshold)) marginHighThreshold = 30;
if (!Number.isFinite(marginLowThreshold)) marginLowThreshold = 0;
let activeSalesDetailId = '';
let pmData = null; // Product Master record for the currently open modal; set once on open, cleared on close

// Shared page state lives here so the plain scripts can collaborate without modules.
let salesPage = 1;
const SALES_PG = 50;
const selectedSalesIds = new Set();
let pendingSalesDeleteIds = [];
let salesDeleteInProgress = false;
let salesFilters;
let activeTab = 'sales';
let reviewPage = 1;
const RECORDS_LOAD_DEFAULT = 200;
const RECORDS_LOAD_MIN = 50;
const RECORDS_LOAD_MAX = 1000;
const RECORD_SEARCH_LIMIT = 100;
let salesRangeStart = '';
let salesRangeEnd = '';
let salesBrowseData = [];
let salesLastDocSnapshot = null;
let salesHasMoreRecords = false;
let salesRecordsLoaded = false;
let salesRecordsLoading = false;
let salesTotalRecords = null;
let salesTotalRevenue = null;
let salesSummaryTotals = null;
let salesSummaryRunId = 0;
let salesSearchMode = false;
let salesSearchTerm = '';
let reviewBrowseData = [];
let reviewLastDocSnapshot = null;
let reviewHasMoreRecords = false;
let reviewRecordsLoaded = false;
let reviewRecordsLoading = false;
let reviewTotalRecords = null;
let reviewTotalRevenue = null;
let reviewSearchMode = false;
let reviewSearchTerm = '';
let inventoryUnitCostCache = Object.create(null);
let inventoryFullCostMapPromise = null;
const REVIEW_FILTER_DEFAULTS = {
  query: '',
  sortKey: 'date',
  sortDir: 'desc',
  columns: {
    date: { from:'', to:'' },
    itemCode: '',
    productName: '',
    category: '',
    unitsSold: { min:'', max:'' },
    sellingPrice: { min:'', max:'' },
    totalRevenue: { min:'', max:'' },
    discount: { min:'', max:'' },
    srpwdDiscount: { min:'', max:'' }
  }
};

function freshReviewFilterDefaults() {
  return JSON.parse(JSON.stringify(REVIEW_FILTER_DEFAULTS));
}

function loadReviewFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem('underReviewFilters')) || {};
    return {
      ...REVIEW_FILTER_DEFAULTS,
      ...saved,
      columns: {
        ...REVIEW_FILTER_DEFAULTS.columns,
        ...(saved.columns || {}),
        date: { ...REVIEW_FILTER_DEFAULTS.columns.date, ...(saved.columns?.date || {}) },
        unitsSold: { ...REVIEW_FILTER_DEFAULTS.columns.unitsSold, ...(saved.columns?.unitsSold || {}) },
        sellingPrice: { ...REVIEW_FILTER_DEFAULTS.columns.sellingPrice, ...(saved.columns?.sellingPrice || {}) },
        totalRevenue: { ...REVIEW_FILTER_DEFAULTS.columns.totalRevenue, ...(saved.columns?.totalRevenue || {}) },
        discount: { ...REVIEW_FILTER_DEFAULTS.columns.discount, ...(saved.columns?.discount || {}) },
        srpwdDiscount: { ...REVIEW_FILTER_DEFAULTS.columns.srpwdDiscount, ...(saved.columns?.srpwdDiscount || {}) }
      }
    };
  } catch {
    return freshReviewFilterDefaults();
  }
}

let reviewFilters = loadReviewFilters();
const REVIEW_PG = 50;
const selectedReviewIds = new Set();
let pendingReviewDeleteIds = [];
let reviewDeleteInProgress = false;
let salesPageAuthReady = false;

function getRecordsLoadLimit({ syncInput = true } = {}) {
  const input = typeof document !== 'undefined' ? document.getElementById('records-load-limit') : null;
  const raw = input ? Number(input.value) : RECORDS_LOAD_DEFAULT;
  const parsed = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : RECORDS_LOAD_DEFAULT;
  const clamped = Math.min(RECORDS_LOAD_MAX, Math.max(RECORDS_LOAD_MIN, parsed));
  if (input && syncInput) input.value = String(clamped);
  return clamped;
}

function salesNameLower(value) {
  return String(value || '').toLowerCase().trim();
}

function canEditSalesPage() {
  return salesPageAuthReady && typeof canCurrentUserEdit === 'function' && canCurrentUserEdit('pos-import');
}

function requireSalesEditAccess() {
  if (canEditSalesPage()) return true;
  if (salesPageAuthReady) alert('View-only access cannot edit or import sales records.');
  return false;
}

function applySalesPagePermissions() {
  const readOnly = !canEditSalesPage();
  if (readOnly) {
    selectedSalesIds.clear();
    selectedReviewIds.clear();
  }
  [
    'btn-add-sales-entry',
    'file-input',
    'btn-rematch-now',
    'btn-delete-sales-selected',
    'btn-delete-review-selected',
    'btn-confirm-delete-sales',
    'btn-confirm-delete-review',
    'btn-save-sales-entry',
    'btn-apply-margin-thresholds',
    'sales-select-page',
    'review-select-page'
  ].forEach(id => {
    const element = document.getElementById(id);
    if (!element) return;
    element.disabled = readOnly;
    element.classList.toggle('role-disabled', readOnly);
    if (readOnly) element.title = 'View-only access';
  });

  document.querySelectorAll(
    '.sales-row-select, .review-row-select, .review-cost-input, .review-actions button, input[name="cost-method"], #sales-info-section input, #sales-info-section select, #btn-save-sales-detail'
  ).forEach(element => {
    element.disabled = readOnly;
    element.classList.toggle('role-disabled', readOnly);
    if (readOnly) element.title = 'View-only access';
  });

  const productMasterLink = document.getElementById('btn-open-product-master');
  if (productMasterLink) {
    productMasterLink.style.display = readOnly ? 'none' : '';
    productMasterLink.setAttribute('aria-disabled', readOnly ? 'true' : 'false');
  }

  const dropZoneEl = document.getElementById('drop-zone');
  if (dropZoneEl) {
    dropZoneEl.classList.toggle('is-import-disabled', readOnly);
    dropZoneEl.title = readOnly ? 'View-only access' : '';
  }

  document.querySelectorAll('#sales-bulk-toolbar, #sales-select-all-banner, #review-bulk-toolbar, #review-select-all-banner')
    .forEach(element => { if (readOnly) element.classList.remove('open'); });
}

// ─── Column aliases ───────────────────────────────────────────────────────────
const POS_COL_ALIASES = {
  itemCode: ['material code','mat code','item code','product code','sku','code'],
  barcode:  ['barcode','bar code'],
  itemName: ['item name','product name','description','name'],
  quantity: ['quantity','qty','units sold','unit sold','sold'],
  total:    ['total','total sales','total sale','total amount','sales amount','amount'],
  date:     ['date','transaction date','sale date'],
  category: ['category','class','cat'],
};
const POS_HEADER_LABELS = new Set([
  'barcode','bar code','material code','item code','product code','sku',
  'item name','product name','description','item','name',
  'quantity','qty','units sold','unit sold','sold',
  'total sales','total sale','total amount','sales amount','amount','total',
  'category','unit cost','cost','selling price','price','srp',
  'date','transaction date','sale date'
]);

// ─── Transient parse state ────────────────────────────────────────────────────
let xlsData            = [];
let detectedMode       = '';
let detectedSingleDate = '';
let detectedRangeStart = '';
let detectedRangeEnd   = '';
let detectedDateColIdx = -1;
let detectedDateColName= '';

// ─── Firestore helpers ────────────────────────────────────────────────────────

function normalizeItemCode(value) {
  return String(value ?? '').trim().toUpperCase();
}

function productCostForMethod(product) {
  const latest = Number(product.latestCost ?? product.unitCost ?? product.cost) || 0;
  if (costMethod === 'average') return Number(product.averageCost) || latest;
  return latest;
}

function inventoryCostDate(row) {
  return String(row?.dateDelivered || row?.rowDate || row?.date || row?.importedAt || '').slice(0, 10);
}

function inventoryUnitCostForCode(costMap, itemCode) {
  if (!costMap) return 0;
  const rawCode = String(itemCode || '').trim();
  return Number(costMap[rawCode] || costMap[rawCode.toUpperCase()] || 0) || 0;
}

function mergeInventoryCostRows(rows, target = inventoryUnitCostCache) {
  rows.forEach(row => {
    const code = String(row.itemCode || row.code || '').trim();
    const unitCost = Number(row.unitCost) || 0;
    if (!code || unitCost <= 0) return;
    if (String(row.type || 'Incoming').toLowerCase() === 'outgoing') return;
    const date = inventoryCostDate(row);
    const saved = target[code] || target[code.toUpperCase()];
    if (!saved || date >= saved.date) {
      const entry = { unitCost, date };
      target[code] = entry;
      target[code.toUpperCase()] = entry;
    }
  });
  return Object.fromEntries(Object.entries(target).map(([code, entry]) => [code, entry.unitCost]));
}

function inventoryQueryCodes(itemCodes = []) {
  const codes = new Set();
  itemCodes.forEach(value => {
    const code = String(value || '').trim();
    if (!code) return;
    codes.add(code);
    codes.add(code.toUpperCase());
  });
  return [...codes];
}

// Latest unit cost per item code. Reads the purpose-built itemCost/{code} rollup
// (one doc per code, latest-delivery-wins) instead of scanning raw inventoryData.
async function loadInventoryUnitCostMap(itemCodes = []) {
  const requestedCodes = inventoryQueryCodes(itemCodes);
  const setCost = (code, unitCost) => {
    const entry = { unitCost: Number(unitCost) || 0, date: '' };
    inventoryUnitCostCache[code] = entry;
    inventoryUnitCostCache[code.toUpperCase()] = entry;
  };

  if (requestedCodes.length) {
    // Only look up codes we haven't cached yet.
    const missing = [...new Set(requestedCodes.map(c => String(c).trim()).filter(Boolean))]
      .filter(code => inventoryUnitCostCache[code] === undefined && inventoryUnitCostCache[code.toUpperCase()] === undefined);
    // itemCost docs are keyed by the exact item code — fetch each (batched reads).
    for (let start = 0; start < missing.length; start += 50) {
      const chunk = missing.slice(start, start + 50);
      const snaps = await Promise.all(chunk.map(code =>
        db.collection('itemCost').doc(code).get().catch(() => null)));
      snaps.forEach((snap, i) => {
        const code = chunk[i];
        const uc = snap && snap.exists ? Number(snap.data().unit_cost) || 0 : 0;
        setCost(code, uc);
      });
    }
    return Object.fromEntries(Object.entries(inventoryUnitCostCache).map(([code, entry]) => [code, entry.unitCost]));
  }

  // No specific codes → load the whole itemCost collection once (cheap: one doc/code).
  if (inventoryFullCostMapPromise) return inventoryFullCostMapPromise;
  inventoryFullCostMapPromise = db.collection('itemCost').get()
    .then(result => {
      if (typeof logFirestoreReadSuccess === 'function') logFirestoreReadSuccess('itemCost read');
      result.forEach(doc => setCost(doc.id, Number(doc.data().unit_cost) || 0));
      return Object.fromEntries(Object.entries(inventoryUnitCostCache).map(([code, entry]) => [code, entry.unitCost]));
    })
    .catch(err => {
      if (typeof logFirestoreReadFailure === 'function') logFirestoreReadFailure(err);
      throw err;
    });
  return inventoryFullCostMapPromise;
}

function salesGrossSrp(row) {
  const unitsSold = Number(row?.unitsSold) || 0;
  const sellingPrice = Number(row?.sellingPrice ?? row?.srpUnit) || 0;
  const grossFromUnitPrice = unitsSold * sellingPrice;
  if (grossFromUnitPrice > 0) return grossFromUnitPrice;

  const totalRevenue = Number(row?.totalRevenue) || 0;
  const discount = Number(row?.discount) || 0;
  return totalRevenue + discount;
}

function salesMarginPercent(grossProfit, row) {
  const unitsSold = Number(row?.unitsSold) || 0;
  const totalCost = Number(row?.totalCost) || ((Number(row?.unitCost) || 0) * unitsSold);
  if (totalCost > 0) return Number((Number(grossProfit) / totalCost * 100).toFixed(4));
  const totalRevenue = Number(row?.totalRevenue) ||
    ((Number(row?.sellingPrice ?? row?.srpUnit) || 0) * unitsSold);
  return totalRevenue > 0 ? 100 : 0;
}

function salesGrossProfitAmount(row) {
  const unitsSold = Number(row?.unitsSold) || 0;
  const unitCost = Number(row?.unitCost) || 0;
  const totalCost = Number(row?.totalCost) || (unitCost * unitsSold);
  // Gross profit = total revenue − (unit cost × units sold).
  const totalRevenue = Number(row?.totalRevenue) ||
    ((Number(row?.sellingPrice ?? row?.srpUnit) || 0) * unitsSold);
  return totalRevenue - totalCost;
}

function normalizeSalesFinancials(row, inventoryCostMap = null) {
  const unitsSold = Number(row.unitsSold) || 0;
  const inventoryUnitCost = inventoryUnitCostForCode(inventoryCostMap, row.itemCode);
  const unitCost = inventoryUnitCost || Number(row.unitCost) || 0;
  const totalCost = unitCost * unitsSold;
  const grossProfit = salesGrossProfitAmount({ ...row, unitsSold, unitCost, totalCost });
  return {
    ...row,
    unitCost,
    totalCost,
    grossProfit,
    margin: salesMarginPercent(grossProfit, { ...row, unitsSold, unitCost, totalCost }),
  };
}

function setCostMethodInputsDisabled(disabled) {
  document.querySelectorAll('input[name="cost-method"]').forEach(input => {
    input.disabled = disabled;
  });
}

// Load all productMaster docs once; return a map keyed by itemCode.
// Indexes BOTH the trimmed-uppercase key AND the raw trimmed key so any
// caller finds a match regardless of how it normalizes the lookup value.
async function loadProductMasterMap() {
  const snap = await db.collection('productMaster').get();
  const map  = {};
  snap.forEach(doc => {
    const d       = doc.data();
    const rawCode = String(d.itemCode ?? d.code ?? '').trim();
    if (!rawCode) return;
    const entry      = { ...d, _id: doc.id };
    map[rawCode]                 = entry; // exact trimmed key
    map[rawCode.toUpperCase()]   = entry; // uppercase key
  });
  return map;
}

function cloneSalesFilterState(filterState = salesFilters) {
  return JSON.parse(JSON.stringify(filterState || {}));
}

function monthDateBounds(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return null;
  const [year, monthNum] = month.split('-').map(Number);
  const lastDay = new Date(year, monthNum, 0).getDate();
  return {
    start: `${year}-${String(monthNum).padStart(2, '0')}-01`,
    end: `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  };
}

function salesSummaryDateRange(filterState = salesFilters) {
  if (!salesRangeStart || !salesRangeEnd) return null;
  const columns = filterState?.columns || {};
  let start = salesRangeStart;
  let end = salesRangeEnd;
  const monthBounds = monthDateBounds(filterState?.month);
  if (monthBounds) {
    start = start > monthBounds.start ? start : monthBounds.start;
    end = end < monthBounds.end ? end : monthBounds.end;
  }
  if (columns.date?.from) start = start > columns.date.from ? start : columns.date.from;
  if (columns.date?.to) end = end < columns.date.to ? end : columns.date.to;
  if (activeTab === 'review') {
    const reviewDate = reviewFilters?.columns?.date || {};
    if (reviewDate.from) start = start > reviewDate.from ? start : reviewDate.from;
    if (reviewDate.to) end = end < reviewDate.to ? end : reviewDate.to;
  }
  return start <= end ? { start, end } : null;
}

function salesSummaryBaseQuery(collectionName, range) {
  return db.collection(collectionName)
    .where('date', '>=', range.start)
    .where('date', '<=', range.end)
    .orderBy('date');
}

async function countSummaryQuery(collectionName, range) {
  const query = db.collection(collectionName)
    .where('date', '>=', range.start)
    .where('date', '<=', range.end);
  if (typeof query.count === 'function') {
    const snap = await query.count().get();
    return Number(snap.data().count) || 0;
  }
  if (typeof firestoreCount === 'function') return firestoreCount(query, `${collectionName} summary count`);
  return null;
}

function costedSalesSummaryRow(row, productMap, inventoryCostMap) {
  const codeKey = String(row.itemCode || '').trim();
  const product = productMap[codeKey] || productMap[codeKey.toUpperCase()];
  const unitsSold = Number(row.unitsSold) || 0;
  const totalRevenue = Number(row.totalRevenue) || 0;
  const sellingPrice = Number(row.sellingPrice ?? row.srpUnit ?? row.srp) ||
    (unitsSold > 0 ? totalRevenue / unitsSold : 0);
  const unitCost = inventoryUnitCostForCode(inventoryCostMap, codeKey) ||
    (product ? productCostForMethod(product) : (Number(row.unitCost) || 0));
  const totalCost = unitCost * unitsSold;
  const grossProfit = salesGrossProfitAmount({ ...row, unitsSold, unitCost, totalCost, sellingPrice, totalRevenue });
  return {
    ...row,
    unitsSold,
    totalRevenue,
    sellingPrice,
    unitCost,
    totalCost,
    grossProfit,
    margin: salesMarginPercent(grossProfit, { ...row, unitsSold, unitCost, totalCost, sellingPrice, totalRevenue })
  };
}

function applySalesSummaryTotals(totals) {
  salesSummaryTotals = totals || (typeof emptySalesSummaryTotals === 'function'
    ? emptySalesSummaryTotals()
    : {
      grossRevenue: 0, netRevenue: 0, revenue: 0, discounts: 0, srpwdDiscounts: 0,
      totalDiscounts: 0, cogs: 0, profit: 0, unitsSold: 0, count: 0,
      pendingRevenue: 0, pendingGrossSales: 0, totalRevenue: 0
    });
  if (typeof updateSummaryCards === 'function') updateSummaryCards();
}

async function computeSummaryTotals(filterState = salesFilters, options = {}) {
  const runId = ++salesSummaryRunId;
  const filters = cloneSalesFilterState(filterState);
  const range = salesSummaryDateRange(filters);
  const progress = typeof salesLongProgress !== 'undefined' ? salesLongProgress : null;
  const label = options.label || 'Computing Sales summary...';
  if (!range) {
    applySalesSummaryTotals(null);
    return salesSummaryTotals;
  }

  applySalesSummaryTotals(null);
  if (progress) progress.show(`${label} Counting records...`, 0, 0);

  let salesCount = null;
  let reviewCount = null;
  try {
    [salesCount, reviewCount] = await Promise.all([
      countSummaryQuery('salesData', range),
      countSummaryQuery('underReviewData', range)
    ]);
  } catch (err) {
    console.warn('[Sales Summary] Count failed; continuing without denominator:', err);
  }

  const totalForProgress = (Number(salesCount) || 0) + (Number(reviewCount) || 0);
  const scanLabel = `${label} Scanning approved + pending sales...`;
  if (progress) progress.update(scanLabel, 0, totalForProgress);

  const [productMap, inventoryCostMap] = await Promise.all([
    loadProductMasterMap(),
    loadInventoryUnitCostMap()
  ]);

  const totals = typeof emptySalesSummaryTotals === 'function'
    ? emptySalesSummaryTotals()
    : {
      grossRevenue: 0, netRevenue: 0, revenue: 0, discounts: 0, srpwdDiscounts: 0,
      totalDiscounts: 0, cogs: 0, profit: 0, unitsSold: 0, count: 0,
      pendingRevenue: 0, pendingGrossSales: 0, totalRevenue: 0
    };
  let processed = 0;
  let cursor = null;

  // Approved sales now live in salesDaily rollups: read the day-docs in range and
  // expand each into per-item-day rows, then cost + total them.
  {
    let q = db.collection('salesDaily').orderBy(firebase.firestore.FieldPath.documentId());
    if (range.start) q = q.startAt(range.start);
    if (range.end) q = q.endAt(range.end);
    const snap = await q.get();
    snap.forEach(doc => {
      salesDailyDocToRows(doc.id, doc.data()).forEach(base => {
        const row = costedSalesSummaryRow(base, productMap, inventoryCostMap);
        if (!rowMatchesFilters(row, filters)) return;
        const grossRevenue = posGrossRevenue(row);
        const netRevenue = posNetRevenue(row);
        totals.grossRevenue += grossRevenue;
        totals.netRevenue += netRevenue;
        totals.revenue += netRevenue;
        totals.srpwdDiscounts += posSrpwdDiscount(row);
        totals.cogs += Number(row.totalCost) || 0;
        totals.profit += grossRevenue - (Number(row.totalCost) || 0);
        totals.unitsSold += Number(row.unitsSold) || 0;
        totals.count += 1;
      });
    });
    processed += snap.size;
    if (progress) progress.update(scanLabel, processed, totalForProgress);
    if (runId !== salesSummaryRunId) return null;
  }

  cursor = null;
  while (true) {
    let query = salesSummaryBaseQuery('underReviewData', range).limit(VS_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (!snap.docs.length) break;
    snap.docs.forEach(doc => {
      const row = { _id: doc.id, ...doc.data() };
      totals.pendingGrossSales += posGrossRevenue(row);
    });
    processed += snap.docs.length;
    if (progress) progress.update(scanLabel, processed, totalForProgress);
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < VS_PAGE_SIZE) break;
    if (runId !== salesSummaryRunId) return null;
  }

  totals.pendingRevenue = totals.pendingGrossSales;
  totals.totalRevenue = (Number(totals.grossRevenue) || 0) + totals.pendingGrossSales;

  totals.totalDiscounts = Math.max(0, totals.grossRevenue - totals.netRevenue);
  totals.discounts = Math.max(0, totals.totalDiscounts - totals.srpwdDiscounts);
  if (runId === salesSummaryRunId) {
    applySalesSummaryTotals(totals);
    if (progress) {
      progress.update(scanLabel, totalForProgress || processed, totalForProgress || processed);
      setTimeout(() => {
        if (runId === salesSummaryRunId) progress.hide();
      }, 500);
    }
  }
  return totals;
}

// Write an array of plain-object docs to a Firestore collection in batches of 499.
// onProgress(batchSize, total) is called after every committed batch.
// Returns the saved docs with their Firestore-assigned _id fields.
async function batchWriteToDB(collName, docs, onProgress) {
  if (!requireSalesEditAccess()) return [];
  const BATCH_SIZE = 499;
  const saved = [];
  const total = docs.length;
  let written = 0;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const chunk = docs.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    const refs  = chunk.map(() => db.collection(collName).doc());
    refs.forEach((ref, j) => batch.set(ref, chunk[j]));
    await batch.commit();
    chunk.forEach((doc, j) => saved.push({ _id: refs[j].id, ...doc }));
    written += chunk.length;
    if (onProgress) onProgress(chunk.length, total);
  }
  return saved;
}

async function recomputeAllSalesCOGS() {
  if (!requireSalesEditAccess()) return;
  if (cogsRecomputeInProgress) return;
  if (!_salesData.length) {
    alert('Load a date range first, then apply COGS changes to the loaded records.');
    return;
  }
  const statusEl = document.getElementById('import-status');
  const fillEl = document.getElementById('progress-fill');
  const labelEl = document.getElementById('import-status-label');
  cogsRecomputeInProgress = true;
  statusEl.style.display = '';
  fillEl.style.width = '0%';
  labelEl.textContent = 'Recomputing COGS... 0%';
  dropZone.classList.add('is-import-disabled');
  fileInput.disabled = true;
  setCostMethodInputsDisabled(true);

  try {
    // Sales is rollup-only: recompute COGS in memory for the loaded rows using the
    // selected cost method (Latest/Average from Product Master). No DB write —
    // there are no per-sale documents to update.
    const rows = _salesData.map(row => ({ ...row }));
    const productMap = await loadProductMasterMap();
    rows.forEach(row => {
      const codeKey = String(row.itemCode || '').trim();
      const product = productMap[codeKey] || productMap[codeKey.toUpperCase()];
      // Honor Latest vs Average: Product Master cost by method wins.
      const unitCost = product ? (Number(productCostForMethod(product)) || 0) : (Number(row.unitCost) || 0);
      const unitsSold = Number(row.unitsSold) || 0;
      const totalRevenue = Number(row.totalRevenue) || 0;
      const totalCost = unitCost * unitsSold;
      const grossProfit = salesGrossProfitAmount({ ...row, unitsSold, unitCost, totalCost, totalRevenue });
      const margin = salesMarginPercent(grossProfit, { ...row, unitsSold, unitCost, totalCost, totalRevenue });
      Object.assign(row, { unitCost, totalCost, grossProfit, margin, costMethod });
    });
    fillEl.style.width = '100%';
    labelEl.textContent = 'COGS recompute complete! ✓';
    _salesData = rows;
    salesBrowseData = rows;
    renderAll();
    await new Promise(resolve => setTimeout(resolve, 600));
  } catch (err) {
    console.error('[POS COGS] Recompute failed:', err);
    alert('Could not recompute COGS. Please check your connection and try again.');
  } finally {
    cogsRecomputeInProgress = false;
    statusEl.style.display = 'none';
    dropZone.classList.remove('is-import-disabled');
    fileInput.disabled = false;
    setCostMethodInputsDisabled(false);
  }
}

async function addToImportHistory(historyDoc) {
  if (!requireSalesEditAccess()) return;
  logAudit('Import', 'POS Sales',
    `Imported '${historyDoc.filename}' - ${historyDoc.count.toLocaleString()} records, ${historyDoc.reviewCount.toLocaleString()} under review`);
}

async function saveSalesDetailChanges() {
  if (!requireSalesEditAccess()) return;
  const row = _salesData.find(item => item._id === activeSalesDetailId);
  const button = document.getElementById('btn-save-sales-detail');
  const values = getSalesDetailValues();
  if (!row || !values || !values.date || values.unitsSold < 0 || values.sellingPrice < 0) {
    alert('Please enter a valid date, units sold, and selling price.');
    return;
  }

  const originalCategory = row.category;
  const categoryChanged  = values.category !== originalCategory;

  button.disabled = true;
  button.textContent = 'Saving...';
  try {
    values.nameLower = salesNameLower(values.productName);
    await db.collection('salesData').doc(row._id).update(values);
    Object.assign(row, values);
    logAudit('Edit', 'Sales Record',
      `Edited sales record ${row.itemCode || row._id} - ${values.unitsSold} units on ${formatDate(values.date)}`);

    let savedMsg = '✓ Saved';
    if (categoryChanged && values.itemCode) {
      const pmSnap = await db.collection('productMaster')
        .where('itemCode', '==', String(values.itemCode).trim())
        .limit(1)
        .get();
      if (!pmSnap.empty) {
        await pmSnap.docs[0].ref.update(epcStamp({ category: values.category }));
        savedMsg = 'Saved. Category also updated in Product Master.';
      }
    }

    renderAll();
    document.getElementById('sales-detail-saved').textContent = savedMsg;
    button.textContent = 'Save Changes';
    button.disabled = false;
  } catch (err) {
    console.error('[POS Sales Detail] Sale update failed:', err);
    alert(`Could not update the sales record: ${err.message}`);
    button.disabled = false;
    button.textContent = 'Save Changes';
  }
}

async function deleteSalesRows(ids, onProgress) {
  if (!requireSalesEditAccess()) return;
  return deleteFromFirestore('salesData', ids, onProgress);
}

async function deleteReviewRows(ids, onProgress) {
  if (!requireSalesEditAccess()) return;
  return deleteFromFirestore('underReviewData', ids, onProgress);
}

async function saveReviewRow(id) {
  if (!requireSalesEditAccess()) return;
  const inp  = document.getElementById('rc-' + id);
  const cost = parsePeso(inp?.value);
  if (!cost || cost <= 0) {
    inp?.classList.add('input-error');
    inp?.focus();
    alert('Please enter a valid Unit Cost.');
    return;
  }
  inp?.classList.remove('input-error');

  const row = _reviewData.find(r => r._id === id);
  if (!row) return;

  // Disable button during async save
  const btn = inp?.closest('tr')?.querySelector('button');
  if (btn) btn.disabled = true;

  try {
    const unitsSold   = row.unitsSold    || 0;
    const totalCost   = cost * unitsSold;
    const totalRev    = row.totalRevenue || 0;
    const grossProfit = salesGrossProfitAmount({ ...row, unitsSold, unitCost: cost, totalCost });
    const margin      = salesMarginPercent(grossProfit, { ...row, unitsSold, unitCost: cost, totalCost });
    const markup      = row.sellingPrice > 0 && cost > 0
      ? parseFloat(((row.sellingPrice - cost) / cost * 100).toFixed(2)) : 0;

    // 1. Upsert to productMaster — find by itemCode field, update in-place or add new
    const historyEntry = {
      date:     row.date || todayISO(),
      unitCost: cost,
      supplier: ''
    };
    const pmDocData = {
      itemCode:    String(row.itemCode || '').trim(),
      productName: row.productName,
      category:    row.category || 'Uncategorized',
      unitCost:    cost,
      latestCost:  cost,
      averageCost: cost,
      latestDate:  historyEntry.date,
      costHistory: [historyEntry],
      srp:         row.sellingPrice || 0,
      markup
    };
    const existingPM = await db.collection('productMaster')
      .where('itemCode', '==', pmDocData.itemCode)
      .limit(1)
      .get();
    if (!existingPM.empty) {
      await existingPM.docs[0].ref.set(epcStamp(pmDocData), { merge: true });
    } else {
      await db.collection('productMaster').add(epcStamp(pmDocData));
    }

    // 2. Add to salesData
    const salesDoc = {
      date:         row.date,
      itemCode:     row.itemCode,
      productName:  row.productName,
      nameLower:    salesNameLower(row.productName),
      category:     row.category || 'Uncategorized',
      unitsSold, unitCost: cost, totalCost,
      sellingPrice: row.sellingPrice,
      totalRevenue: totalRev,
      grossProfit,  margin,
      importedAt:   row.importedAt,
      filename:     row.filename,
      costMethod
    };
    const salesRef = await db.collection('salesData').add(salesDoc);

    // 3. Delete from underReviewData
    await db.collection('underReviewData').doc(id).delete();

    // 4. Update local cache
    _salesData.unshift({ _id: salesRef.id, ...salesDoc });
    _reviewData = _reviewData.filter(r => r._id !== id);
    selectedReviewIds.delete(id);

    renderAll();
    logAudit('Create', 'Product Master',
      `Resolved under-review item ${row.itemCode} with unit cost ${formatPeso(cost)}`);

    // Background: catch any other Under Review items that share this PM entry
    rematchUnderReview().catch(err => console.error('[rematchUnderReview] Error:', err));
  } catch (err) {
    console.error('saveReviewRow error:', err);
    alert('Could not save this item. Please check your connection and try again.');
    if (btn) btn.disabled = false;
  }
}


// ─── Firestore collection API ────────────────────────────────────────────────
function selectedRecordsRange() {
  return { start: salesRangeStart, end: salesRangeEnd };
}

const VS_PAGE_SIZE = 1000;

function buildRangeQuery(collectionName, append, lastDocSnapshot) {
  // Initial load always fetches VS_PAGE_SIZE docs; incremental fetch via loadNextSalesPage/loadNextReviewPage
  let query = db.collection(collectionName)
    .where('date', '>=', salesRangeStart)
    .where('date', '<=', salesRangeEnd)
    .orderBy('date')
    .limit(VS_PAGE_SIZE);
  if (append && lastDocSnapshot) query = query.startAfter(lastDocSnapshot);
  return query;
}

function buildRangeCountQuery(collectionName) {
  return db.collection(collectionName)
    .where('date', '>=', salesRangeStart)
    .where('date', '<=', salesRangeEnd);
}

function buildDateRangeCountQuery(collectionName, start, end) {
  return db.collection(collectionName)
    .where('date', '>=', start)
    .where('date', '<=', end);
}

async function countRangeRecords(collectionName) {
  const query = buildRangeCountQuery(collectionName);
  if (typeof firestoreCount === 'function') return firestoreCount(query, `${collectionName} count`);
  if (typeof query.count !== 'function') return null;
  const snap = await query.count().get();
  return Number(snap.data().count) || 0;
}

async function countRecordsForDateRange(collectionName, start, end) {
  const query = buildDateRangeCountQuery(collectionName, start, end);
  if (typeof firestoreCount === 'function') return firestoreCount(query, `${collectionName} export count`);
  if (typeof query.count !== 'function') return null;
  const snap = await query.count().get();
  return Number(snap.data().count) || 0;
}

async function sumRangeRecords(collectionName, fieldName) {
  const query = buildRangeCountQuery(collectionName);
  if (typeof query.aggregate !== 'function' ||
      typeof firebase === 'undefined' ||
      !firebase.firestore?.AggregateField?.sum) {
    return null;
  }
  const snap = await query.aggregate({
    value: firebase.firestore.AggregateField.sum(fieldName)
  }).get();
  return Number(snap.data().value) || 0;
}

async function safeRangeCount(collectionName) {
  try {
    return await countRangeRecords(collectionName);
  } catch (err) {
    console.warn(`[Sales] ${collectionName} count failed; continuing without total:`, err);
    return null;
  }
}

async function safeRangeSum(collectionName, fieldName) {
  try {
    return await sumRangeRecords(collectionName, fieldName);
  } catch (err) {
    console.warn(`[Sales] ${collectionName} ${fieldName} sum failed; continuing without sum:`, err);
    return null;
  }
}

async function loadRangeAggregates(collectionName) {
  const countPromise = safeRangeCount(collectionName);
  if (collectionName !== 'underReviewData') {
    return { count: await countPromise, totalRevenue: null };
  }

  const [count, totalRevenue] = await Promise.all([
    countPromise,
    safeRangeSum(collectionName, 'totalRevenue')
  ]);
  return { count, totalRevenue };
}

function mergeRecordResults(snapshots) {
  const rowsById = new Map();
  snapshots.forEach(snap => {
    snap.docs.forEach(doc => rowsById.set(doc.id, { _id: doc.id, ...doc.data() }));
  });
  return [...rowsById.values()]
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
    .slice(0, RECORD_SEARCH_LIMIT);
}

async function searchCollectionRecords(collectionName, term) {
  const rawValue = String(term || '').trim();
  const value = rawValue.toLowerCase();
  if (!value) return [];
  const upperBound = value + '\uf8ff';
  const codeUpperBound = rawValue + '\uf8ff';
  const queries = [
    db.collection(collectionName)
      .where('nameLower', '>=', value)
      .where('nameLower', '<=', upperBound)
      .limit(RECORD_SEARCH_LIMIT),
    db.collection(collectionName)
      .where('itemCode', '>=', rawValue)
      .where('itemCode', '<=', codeUpperBound)
      .limit(RECORD_SEARCH_LIMIT),
  ];
  if (rawValue.toUpperCase() !== rawValue) {
    const upperCode = rawValue.toUpperCase();
    queries.push(db.collection(collectionName)
      .where('itemCode', '>=', upperCode)
      .where('itemCode', '<=', upperCode + '\uf8ff')
      .limit(RECORD_SEARCH_LIMIT));
  }
  const snapshots = await Promise.all(queries.map(query => query.get()
    .then(result => {
      if (typeof logFirestoreReadSuccess === 'function') logFirestoreReadSuccess(`${collectionName} search`);
      return result;
    })
    .catch(err => {
      if (typeof logFirestoreReadFailure === 'function') logFirestoreReadFailure(err);
      throw err;
    })
  ));
  return mergeRecordResults(snapshots);
}

// Expand salesDaily/{date} rollup docs into per-item-day rows for the Sales Data
// table. Sales is rollup-only now (no raw salesData), so we read just the day-docs
// in the selected range — one read per day — and unpack their products map.
function salesDailyDocToRows(date, data) {
  const products = (data && data.products) || {};
  const rows = [];
  Object.keys(products).forEach(code => {
    const p = products[code] || {};
    const unitsSold = Number(p.units) || 0;
    const totalRevenue = Number(p.revenue) || 0;
    const unitCost = Number(p.unit_cost) || 0;
    rows.push({
      _id: `${date}__${code}`,
      _fromRollup: true,
      date,
      itemCode: code,
      productName: p.name || code,
      category: p.category || '',
      unitsSold,
      sellingPrice: unitsSold > 0 ? Math.round((totalRevenue / unitsSold) * 10000) / 10000 : 0,
      totalRevenue,
      discount: 0,
      srpwdDiscount: 0,
      unitCost,
      salesFlag: 'Approved',
    });
  });
  return rows;
}

async function loadSalesData({ append = false } = {}) {
  if (!salesRangeStart || !salesRangeEnd) return [];
  let q = db.collection('salesDaily').orderBy(firebase.firestore.FieldPath.documentId());
  if (salesRangeStart) q = q.startAt(salesRangeStart);
  if (salesRangeEnd) q = q.endAt(salesRangeEnd);
  let snap;
  try {
    snap = await q.get();
    if (typeof logFirestoreReadSuccess === 'function') logFirestoreReadSuccess('sales read (salesDaily)');
  } catch (err) {
    if (typeof logFirestoreReadFailure === 'function') logFirestoreReadFailure(err);
    throw err;
  }
  const rawRows = [];
  snap.forEach(doc => rawRows.push(...salesDailyDocToRows(doc.id, doc.data())));
  const inventoryCostMap = await loadInventoryUnitCostMap();  // full itemCost map (1 bulk read)
  const rows = rawRows.map(row => normalizeSalesFinancials(row, inventoryCostMap));

  salesTotalRecords = rows.length;
  salesTotalRevenue = rows.reduce((s, r) => s + (Number(r.totalRevenue) || 0), 0);
  salesHasMoreRecords = false;          // rollup range is loaded in one pass
  salesLastDocSnapshot = null;
  salesRecordsLoaded = true;
  salesBrowseData = rows;               // not paginated; full range in memory
  salesSearchMode = false;
  salesSearchTerm = '';
  return salesBrowseData;
}

async function loadUnderReview({ append = false } = {}) {
  if (!salesRangeStart || !salesRangeEnd) return [];
  const aggregatePromise = !append ? loadRangeAggregates('underReviewData') : Promise.resolve(null);
  const snapPromise = buildRangeQuery('underReviewData', append, reviewLastDocSnapshot).get()
    .then(result => {
      if (typeof logFirestoreReadSuccess === 'function') logFirestoreReadSuccess('under-review read');
      return result;
    })
    .catch(err => {
      if (typeof logFirestoreReadFailure === 'function') logFirestoreReadFailure(err);
      throw err;
    });
  const [aggregate, snap] = await Promise.all([aggregatePromise, snapPromise]);
  if (aggregate) {
    reviewTotalRecords = aggregate.count;
    reviewTotalRevenue = aggregate.totalRevenue;
  }
  reviewLastDocSnapshot = snap.docs[snap.docs.length - 1] || reviewLastDocSnapshot;
  reviewHasMoreRecords = reviewTotalRecords == null
    ? snap.docs.length === VS_PAGE_SIZE
    : (append ? reviewBrowseData.length + snap.docs.length : snap.docs.length) < reviewTotalRecords;
  reviewRecordsLoaded = true;
  const rows = snap.docs.map(doc => ({ _id: doc.id, ...doc.data() }));
  reviewBrowseData = append ? [...reviewBrowseData, ...rows] : rows;
  reviewSearchMode = false;
  reviewSearchTerm = '';
  return reviewBrowseData;
}

async function searchSalesData(term) {
  // Sales is rollup-only: search within the loaded range (salesBrowseData). Make
  // sure the range is loaded first, then filter by item code / product name.
  if (!salesRecordsLoaded) { await loadSalesData({ append: false }); }
  const q = String(term || '').trim().toLowerCase();
  salesSearchMode = true;
  salesSearchTerm = q;
  salesHasMoreRecords = false;
  if (!q) return salesBrowseData;
  return salesBrowseData.filter(r =>
    String(r.itemCode || '').toLowerCase().includes(q) ||
    String(r.productName || '').toLowerCase().includes(q));
}

async function searchUnderReview(term) {
  reviewSearchMode = true;
  reviewSearchTerm = String(term || '').trim();
  reviewHasMoreRecords = false;
  return searchCollectionRecords('underReviewData', term);
}
// ─── Full-range CSV export (chunked, no DOM rendering) ────────────────────────
const EXPORT_CHUNK_SIZE = 500;

// Fetch every document in [start, end] from collectionName using Firestore
// pagination. onProgress(totalFetched) is called after each page.
// Returns a flat array of plain objects (no Firestore doc wrappers).
async function fetchAllRecordsForExport(collectionName, start, end, onProgress) {
  const rows = [];
  let cursor = null;
  while (true) {
    let q = db.collection(collectionName)
      .where('date', '>=', start)
      .where('date', '<=', end)
      .orderBy('date')
      .limit(EXPORT_CHUNK_SIZE);
    if (cursor) q = q.startAfter(cursor);
    let snap;
    try {
      snap = await q.get();
    } catch (err) {
      const indexUrl = typeof firestoreIndexUrlFromError === 'function'
        ? firestoreIndexUrlFromError(err) : null;
      if (indexUrl) {
        alert(`Firestore needs an index for this export. Open this link to create it:\n\n${indexUrl}`);
      }
      throw err;
    }
    snap.docs.forEach(doc => rows.push({ _id: doc.id, ...doc.data() }));
    if (typeof onProgress === 'function') onProgress(rows.length);
    if (snap.docs.length < EXPORT_CHUNK_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return rows;
}

async function exportSalesDataRange(start, end, onProgress) {
  // Sales is rollup-only: read salesDaily/{date} docs in range and expand.
  let q = db.collection('salesDaily').orderBy(firebase.firestore.FieldPath.documentId());
  if (start) q = q.startAt(start);
  if (end) q = q.endAt(end);
  const snap = await q.get();
  const rawRows = [];
  snap.forEach(doc => {
    rawRows.push(...salesDailyDocToRows(doc.id, doc.data()));
    if (typeof onProgress === 'function') onProgress(rawRows.length);
  });
  if (!rawRows.length) return null;
  const inventoryCostMap = await loadInventoryUnitCostMap();  // full itemCost map
  return rawRows.map(row => normalizeSalesFinancials(row, inventoryCostMap));
}

async function exportUnderReviewRange(start, end, onProgress) {
  const rows = await fetchAllRecordsForExport('underReviewData', start, end, onProgress);
  return rows.length ? rows : null;
}

// ─── Virtual scroll: incremental page fetch ───────────────────────────────────
async function loadNextSalesPage() {
  if (!salesHasMoreRecords || salesRecordsLoading || !salesRangeStart || !salesRangeEnd) return;
  salesRecordsLoading = true;
  updateRecordsQueryControls();
  try {
    let q = db.collection('salesData')
      .where('date', '>=', salesRangeStart)
      .where('date', '<=', salesRangeEnd)
      .orderBy('date')
      .limit(VS_PAGE_SIZE);
    if (salesLastDocSnapshot) q = q.startAfter(salesLastDocSnapshot);
    const snap = await q.get();
    if (typeof logFirestoreReadSuccess === 'function') logFirestoreReadSuccess('sales vs-page');
    if (snap.docs.length) {
      salesLastDocSnapshot = snap.docs[snap.docs.length - 1];
      const rawRows = snap.docs.map(doc => ({ _id: doc.id, ...doc.data() }));
      const inventoryCostMap = await loadInventoryUnitCostMap(rawRows.map(r => r.itemCode));
      const newRows = rawRows.map(row => normalizeSalesFinancials(row, inventoryCostMap));
      salesBrowseData = [...salesBrowseData, ...newRows];
      _salesData = salesBrowseData;
    }
    salesHasMoreRecords = salesTotalRecords == null
      ? snap.docs.length === VS_PAGE_SIZE
      : salesBrowseData.length < salesTotalRecords;
  } catch (err) {
    if (typeof logFirestoreReadFailure === 'function') logFirestoreReadFailure(err);
    console.error('[VS] loadNextSalesPage failed:', err);
  } finally {
    salesRecordsLoading = false;
    renderAll();
    updateRecordsQueryControls();
  }
}

async function loadNextReviewPage() {
  if (!reviewHasMoreRecords || reviewRecordsLoading || !salesRangeStart || !salesRangeEnd) return;
  reviewRecordsLoading = true;
  updateRecordsQueryControls();
  try {
    let q = db.collection('underReviewData')
      .where('date', '>=', salesRangeStart)
      .where('date', '<=', salesRangeEnd)
      .orderBy('date')
      .limit(VS_PAGE_SIZE);
    if (reviewLastDocSnapshot) q = q.startAfter(reviewLastDocSnapshot);
    const snap = await q.get();
    if (typeof logFirestoreReadSuccess === 'function') logFirestoreReadSuccess('review vs-page');
    if (snap.docs.length) {
      reviewLastDocSnapshot = snap.docs[snap.docs.length - 1];
      const newRows = snap.docs.map(doc => ({ _id: doc.id, ...doc.data() }));
      reviewBrowseData = [...reviewBrowseData, ...newRows];
      _reviewData = reviewBrowseData;
    }
    reviewHasMoreRecords = reviewTotalRecords == null
      ? snap.docs.length === VS_PAGE_SIZE
      : reviewBrowseData.length < reviewTotalRecords;
  } catch (err) {
    if (typeof logFirestoreReadFailure === 'function') logFirestoreReadFailure(err);
    console.error('[VS] loadNextReviewPage failed:', err);
  } finally {
    reviewRecordsLoading = false;
    renderAll();
    updateRecordsQueryControls();
  }
}

function saveSalesDataBatch(docs, onProgress) { return batchWriteToDB('salesData', docs, onProgress); }
async function saveManualSalesEntry(doc) {
  if (!requireSalesEditAccess()) return null;
  const ref = await db.collection('salesData').add(doc);
  return { _id: ref.id, ...doc };
}
function saveUnderReviewBatch(docs, onProgress) { return batchWriteToDB('underReviewData', docs, onProgress); }
function fetchProductMaster() { return loadProductMasterMap(); }
async function upsertProductMaster(itemCode, productData) {
  if (!requireSalesEditAccess()) return null;
  const ref = db.collection('productMaster').doc(normalizeItemCode(itemCode));
  await ref.set(epcStamp(productData), { merge:true });
  return ref;
}
async function deleteFromFirestore(collectionName, ids, onProgress, batchSize = 499, retries = 3) {
  if (!requireSalesEditAccess()) return;
  const totalBatches = Math.max(1, Math.ceil(ids.length / batchSize));
  for (let start = 0; start < ids.length; start += batchSize) {
    let attempt = 0;
    while (true) {
      try {
        const batch = db.batch();
        ids.slice(start, start + batchSize).forEach(id => batch.delete(db.collection(collectionName).doc(id)));
        await batch.commit();
        break;
      } catch (err) {
        attempt++;
        if (attempt >= retries) throw err;
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
    if (onProgress) onProgress(Math.round((Math.floor(start / batchSize) + 1) / totalBatches * 100));
  }
}

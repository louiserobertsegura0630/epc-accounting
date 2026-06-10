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
  const sellingPrice = Number(row?.sellingPrice ?? row?.srpUnit) || 0;
  const totalCost = Number(row?.totalCost) || ((Number(row?.unitCost) || 0) * unitsSold);
  const unitCost = unitsSold > 0 ? totalCost / unitsSold : Number(row?.unitCost) || 0;
  void grossProfit;
  return unitCost > 0 ? Number(((sellingPrice - unitCost) / unitCost * 100).toFixed(1)) : 0;
}

function salesGrossProfitAmount(row) {
  const totalCost = Number(row?.totalCost) || ((Number(row?.unitCost) || 0) * (Number(row?.unitsSold) || 0));
  return salesGrossSrp(row) - totalCost;
}

function normalizeSalesFinancials(row) {
  const unitsSold = Number(row.unitsSold) || 0;
  const unitCost = Number(row.unitCost) || 0;
  const totalCost = Number(row.totalCost) || (unitCost * unitsSold);
  const grossProfit = salesGrossProfitAmount({ ...row, unitsSold, unitCost, totalCost });
  return {
    ...row,
    totalCost,
    grossProfit,
    margin: salesMarginPercent(grossProfit, row),
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
    const [salesSnapshot, productMap] = await Promise.all([
      db.collection('salesData').get(),
      loadProductMasterMap(),
    ]);
    const rows = salesSnapshot.docs.map(doc => ({ _id: doc.id, ...doc.data() }));
    const batchSize = 499;
    const totalBatches = Math.max(1, Math.ceil(rows.length / batchSize));

    for (let start = 0; start < rows.length; start += batchSize) {
      const chunk = rows.slice(start, start + batchSize);
      const batch = db.batch();
      chunk.forEach(row => {
        const codeKey = String(row.itemCode || '').trim();
        const product = productMap[codeKey] || productMap[codeKey.toUpperCase()];
        const unitCost = product ? productCostForMethod(product) : (Number(row.unitCost) || 0);
        const unitsSold = Number(row.unitsSold) || 0;
        const totalRevenue = Number(row.totalRevenue) || 0;
        const totalCost = unitCost * unitsSold;
        const grossProfit = salesGrossProfitAmount({ ...row, unitsSold, unitCost, totalCost });
        const margin = salesMarginPercent(grossProfit, { ...row, unitsSold, unitCost, totalCost });
        Object.assign(row, { unitCost, totalCost, grossProfit, margin, costMethod });
        batch.update(db.collection('salesData').doc(row._id), {
          unitCost, totalCost, grossProfit, margin, costMethod
        });
      });
      await batch.commit();
      const percent = Math.round((Math.floor(start / batchSize) + 1) / totalBatches * 100);
      fillEl.style.width = `${percent}%`;
      labelEl.textContent = `Recomputing COGS... ${percent}%`;
    }

    _salesData = rows;
    fillEl.style.width = '100%';
    labelEl.textContent = 'COGS recompute complete! ✓';
    renderAll();
    await new Promise(resolve => setTimeout(resolve, 1000));
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
        await pmSnap.docs[0].ref.update({ category: values.category });
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
      await existingPM.docs[0].ref.set(pmDocData, { merge: true });
    } else {
      await db.collection('productMaster').add(pmDocData);
    }

    // 2. Add to salesData
    const salesDoc = {
      date:         row.date,
      itemCode:     row.itemCode,
      productName:  row.productName,
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
async function loadSalesData() {
  const snap = await db.collection('salesData').orderBy('date', 'desc').get();
  return snap.docs.map(doc => normalizeSalesFinancials({ _id: doc.id, ...doc.data() }));
}
async function loadUnderReview() {
  const snap = await db.collection('underReviewData').get();
  return snap.docs.map(doc => ({ _id: doc.id, ...doc.data() }));
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
  await ref.set(productData, { merge:true });
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

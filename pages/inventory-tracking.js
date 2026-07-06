
initSidebar('inventory-tracking');

const INV_CATS = ['Grains','Cooking Essentials','Condiments','Instant Food','Dairy & Eggs'];
let selectedOutgoingProduct = null;
let outgoingSearchTimer = null;
let outgoingSearchQuery = '';
let potentialSubtab = 'included';
let potentialDetailCode = '';
let potentialPage = 1;
let potentialLastSearch = '';
const selectedPotentialCodes = new Set();
let potentialSortKey = 'potentialRevenue';
let potentialSortDir = 'desc';
let potentialFilters = {};
let inventoryAggregateTotals = null;
let inventoryLastDocSnapshot = null;
let inventoryDailyCursor = null;   // last date loaded for the rollup-based movements table
let inventoryHasMoreRecords = false;
let inventoryHasGenerated = false;   // KPIs/table stay blank until Generate is run
let inventorySalesRematchRunning = false;
const INVENTORY_SALES_REMATCH_PAGE_SIZE = 500;

// ─── Virtual Scroll State ─────────────────────────────────────────────────────
const INV_VS_ROW_H    = 38;
const INV_VS_WINDOW   = 80;
const INV_VS_OVERSCAN = 10;
let _invVsScrollTop   = 0;
let _invVsSentinelObs = null;
let _invVsRAF         = 0;
let _invVsLoadingMore = false;
let _invVsWindowRows  = [];
const POTENTIAL_PAGE_SIZE = 50;
const POTENTIAL_MARKUP_KEY = 'inventoryPotentialMarkupSettings';
const POTENTIAL_COLUMNS = [
  { key: 'itemCode', label: 'Item Code', type: 'text' },
  { key: 'description', label: 'Description', type: 'text' },
  { key: 'category', label: 'Category', type: 'select' },
  { key: 'supplier', label: 'Supplier', type: 'text' },
  { key: 'remainingQty', label: 'Remaining Qty', type: 'number' },
  { key: 'unitCost', label: 'Unit Cost', type: 'number' },
  { key: 'effectiveSellingPrice', label: 'Selling Price Basis', type: 'number' },
  { key: 'potentialRevenue', label: 'Potential Revenue', type: 'number' },
  { key: 'status', label: 'Status', type: 'select' }
];

function inventoryCode(value) {
  return String(value || '').trim();
}

function inventoryProductCode(product) {
  return inventoryCode(product?.itemCode || product?.code);
}

function inventoryProductDescription(product) {
  return String(product?.productName || product?.name || product?.description || '').trim();
}

function inventoryProductForCode(itemCode) {
  const code = inventoryCode(itemCode);
  return getCachedProductMasterRows().find(product => inventoryProductCode(product) === code);
}

function inventoryProductSellingPrice(product) {
  return Number(
    product?.sellingPrice ??
    product?.srp ??
    product?.retailPrice ??
    product?.price ??
    product?.unitPrice ??
    0
  ) || 0;
}

function salesRevenueValue(sale, qty) {
  const directRevenue = Number(
    sale.totalRevenue ??
    sale.revenue ??
    sale.totalAmount ??
    sale.totalSales ??
    sale.grossSales ??
    sale.amount ??
    0
  ) || 0;
  if (directRevenue > 0) return directRevenue;
  const sellingPrice = Number(sale.sellingPrice ?? sale.price ?? sale.srp ?? 0) || 0;
  return sellingPrice > 0 && qty > 0 ? sellingPrice * qty : 0;
}

function inventoryDisplayDescription(row) {
  return inventoryProductDescription(inventoryProductForCode(row.itemCode)) || row.description || '';
}

function inventoryDisplayCategory(row) {
  return String(inventoryProductForCode(row.itemCode)?.category || '').trim() || 'Uncategorized';
}

function inventoryRowsForCode(itemCode) {
  const code = inventoryCode(itemCode);
  return DB.get('inventory_movements').filter(row => inventoryCode(row.itemCode) === code);
}

function inventoryTotalsForCode(itemCode) {
  const rows = inventoryRowsForCode(itemCode);
  const incoming = rows.filter(row => row.type === 'Incoming')
    .reduce((sum, row) => sum + (Number(row.qty) || 0), 0);
  const outgoing = rows.filter(row => row.type === 'Outgoing')
    .reduce((sum, row) => sum + (Number(row.qty) || 0), 0);
  return { incoming, outgoing, balance: incoming - outgoing };
}

// ─── POS Sales → derived Outgoing rows ──────────────────────────────────────
// Every POS sale shows up as an Outgoing movement (read-only; owned by Sales).
// Derived at load time only — never written back to Firestore inventoryData.
function saleToOutgoingRow(sale, index) {
  const code = inventoryCode(sale.itemCode ?? sale.code);
  const qty  = Number(sale.unitsSold ?? sale.quantity ?? sale.qty ?? sale.unitSold ?? sale.soldQty) || 0;
  if (!code || qty <= 0) return null;
  const unitCost = Number(sale.unitCost ?? sale.cost) || 0;
  const raw = sale.date ?? sale.dateSold ?? sale.transactionDate;
  const date = raw && typeof raw.toDate === 'function'
    ? raw.toDate().toISOString().slice(0, 10)
    : String(raw || '').slice(0, 10);
  return {
    id: `sale-${sale._firestoreId || sale.id || `${code}|${date}|${qty}|${index}`}`,
    type: 'Outgoing',
    itemCode: code,
    description: sale.productName || sale.description || sale.itemName || '',
    category: sale.category || '',
    supplier: '',
    unitCost,
    qty,
    totalCost: Number(sale.totalCost) || unitCost * qty,
    dateDelivered: date,
    notes: 'POS Sale',
    _derived: true,
  };
}

// Average selling price per item code, derived from POS sales (salesData).
// Weighted ASP = total revenue / total units sold across all sales of that item.
let salesAspByCode = {};

function inventoryAvgSellingPrice(itemCode) {
  return salesAspByCode[inventoryCode(itemCode)] || 0;
}

// Potential revenue of an incoming batch = ASP × incoming units.
function inventoryPotentialRevenue(row) {
  if (String(row.type || 'Incoming').toLowerCase() === 'outgoing') return 0;
  return inventoryAvgSellingPrice(row.itemCode) * (Number(row.qty) || 0);
}

function getPotentialMarkupSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(POTENTIAL_MARKUP_KEY) || '{}');
    return {
      globalMarkup: Number(parsed.globalMarkup) || 0,
      categoryMarkup: parsed.categoryMarkup && typeof parsed.categoryMarkup === 'object'
        ? parsed.categoryMarkup
        : {},
      itemOverrides: parsed.itemOverrides && typeof parsed.itemOverrides === 'object'
        ? parsed.itemOverrides
        : {},
      excludedCodes: Array.isArray(parsed.excludedCodes) ? parsed.excludedCodes : []
    };
  } catch {
    return { globalMarkup: 0, categoryMarkup: {}, itemOverrides: {}, excludedCodes: [] };
  }
}

function savePotentialMarkupSettings(settings) {
  localStorage.setItem(POTENTIAL_MARKUP_KEY, JSON.stringify(settings));
}

function potentialMarkupForCategory(category) {
  const settings = getPotentialMarkupSettings();
  const categoryValue = Number(settings.categoryMarkup?.[category]);
  return Number.isFinite(categoryValue) && categoryValue > 0
    ? categoryValue
    : settings.globalMarkup;
}

function potentialItemOverride(itemCode) {
  return getPotentialMarkupSettings().itemOverrides?.[inventoryCode(itemCode)] || {};
}

function latestIncomingCost(rows) {
  const latest = rows
    .filter(row => row.type === 'Incoming' && Number(row.unitCost) > 0)
    .sort((a, b) => String(b.dateDelivered || '').localeCompare(String(a.dateDelivered || '')))[0];
  return Number(latest?.unitCost) || 0;
}

function potentialRevenueRows() {
  const grouped = new Map();
  const settings = getPotentialMarkupSettings();
  const excluded = new Set((settings.excludedCodes || []).map(inventoryCode));
  DB.get('inventory_movements').forEach(row => {
    const code = inventoryCode(row.itemCode);
    if (!code || excluded.has(code)) return;
    if (!grouped.has(code)) grouped.set(code, {
      itemCode: code,
      rows: [],
      incomingRows: [],
      outgoingRows: [],
      incomingQty: 0,
      outgoingQty: 0
    });
    const group = grouped.get(code);
    group.rows.push(row);
    if (row.type === 'Incoming') {
      group.incomingRows.push(row);
      group.incomingQty += Number(row.qty) || 0;
    } else if (row.type === 'Outgoing') {
      group.outgoingRows.push(row);
      group.outgoingQty += Number(row.qty) || 0;
    }
  });

  return [...grouped.values()].map(group => {
    const sample = group.incomingRows[0] || group.rows[0] || {};
    const product = inventoryProductForCode(group.itemCode);
    const category = inventoryDisplayCategory(sample);
    const unitCost = latestIncomingCost(group.rows);
    const productSellingPrice = inventoryProductSellingPrice(product);
    const avgSellingPrice = inventoryAvgSellingPrice(group.itemCode);
    const override = settings.itemOverrides?.[group.itemCode] || {};
    const manualPrice = Number(override.sellingPrice) || 0;
    const manualMarkup = Number(override.markupPercent) || 0;
    const markupPercent = potentialMarkupForCategory(category);
    const manualMarkupSellingPrice = unitCost > 0 && manualMarkup > 0
      ? unitCost * (1 + manualMarkup / 100)
      : 0;
    const markupSellingPrice = unitCost > 0 && markupPercent > 0
      ? unitCost * (1 + markupPercent / 100)
      : 0;
    const effectiveSellingPrice = manualPrice > 0
      ? manualPrice
      : avgSellingPrice > 0
        ? avgSellingPrice
        : manualMarkupSellingPrice > 0
          ? manualMarkupSellingPrice
          : productSellingPrice > 0
            ? productSellingPrice
            : markupSellingPrice;
    const remainingQty = group.incomingQty - group.outgoingQty;
    const source = manualPrice > 0
      ? 'Manual selling price'
      : avgSellingPrice > 0
        ? 'Sales average'
        : manualMarkupSellingPrice > 0
          ? `Manual markup ${manualMarkup}%`
          : productSellingPrice > 0
            ? 'Product Master selling price'
            : (markupPercent > 0 ? `Markup ${markupPercent}%` : 'For review');
    return {
      ...group,
      remainingQty,
      description: inventoryDisplayDescription(sample),
      category,
      supplier: sample.supplier || group.incomingRows.find(row => row.supplier)?.supplier || '',
      unitCost,
      productSellingPrice,
      avgSellingPrice,
      markupPercent,
      manualPrice,
      manualMarkup,
      effectiveSellingPrice,
      potentialRevenue: remainingQty > 0 ? effectiveSellingPrice * remainingQty : 0,
      source
    };
  }).filter(row => row.remainingQty > 0);
}

function potentialRevenueIncludedRows() {
  return potentialRevenueRows().filter(row => row.effectiveSellingPrice > 0);
}

function potentialRevenueReviewRows() {
  return potentialRevenueRows().filter(row => row.effectiveSellingPrice <= 0);
}

function totalPotentialRevenue() {
  return potentialRevenueIncludedRows().reduce((sum, row) => sum + row.potentialRevenue, 0);
}

// Replace the derived sales-outgoing rows in the movements array with a fresh
// set built from the given sales records, then repaint table + summary.
function applySalesOutgoing(sales) {
  // Recompute average selling price per item code from the sales records.
  const agg = {};
  (sales || []).forEach(s => {
    const code = inventoryCode(s.itemCode ?? s.code);
    const qty = Number(s.unitsSold ?? s.quantity ?? s.qty) || 0;
    if (!code) return;
    if (!agg[code]) agg[code] = { rev: 0, units: 0 };
    agg[code].rev   += salesRevenueValue(s, qty);
    agg[code].units += qty;
  });
  salesAspByCode = {};
  Object.keys(agg).forEach(code => {
    salesAspByCode[code] = agg[code].units ? agg[code].rev / agg[code].units : 0;
  });

  const real    = DB.get('inventory_movements').filter(row => !row._derived);
  const derived = (sales || []).map(saleToOutgoingRow).filter(Boolean);
  DB.set('inventory_movements', [...real, ...derived]);
  invTable.render();
  renderSummary();
}

function setInventorySalesRematchProgress(processed = 0, total = 0, label = 'Re-matching Sales...') {
  const wrap = document.getElementById('inventory-sales-rematch-progress');
  const fill = document.getElementById('inventory-sales-rematch-fill');
  const text = document.getElementById('inventory-sales-rematch-text');
  if (!wrap || !fill || !text) return;
  const done = Math.max(0, Number(processed) || 0);
  const all = Math.max(0, Number(total) || 0);
  const pct = all > 0 ? Math.min(100, Math.floor(done / all * 100)) : 0;
  wrap.style.display = '';
  fill.style.width = `${pct}%`;
  text.textContent = all > 0
    ? `${label} ${pct}% (${done.toLocaleString()} / ${all.toLocaleString()})`
    : `${label} ${done.toLocaleString()} processed`;
}

function hideInventorySalesRematchProgress() {
  const wrap = document.getElementById('inventory-sales-rematch-progress');
  const fill = document.getElementById('inventory-sales-rematch-fill');
  const text = document.getElementById('inventory-sales-rematch-text');
  if (fill) fill.style.width = '0%';
  if (text) text.textContent = '';
  if (wrap) wrap.style.display = 'none';
}

async function countInventorySalesRows(db) {
  const query = db.collection('salesData');
  if (typeof firestoreCount === 'function') return firestoreCount(query, 'salesData inventory re-match count');
  if (typeof query.count !== 'function') return null;
  const snap = await query.count().get();
  return Number(snap.data().count) || 0;
}

async function fetchSalesRowsForInventoryRematch(db, total) {
  const sales = [];
  let cursor = null;
  let processed = 0;
  while (true) {
    let query = db.collection('salesData')
      .orderBy(firebase.firestore.FieldPath.documentId())
      .limit(INVENTORY_SALES_REMATCH_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    snap.docs.forEach(doc => sales.push({ _firestoreId: doc.id, ...doc.data() }));
    processed += snap.docs.length;
    setInventorySalesRematchProgress(processed, total, 'Re-matching Sales...');
    if (snap.docs.length < INVENTORY_SALES_REMATCH_PAGE_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return sales;
}

async function rematchInventoryAgainstSales({ silent = false } = {}) {
  const db = getFirestoreDB();
  const btn = document.getElementById('btn-rematch-sales-inv');
  if (inventorySalesRematchRunning) return;
  inventorySalesRematchRunning = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Re-matching...';
  }

  try {
    if (!db) {
      const localSales = DB.get('pos_sales');
      setInventorySalesRematchProgress(localSales.length, localSales.length, 'Re-matching Sales...');
      applySalesOutgoing(localSales);
      if (!silent) showToast(`Re-matched ${localSales.length.toLocaleString()} sales rows against inventory item codes.`, 'success');
      return;
    }

    const total = await countInventorySalesRows(db);
    setInventorySalesRematchProgress(0, total, 'Re-matching Sales...');
    const sales = await fetchSalesRowsForInventoryRematch(db, total);
    const derived = sales.map(saleToOutgoingRow).filter(Boolean);
    console.info(`[Inventory] salesData re-match: ${sales.length} sales docs -> ${derived.length} outgoing rows.`);
    applySalesOutgoing(sales);
    if (!silent) {
      showToast(
        `Re-matched ${sales.length.toLocaleString()} sales row${sales.length === 1 ? '' : 's'} against inventory item codes.`,
        'success'
      );
    }
  } catch (err) {
    console.error('[Inventory] salesData re-match failed:', err);
    const indexUrl = typeof firestoreIndexUrlFromError === 'function' ? firestoreIndexUrlFromError(err) : '';
    if (indexUrl) {
      alert(`Firestore needs an index for this inventory/sales re-match. Open this link to create it:\n\n${indexUrl}`);
    } else if (!silent) {
      alert(`Could not re-match inventory against Sales: ${err.message || err}`);
    }
  } finally {
    inventorySalesRematchRunning = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Re-match Sales';
    }
    setTimeout(hideInventorySalesRematchProgress, 900);
  }
}

// Live source of truth: the Sales page writes to the 'salesData' collection.
// Each POS sale becomes a read-only Outgoing movement here.
function watchSalesOutgoing() {
  rematchInventoryAgainstSales({ silent: true });
}

function outgoingProductCost(product) {
  const productCost = Number(product?.latestCost ?? product?.unitCost ?? product?.cost) || 0;
  if (productCost > 0) return productCost;
  return Number(inventoryRowsForCode(inventoryProductCode(product))
    .filter(row => row.type === 'Incoming' && Number(row.unitCost) > 0)
    .sort((a, b) => String(b.dateDelivered || '').localeCompare(String(a.dateDelivered || '')))[0]?.unitCost) || 0;
}

function invEsc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isOutgoingEntry() {
  return document.getElementById('r-outgoing').checked;
}

function calcInvTotal() {
  const cost = parsePeso(document.getElementById('inv-unit-cost').value) || 0;
  const qty  = parseInt(document.getElementById('inv-qty').value) || 0;
  document.getElementById('inv-total-cost').value = formatNum(cost * qty);
}
document.getElementById('inv-unit-cost').addEventListener('input', calcInvTotal);
document.getElementById('inv-qty').addEventListener('input', () => {
  calcInvTotal();
  renderOutgoingWarning();
});

function clearOutgoingSelection(clearInputs = true) {
  selectedOutgoingProduct = null;
  outgoingSearchQuery = '';
  if (clearInputs) {
    document.getElementById('inv-code').value = '';
    document.getElementById('inv-desc').value = '';
    document.getElementById('inv-category').value = '';
    document.getElementById('inv-unit-cost').value = '';
    calcInvTotal();
  }
  document.getElementById('inv-code').readOnly = false;
  document.getElementById('inv-desc').readOnly = false;
  document.getElementById('inv-category').disabled = false;
  document.getElementById('inv-product-search-results').innerHTML = '';
  document.getElementById('btn-change-inv-product').classList.remove('open');
  document.getElementById('inv-outgoing-detail').classList.remove('open');
  renderOutgoingWarning();
}

function syncInventoryTypeMode() {
  const outgoing = isOutgoingEntry();
  document.getElementById('inv-supplier-group').classList.toggle('inv-hidden', outgoing);
  document.getElementById('inv-unit-cost-group').classList.toggle('inv-hidden', outgoing);
  document.getElementById('inv-supplier').disabled = outgoing;
  document.getElementById('inv-unit-cost').disabled = outgoing;
  document.getElementById('inv-qty-label').textContent = outgoing ? 'Outgoing units' : 'Quantity';
  if (!outgoing) clearOutgoingSelection(false);
}

function rankOutgoingProduct(product, query) {
  const code = inventoryProductCode(product).toLowerCase();
  const description = inventoryProductDescription(product).toLowerCase();
  if (code === query || description === query) return 0;
  if (code.startsWith(query) || description.startsWith(query)) return 1;
  return 2;
}

function queueOutgoingSearch(event) {
  if (!isOutgoingEntry() || selectedOutgoingProduct) return;
  outgoingSearchQuery = String(event?.target?.value || '').trim().toLowerCase();
  clearTimeout(outgoingSearchTimer);
  outgoingSearchTimer = setTimeout(renderOutgoingSearchResults, 200);
}

function renderOutgoingSearchResults() {
  const results = document.getElementById('inv-product-search-results');
  const query = outgoingSearchQuery;
  if (!isOutgoingEntry() || selectedOutgoingProduct || query.length < 2) {
    results.innerHTML = '';
    return;
  }
  const matches = getCachedProductMasterRows()
    .filter(product => {
      const code = inventoryProductCode(product).toLowerCase();
      const description = inventoryProductDescription(product).toLowerCase();
      return code.includes(query) || description.includes(query);
    })
    .sort((a, b) => rankOutgoingProduct(a, query) - rankOutgoingProduct(b, query))
    .slice(0, 5);
  results.innerHTML = matches.length ? matches.map(product => `
    <button class="inv-product-result" type="button" data-item-code="${invEsc(inventoryProductCode(product))}">
      <strong class="mono">${invEsc(inventoryProductCode(product))}</strong>
      <span>${invEsc(inventoryProductDescription(product))}</span>
    </button>`).join('') : '<div class="inv-product-result"><span>No matching Product Master items.</span></div>';
}

function ensureInventoryCategoryOption(category) {
  const select = document.getElementById('inv-category');
  if (category && ![...select.options].some(option => option.value === category)) {
    select.insertAdjacentHTML('beforeend', `<option value="${invEsc(category)}">${invEsc(category)}</option>`);
  }
}

function selectOutgoingProduct(itemCode) {
  selectedOutgoingProduct = getCachedProductMasterRows()
    .find(product => inventoryProductCode(product) === inventoryCode(itemCode));
  if (!selectedOutgoingProduct) return;
  const code = inventoryProductCode(selectedOutgoingProduct);
  const description = inventoryProductDescription(selectedOutgoingProduct);
  const category = selectedOutgoingProduct.category || 'Uncategorized';
  ensureInventoryCategoryOption(category);
  document.getElementById('inv-code').value = code;
  document.getElementById('inv-desc').value = description;
  document.getElementById('inv-code').readOnly = true;
  document.getElementById('inv-desc').readOnly = true;
  document.getElementById('inv-category').value = category;
  document.getElementById('inv-category').disabled = true;
  document.getElementById('inv-unit-cost').value = formatNum(outgoingProductCost(selectedOutgoingProduct));
  document.getElementById('inv-product-search-results').innerHTML = '';
  document.getElementById('btn-change-inv-product').classList.add('open');
  renderOutgoingProductDetail();
  calcInvTotal();
}

function renderOutgoingProductDetail() {
  if (!selectedOutgoingProduct) return;
  const code = inventoryProductCode(selectedOutgoingProduct);
  const totals = inventoryTotalsForCode(code);
  document.getElementById('inv-balance-incoming').textContent = totals.incoming.toLocaleString();
  document.getElementById('inv-balance-outgoing').textContent = totals.outgoing.toLocaleString();
  document.getElementById('inv-balance-current').textContent = totals.balance.toLocaleString();
  document.getElementById('inv-outgoing-detail').classList.add('open');
  const history = inventoryRowsForCode(code)
    .filter(row => row.type === 'Incoming')
    .sort((a, b) => String(b.dateDelivered || '').localeCompare(String(a.dateDelivered || '')));
  document.getElementById('inv-incoming-history').innerHTML = history.length
    ? history.map(row => `<div>${formatDate(row.dateDelivered)} <strong>${Number(row.qty).toLocaleString()} units</strong></div>`).join('')
    : '<div>No incoming records found.</div>';
  renderOutgoingWarning();
}

function renderOutgoingWarning() {
  const qty = Number(document.getElementById('inv-qty').value) || 0;
  const balance = selectedOutgoingProduct
    ? inventoryTotalsForCode(inventoryProductCode(selectedOutgoingProduct)).balance : 0;
  document.getElementById('inv-outgoing-warning').classList
    .toggle('open', Boolean(isOutgoingEntry() && selectedOutgoingProduct && qty > balance));
}

async function syncInventoryDisplayFieldsToProductMaster(itemCode, description, category) {
  const code = inventoryCode(itemCode);
  if (!code) return;
  const productName = String(description || '').trim();
  const productCategory = String(category || '').trim() || 'Uncategorized';
  const products = getCachedProductMasterRows();
  let product = products.find(row => inventoryProductCode(row) === code);
  if (product) {
    product.productName = productName;
    product.name = productName;
    product.category = productCategory;
  } else {
    product = {
      id:genId(), itemCode:code, code, productName, name:productName,
      category:productCategory, status:'Active'
    };
    products.push(product);
  }
  cacheProductMasterRows(products);

  const db = getFirestoreDB();
  if (!db) return;
  const snapshot = await db.collection('productMaster')
    .where('itemCode', '==', code)
    .limit(1)
    .get();
  const fields = { itemCode:code, productName, name:productName, category:productCategory };
  if (!snapshot.empty) await snapshot.docs[0].ref.set(fields, { merge:true });
  else await db.collection('productMaster').doc(code).set(fields, { merge:true });
}

function setTab(tab) {
  ['all','incoming','outgoing'].forEach(t => {
    document.getElementById('tab-'+t)?.classList.toggle('active', t===tab);
  });
  const labels = {
    all:'All Movements',
    incoming:'Incoming Movements',
    outgoing:'Outgoing Movements'
  };
  document.getElementById('tab-label').textContent = labels[tab];
  document.getElementById('inv-thead')?.closest('.table-container')?.classList.toggle('inv-hide-revenue-cols', tab === 'incoming');
  document.getElementById('potential-revenue-panel')?.classList.toggle('open', tab === 'potential');
  resetInventoryVirtualScroll();
  invTable.setTab(tab);
}

function resetInventoryVirtualScroll() {
  _invVsScrollTop = 0;
  const scroll = document.getElementById('inv-tbody')?.closest('.table-scroll');
  if (scroll) scroll.scrollTop = 0;
}

function resetForm() {
  document.getElementById('inv-edit-id').value = '';
  document.getElementById('modal-inv-title').textContent = 'Add Inventory Entry';
  document.getElementById('inv-code').value = '';
  document.getElementById('inv-desc').value = '';
  document.getElementById('inv-unit-cost').value = '';
  document.getElementById('inv-qty').value = '';
  document.getElementById('inv-total-cost').value = '';
  document.getElementById('inv-notes').value = '';
  document.getElementById('inv-date').value = todayISO();
  document.getElementById('r-incoming').checked = true;
  if (invTable.activeTab === 'outgoing') document.getElementById('r-outgoing').checked = true;
  initCatDropdown(document.getElementById('inv-category'), 'inv', INV_CATS);
  setSupplierPickerValue('inv-supplier', '');
  clearOutgoingSelection(false);
  syncInventoryTypeMode();
}

function renderSummary() {
  // Before Generate, KPIs stay blank (no history scan) — they reflect only the
  // generated date window once the user runs a query.
  const blank = !inventoryHasGenerated;
  const movs = DB.get('inventory_movements');
  const inVal = inventoryAggregateTotals?.inVal ?? movs.filter(m=>m.type==='Incoming').reduce((s,m)=>s+(m.totalCost||0),0);
  const outVal = inventoryAggregateTotals?.outVal ?? movs.filter(m=>m.type==='Outgoing').reduce((s,m)=>s+(m.totalCost||0),0);
  const show = (cls, v) => blank ? '<div class="kpi-value kpi-muted">—</div>' : `<div class="kpi-value ${cls}">${formatPeso(v)}</div>`;
  document.getElementById('inv-summary').innerHTML = `
    <div class="summary-card">
      <div class="kpi-label">Total Incoming Value</div>
      ${show('green', inVal)}
    </div>
    <div class="summary-card">
      <div class="kpi-label">Total Outgoing Value</div>
      ${show('red', outVal)}
    </div>
    <div class="summary-card">
      <div class="kpi-label">Net Movement</div>
      ${show((inVal-outVal)>=0?'blue':'', inVal-outVal)}
    </div>`;
}

// Total Incoming Value now SUMS dailyPurchases (one read per day), not raw rows.
// Outgoing still comes from salesData-derived rows in memory (unchanged model).
async function sumDailyPurchases(db, fromDate, toDate) {
  let q = db.collection('dailyPurchases');
  if (fromDate) q = q.where(firebase.firestore.FieldPath.documentId(), '>=', fromDate);
  if (toDate)   q = q.where(firebase.firestore.FieldPath.documentId(), '<=', toDate);
  const snap = await q.get();
  let total = 0, qty = 0, days = 0;
  snap.forEach((doc) => { const d = doc.data(); total += Number(d.total_cost) || 0; qty += Number(d.qty) || 0; days++; });
  return { total: Math.round(total * 100) / 100, qty, days };
}

// Per-product lookup: read inventoryDaily day-docs in [fromDate,toDate] and pick
// item_code out of each in the browser — one read per day, never a raw-row scan.
async function lookupItemAcrossDays(itemCode, fromDate, toDate) {
  const db = getFirestoreDB();
  if (!db) return [];
  const code = String(itemCode || '').trim();
  if (!code) return [];
  let q = db.collection('inventoryDaily');
  if (fromDate) q = q.where(firebase.firestore.FieldPath.documentId(), '>=', fromDate);
  if (toDate)   q = q.where(firebase.firestore.FieldPath.documentId(), '<=', toDate);
  const snap = await q.get();
  const out = [];
  snap.forEach((doc) => {
    const it = (doc.data().items || {})[code];
    if (it) out.push({ date: doc.id, itemCode: code, name: it.name, qty: it.qty, unitCost: it.unit_cost, totalCost: it.total_cost });
  });
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// Memoized code -> supplier map from Product Master (for backfilling old rollup
// rows that predate storing supplier in inventoryDaily).
let _invSupplierMap = null;
function inventorySupplierForCode(code) {
  if (!_invSupplierMap) {
    _invSupplierMap = new Map();
    (getCachedProductMasterRows() || []).forEach((p) => {
      const c = inventoryProductCode(p);
      if (c && p.supplier) _invSupplierMap.set(c, p.supplier);
    });
  }
  return _invSupplierMap.get(inventoryCode(code)) || '';
}
function invalidateInvSupplierMap() { _invSupplierMap = null; }

// Build a movements-table row from one inventoryDaily item entry. Gives it a stable
// id (date__code) so selection works, and resolves supplier (rollup first, then
// Product Master fallback for older data that didn't store it).
function rollupItemToRow(date, code, it) {
  return {
    id: `${date}__${code}`,
    dateDelivered: date,
    type: 'Incoming',
    itemCode: code,
    description: it.name || '',
    category: '',
    supplier: it.supplier || inventorySupplierForCode(code) || '',
    unitCost: it.unit_cost,
    qty: it.qty,
    totalCost: it.total_cost,
    _fromRollup: true,
  };
}

// Server-side paginated movements table from inventoryDaily. Fetch a window of
// day-docs (newest first), unpack their items into item-day rows. One read/day.
async function loadInventoryDailyPage({ pageDays = 14, beforeDate = null } = {}) {
  const db = getFirestoreDB();
  if (!db) return { rows: [], lastDate: null, hasMore: false };
  let q = db.collection('inventoryDaily').orderBy(firebase.firestore.FieldPath.documentId(), 'desc');
  if (beforeDate) q = q.where(firebase.firestore.FieldPath.documentId(), '<', beforeDate);
  q = q.limit(pageDays);
  const snap = await q.get();
  const rows = [];
  snap.forEach((doc) => {
    const items = doc.data().items || {};
    Object.keys(items).forEach((code) => rows.push(rollupItemToRow(doc.id, code, items[code])));
  });
  const lastDate = snap.docs.length ? snap.docs[snap.docs.length - 1].id : null;
  return { rows, lastDate, hasMore: snap.docs.length === pageDays };
}

// Load inventory movements for a specific date range from inventoryDaily rollups.
// Reads only the day-docs in [from,to] — one read per day in range.
async function loadInventoryDailyRange(from, to) {
  const db = getFirestoreDB();
  if (!db) return { rows: [], days: 0 };
  let q = db.collection('inventoryDaily').orderBy(firebase.firestore.FieldPath.documentId(), 'desc');
  if (from) q = q.where(firebase.firestore.FieldPath.documentId(), '>=', from);
  if (to) q = q.where(firebase.firestore.FieldPath.documentId(), '<=', to);
  const snap = await q.get();
  const rows = [];
  snap.forEach((doc) => {
    const items = doc.data().items || {};
    Object.keys(items).forEach((code) => rows.push(rollupItemToRow(doc.id, code, items[code])));
  });
  return { rows, days: snap.docs.length };
}

// Generate: the DATE column filter (From/To) is the fetch window. Reads only those
// day-docs, then the other column filters (item code, type, category, supplier,
// qty, cost) apply client-side via the table's normal filtering.
async function generateInventory() {
  const btn = document.getElementById('tt-generate-inv') || document.querySelector('#inv-thead .generate-row .btn');
  const status = document.getElementById('inv-query-status');
  const dateF = (invTable.filters && invTable.filters.dateDelivered) || {};
  const from = dateF.from || '';
  const to = dateF.to || '';
  if (!from && !to) { if (status) status.textContent = 'Set the Date filter (From / To) first.'; return; }
  if (from && to && from > to) { if (status) status.textContent = 'From date is after To date.'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
  if (status) status.textContent = 'Loading…';
  try {
    const { rows, days } = await loadInventoryDailyRange(from, to);
    // Replace movements with the queried window (keep locally-derived Outgoing rows).
    const derived = (DB.get('inventory_movements') || []).filter((m) => m.type === 'Outgoing');
    DB.set('inventory_movements', [...rows, ...derived]);
    inventoryHasMoreRecords = false;
    inventoryHasGenerated = true;
    updateInventoryLoadMoreControl();
    computeInventoryKpisFromLoaded();   // KPIs reflect the generated set only
    invTable.render();
    renderSummary();
    const delBtn = document.getElementById('btn-delete-all-inv');
    if (delBtn) delBtn.style.display = rows.length ? '' : 'none';
    if (status) status.textContent = `${rows.length.toLocaleString()} item-day(s) across ${days} day(s).`;
  } catch (e) {
    console.error('[Inventory] Generate failed:', e);
    if (status) status.textContent = 'Load failed: ' + (e && e.message ? e.message : 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate'; }
  }
}

// KPI totals computed from the currently-loaded rows (no history scan).
function computeInventoryKpisFromLoaded() {
  const movs = DB.get('inventory_movements') || [];
  const inVal = movs.filter((m) => m.type === 'Incoming').reduce((s, m) => s + (Number(m.totalCost) || 0), 0);
  const outVal = movs.filter((m) => m.type === 'Outgoing').reduce((s, m) => s + (Number(m.totalCost) || 0), 0);
  inventoryAggregateTotals = { count: null, inVal, outVal };
  renderSummary();
}

// KPIs now reflect ONLY the generated (loaded) window — no whole-history scan.
// Before Generate they stay blank; after Generate/edits they sum the loaded rows.
async function refreshInventoryAggregates() {
  if (!inventoryHasGenerated) { renderSummary(); return; }
  computeInventoryKpisFromLoaded();
}

function inventoryLoadLimit() {
  return clampRecordsLoadLimit('inv-load-limit');
}

function updateInventoryLoadMoreControl() {
  const button = document.getElementById('btn-load-more-inv');
  if (!button) return;
  button.style.display = inventoryHasMoreRecords ? '' : 'none';
  button.disabled = !inventoryHasMoreRecords;
}

async function loadInventoryBatch({ append = false } = {}) {
  const db = getFirestoreDB();
  if (!db) return DB.get('inventory_movements');
  if (!append) {
    inventoryLastDocSnapshot = null;
    inventoryDailyCursor = null;
    _invVsScrollTop = 0;
    const scroll = document.getElementById('inv-tbody')?.closest('.table-scroll');
    if (scroll) scroll.scrollTop = 0;
  }
  // Movements table now reads per-day rollups (inventoryDaily), newest-first,
  // a fixed window of days per page — server-side pagination, one read/day.
  const PAGE_DAYS = 30;
  const before = append ? inventoryDailyCursor : null;
  const page = await loadInventoryDailyPage({ pageDays: PAGE_DAYS, beforeDate: before });
  inventoryDailyCursor = page.lastDate || inventoryDailyCursor;
  const existing = append ? DB.get('inventory_movements') : [];
  // Keep any locally-derived Outgoing rows (from salesData) on a fresh (non-append) load.
  const derivedOutgoing = existing.filter((r) => r.type === 'Outgoing');
  const merged = append ? [...existing, ...page.rows] : [...page.rows, ...derivedOutgoing];
  DB.set('inventory_movements', merged);
  inventoryHasMoreRecords = page.hasMore;
  updateInventoryLoadMoreControl();
  return DB.get('inventory_movements');
}

async function saveInv() {
  const code    = document.getElementById('inv-code').value.trim();
  const desc    = document.getElementById('inv-desc').value.trim();
  const cat     = document.getElementById('inv-category').value || 'Uncategorized';
  const date    = document.getElementById('inv-date').value;
  const cost    = parsePeso(document.getElementById('inv-unit-cost').value);
  const qty     = parseInt(document.getElementById('inv-qty').value) || 0;
  const type    = document.querySelector('input[name="inv-type"]:checked')?.value;

  if (!code||!desc||!date||!qty||(type === 'Incoming' && !cost)) { alert('Please fill all required fields.'); return; }
  if (type === 'Outgoing' && !selectedOutgoingProduct) {
    alert('Please select an existing Product Master item from the search results.');
    return;
  }

  const supplierEl = document.getElementById('inv-supplier');
  const supplier   = type === 'Outgoing' ? '' : supplierEl.value;
  const savedCost  = type === 'Outgoing' ? outgoingProductCost(selectedOutgoingProduct) : cost;
  const balance    = type === 'Outgoing' ? inventoryTotalsForCode(code).balance : 0;

  const record = {
    type, itemCode:code, description:desc, category:cat, supplier,
    unitCost:savedCost, qty, totalCost:savedCost*qty, dateDelivered:date,
    flagged:type === 'Outgoing' && qty > balance,
    notes: document.getElementById('inv-notes').value
  };

  const editId = document.getElementById('inv-edit-id').value;
  let savedRow;
  if (editId) {
    const existing = DB.get('inventory_movements').find(row => row.id === editId);
    DB.update('inventory_movements', editId, record);
    savedRow = DB.get('inventory_movements').find(row => row.id === editId);
    if (existing?._firestoreId) savedRow._firestoreId = existing._firestoreId;
  } else {
    record.id = genId();
    DB.push('inventory_movements', record);
    savedRow = record;
  }

  try {
    const db = getFirestoreDB();
    if (!db) throw new Error('Database unavailable.');
    const firestoreId = savedRow._firestoreId || inventoryFirestoreDocId(savedRow);
    const firestoreRow = { ...savedRow };
    delete firestoreRow._firestoreId;
    await db.collection('inventoryData').doc(firestoreId).set(firestoreRow, { merge: true });
    savedRow._firestoreId = firestoreId;
    await syncInventoryDisplayFieldsToProductMaster(code, desc, cat);
  } catch (err) {
    console.error('[Inventory] Save failed:', err);
    alert('Could not save the inventory entry to the database. Please try again.');
    return;
  }

  closeModal('modal-inv');
  invTable.render();
  renderSummary();
  refreshInventoryAggregates();
  logAudit(editId ? 'Edit' : 'Create', 'Inventory',
    `${editId ? 'Edited' : 'Added'} ${type.toLowerCase()} - ${qty} units of ${code} on ${formatDate(date)}`);
}

function editInv(id) {
  const m = DB.get('inventory_movements').find(x => x.id===id);
  if (!m || m._derived) return;
  document.getElementById('inv-edit-id').value = m.id;
  document.getElementById('modal-inv-title').textContent = 'Edit Inventory Entry';
  document.getElementById(m.type==='Incoming'?'r-incoming':'r-outgoing').checked = true;
  document.getElementById('inv-code').value     = m.itemCode;
  document.getElementById('inv-desc').value     = inventoryDisplayDescription(m);
  document.getElementById('inv-unit-cost').value = formatNum(m.unitCost);
  document.getElementById('inv-qty').value      = m.qty;
  document.getElementById('inv-date').value     = m.dateDelivered;
  document.getElementById('inv-notes').value    = m.notes||'';
  initCatDropdown(document.getElementById('inv-category'), 'inv', INV_CATS);
  ensureInventoryCategoryOption(inventoryDisplayCategory(m));
  document.getElementById('inv-category').value = inventoryDisplayCategory(m);
  setSupplierPickerValue('inv-supplier', m.supplier || '');
  clearOutgoingSelection(false);
  if (m.type === 'Outgoing') selectOutgoingProduct(m.itemCode);
  syncInventoryTypeMode();
  calcInvTotal();
  openModal('modal-inv');
}

function deleteInv(id) {
  const m = DB.get('inventory_movements').find(x=>x.id===id);
  if (!m || m._derived) return;
  confirmDelete(`Delete this inventory entry for <strong>${m?.description}</strong>?`, async () => {
    try {
      const db = getFirestoreDB();
      if (!db) throw new Error('Database unavailable.');
      await db.collection('inventoryData').doc(m._firestoreId || inventoryFirestoreDocId(m)).delete();
      DB.remove('inventory_movements', id);
      selectedInvIds.delete(id);
      invTable.render(); renderSummary();
      refreshInventoryAggregates();
      logAudit('Delete', 'Inventory', `Deleted ${m?.type?.toLowerCase() || 'inventory'} entry for ${m?.itemCode || id}`);
    } catch (err) {
      console.error('[Inventory] Delete failed:', err);
      alert('Could not delete the inventory entry. Please try again.');
    }
  });
}

const selectedInvIds = new Set();

function invFilteredRows() {
  return invTable ? invTable._getProcessed() : [];
}

// Delete every row matching the CURRENT filter (not just the visible page). Scoped
// to the generated window + column filters. Rewrites the affected inventoryDaily /
// dailyPurchases rollups and removes the matching raw inventoryData rows.
function deleteAllFilteredInventory() {
  const rows = invFilteredRows().filter(r => r.type === 'Incoming' && !r._derived);
  if (!rows.length) { alert('Nothing to delete for the current filter.'); return; }
  const dates = [...new Set(rows.map(r => r.dateDelivered))].sort();
  confirmDelete(
    `Delete <strong>${rows.length.toLocaleString()}</strong> item-day record(s) across <strong>${dates.length}</strong> day(s) matching the current filter?<br><br>This rewrites the affected daily rollups and removes the underlying rows. It cannot be undone.`,
    () => performDeleteAllFilteredInventory(rows, dates));
}

async function performDeleteAllFilteredInventory(rows, dates) {
  const db = getFirestoreDB();
  if (!db) { alert('Database unavailable.'); return; }
  const status = document.getElementById('inv-query-status');
  if (status) status.textContent = 'Deleting…';

  // Group the item codes to remove, per date.
  const removeByDate = new Map(); // date -> Set(itemCode)
  rows.forEach(r => {
    if (!removeByDate.has(r.dateDelivered)) removeByDate.set(r.dateDelivered, new Set());
    removeByDate.get(r.dateDelivered).add(String(r.itemCode));
  });

  try {
    for (const date of removeByDate.keys()) {
      const codes = removeByDate.get(date);
      const dref = db.collection('inventoryDaily').doc(date);
      const snap = await dref.get();
      if (snap.exists) {
        const data = snap.data() || {};
        const items = data.items || {};
        let qty = 0, cost = 0;
        Object.keys(items).forEach(code => {
          if (codes.has(code)) { delete items[code]; return; }
          qty += Number(items[code].qty) || 0;
          cost += Number(items[code].total_cost) || 0;
        });
        cost = Math.round(cost * 100) / 100;
        if (Object.keys(items).length === 0) {
          await dref.delete();
          await db.collection('dailyPurchases').doc(date).delete().catch(() => {});
        } else {
          await dref.set({ items, totals: { qty, total_cost: cost }, lastUpdated: firebase.firestore.FieldValue.serverTimestamp() });
          await db.collection('dailyPurchases').doc(date).set({ total_cost: cost, qty, lastUpdated: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
        }
      }
      // Remove matching raw inventoryData rows for this date + codes, in pages.
      // (Query by date, filter codes client-side, batch-delete.)
      let cursor = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let q = db.collection('inventoryData').where('dateDelivered', '==', date).limit(400);
        const rs = await q.get();
        if (rs.empty) break;
        const batch = db.batch();
        let n = 0;
        rs.docs.forEach(doc => {
          const d = doc.data();
          if (codes.has(String(d.itemCode))) { batch.delete(doc.ref); n++; }
        });
        if (n > 0) await batch.commit();
        if (rs.size < 400) break;
        if (cursor === rs.docs[rs.docs.length - 1].id) break;
        cursor = rs.docs[rs.docs.length - 1].id;
      }
    }
    // Drop the deleted rows from the in-memory table.
    const remaining = (DB.get('inventory_movements') || []).filter(m =>
      !(m.type === 'Incoming' && !m._derived && removeByDate.get(m.dateDelivered)?.has(String(m.itemCode))));
    DB.set('inventory_movements', remaining);
    computeInventoryKpisFromLoaded();
    invTable.render();
    if (status) status.textContent = `Deleted ${rows.length.toLocaleString()} record(s).`;
    logAudit('Delete', 'Inventory', `Bulk-deleted ${rows.length} item-days across ${dates.length} dates (filtered)`);
  } catch (e) {
    console.error('[Inventory] Delete all failed:', e);
    if (status) status.textContent = 'Delete failed: ' + (e && e.message ? e.message : 'error');
    alert('Delete failed. Some records may remain. Please retry.');
  }
}

function invCurrentPageRows(rows = invFilteredRows()) {
  const start = (invTable.page - 1) * invTable.pageSize;
  return rows.slice(start, start + invTable.pageSize);
}

function invVisibleRows() {
  // In virtual mode the "select all" scope is the full filtered set, not just the
  // rendered window — so the header checkbox selects everything the query matches.
  return invFilteredRows();
}

function syncBulkSelectionUI() {
  const existing = new Set(DB.get('inventory_movements').map(m => m.id));
  const filtered = invFilteredRows().filter(r => !r._derived);
  const filteredSet = new Set(filtered.map(r => r.id));
  [...selectedInvIds].forEach(id => {
    if (!existing.has(id) || !filteredSet.has(id)) selectedInvIds.delete(id);
  });

  const visibleIds = filtered.map(row => row.id);
  const selectedCount = selectedInvIds.size;
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedInvIds.has(id));
  const someVisibleSelected = visibleIds.some(id => selectedInvIds.has(id));

  document.querySelectorAll('.inv-row-select').forEach(cb => {
    cb.checked = selectedInvIds.has(cb.value);
  });

  const selectAll = document.getElementById('inv-select-all');
  if (selectAll) {
    selectAll.checked = allVisibleSelected;
    selectAll.indeterminate = !allVisibleSelected && someVisibleSelected;
    selectAll.disabled = visibleIds.length === 0;
  }

  const bar = document.getElementById('inv-bulk-bar');
  const count = document.getElementById('inv-bulk-count');
  if (bar && count) {
    bar.classList.toggle('open', selectedCount > 0);
    count.textContent = `${selectedCount} rows selected`;
  }

  const selectedIncomingCount = DB.get('inventory_movements')
    .filter(row => selectedInvIds.has(row.id) && row.type === 'Incoming').length;
  const makeOutgoing = document.getElementById('btn-make-outgoing');
  if (makeOutgoing) {
    makeOutgoing.disabled = selectedIncomingCount === 0;
    makeOutgoing.textContent = selectedIncomingCount
      ? `Make Outgoing (${selectedIncomingCount})`
      : 'Make Outgoing';
  }
}

function toggleInvRowSelection(id, checked) {
  if (checked) selectedInvIds.add(id);
  else selectedInvIds.delete(id);
  syncBulkSelectionUI();
}

function toggleAllVisibleInvRows(checked) {
  invVisibleRows().filter(row => !row._derived).forEach(row => {
    if (checked) selectedInvIds.add(row.id);
    else selectedInvIds.delete(row.id);
  });
  syncBulkSelectionUI();
}

function deselectAllInvRows() {
  selectedInvIds.clear();
  syncBulkSelectionUI();
}

let bulkOutgoingGroups = [];

function groupedSelectedIncomingRows() {
  const groups = new Map();
  DB.get('inventory_movements')
    .filter(row => selectedInvIds.has(row.id) && row.type === 'Incoming')
    .forEach(row => {
      const itemCode = inventoryCode(row.itemCode);
      if (!itemCode) return;
      const group = groups.get(itemCode) || {
        itemCode,
        description: inventoryDisplayDescription(row),
        category: inventoryDisplayCategory(row),
        qty: 0
      };
      group.qty += Number(row.qty) || 0;
      groups.set(itemCode, group);
    });
  return [...groups.values()];
}

function renderBulkOutgoingWarnings() {
  document.querySelectorAll('.bulk-outgoing-qty').forEach(input => {
    const group = bulkOutgoingGroups[Number(input.dataset.index)];
    const qty = Number(input.value) || 0;
    const balance = inventoryTotalsForCode(group.itemCode).balance;
    document.getElementById(`bulk-outgoing-warning-${input.dataset.index}`).textContent =
      qty > balance ? `⚠ Outgoing exceeds available balance (${balance.toLocaleString()} units)` : '';
  });
}

function openMakeOutgoingModal() {
  bulkOutgoingGroups = groupedSelectedIncomingRows();
  if (!bulkOutgoingGroups.length) {
    alert('Select at least one Incoming inventory row.');
    return;
  }

  document.getElementById('bulk-outgoing-date').value = todayISO();
  document.getElementById('bulk-outgoing-list').innerHTML = bulkOutgoingGroups.map((group, index) => `
    <div class="bulk-outgoing-row">
      <div>
        <strong class="mono">${invEsc(group.itemCode)}</strong>
        <span>${invEsc(group.description)}</span>
      </div>
      <label>Outgoing units
        <input class="form-input bulk-outgoing-qty" type="number" min="1" value="${group.qty}" data-index="${index}">
      </label>
      <div class="bulk-outgoing-warning" id="bulk-outgoing-warning-${index}"></div>
    </div>`).join('');
  document.querySelectorAll('.bulk-outgoing-qty').forEach(input => {
    input.addEventListener('input', renderBulkOutgoingWarnings);
  });
  renderBulkOutgoingWarnings();
  openModal('modal-make-outgoing');
}

async function saveBulkOutgoing() {
  const date = document.getElementById('bulk-outgoing-date').value;
  const rows = [...document.querySelectorAll('.bulk-outgoing-qty')].map(input => {
    const group = bulkOutgoingGroups[Number(input.dataset.index)];
    const qty = Number(input.value) || 0;
    const id = genId();
    const unitCost = outgoingProductCost(inventoryProductForCode(group.itemCode));
    return {
      id,
      documentNo: `bulk-outgoing-${id}`,
      type: 'Outgoing',
      itemCode: group.itemCode,
      description: group.description,
      category: group.category,
      supplier: '',
      unitCost,
      qty,
      totalCost: unitCost * qty,
      dateDelivered: date,
      flagged: qty > inventoryTotalsForCode(group.itemCode).balance,
      notes: 'Created from selected incoming rows'
    };
  });

  if (!date || rows.some(row => row.qty <= 0)) {
    alert('Choose a date and enter outgoing units greater than zero.');
    return;
  }

  const saveBtn = document.getElementById('btn-confirm-make-outgoing');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    const fsdb = getFirestoreDB();
    if (!fsdb) throw new Error('Database unavailable.');

    for (let start = 0; start < rows.length; start += 400) {
      const chunk = rows.slice(start, start + 400);
      await commitFreshBatchWithRetry(() => {
        const batch = fsdb.batch();
        chunk.forEach(row => {
          batch.set(fsdb.collection('inventoryData').doc(inventoryFirestoreDocId(row)), row);
        });
        return batch;
      }, start + chunk.length);
      await sleep(300);
    }

    rows.forEach(row => DB.push('inventory_movements', row));
    logAudit('Create', 'Inventory',
      `Bulk make-outgoing - ${rows.length.toLocaleString()} product records created on ${formatDate(date)}`);
    selectedInvIds.clear();
    closeModal('modal-make-outgoing');
    invTable.render();
    renderSummary();
    refreshInventoryAggregates();
    showToast(`${rows.length} outgoing record${rows.length === 1 ? '' : 's'} created.`, 'success');
  } catch (err) {
    console.error('[Inventory] Bulk outgoing save failed:', err);
    alert('Could not save outgoing inventory records. Please try again.');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Outgoing';
  }
}

function openBulkDeleteModal() {
  const count = selectedInvIds.size;
  if (!count) return;
  document.getElementById('bulk-delete-title').textContent = `Delete ${count} entries?`;
  document.getElementById('bulk-delete-body').textContent =
    `This will permanently remove ${count} inventory records. This action cannot be undone.`;
  openModal('modal-bulk-delete');
}

async function confirmBulkDelete() {
  const ids = [...selectedInvIds];
  if (!ids.length) return;

  const cancelBtn = document.getElementById('btn-cancel-bulk-delete');
  const closeBtn  = document.getElementById('btn-close-bulk-delete');
  const deleteBtn = document.getElementById('btn-confirm-bulk-delete');

  // Lock the modal for the duration of the delete
  cancelBtn.disabled = true;
  closeBtn.disabled  = true;
  deleteBtn.disabled = true;
  deleteBtn.innerHTML = '<span class="spinner"></span> Deleting... 0%';

  const selectedSet  = new Set(ids);
  const shouldGoPrev = invTable.page > 1 && invCurrentPageRows().length > 0 &&
    invCurrentPageRows().every(row => selectedSet.has(row.id));
  const selectedRows = DB.get('inventory_movements').filter(row => selectedSet.has(row.id));

  const totalBatches     = Math.max(1, Math.ceil(selectedRows.length / 200));
  let   batchesCompleted = 0;

  try {
    const fsdb = getFirestoreDB();
    if (!fsdb) throw new Error('Database unavailable.');

    for (let start = 0; start < selectedRows.length; start += 200) {
      const chunk = selectedRows.slice(start, start + 200);
      const batch = fsdb.batch();
      chunk.forEach(row => {
        batch.delete(fsdb.collection('inventoryData').doc(row._firestoreId || inventoryFirestoreDocId(row)));
      });
      await batch.commit();
      batchesCompleted++;
      const pct = Math.round((batchesCompleted / totalBatches) * 100);
      deleteBtn.innerHTML = `<span class="spinner"></span> Deleting... ${pct}%`;
      await sleep(200);
    }
  } catch (err) {
    console.error('[Inventory] Bulk delete failed:', err);
    alert('Could not delete the selected inventory records. Please try again.');
    cancelBtn.disabled    = false;
    closeBtn.disabled     = false;
    deleteBtn.disabled    = false;
    deleteBtn.textContent = 'Delete';
    return;
  }

  const count = ids.length;
  deleteBtn.textContent = '✓ Deleted!';
  await sleep(1000);

  DB.set('inventory_movements', DB.get('inventory_movements').filter(row => !selectedSet.has(row.id)));
  selectedInvIds.clear();
  if (shouldGoPrev) invTable.page = Math.max(1, invTable.page - 1);

  // Reset modal buttons before closing so they're ready for next use
  cancelBtn.disabled    = false;
  closeBtn.disabled     = false;
  deleteBtn.disabled    = false;
  deleteBtn.textContent = 'Delete';

  closeModal('modal-bulk-delete');
  invTable.render();
  renderSummary();
  showToast(`${count} entries deleted.`, 'success');
  logAudit('Delete', 'Inventory', `Deleted ${count.toLocaleString()} inventory entries`);
}

function formatCSVDate(value) {
  if (!value) return '';
  const iso = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return `${String(parsed.getMonth() + 1).padStart(2, '0')}/${String(parsed.getDate()).padStart(2, '0')}/${parsed.getFullYear()}`;
}

async function exportInventoryCSV() {
  const btn = document.getElementById('btn-export-inv');
  btn.disabled = true;
  btn.textContent = 'Exporting...';
  try {
    if (invTable.activeTab === 'potential') {
      const rows = potentialRowsForActiveSubtab();
      exportRowsToCSV(`inventory-potential-revenue-${todayISO()}.csv`, [
        { label:'Item Code', value:'itemCode' },
        { label:'Description', value:'description' },
        { label:'Category', value:'category' },
        { label:'Supplier', value:'supplier' },
        { label:'Incoming Units', value:'incomingQty' },
        { label:'Outgoing/Sold Units', value:'outgoingQty' },
        { label:'Remaining Qty', value:'remainingQty' },
        { label:'Unit Cost', value:'unitCost' },
        { label:'Selling Price Basis', value:'effectiveSellingPrice' },
        { label:'Basis Source', value:'source' },
        { label:'Potential Revenue', value:'potentialRevenue' },
      ], rows);
      showToast(`${rows.length.toLocaleString()} potential revenue records exported to CSV.`, 'success');
      return;
    }
    const rows = invTable.getProcessedRows();
    exportRowsToCSV(`inventory-${todayISO()}.csv`, [
      { label:'Item Code', value: row => row.itemCode || '' },
      { label:'Date', value: row => csvDate(row.dateDelivered) },
      { label:'Type', value: row => row.type || '' },
      { label:'Description', value: row => inventoryDisplayDescription(row) || '' },
      { label:'Category', value: row => inventoryDisplayCategory(row) || '' },
      { label:'Supplier', value: row => row.supplier || '' },
      { label:'Qty', value: row => row.qty ?? 0 },
      { label:'Unit Cost', value: row => row.unitCost ?? 0 },
      { label:'Total Cost', value: row => row.totalCost ?? 0 },
      { label:'Avg Selling Price', value: row => inventoryAvgSellingPrice(row.itemCode) },
      { label:'Potential Revenue', value: row => inventoryPotentialRevenue(row) },
    ], rows);
    showToast(`${rows.length.toLocaleString()} inventory records exported to CSV.`, 'success');
  } catch (err) {
    console.error('[Inventory] CSV export failed:', err);
    alert(`Could not export inventory data: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Export as CSV';
  }
}

function potentialSearchRows(rows) {
  const query = document.getElementById('search-inv').value.trim().toLowerCase();
  if (!query) return rows;
  return rows.filter(row => [
    row.itemCode, row.description, row.category, row.supplier, row.source
  ].some(value => String(value || '').toLowerCase().includes(query)));
}

function potentialColumnValue(row, key) {
  if (key === 'status') return row.effectiveSellingPrice > 0 ? 'Included' : 'For review';
  return row[key] ?? '';
}

function potentialFilterOptions(key, rows) {
  return [...new Set(rows.map(row => potentialColumnValue(row, key)).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
}

function potentialPassesFilters(row) {
  return Object.entries(potentialFilters).every(([key, filter]) => {
    if (filter == null || filter === '') return true;
    const value = potentialColumnValue(row, key);
    if (typeof filter === 'object') {
      const numberValue = Number(value) || 0;
      if (filter.min !== '' && filter.min != null && Number.isFinite(Number(filter.min)) && numberValue < Number(filter.min)) return false;
      if (filter.max !== '' && filter.max != null && Number.isFinite(Number(filter.max)) && numberValue > Number(filter.max)) return false;
      return true;
    }
    return String(value || '').toLowerCase().includes(String(filter).trim().toLowerCase());
  });
}

function sortPotentialRows(rows) {
  const dir = potentialSortDir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const av = potentialColumnValue(a, potentialSortKey);
    const bv = potentialColumnValue(b, potentialSortKey);
    const numericKeys = new Set(['remainingQty', 'unitCost', 'effectiveSellingPrice', 'potentialRevenue']);
    const cmp = numericKeys.has(potentialSortKey)
      ? (Number(av) || 0) - (Number(bv) || 0)
      : String(av || '').localeCompare(String(bv || ''));
    return cmp * dir;
  });
}

function potentialSortIcon(key) {
  if (potentialSortKey !== key) return '<span class="sort-icon">↕</span>';
  return `<span class="sort-icon sort-active">${potentialSortDir === 'asc' ? '↑' : '↓'}</span>`;
}

function renderPotentialFilterCell(column, baseRows) {
  const filter = potentialFilters[column.key];
  if (column.type === 'number') {
    return `
      <th>
        <div class="col-filter-range">
          <input class="col-filter" type="number" placeholder="Min"
            value="${invEsc(filter?.min || '')}"
            onchange="setPotentialRangeFilter('${column.key}', 'min', this.value)">
          <span>–</span>
          <input class="col-filter" type="number" placeholder="Max"
            value="${invEsc(filter?.max || '')}"
            onchange="setPotentialRangeFilter('${column.key}', 'max', this.value)">
        </div>
      </th>`;
  }
  if (column.type === 'select') {
    const options = potentialFilterOptions(column.key, baseRows);
    return `
      <th>
        <select class="col-filter" onchange="setPotentialFilter('${column.key}', this.value)">
          <option value="">All</option>
          ${options.map(option => `
            <option value="${invEsc(option)}" ${filter === option ? 'selected' : ''}>${invEsc(option)}</option>
          `).join('')}
        </select>
      </th>`;
  }
  return `
    <th>
      <input class="col-filter" type="text" placeholder="Filter..."
        value="${invEsc(filter || '')}"
        onchange="setPotentialFilter('${column.key}', this.value)">
    </th>`;
}

function renderPotentialTableHead(baseRows) {
  return `
    <tr class="header-row">
      <th class="select-col"><input type="checkbox" id="potential-select-all" aria-label="Select visible potential revenue rows" onchange="toggleAllVisiblePotential(this.checked)"></th>
      ${POTENTIAL_COLUMNS.map(column => `
        <th class="sortable ${potentialSortKey === column.key ? 'is-sorted' : ''}" onclick="setPotentialSort('${column.key}')">
          ${column.label} ${potentialSortIcon(column.key)}
        </th>
      `).join('')}
    </tr>
    <tr class="filter-row">
      <th></th>
      ${POTENTIAL_COLUMNS.map(column => renderPotentialFilterCell(column, baseRows)).join('')}
    </tr>`;
}

function setPotentialSort(key) {
  if (potentialSortKey === key) potentialSortDir = potentialSortDir === 'asc' ? 'desc' : 'asc';
  else {
    potentialSortKey = key;
    potentialSortDir = 'asc';
  }
  potentialPage = 1;
  renderPotentialRevenueTable();
}

function setPotentialFilter(key, value) {
  potentialFilters[key] = value;
  potentialPage = 1;
  renderPotentialRevenueTable();
}

function setPotentialRangeFilter(key, part, value) {
  potentialFilters[key] = { ...(potentialFilters[key] || {}), [part]: value };
  potentialPage = 1;
  renderPotentialRevenueTable();
}

function hasPotentialFilters() {
  const hasColumnFilters = Object.values(potentialFilters).some(filter => {
    if (filter == null) return false;
    if (typeof filter === 'object') return !!(filter.min || filter.max);
    return String(filter).trim() !== '';
  });
  return hasColumnFilters || !!document.getElementById('search-inv').value.trim();
}

function clearInventoryActiveFilters() {
  if (invTable?.activeTab === 'potential') {
    potentialFilters = {};
    potentialSortKey = 'potentialRevenue';
    potentialSortDir = 'desc';
    potentialPage = 1;
    potentialLastSearch = '';
    selectedPotentialCodes.clear();
    document.getElementById('search-inv').value = '';
    renderPotentialRevenueTable();
    return;
  }
  invTable.clearAll();
}

function renderPotentialMarkupControls() {
  const settings = getPotentialMarkupSettings();
  const categories = [...new Set(potentialRevenueRows().map(row => row.category).filter(Boolean))].sort();
  const categorySelect = document.getElementById('potential-category-select');
  const currentCategory = categorySelect.value || categories[0] || '';
  categorySelect.innerHTML = categories.length
    ? categories.map(category => `<option value="${invEsc(category)}">${invEsc(category)}</option>`).join('')
    : '<option value="">No categories</option>';
  if (currentCategory && categories.includes(currentCategory)) categorySelect.value = currentCategory;
  document.getElementById('potential-global-markup').value = settings.globalMarkup || '';
  document.getElementById('potential-category-markup').value =
    settings.categoryMarkup?.[categorySelect.value] || '';
}

function potentialBaseRowsForActiveSubtab() {
  return potentialSubtab === 'review'
    ? potentialRevenueReviewRows()
    : potentialRevenueIncludedRows();
}

function potentialRowsForActiveSubtab() {
  return sortPotentialRows(
    potentialSearchRows(potentialBaseRowsForActiveSubtab()).filter(potentialPassesFilters)
  );
}

function renderPotentialPagination(total) {
  const el = document.getElementById('inv-pagination');
  if (!el) return;
  const totalPages = Math.max(1, Math.ceil(total / POTENTIAL_PAGE_SIZE));
  if (potentialPage > totalPages) potentialPage = totalPages;
  if (total === 0 || potentialSubtab === 'detail') {
    el.innerHTML = '';
    return;
  }
  const from = (potentialPage - 1) * POTENTIAL_PAGE_SIZE + 1;
  const to = Math.min(potentialPage * POTENTIAL_PAGE_SIZE, total);
  const pages = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= potentialPage - 2 && i <= potentialPage + 2)) {
      if (pages.length && pages[pages.length - 1] !== i - 1) pages.push('…');
      pages.push(i);
    }
  }
  el.innerHTML = `
    <div class="pagination-info">Showing ${from}–${to} of ${total.toLocaleString()} items</div>
    <div class="pagination-controls">
      <button class="page-btn" ${potentialPage <= 1 ? 'disabled' : ''} onclick="setPotentialPage(${potentialPage - 1})">‹ Prev</button>
      ${pages.map(page => page === '…'
        ? '<span class="page-ellipsis">…</span>'
        : `<button class="page-btn${page === potentialPage ? ' active' : ''}" onclick="setPotentialPage(${page})">${page}</button>`
      ).join('')}
      <button class="page-btn" ${potentialPage >= totalPages ? 'disabled' : ''} onclick="setPotentialPage(${potentialPage + 1})">Next ›</button>
    </div>`;
}

function setPotentialPage(page) {
  potentialPage = Math.max(1, page);
  renderPotentialRevenueTable();
}

function syncPotentialBulkBar(pageRows = []) {
  const bar = document.getElementById('potential-bulk-bar');
  const count = selectedPotentialCodes.size;
  bar.classList.toggle('open', count > 0 && invTable.activeTab === 'potential' && potentialSubtab !== 'detail');
  document.getElementById('potential-bulk-count').textContent =
    `${count.toLocaleString()} item${count === 1 ? '' : 's'} selected`;
  document.getElementById('potential-bulk-markup-wrap').style.display =
    potentialSubtab === 'review' ? 'flex' : 'none';
  document.getElementById('btn-apply-selected-potential-markup').style.display =
    potentialSubtab === 'review' ? '' : 'none';
  const visibleCodes = pageRows.map(row => row.itemCode);
  const selectAll = document.getElementById('potential-select-all');
  if (selectAll) {
    selectAll.checked = visibleCodes.length > 0 && visibleCodes.every(code => selectedPotentialCodes.has(code));
    selectAll.indeterminate = visibleCodes.some(code => selectedPotentialCodes.has(code)) && !selectAll.checked;
  }
}

function togglePotentialSelection(itemCode, checked) {
  const code = inventoryCode(itemCode);
  if (checked) selectedPotentialCodes.add(code);
  else selectedPotentialCodes.delete(code);
  syncPotentialBulkBar(potentialRowsForActiveSubtab()
    .slice((potentialPage - 1) * POTENTIAL_PAGE_SIZE, potentialPage * POTENTIAL_PAGE_SIZE));
}

function toggleAllVisiblePotential(checked) {
  potentialRowsForActiveSubtab()
    .slice((potentialPage - 1) * POTENTIAL_PAGE_SIZE, potentialPage * POTENTIAL_PAGE_SIZE)
    .forEach(row => {
      if (checked) selectedPotentialCodes.add(row.itemCode);
      else selectedPotentialCodes.delete(row.itemCode);
    });
  renderPotentialRevenueTable();
}

function clearPotentialSelection() {
  selectedPotentialCodes.clear();
  renderPotentialRevenueTable();
}

function applySelectedPotentialMarkup() {
  if (!selectedPotentialCodes.size) return;
  const markup = Math.max(0, Number(document.getElementById('potential-bulk-markup').value) || 0);
  if (!markup) {
    alert('Enter a markup percentage for the selected items.');
    return;
  }
  const settings = getPotentialMarkupSettings();
  [...selectedPotentialCodes].forEach(code => {
    settings.itemOverrides[code] = {
      ...(settings.itemOverrides[code] || {}),
      markupPercent: markup,
      sellingPrice: 0
    };
  });
  savePotentialMarkupSettings(settings);
  selectedPotentialCodes.clear();
  document.getElementById('potential-bulk-markup').value = '';
  potentialSubtab = 'included';
  potentialPage = 1;
  renderSummary();
  renderPotentialRevenueTable();
  showToast(`Markup applied to selected potential revenue items.`, 'success');
}

function deleteSelectedPotentialItems() {
  if (!selectedPotentialCodes.size) return;
  const count = selectedPotentialCodes.size;
  if (!confirm(`Delete ${count.toLocaleString()} selected items from Potential Revenue? Inventory records will not be deleted.`)) return;
  const settings = getPotentialMarkupSettings();
  const excluded = new Set((settings.excludedCodes || []).map(inventoryCode));
  selectedPotentialCodes.forEach(code => excluded.add(code));
  settings.excludedCodes = [...excluded];
  savePotentialMarkupSettings(settings);
  selectedPotentialCodes.clear();
  renderSummary();
  renderPotentialRevenueTable();
  showToast(`${count.toLocaleString()} potential revenue items deleted.`, 'success');
}

function renderPotentialRevenueTable() {
  const currentSearch = document.getElementById('search-inv').value.trim();
  if (currentSearch !== potentialLastSearch) {
    potentialLastSearch = currentSearch;
    potentialPage = 1;
  }
  if (potentialSubtab === 'detail') {
    renderPotentialDetailView();
    return;
  }
  const baseRows = potentialBaseRowsForActiveSubtab();
  const rows = potentialRowsForActiveSubtab();
  const totalPages = Math.max(1, Math.ceil(rows.length / POTENTIAL_PAGE_SIZE));
  if (potentialPage > totalPages) potentialPage = totalPages;
  const pageRows = rows.slice((potentialPage - 1) * POTENTIAL_PAGE_SIZE, potentialPage * POTENTIAL_PAGE_SIZE);
  const thead = document.getElementById('inv-thead');
  const tbody = document.getElementById('inv-tbody');
  document.getElementById('inv-bulk-bar').classList.remove('open');
  document.getElementById('btn-clear-inv').style.display = hasPotentialFilters() ? '' : 'none';
  renderPotentialMarkupControls();
  document.getElementById('potential-revenue-panel').classList.toggle('hide-settings', potentialSubtab !== 'review');

  document.getElementById('potential-subtab-included').classList.toggle('active', potentialSubtab === 'included');
  document.getElementById('potential-subtab-review').classList.toggle('active', potentialSubtab === 'review');
  document.getElementById('potential-subtab-detail').classList.remove('open', 'active');

  thead.innerHTML = renderPotentialTableHead(baseRows);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><p>${
      potentialSubtab === 'review'
        ? 'No items need selling price review.'
        : 'No items are included in potential revenue yet.'
    }</p></div></td></tr>`;
    renderPotentialPagination(0);
    syncPotentialBulkBar([]);
    return;
  }

  tbody.innerHTML = pageRows.map(row => `
    <tr class="potential-row" onclick="openPotentialDetail('${invEsc(row.itemCode)}')">
      <td class="select-col">
        <input type="checkbox" aria-label="Select potential revenue item"
          ${selectedPotentialCodes.has(row.itemCode) ? 'checked' : ''}
          onclick="event.stopPropagation()"
          onchange="togglePotentialSelection('${invEsc(row.itemCode)}', this.checked)">
      </td>
      <td class="mono">${invEsc(row.itemCode)}</td>
      <td>${invEsc(row.description || '—')}</td>
      <td>${invEsc(row.category || 'Uncategorized')}</td>
      <td>${invEsc(row.supplier || '—')}</td>
      <td class="mono">${row.remainingQty.toLocaleString()}</td>
      <td class="mono">${formatPeso(row.unitCost)}</td>
      <td class="mono">
        ${row.effectiveSellingPrice > 0 ? formatPeso(row.effectiveSellingPrice) : '—'}
        <span class="potential-source">${invEsc(row.source)}</span>
      </td>
      <td class="mono"><strong>${row.potentialRevenue > 0 ? formatPeso(row.potentialRevenue) : '—'}</strong></td>
      <td><span class="badge ${row.effectiveSellingPrice > 0 ? 'badge-green' : 'badge-gray'}">${
        row.effectiveSellingPrice > 0 ? 'Included' : 'For review'
      }</span></td>
    </tr>
  `).join('');
  renderPotentialPagination(rows.length);
  syncPotentialBulkBar(pageRows);
}

function setPotentialSubtab(tab) {
  potentialSubtab = tab === 'review' ? 'review' : 'included';
  potentialDetailCode = '';
  potentialPage = 1;
  selectedPotentialCodes.clear();
  renderPotentialRevenueTable();
}

function savePotentialMarkup() {
  const settings = getPotentialMarkupSettings();
  settings.globalMarkup = Math.max(0, Number(document.getElementById('potential-global-markup').value) || 0);
  const category = document.getElementById('potential-category-select').value;
  const categoryMarkup = Math.max(0, Number(document.getElementById('potential-category-markup').value) || 0);
  if (category) {
    if (categoryMarkup > 0) settings.categoryMarkup[category] = categoryMarkup;
    else delete settings.categoryMarkup[category];
  }
  savePotentialMarkupSettings(settings);
  potentialSubtab = 'included';
  potentialDetailCode = '';
  potentialPage = 1;
  renderSummary();
  renderPotentialRevenueTable();
  showToast('Potential revenue markup settings updated.', 'success');
}

function potentialDetailHtml(row) {
  if (!row) return;
  const incomingRows = row.incomingRows
    .slice()
    .sort((a, b) => String(b.dateDelivered || '').localeCompare(String(a.dateDelivered || '')));
  const outgoingRows = row.outgoingRows
    .slice()
    .sort((a, b) => String(b.dateDelivered || '').localeCompare(String(a.dateDelivered || '')));

  return `
    <button class="btn btn-outline-gray btn-sm potential-back" type="button" onclick="setPotentialSubtab('${row.effectiveSellingPrice > 0 ? 'included' : 'review'}')">Back to ${row.effectiveSellingPrice > 0 ? 'Inclusions' : 'For Review'}</button>
    <div class="potential-manual-editor">
      <label>
        Manual selling price
        <input type="number" min="0" step="0.01" id="potential-manual-price" value="${row.manualPrice || ''}" placeholder="0.00">
      </label>
      <label>
        Manual markup
        <div class="markup-control">
          <input type="number" min="0" step="0.01" id="potential-manual-markup" value="${row.manualMarkup || ''}" placeholder="0">
          <span>%</span>
        </div>
      </label>
      <button class="btn btn-primary btn-sm" type="button" onclick="savePotentialManualOverride('${invEsc(row.itemCode)}')">Save Item Price</button>
      <button class="btn btn-outline-gray btn-sm" type="button" onclick="clearPotentialManualOverride('${invEsc(row.itemCode)}')">Clear Manual Price</button>
    </div>
    <div class="potential-detail-grid">
      <div><span>Item Code</span><strong class="mono">${invEsc(row.itemCode)}</strong></div>
      <div><span>Incoming Units</span><strong>${row.incomingQty.toLocaleString()}</strong></div>
      <div><span>Outgoing / Sold Units</span><strong>${row.outgoingQty.toLocaleString()}</strong></div>
      <div><span>Remaining Units</span><strong>${row.remainingQty.toLocaleString()}</strong></div>
      <div><span>Unit Cost</span><strong class="mono">${formatPeso(row.unitCost)}</strong></div>
      <div><span>Selling Price Basis</span><strong class="mono">${row.effectiveSellingPrice > 0 ? formatPeso(row.effectiveSellingPrice) : '—'}</strong></div>
      <div><span>Basis Source</span><strong>${invEsc(row.source)}</strong></div>
      <div><span>Potential Revenue</span><strong class="mono">${row.potentialRevenue > 0 ? formatPeso(row.potentialRevenue) : '—'}</strong></div>
    </div>
    <div class="potential-detail-section">
      <h3>Inventory Incoming Records</h3>
      <table class="potential-detail-table">
        <thead><tr><th>Date</th><th>Supplier</th><th>Qty</th><th>Unit Cost</th><th>Total Cost</th></tr></thead>
        <tbody>${incomingRows.length ? incomingRows.map(item => `
          <tr>
            <td>${formatDate(item.dateDelivered)}</td>
            <td>${invEsc(item.supplier || '—')}</td>
            <td class="mono">${Number(item.qty || 0).toLocaleString()}</td>
            <td class="mono">${formatPeso(item.unitCost || 0)}</td>
            <td class="mono">${formatPeso(item.totalCost || 0)}</td>
          </tr>`).join('') : '<tr><td colspan="5">No incoming records found.</td></tr>'}</tbody>
      </table>
    </div>
    <div class="potential-detail-section">
      <h3>Sales / Outgoing Records</h3>
      <table class="potential-detail-table">
        <thead><tr><th>Date</th><th>Source</th><th>Qty</th><th>Unit Cost</th><th>Total Cost</th></tr></thead>
        <tbody>${outgoingRows.length ? outgoingRows.map(item => `
          <tr>
            <td>${formatDate(item.dateDelivered)}</td>
            <td>${item._derived ? 'POS Sale' : 'Inventory Outgoing'}</td>
            <td class="mono">${Number(item.qty || 0).toLocaleString()}</td>
            <td class="mono">${formatPeso(item.unitCost || 0)}</td>
            <td class="mono">${formatPeso(item.totalCost || 0)}</td>
          </tr>`).join('') : '<tr><td colspan="5">No sales or outgoing records found.</td></tr>'}</tbody>
      </table>
    </div>`;
}

function savePotentialManualOverride(itemCode) {
  const code = inventoryCode(itemCode);
  const price = Math.max(0, Number(document.getElementById('potential-manual-price').value) || 0);
  const markup = Math.max(0, Number(document.getElementById('potential-manual-markup').value) || 0);
  if (!price && !markup) {
    alert('Enter either a manual selling price or a markup percentage.');
    return;
  }
  const settings = getPotentialMarkupSettings();
  settings.itemOverrides[code] = {
    sellingPrice: price,
    markupPercent: price > 0 ? 0 : markup
  };
  savePotentialMarkupSettings(settings);
  renderSummary();
  openPotentialDetail(code);
  showToast('Manual potential revenue price saved.', 'success');
}

function clearPotentialManualOverride(itemCode) {
  const code = inventoryCode(itemCode);
  const settings = getPotentialMarkupSettings();
  delete settings.itemOverrides[code];
  savePotentialMarkupSettings(settings);
  renderSummary();
  openPotentialDetail(code);
  showToast('Manual potential revenue price cleared.', 'success');
}

function renderPotentialDetailView() {
  const row = potentialRevenueRows().find(item => item.itemCode === inventoryCode(potentialDetailCode));
  const thead = document.getElementById('inv-thead');
  const tbody = document.getElementById('inv-tbody');
  document.getElementById('inv-pagination').innerHTML = '';
  document.getElementById('inv-bulk-bar').classList.remove('open');
  document.getElementById('potential-bulk-bar').classList.remove('open');
  document.getElementById('potential-revenue-panel').classList.add('hide-settings');
  document.getElementById('potential-subtab-included').classList.remove('active');
  document.getElementById('potential-subtab-review').classList.remove('active');
  document.getElementById('potential-subtab-detail').classList.add('open', 'active');
  document.getElementById('potential-subtab-detail').textContent =
    row ? `${row.description || row.itemCode}` : 'Item Detail';
  thead.innerHTML = '';
  tbody.innerHTML = row
    ? `<tr><td class="potential-detail-cell">${potentialDetailHtml(row)}</td></tr>`
    : '<tr><td><div class="empty-state"><p>The selected item could not be found.</p></div></td></tr>';
}

function openPotentialDetail(itemCode) {
  potentialDetailCode = inventoryCode(itemCode);
  potentialSubtab = 'detail';
  renderPotentialRevenueTable();
}

document.getElementById('btn-add-inv').addEventListener('click', () => { resetForm(); openModal('modal-inv'); });
initSupplierPicker('inv-supplier', 'inv-supplier-search', 'inv-supplier-results');
document.getElementById('inv-code').addEventListener('input', queueOutgoingSearch);
document.getElementById('inv-desc').addEventListener('input', queueOutgoingSearch);
document.getElementById('r-incoming').addEventListener('change', syncInventoryTypeMode);
document.getElementById('r-outgoing').addEventListener('change', syncInventoryTypeMode);
document.getElementById('btn-change-inv-product').addEventListener('click', () => {
  clearOutgoingSelection();
  document.getElementById('inv-code').focus();
});
document.getElementById('inv-product-search-results').addEventListener('click', event => {
  const result = event.target.closest('[data-item-code]');
  if (result) selectOutgoingProduct(result.dataset.itemCode);
});
document.getElementById('btn-rematch-sales-inv')?.addEventListener('click', () => rematchInventoryAgainstSales({ silent: false }));
document.getElementById('btn-export-inv').addEventListener('click', exportInventoryCSV);
document.getElementById('btn-save-inv').addEventListener('click', saveInv);
document.getElementById('btn-make-outgoing').addEventListener('click', openMakeOutgoingModal);
document.getElementById('btn-confirm-make-outgoing').addEventListener('click', saveBulkOutgoing);
document.getElementById('btn-delete-selected')?.addEventListener('click', openBulkDeleteModal);
document.getElementById('btn-deselect-inv')?.addEventListener('click', deselectAllInvRows);
document.getElementById('btn-cancel-bulk-delete').addEventListener('click', () => closeModal('modal-bulk-delete'));
document.getElementById('btn-confirm-bulk-delete').addEventListener('click', confirmBulkDelete);
document.getElementById('btn-save-potential-markup').addEventListener('click', savePotentialMarkup);
document.getElementById('btn-apply-selected-potential-markup').addEventListener('click', applySelectedPotentialMarkup);
document.getElementById('btn-delete-selected-potential').addEventListener('click', deleteSelectedPotentialItems);
document.getElementById('btn-clear-potential-selection').addEventListener('click', clearPotentialSelection);
document.getElementById('potential-category-select').addEventListener('change', () => {
  const settings = getPotentialMarkupSettings();
  document.getElementById('potential-category-markup').value =
    settings.categoryMarkup?.[document.getElementById('potential-category-select').value] || '';
});
renderSummary();
// Load more hidden — VS sentinel handles incremental fetch
const _invLoadMoreBtn = document.getElementById('btn-load-more-inv');
if (_invLoadMoreBtn) { _invLoadMoreBtn.style.display = 'none'; _invLoadMoreBtn.disabled = true; }
document.getElementById('inv-load-limit')?.addEventListener('change', () => clampRecordsLoadLimit('inv-load-limit'));
document.getElementById('inv-load-limit')?.addEventListener('blur', () => clampRecordsLoadLimit('inv-load-limit'));

// ─── TrackingTable ────────────────────────────────────────────────────────────
const invTable = new TrackingTable({
  id: 'inv',
  storageKey: 'inventory_movements',
  dateField: 'dateDelivered',
  generate: { label: 'Generate', onClick: 'generateInventory', statusId: 'inv-query-status' },
  theadId: 'inv-thead',
  tbodyId: 'inv-tbody',
  clearBtnId: 'btn-clear-inv',
  quickSearchId: 'search-inv',
  paginationId: 'inv-pagination',
  tabFilter: (row, tab) => tab !== 'potential' ||
    (row.type === 'Incoming' && inventoryPotentialRevenue(row) > 0),
  columns: [
    { key:'_select',       label:'<input type="checkbox" id="inv-select-all" aria-label="Select all visible inventory rows" onchange="toggleAllVisibleInvRows(this.checked)">', sortable:false, filterable:false },
    { key:'itemCode',      label:'Item Code',   sortable:true, filterable:true,  filterType:'text', filterPlaceholder:'Filter…' },
    { key:'dateDelivered', label:'Date',        sortable:true, filterable:true,  filterType:'date-range' },
    { key:'type',          label:'Type',        sortable:true, filterable:true,  filterType:'dropdown',
      filterOptions:['Incoming','Outgoing'] },
    { key:'description',   label:'Description', sortable:true, filterable:true,  filterType:'text', filterPlaceholder:'Filter…',
      sortVal:inventoryDisplayDescription, filterVal:inventoryDisplayDescription },
    { key:'category',      label:'Category',    sortable:true, filterable:true,  filterType:'dropdown',
      sortVal:inventoryDisplayCategory, filterVal:inventoryDisplayCategory,
      filterOptions: () => [...new Set(DB.get('inventory_movements').map(inventoryDisplayCategory).filter(Boolean))].sort() },
    { key:'supplier',      label:'Supplier',    sortable:true, filterable:true,  filterType:'text', filterPlaceholder:'Filter…' },
    { key:'qty',           label:'Qty',         sortable:true, filterable:true,  filterType:'num-range', sortVal:r=>r.qty },
    { key:'unitCost',      label:'Unit Cost',   sortable:true, filterable:true,  filterType:'num-range', sortVal:r=>r.unitCost },
    { key:'totalCost',     label:'Total Cost',  sortable:true, filterable:true,  filterType:'num-range', sortVal:r=>r.totalCost },
    { key:'avgSellingPrice',  label:'Avg Selling Price', sortable:true, filterable:false, sortVal:r=>inventoryAvgSellingPrice(r.itemCode) },
    { key:'potentialRevenue', label:'Potential Revenue', sortable:true, filterable:false, sortVal:inventoryPotentialRevenue },
    { key:'_actions',      label:'Actions',     sortable:false, filterable:false },
  ],
  renderRow: m => `<tr${m._derived ? ' class="inv-derived-row"' : ''}>
      <td class="select-col">${m._derived ? '' : `<input type="checkbox" class="inv-row-select" value="${m.id}" aria-label="Select inventory entry" onchange="toggleInvRowSelection('${m.id}', this.checked)">`}</td>
      <td class="mono">${m.itemCode}</td>
      <td>${formatDate(m.dateDelivered)}</td>
      <td><span class="badge ${m.type==='Incoming'?'badge-green':'badge-red'}">${m.type}</span></td>
      <td title="${invEsc(inventoryDisplayDescription(m))}">${invEsc(inventoryDisplayDescription(m))}</td>
      <td>${invEsc(inventoryDisplayCategory(m))}</td>
      <td>${m.supplier||'—'}</td>
      <td class="mono">${m.qty.toLocaleString()}</td>
      <td class="mono">${formatPeso(m.unitCost)}</td>
      <td class="mono"><strong>${formatPeso(m.totalCost)}</strong></td>
      <td class="mono inv-revenue-col">${inventoryAvgSellingPrice(m.itemCode) > 0 ? formatPeso(inventoryAvgSellingPrice(m.itemCode)) : '—'}</td>
      <td class="mono inv-revenue-col">${m.type === 'Incoming' && inventoryAvgSellingPrice(m.itemCode) > 0 ? formatPeso(inventoryPotentialRevenue(m)) : '—'}</td>
      <td>
        ${m._derived
          ? '<span class="badge badge-blue" title="Generated from a POS sale — manage it on the Sales page">POS Sale</span>'
          : `<div class="action-btns">
          <button class="btn btn-outline btn-xs" onclick="editInv('${m.id}')">Edit</button>
          <button class="btn btn-danger btn-xs" onclick="deleteInv('${m.id}')">Delete</button>
        </div>`}
      </td>
    </tr>`,
  emptyHtml: tab => tab === 'potential'
    ? '<tr><td colspan="13"><div class="empty-state"><p>No incoming inventory items with potential revenue found.</p></div></td></tr>'
    : '<tr><td colspan="13"><div class="empty-state"><div class="empty-icon">📦</div><p>No inventory movements yet.</p></div></td></tr>',
});
// Server-side item search: when the box holds an item-code-like value, fetch that
// item's day-rows from inventoryDaily (one read/day) and merge them in, so a code
// that isn't in the loaded window still appears — without scanning raw rows.
let _invSearchTimer = null, _invSearchLoaded = new Set();
(function wireInventoryItemSearch() {
  const box = document.getElementById('search-inv');
  if (!box) return;
  box.addEventListener('input', () => {
    clearTimeout(_invSearchTimer);
    const q = box.value.trim();
    if (!/^[0-9A-Za-z._-]{5,}$/.test(q) || _invSearchLoaded.has(q)) return; // only code-like queries
    _invSearchTimer = setTimeout(async () => {
      try {
        const hits = await lookupItemAcrossDays(q);   // whole history; ~1 read/day
        if (!hits.length) return;
        _invSearchLoaded.add(q);
        const rows = hits.map((h) => ({ dateDelivered: h.date, type: 'Incoming', itemCode: h.itemCode, description: h.name || '', category: '', supplier: '', unitCost: h.unitCost, qty: h.qty, totalCost: h.totalCost, _fromRollup: true }));
        const cur = DB.get('inventory_movements') || [];
        const seen = new Set(cur.map((r) => `${r.itemCode}|${r.dateDelivered}`));
        const add = rows.filter((r) => !seen.has(`${r.itemCode}|${r.dateDelivered}`));
        if (add.length) { DB.set('inventory_movements', [...cur, ...add]); invTable.render(); }
      } catch (e) { console.warn('item search failed:', e); }
    }, 350);
  });
})();

function _attachInvSentinel() {
  if (_invVsSentinelObs) _invVsSentinelObs.disconnect();
  const el = document.getElementById('inv-fetch-sentinel');
  if (!el) return;
  const root = el.closest('.table-scroll');
  _invVsSentinelObs = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && inventoryHasMoreRecords && !_invVsLoadingMore) {
      _invVsLoadingMore = true;
      invTable.render();
      loadInventoryBatch({ append: true })
        .then(() => invTable.render())
        .catch(err => console.error('[Inventory] Load more failed:', err))
        .finally(() => {
          _invVsLoadingMore = false;
          invTable.render();
        });
    }
  }, { root, threshold: 0 });
  _invVsSentinelObs.observe(el);
}

const baseInvRender = invTable.render.bind(invTable);
invTable.render = function() {
  if (this.activeTab === 'potential') {
    renderPotentialRevenueTable();
    syncBulkSelectionUI();
    return;
  }
  const thead = document.getElementById(this.cfg.theadId);
  if (thead && !thead.querySelector('.header-row')) this._buildHeaders();
  this._refreshDynamicDropdowns();
  this._refreshSortIcons();
  this._refreshFilterDots();

  const allRows  = this._getProcessed();
  const tbody    = document.getElementById(this.cfg.tbodyId);
  const scroll   = tbody?.closest('.table-scroll');
  const COLS     = 13;

  if (!allRows.length) {
    if (scroll) scroll.classList.remove('vs-active');
    _invVsWindowRows = [];
    tbody.innerHTML = typeof this.cfg.emptyHtml === 'function'
      ? this.cfg.emptyHtml(this.activeTab)
      : this.cfg.emptyHtml;
    document.getElementById(this.cfg.paginationId).innerHTML = '';
    this._refreshClearBtn();
    syncBulkSelectionUI();
    return;
  }

  if (scroll) scroll.classList.add('vs-active');

  const totalRows    = allRows.length;
  const firstVisible = Math.max(0, Math.floor(_invVsScrollTop / INV_VS_ROW_H) - INV_VS_OVERSCAN);
  const lastVisible  = Math.min(totalRows - 1, firstVisible + INV_VS_WINDOW - 1);
  const windowRows   = allRows.slice(firstVisible, lastVisible + 1);
  _invVsWindowRows = windowRows;
  const paddingTop    = firstVisible * INV_VS_ROW_H;
  const paddingBottom = Math.max(0, totalRows - lastVisible - 1) * INV_VS_ROW_H;
  const topSpacer    = paddingTop    ? `<tr style="height:${paddingTop}px"><td colspan="${COLS}"></td></tr>` : '';
  const bottomSpacer = paddingBottom ? `<tr style="height:${paddingBottom}px"><td colspan="${COLS}"></td></tr>` : '';
  const fetchSentinel = inventoryHasMoreRecords
    ? `<tr class="vs-fetch-sentinel"><td colspan="${COLS}"><div id="inv-fetch-sentinel"></div></td></tr>` : '';
  const loadingRow = _invVsLoadingMore
    ? `<tr class="vs-loading-row"><td colspan="${COLS}"><span class="spinner"></span> Loading more records...</td></tr>` : '';

  tbody.innerHTML = topSpacer + windowRows.map(r => this.cfg.renderRow(r)).join('') + bottomSpacer + fetchSentinel + loadingRow;

  const displayTotal = this.remoteTotal != null && this.activeTab === 'all' && !this.hasActive()
    ? this.remoteTotal
    : totalRows;
  const loadedLabel = displayTotal !== totalRows
    ? `${totalRows.toLocaleString()} loaded | ${displayTotal.toLocaleString()} total`
    : `${totalRows.toLocaleString()} entries`;
  document.getElementById(this.cfg.paginationId).innerHTML =
    `<div class="pagination-info">${loadedLabel}</div>`;

  this._refreshClearBtn();
  if (inventoryHasMoreRecords) _attachInvSentinel();
  syncBulkSelectionUI();
};
['setSort', 'setFilter', 'setRangeFilter', 'clearAll'].forEach(method => {
  const original = invTable[method].bind(invTable);
  invTable[method] = function(...args) {
    resetInventoryVirtualScroll();
    return original(...args);
  };
});
invTable.render();

// ─── VS scroll listener ───────────────────────────────────────────────────────
(function wireInventoryVSScroll() {
  const scroll = document.getElementById('inv-tbody')?.closest('.table-scroll');
  if (!scroll) return;
  scroll.addEventListener('scroll', () => {
    _invVsScrollTop = scroll.scrollTop;
    cancelAnimationFrame(_invVsRAF);
    _invVsRAF = requestAnimationFrame(() => {
      if (scroll.classList.contains('vs-active')) invTable.render();
    });
  }, { passive: true });
})();

// ─── MIS Import — Web Worker + Virtual Scroll + Batched Import ───────────────
let MIS_ROWS = [];   // [{ row, checked, inPM }]
let MIS_DATE = null;
let MIS_SOURCE_FILE = '';
let _misWorker = null;
let IMPORT_REVIEW = null;
let MIS_ZERO_COST_COUNT = 0;

// ─── Virtual scroll ───────────────────────────────────────────────────────────
const VS = { H: 280, ROW_H: 36, BUFFER: 4 };
let vsEl, vsTbody;

function vsInit() {
  vsEl    = document.getElementById('mis-vs-scroll');
  vsTbody = document.getElementById('mis-vs-body');
  vsEl.addEventListener('scroll', vsRender, { passive: true });
  vsEl.addEventListener('change', function(e) {
    if (e.target.classList.contains('mis-row-chk')) {
      MIS_ROWS[+e.target.dataset.idx].checked = e.target.checked;
      misSyncAllChk(); updateMISBtn(); updatePreviewMeta();
    }
  });
}

function productMasterRows() {
  return getCachedProductMasterRows();
}

function saveProductMasterRows(rows) {
  cacheProductMasterRows(rows);
  syncProductMasterToFirestore(rows);
}

function costChanged(imported, saved) {
  return Number(imported || 0) !== Number(saved || 0);
}

function renderImportReview() {
  if (!IMPORT_REVIEW) return;
  const changed = IMPORT_REVIEW.existingItems.filter(r => r.costChanged);
  document.getElementById('review-summary').innerHTML = `
    <div class="summary-card"><div class="kpi-label">Total Imported Rows</div><div class="kpi-value">${IMPORT_REVIEW.totalRows.toLocaleString()}</div></div>
    <div class="summary-card"><div class="kpi-label">Unique Item Codes</div><div class="kpi-value">${IMPORT_REVIEW.uniqueCount.toLocaleString()}</div></div>
    <div class="summary-card"><div class="kpi-label">New Items Added</div><div class="kpi-value green">${IMPORT_REVIEW.newItems.length.toLocaleString()}</div></div>
    <div class="summary-card"><div class="kpi-label">Existing Items Updated</div><div class="kpi-value">${IMPORT_REVIEW.existingItems.length.toLocaleString()}</div></div>
    <div class="summary-card"><div class="kpi-label">Cost Changes</div><div class="kpi-value ${changed.length ? 'red' : ''}">${changed.length.toLocaleString()}</div></div>`;

  document.getElementById('review-new-tbody').innerHTML = IMPORT_REVIEW.newItems.length
    ? IMPORT_REVIEW.newItems.map(r => `<tr>
        <td class="mono">${r.itemCode}</td><td>${r.description || '—'}</td><td>${r.supplier || '—'}</td>
        <td class="mono">${formatPeso(r.unitCost)}</td><td><span class="badge badge-green">New ✓</span></td>
      </tr>`).join('')
    : '<tr><td colspan="5"><div class="empty-state"><p>No new Product Master items.</p></div></td></tr>';

  document.getElementById('review-existing-tbody').innerHTML = IMPORT_REVIEW.existingItems.length
    ? IMPORT_REVIEW.existingItems.map(r => `<tr class="${r.costChanged ? 'review-cost-change' : ''}">
        <td class="mono">${r.itemCode}</td><td>${r.description || '—'}</td><td>${r.supplier || '—'}</td>
        <td class="mono">${formatPeso(r.unitCost)}</td><td class="mono">${formatPeso(r.savedUnitCost)}</td>
        <td><span class="badge badge-green">History Added</span></td>
        <td>—</td>
      </tr>`).join('')
    : '<tr><td colspan="7"><div class="empty-state"><p>No existing Product Master matches.</p></div></td></tr>';

  document.getElementById('btn-review-update-all').style.display = 'none';
}

function openImportReview() {
  renderImportReview();
  openModal('modal-import-review');
}

async function updateReviewCost(itemCode) {
  if (!IMPORT_REVIEW) return;
  const row = IMPORT_REVIEW.existingItems.find(r => r.itemCode === itemCode);
  if (!row || !row.costChanged) return;

  // Update local cache
  const products = productMasterRows();
  const p = products.find(prod => prod.itemCode === itemCode);
  if (p) { p.unitCost = row.unitCost; p.cost = row.unitCost; }
  cacheProductMasterRows(products);

  // Targeted Firestore update — find by itemCode field, never by doc ID
  const fsdb = getFirestoreDB();
  if (fsdb) {
    try {
      const snap = await fsdb.collection('productMaster')
        .where('itemCode', '==', String(itemCode).trim())
        .limit(1)
        .get();
      if (!snap.empty) {
        await snap.docs[0].ref.update({ unitCost: row.unitCost, latestCost: row.unitCost });
      } else {
        await fsdb.collection('productMaster').add({
          itemCode: String(itemCode).trim(),
          unitCost: row.unitCost,
          latestCost: row.unitCost
        });
      }
    } catch (err) {
      console.error('[Inventory] PM cost update failed:', err);
    }
  }

  row.savedUnitCost = row.unitCost;
  row.costChanged = false;
  renderImportReview();
  showToast(`Unit cost updated for ${itemCode}.`, 'success');
}

async function updateAllReviewCosts() {
  if (!IMPORT_REVIEW) return;
  const changed = IMPORT_REVIEW.existingItems.filter(r => r.costChanged);
  if (!changed.length) return;

  // Update local cache
  const byCode = new Map(changed.map(r => [r.itemCode, r]));
  const products = productMasterRows();
  products.forEach(p => {
    const row = byCode.get(p.itemCode);
    if (!row) return;
    p.unitCost = row.unitCost;
    p.cost = row.unitCost;
  });
  cacheProductMasterRows(products);

  // Targeted Firestore updates — each found by itemCode field
  const fsdb = getFirestoreDB();
  if (fsdb) {
    try {
      await Promise.all(changed.map(async row => {
        const snap = await fsdb.collection('productMaster')
          .where('itemCode', '==', String(row.itemCode).trim())
          .limit(1)
          .get();
        if (!snap.empty) {
          await snap.docs[0].ref.update({ unitCost: row.unitCost, latestCost: row.unitCost });
        } else {
          await fsdb.collection('productMaster').add({
            itemCode: String(row.itemCode).trim(),
            unitCost: row.unitCost,
            latestCost: row.unitCost
          });
        }
      }));
    } catch (err) {
      console.error('[Inventory] PM bulk cost update failed:', err);
    }
  }

  changed.forEach(r => { r.savedUnitCost = r.unitCost; r.costChanged = false; });
  renderImportReview();
  showToast(`${changed.length} unit cost${changed.length === 1 ? '' : 's'} updated.`, 'success');
}

function exportImportReviewCSV() {
  if (!IMPORT_REVIEW) return;
  const rows = [['Section','Item Code','Description','Supplier','Imported Unit Cost','Saved Unit Cost','Status']];
  IMPORT_REVIEW.newItems.forEach(r => rows.push(['New', r.itemCode, r.description || '', r.supplier || '', r.unitCost || 0, '', 'New']));
  IMPORT_REVIEW.existingItems.forEach(r => rows.push(['Existing', r.itemCode, r.description || '', r.supplier || '', r.unitCost || 0, r.savedUnitCost || 0, r.costChanged ? 'Cost Changed' : 'Already Exists']));
  const csv = rows.map(cols => cols.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type:'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `mis-import-review-${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function vsRender() {
  if (!vsEl || !MIS_ROWS.length) return;
  const top   = vsEl.scrollTop;
  const start = Math.max(0, Math.floor(top / VS.ROW_H) - VS.BUFFER);
  const end   = Math.min(MIS_ROWS.length, Math.ceil((top + VS.H) / VS.ROW_H) + VS.BUFFER);
  let html = '';
  for (let i = start; i < end; i++) html += misBuildRow(MIS_ROWS[i], i);
  vsTbody.style.height = `${MIS_ROWS.length * VS.ROW_H}px`;
  vsTbody.innerHTML = html;
}

function misBuildRow(item, idx) {
  const { row, checked, inPM } = item;
  const badge = inPM
    ? `<span class="badge badge-green" style="font-size:10px">&#10003; In PM</span>`
    : `<span class="badge badge-amber" style="font-size:10px">&#8594; Will be added</span>`;
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  return `<div class="mis-vgrid-row${checked ? '' : ' dim'}" style="transform:translateY(${idx * VS.ROW_H}px)">
    <div class="mis-vgrid-cell"><input type="checkbox" class="mis-row-chk" data-idx="${idx}" ${checked ? 'checked' : ''} style="accent-color:var(--primary)"></div>
    <div class="mis-vgrid-cell mono">${esc(row.itemCode)||'—'}</div>
    <div class="mis-vgrid-cell" title="${esc(row.description)}">${esc(row.description)||'—'}</div>
    <div class="mis-vgrid-cell">${esc(row.category)||'—'}</div>
    <div class="mis-vgrid-cell">${esc(row.supplier)||'—'}</div>
    <div class="mis-vgrid-cell mono">${row.qty}</div>
    <div class="mis-vgrid-cell mono">${formatPeso(row.unitCost)}</div>
    <div class="mis-vgrid-cell mono"><strong>${formatPeso(row.totalCost)}</strong></div>
    <div class="mis-vgrid-cell">${badge}</div>
  </div>`;
}

function misInitHead() {
  const TH = ['', 'Item Code', 'Description', 'Category', 'Supplier', 'Qty', 'Unit Cost', 'Total Cost', 'PM Status'];
  document.getElementById('mis-vs-head').innerHTML =
    TH.map((h, i) => i === 0
      ? `<div class="mis-vgrid-cell"><input type="checkbox" id="mis-all-chk" style="accent-color:var(--primary)" checked></div>`
      : `<div class="mis-vgrid-cell">${h}</div>`
    ).join('');
  document.getElementById('mis-all-chk').addEventListener('change', function() {
    MIS_ROWS.forEach(r => r.checked = this.checked);
    vsRender(); updateMISBtn(); updatePreviewMeta();
  });
}

function misSyncAllChk() {
  const el = document.getElementById('mis-all-chk'); if (!el) return;
  const n = MIS_ROWS.length, s = MIS_ROWS.filter(r => r.checked).length;
  el.indeterminate = s > 0 && s < n; el.checked = s === n;
}

function updateMISBtn() {
  const n   = MIS_ROWS.filter(r => r.checked).length;
  const btn = document.getElementById('btn-confirm-mis');
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? `Import ${n.toLocaleString()} Row${n !== 1 ? 's' : ''}` : 'Import Records';
}

function updatePreviewMeta() {
  const total   = MIS_ROWS.length;
  const sel     = MIS_ROWS.filter(r => r.checked).length;
  const flagged = MIS_ROWS.filter(r => r.checked && !r.inPM && Number(r.row.unitCost) > 0).length;
  const zeroCost = MIS_ROWS.filter(r => r.checked && !(Number(r.row.unitCost) > 0)).length;
  const selectedText = sel === total && total > 0 ? 'all selected' : `${sel.toLocaleString()} selected`;
  document.getElementById('mis-preview-count').textContent =
    `${total.toLocaleString()} row${total !== 1 ? 's' : ''} parsed. ${selectedText}`;
  const pmW = document.getElementById('mis-pm-warning');
  if (flagged > 0 || zeroCost > 0) {
    const notes = [];
    if (flagged > 0) notes.push(`${flagged.toLocaleString()} new item${flagged !== 1 ? 's' : ''} will be added to Product Master without a category`);
    if (zeroCost > 0) notes.push(`${zeroCost.toLocaleString()} row${zeroCost !== 1 ? 's' : ''} with zero unit cost will be skipped`);
    pmW.style.display = '';
    pmW.textContent = notes.join(' · ');
  }
  else pmW.style.display = 'none';
}

// ─── Web Worker (blob URL from inline template) ───────────────────────────────
function getMISWorker() {
  if (_misWorker) _misWorker.terminate();
  let src = document.getElementById('mis-worker-src').textContent;
  // Resolve SheetJS to an ABSOLUTE URL so importScripts works inside the blob worker
  // (relative paths have no valid base in a blob:// worker, which fails when deployed).
  const xlsxUrl = new URL('../assets/vendor/xlsx.full.min.js', document.baseURI).href;
  src = src.replace('__XLSX_URL__', xlsxUrl);
  const blob = new Blob([src], { type: 'application/javascript' });
  const url  = URL.createObjectURL(blob);
  _misWorker = new Worker(url);
  URL.revokeObjectURL(url);
  return _misWorker;
}

function parseMISCSVDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const mdy = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (mdy) {
    const year = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
    return `${year}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function parseMISCSVNumber(value) {
  return parseFloat(String(value ?? '').replace(/[,\s]/g, '').replace(/[^\d.-]/g, '')) || 0;
}

function finishMISParse(detectedDate, dateSource) {
  document.getElementById('mis-parse-status').textContent = 'Checking Product Master...';
  MIS_DATE = detectedDate || todayISO();
  if (!MIS_ROWS.length) {
    document.getElementById('mis-parse-progress').style.display = 'none';
    alert('No valid rows found. Make sure the file has Item Code, Description, and Qty columns.');
    return;
  }
  const allRows = MIS_ROWS.map(item => item.row);
  document.getElementById('mis-parse-progress').style.display = 'none';
  const banner = document.getElementById('mis-date-banner');
  banner.style.display = 'flex';
  document.getElementById('mis-date-text').textContent =
    `Detected date: ${formatDate(MIS_DATE)} (source: ${dateSource})`;
  document.getElementById('mis-date-override').value = MIS_DATE;
  misInitHead();
  updatePreviewMeta();
  vsEl.scrollTop = 0;
  vsRender();
  document.getElementById('mis-preview').style.display = 'block';
  updateMISBtn();
}

function parseMISCSVFile(file, existingCodes) {
  if (typeof Papa === 'undefined') {
    document.getElementById('mis-parse-progress').style.display = 'none';
    alert('CSV parser failed to load. Please refresh and try again.');
    return;
  }
  document.getElementById('mis-parse-status').textContent = 'Reading CSV...';
  Papa.parse(file, {
    header: false,
    // The MIS export spaces item records four rows apart. Preserve blanks so
    // the confirmed data offset remains stable.
    skipEmptyLines: false,
    worker: true,
    complete(results) {
      if (results.errors?.length) {
        console.warn('[Inventory] CSV parse warnings:', results.errors);
      }
      const sourceRows = results.data || [];
      const dataRows = sourceRows.slice(14);
      const fallbackDate = sourceRows.slice(0, 14)
        .flat()
        .map(parseMISCSVDate)
        .find(Boolean) || todayISO();
      const parsedRows = dataRows.map(cols => {
        const itemCode = String(cols[0] ?? '').trim();
        if (!itemCode || Number.isNaN(Number(itemCode.replace(/\s/g, '')))) return null;
        const unitCost = parseMISCSVNumber(cols[9]);
        const qty = parseMISCSVNumber(cols[12]);
        const totalCost = parseMISCSVNumber(cols[20]);
        const computedCost = unitCost > 0 ? unitCost : (qty > 0 ? totalCost / qty : 0);
        if (computedCost === 0 && totalCost === 0) return null;
        return {
          itemCode,
          description: String(cols[1] ?? '').trim(),
          documentNo: String(cols[3] ?? '').trim(),
          rowDate: parseMISCSVDate(cols[6]) || fallbackDate,
          supplier: String(cols[8] ?? '').trim(),
          unitCost: computedCost,
          qty,
          uom: String(cols[15] ?? '').trim(),
          totalCost: totalCost || computedCost * qty,
          category: ''
        };
      }).filter(Boolean);
      MIS_ROWS = parsedRows.map(row => ({
        row,
        checked: true,
        inPM: existingCodes.has(row.itemCode.toLowerCase())
      }));
      document.getElementById('mis-parse-bar').style.width = '100%';
      document.getElementById('mis-parse-status').textContent =
        `Parsing... ${MIS_ROWS.length.toLocaleString()} / ${MIS_ROWS.length.toLocaleString()}`;
      finishMISParse(fallbackDate, 'CSV metadata or row date');
    },
    error(err) {
      document.getElementById('mis-parse-progress').style.display = 'none';
      alert(`Error reading CSV file: ${err.message}`);
    }
  });
}

async function readMISFile(file) {
  if (!file.name.match(/\.(xls|xlsx|csv)$/i)) {
    alert('Please upload an Excel (.xls, .xlsx) or CSV file.'); return;
  }
  try {
    await loadProductMasterFromFirestore('', false);
  } catch (err) {
    console.error('[Inventory] Product Master Firestore load failed:', err);
    alert('Could not load Product Master from Firestore. Please try again.');
    return;
  }
  MIS_ROWS = []; MIS_DATE = null; MIS_ZERO_COST_COUNT = 0;
  MIS_SOURCE_FILE = file.name;
  let existingCodes = new Set(productMasterRows().map(p => String(p.itemCode || '').trim().toLowerCase()));
  document.getElementById('mis-parse-progress').style.display = 'block';
  document.getElementById('mis-preview').style.display        = 'none';
  document.getElementById('mis-date-banner').style.display    = 'none';
  document.getElementById('mis-parse-bar').style.width        = '0%';
  document.getElementById('mis-parse-status').textContent     = 'Reading file…';
  if (vsTbody) { vsTbody.innerHTML = ''; vsTbody.style.height = '0px'; }

  if (/\.csv$/i.test(file.name)) {
    parseMISCSVFile(file, existingCodes);
    return;
  }

  const worker = getMISWorker();

  worker.onmessage = function(e) {
    const msg = e.data;
    if (msg.type === 'status') {
      document.getElementById('mis-parse-status').textContent = msg.text;
    } else if (msg.type === 'meta') {
      MIS_DATE = msg.detectedDate;
      document.getElementById('mis-date-override').value = msg.detectedDate;
      document.getElementById('mis-parse-status').textContent = `Parsing ${msg.total.toLocaleString()} rows…`;
    } else if (msg.type === 'progress') {
      const pct = msg.total > 0 ? (msg.done / msg.total * 100).toFixed(1) : 0;
      document.getElementById('mis-parse-bar').style.width = pct + '%';
      document.getElementById('mis-parse-status').textContent =
        `Parsing… ${msg.done.toLocaleString()} / ${msg.total.toLocaleString()}`;
    } else if (msg.type === 'chunk') {
      const mapped = msg.rows.map(row => ({
        row, checked: true,
        inPM: existingCodes.has((row.itemCode || '').toLowerCase()),
      }));
      MIS_ROWS.push(...mapped);
    } else if (msg.type === 'done') {
      finishMISParse(msg.detectedDate, msg.dateSource);
    } else if (msg.type === 'error') {
      document.getElementById('mis-parse-progress').style.display = 'none';
      alert('Error reading file: ' + msg.message);
    }
  };

  worker.onerror = function(err) {
    document.getElementById('mis-parse-progress').style.display = 'none';
    alert('Worker error: ' + (err.message || 'unknown'));
  };

  const reader = new FileReader();
  reader.onload = function(ev) { worker.postMessage(ev.target.result, [ev.target.result]); };
  reader.readAsArrayBuffer(file);
}

function resetMISModal() {
  if (_misWorker) { _misWorker.terminate(); _misWorker = null; }
  MIS_ROWS = []; MIS_DATE = null; MIS_ZERO_COST_COUNT = 0;
  document.getElementById('mis-file-input').value             = '';
  document.getElementById('mis-preview').style.display        = 'none';
  document.getElementById('mis-date-banner').style.display    = 'none';
  document.getElementById('mis-parse-progress').style.display = 'none';
  document.getElementById('mis-import-progress').style.display= 'none';
  document.getElementById('mis-import-status').style.color    = '';
  document.getElementById('mis-import-bar').style.background  = 'var(--primary)';
  if (vsTbody) { vsTbody.innerHTML = ''; vsTbody.style.height = '0px'; }
  const btn = document.getElementById('btn-confirm-mis');
  btn.disabled = true; btn.textContent = 'Import Records'; btn.style.display = '';
  document.getElementById('mis-cancel-btn').style.display = '';
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(html, type = 'success', ms = 5000) {
  const prev = document.getElementById('epc-toast'); if (prev) prev.remove();
  const bg = type === 'success' ? '#16a34a' : type === 'warning' ? '#d97706' : '#1A56DB';
  const el = document.createElement('div');
  el.id = 'epc-toast';
  el.style.cssText = `position:fixed;bottom:24px;right:24px;background:${bg};color:white;
    padding:13px 18px;border-radius:10px;font-size:13.5px;font-weight:600;
    font-family:'Plus Jakarta Sans',sans-serif;z-index:9999;max-width:390px;line-height:1.6;
    box-shadow:0 4px 20px rgba(0,0,0,0.18);cursor:pointer`;
  el.innerHTML = html;
  el.onclick = () => el.remove();
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; } }, ms - 300);
  setTimeout(() => { if (el.parentNode) el.remove(); }, ms);
}

// ─── File input wiring ────────────────────────────────────────────────────────
const misDropZone  = document.getElementById('mis-drop-zone');
const misFileInput = document.getElementById('mis-file-input');
misDropZone.addEventListener('click', () => misFileInput.click());
misDropZone.addEventListener('dragover',  e => { e.preventDefault(); misDropZone.classList.add('dragover'); });
misDropZone.addEventListener('dragleave', () => misDropZone.classList.remove('dragover'));
misDropZone.addEventListener('drop', e => { e.preventDefault(); misDropZone.classList.remove('dragover'); if (e.dataTransfer.files[0]) readMISFile(e.dataTransfer.files[0]); });
misFileInput.addEventListener('change', function() { if (this.files[0]) readMISFile(this.files[0]); this.value = ''; });
document.getElementById('mis-clear-file').addEventListener('click', resetMISModal);
document.getElementById('mis-select-all-btn').addEventListener('click', () => {
  MIS_ROWS.forEach(r => r.checked = true); vsRender(); misSyncAllChk(); updateMISBtn(); updatePreviewMeta();
});
document.getElementById('mis-deselect-all-btn').addEventListener('click', () => {
  MIS_ROWS.forEach(r => r.checked = false); vsRender(); misSyncAllChk(); updateMISBtn(); updatePreviewMeta();
});
document.getElementById('mis-date-override').addEventListener('change', function() { MIS_DATE = this.value; });
document.getElementById('btn-review-update-all').addEventListener('click', updateAllReviewCosts);
document.getElementById('btn-review-export').addEventListener('click', exportImportReviewCSV);
document.getElementById('btn-review-close').addEventListener('click', () => closeModal('modal-import-review'));

// ─── Confirm: batched inventory save + batched PM bulk-add ────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function commitFreshBatchWithRetry(createBatch, currentRow, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const batch = createBatch();
    try {
      await batch.commit();
      return;
    } catch (err) {
      console.warn(`Batch attempt ${attempt} failed at row ${currentRow}:`, err);
      if (attempt === retries) {
        err.currentRow = currentRow;
        throw err;
      }
      await sleep(1000 * attempt);
    }
  }
}

function inventoryMovementKey(row, fallbackDate = '') {
  return `${String(row.itemCode || '').trim().toLowerCase()}|${String(row.documentNo || '').trim().toLowerCase()}|${row.dateDelivered || row.rowDate || fallbackDate}|${Number(row.unitCost) || 0}|${Number(row.qty) || 0}|${Number(row.totalCost) || 0}|${String(row.supplier || '').trim().toLowerCase()}`;
}

function inventoryFirestoreDocId(row, fallbackDate = '') {
  const key = inventoryMovementKey(row, fallbackDate);
  let hashA = 2166136261;
  let hashB = 5381;
  for (let i = 0; i < key.length; i++) {
    hashA = Math.imul(hashA ^ key.charCodeAt(i), 16777619);
    hashB = Math.imul(hashB, 33) ^ key.charCodeAt(i);
  }
  return `mis-${(hashA >>> 0).toString(36)}-${(hashB >>> 0).toString(36)}`;
}

function supplierFirestoreDocId(name) {
  const key = String(name || '').trim().toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  }
  return `mis-supplier-${(hash >>> 0).toString(36)}`;
}

document.getElementById('btn-confirm-mis').addEventListener('click', () => {
  const toImport = MIS_ROWS.filter(r => r.checked);
  if (!toImport.length) return;

  const importDate = document.getElementById('mis-date-override').value || MIS_DATE || todayISO();
  const PREP_BATCH = 200;
  const FIRESTORE_BATCH = 400;
  let   inventorySaved = 0;
  const savedInventoryRows = [];
  const queuedInventoryIds = new Set();

  document.getElementById('mis-import-progress').style.display = 'block';
  document.getElementById('mis-preview').style.display         = 'none';
  document.getElementById('btn-confirm-mis').style.display     = 'none';
  document.getElementById('mis-cancel-btn').style.display      = 'none';
  document.getElementById('mis-import-bar').style.width        = '0%';

  function setBar(done, total, label) {
    document.getElementById('mis-import-status').textContent =
      label + ' ' + done.toLocaleString() + ' / ' + total.toLocaleString();
    document.getElementById('mis-import-bar').style.width =
      (total > 0 ? (done / total * 100).toFixed(1) : 0) + '%';
  }

  function importBatch(start, done) {
    const end = Math.min(start + PREP_BATCH, toImport.length);
    const invRows = DB.get('inventory_movements');
    const existingMovements = new Map(invRows.map(row => [inventoryMovementKey(row), row]));
    for (let i = start; i < end; i++) {
      const r = toImport[i].row;
      if ((!r.itemCode && !r.description) || (!(Number(r.unitCost) > 0) && !(Number(r.totalCost) > 0))) {
        if (!(Number(r.unitCost) > 0) && !(Number(r.totalCost) > 0)) MIS_ZERO_COST_COUNT++;
        continue;
      }
      const movementKey = inventoryMovementKey(r, importDate);
      const savedRow = existingMovements.get(movementKey);
      if (savedRow) {
        const firestoreId = inventoryFirestoreDocId(savedRow);
        if (!queuedInventoryIds.has(firestoreId)) {
          queuedInventoryIds.add(firestoreId);
          savedInventoryRows.push(savedRow);
        }
        continue;
      }
      const inventoryRow = {
        id: genId(), type: 'Incoming',
        itemCode: r.itemCode, description: r.description,
        category: r.category || 'Uncategorized', supplier: r.supplier || '',
        unitCost: r.unitCost, qty: r.qty,
        totalCost: r.totalCost || r.unitCost * r.qty,
        documentNo: r.documentNo || '', uom: r.uom || '',
        dateDelivered: r.rowDate || importDate, notes: 'Imported from MIS file',
      };
      inventoryRow._firestoreId = inventoryFirestoreDocId(inventoryRow);
      invRows.push(inventoryRow);
      existingMovements.set(movementKey, inventoryRow);
      if (!queuedInventoryIds.has(inventoryRow._firestoreId)) {
        queuedInventoryIds.add(inventoryRow._firestoreId);
        savedInventoryRows.push(inventoryRow);
      }
    }
    DB.set('inventory_movements', invRows);
    setBar(end, toImport.length, 'Preparing inventory...');
    if (end < toImport.length) setTimeout(() => importBatch(end, done), 0);
    else done();
  }

  async function saveInventoryRowsToFirestore(rows) {
    const db = getFirestoreDB();
    if (!db || !rows.length) return 0;
    let saved = 0;
    for (let start = 0; start < rows.length; start += FIRESTORE_BATCH) {
      const chunk = rows.slice(start, start + FIRESTORE_BATCH);
      await commitFreshBatchWithRetry(() => {
        const batch = db.batch();
        chunk.forEach(row => {
          const firestoreId = row._firestoreId || inventoryFirestoreDocId(row);
          const firestoreRow = { ...row };
          delete firestoreRow._firestoreId;
          batch.set(db.collection('inventoryData').doc(firestoreId), firestoreRow, { merge: true });
        });
        return batch;
      }, Math.min(start + chunk.length, rows.length));
      saved += chunk.length;
      setBar(saved, rows.length, 'Saving inventory...');
      await sleep(300);
    }
    return saved;
  }

  async function syncProductMasterFromImport(rows) {
    await loadProductMasterFromFirestore('', false);
    const allImportedRows = rows.map(item => item.row);
    const existingProducts = productMasterRows().map(normalizeProductCostData);
    const existingByCode = new Map(
      existingProducts
        .map(p => [String(p.itemCode || p.code || '').trim().toLowerCase(), p])
        .filter(([code]) => code)
    );

    const newProducts = [];
    const changedProducts = new Map();
    const seenCodes = new Set();
    const newItems = [];
    const existingItems = [];
    let skippedHistoryEntries = 0;

    for (const row of allImportedRows) {
      if (!row.itemCode || row.itemCode.toString().trim() === '') continue;
      if (!(Number(row.unitCost) > 0)) continue;
      const itemCode = row.itemCode.toString().trim();
      const key = itemCode.toLowerCase();
      seenCodes.add(key);
      let existing = existingByCode.get(key);
      const entry = {
        date: row.rowDate || importDate,
        unitCost: Number(row.unitCost),
        supplier: String(row.supplier || '').trim()
      };
      const historyKey = `${entry.date}|${entry.unitCost}`;

      if (existing) {
        const duplicate = existing.costHistory.some(saved =>
          `${saved.date}|${Number(saved.unitCost)}` === historyKey);
        if (duplicate) {
          skippedHistoryEntries++;
          changedProducts.set(key, existing);
          continue;
        }
      } else {
        const reviewRow = { itemCode, description: row.description, supplier: row.supplier, unitCost: row.unitCost };
        newItems.push(reviewRow);
        existing = normalizeProductCostData({
          id: genId(),
          itemCode,
          productName: row.description,
          category: 'Uncategorized',
          supplier: row.supplier,
          costHistory: [],
          status: 'Active'
        });
        newProducts.push(existing);
        existingProducts.push(existing);
        existingByCode.set(key, existing);
      }

      const previousCost = existing.latestCost || 0;
      existing.costHistory.push(entry);
      const normalizedExisting = normalizeProductCostData(existing);
      Object.assign(existing, normalizedExisting, {
        productName: existing.productName || row.description,
        supplier: row.supplier || existing.supplier || '',
        lastUpdated: normalizedExisting.latestDate
      });
      changedProducts.set(key, existing);
      if (!newItems.some(item => item.itemCode === itemCode)) {
        existingItems.push({
          itemCode,
          description: row.description,
          supplier: row.supplier,
          unitCost: row.unitCost,
          savedUnitCost: previousCost,
          costChanged: costChanged(row.unitCost, previousCost),
        });
      }
    }

    const updatedProducts = existingProducts;
    const productsToSave = [...changedProducts.values()];
    setBar(0, productsToSave.length, 'Updating Product Master...');
    await upsertProductMasterRowsInFirestore(
      productsToSave,
      (done, total) => setBar(done, total, 'Updating Product Master...'),
      {
        batchSize: 200,
        commitBatch: (batch) => batch.commit(),
        delay: () => sleep(300)
      }
    );
    cacheProductMasterRows(updatedProducts);
    const savedCodes = new Set(updatedProducts.map(p => String(p.itemCode || p.code || '').trim().toLowerCase()).filter(Boolean));
    const missingImportedCodes = [...seenCodes].filter(code => !savedCodes.has(code));
    IMPORT_REVIEW = {
      totalRows: allImportedRows.length,
      uniqueCount: seenCodes.size,
      newItems,
      existingItems,
    };

    if (missingImportedCodes.length) console.warn('Imported codes missing from Product Master:', missingImportedCodes);
    return {
      added: newProducts.length,
      duplicates: existingItems.length,
      skippedHistoryEntries,
      updated: productsToSave.length
    };
  }

  async function upsertSuppliersFromImport(rows) {
    const db = getFirestoreDB();
    if (!db) throw new Error('Database unavailable.');
    const localSuppliers = DB.get('suppliers');
    const localByName = new Map(localSuppliers
      .map(supplier => [String(supplier.name || '').trim().toLowerCase(), supplier])
      .filter(([name]) => name));
    const importedByName = new Map();

    rows.forEach(row => {
      const name = String(row.supplier || '').trim();
      const key = name.toLowerCase();
      if (!key || importedByName.has(key)) return;
      importedByName.set(key, localByName.get(key) || {
        id: supplierFirestoreDocId(name),
        name,
        category: '',
        address: '',
        contactPerson: '',
        phone: '',
        email: '',
        notes: '',
        status: 'Active'
      });
    });

    const importedSuppliers = [...importedByName.values()];
    for (let start = 0; start < importedSuppliers.length; start += FIRESTORE_BATCH) {
      const chunk = importedSuppliers.slice(start, start + FIRESTORE_BATCH);
      await commitFreshBatchWithRetry(() => {
        const batch = db.batch();
        chunk.forEach(supplier => {
          batch.set(
            db.collection('suppliers').doc(supplierFirestoreDocId(supplier.name)),
            supplier,
            { merge: true }
          );
        });
        return batch;
      }, Math.min(start + chunk.length, importedSuppliers.length));
      await sleep(300);
    }

    const newSuppliers = importedSuppliers.filter(supplier =>
      !localByName.has(String(supplier.name || '').trim().toLowerCase())
    );
    if (newSuppliers.length) DB.set('suppliers', [...localSuppliers, ...newSuppliers]);
    return newSuppliers;
  }

  importBatch(0, () => {
    setTimeout(async () => {
      try {
        inventorySaved = await saveInventoryRowsToFirestore(savedInventoryRows);
        const review = await syncProductMasterFromImport(toImport);

        const allImportedRows = toImport.map(item => item.row);
        const newSuppliers = await upsertSuppliersFromImport(allImportedRows);
        logAudit('Import', 'MIS Inventory',
          `Imported '${MIS_SOURCE_FILE || 'MIS file'}' - ${inventorySaved.toLocaleString()} inventory records, ${review.updated.toLocaleString()} products updated`);

        const zeroCostCount = MIS_ZERO_COST_COUNT;
        closeModal('modal-mis'); resetMISModal(); invTable.render(); renderSummary();
        let msg = `✓ Done! ${inventorySaved.toLocaleString()} inventory rows saved, ${review.updated.toLocaleString()} products updated in Product Master.<br>${newSuppliers.length.toLocaleString()} new suppliers registered.`;
        if (zeroCostCount > 0) msg += `<br>${zeroCostCount.toLocaleString()} zero-cost rows skipped.`;
        if (review.skippedHistoryEntries > 0) msg += `<br>${review.skippedHistoryEntries.toLocaleString()} existing cost history entries skipped.`;
        if (review.duplicates > 0) {
          msg += `<br><button class="btn btn-outline-gray btn-xs" style="margin-top:7px;background:white" onclick="openImportReview()">Review ${review.duplicates.toLocaleString()} Updated Items</button>`;
        }
        if (review.added > 0 || review.duplicates > 0) {
          msg += ` <a href="product-master.html" style="color:white;text-decoration:underline;font-weight:700">Open Product Master</a>`;
          showToast(msg, 'warning', 9000);
        } else { showToast(msg, 'success'); }

        // Re-match any Under Review items that now have PM records from this import
        rematchUnderReview()
          .then(({ moved }) => {
            if (moved > 0) {
              showToast(
                `✅ ${moved} Under Review item${moved > 1 ? 's' : ''} matched and moved to Sales Data!`,
                'success'
              );
            }
          })
          .catch(err => console.error('[rematchUnderReview] Error:', err));
      } catch (err) {
        console.error('INCOMING import error:', err);
        const currentRow = Number(err.currentRow) || 0;
        const status = document.getElementById('mis-import-status');
        status.textContent = `⚠️ Error at row ${currentRow.toLocaleString()}: ${err.message}. Please try again.`;
        status.style.color = '#dc2626';
        document.getElementById('mis-import-bar').style.background = '#ef4444';
        document.getElementById('mis-cancel-btn').style.display = '';
      }
    }, 0);
  });
});

// ─── NEW: QBO-style mapping import (replaces the position-based MIS parser) ────
// Writes to inventoryData (content-hash dedup), suppliers, and productMaster —
// preserving the exact behavior of the old confirm handler above. Called by the
// reusable EPCImport dialog via its opts.importer hook.
async function misImportMappedRows(mappedRows, onProgress) {
  const db = getFirestoreDB();
  if (!db) throw new Error('Database unavailable.');
  const FS_BATCH = 400;
  const importDate = todayISO();

  // ── DUPLICATE-DATE BLOCK (all-or-nothing) ─────────────────────────────
  // Collect the distinct delivery dates in this file; if any date already has
  // an inventory upload, reject the WHOLE file and name the conflicts.
  const _nd = (v) => { const s = String(v == null ? '' : v).trim(); const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${('0'+m[2]).slice(-2)}-${('0'+m[3]).slice(-2)}`; const d = new Date(s); return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); };
  const fileDates = new Set();
  mappedRows.forEach((m) => { const d = _nd(m.date_delivered) || importDate; fileDates.add(d); });
  const EI = (typeof EPCImport !== 'undefined') ? EPCImport : null;
  try {
    const conflicts = EI && EI.findDateConflicts
      ? await EI.findDateConflicts(db, 'inventory', fileDates)
      : await (async () => {
          const snap = await db.collection('uploads').where('type', '==', 'inventory').get();
          const c = []; snap.forEach((doc) => { const u = doc.data(); (u.dates || []).forEach((d) => { if (fileDates.has(d)) c.push({ date: d, fileName: u.fileName || '(unnamed)' }); }); }); return c;
        })();
    if (conflicts.length) {
      // Smart per-date message: exact duplicate vs differing correction.
      let lines;
      if (EI && EI.smartConflictMessages) {
        const msgs = await EI.smartConflictMessages(db, 'inventory', mappedRows, conflicts);
        const allExact = msgs.length && msgs.every((m) => m.exact);
        const head = allExact
          ? `This file's inventory data is already uploaded — nothing to do.`
          : `Blocked — ${msgs.length} date(s) already have an inventory upload.`;
        const err = new Error(`${head}\n• ${msgs.map((m) => m.text).join('\n• ')}`);
        err.isDuplicateBlock = true;
        throw err;
      } else {
        const byDate = {};
        conflicts.forEach((c) => { (byDate[c.date] = byDate[c.date] || new Set()).add(c.fileName); });
        lines = Object.keys(byDate).sort().map((d) => `${d} (already in ${[...byDate[d]].join(', ')})`);
        const err = new Error(`Blocked — ${Object.keys(byDate).length} date(s) already have an inventory upload:\n• ${lines.join('\n• ')}\nDelete/replace those dates first, or upload a file without them.`);
        err.isDuplicateBlock = true;
        throw err;
      }
    }
  } catch (e) { if (e.isDuplicateBlock) throw e; /* read failure: proceed (idempotent replace still protects) */ }

  // FILENAME WARNING (soft): same-named inventory file already uploaded?
  if (EI && EI.findSameFilenameUpload) {
    try {
      const fname = (typeof MIS_SOURCE_FILE !== 'undefined' && MIS_SOURCE_FILE) || '';
      const sameName = await EI.findSameFilenameUpload(db, 'inventory', fname);
      if (sameName && !window.confirm(`A file named "${sameName.fileName}" was already uploaded on ${sameName.date}.\n\nContinue anyway?`)) {
        const err = new Error('Upload cancelled — same filename already used.');
        err.isDuplicateBlock = true;
        throw err;
      }
    } catch (e) { if (e.isDuplicateBlock) throw e; }
  }
  const toNum = (v) => { const n = Number(String(v == null ? '' : v).replace(/,/g, '').trim()); return Number.isFinite(n) ? n : 0; };
  const normDate = (v) => {
    const s = String(v == null ? '' : v).trim();
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${('0'+m[2]).slice(-2)}-${('0'+m[3]).slice(-2)}`;
    const d = new Date(s); return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  };

  // 1) Build inventory rows (skip zero-cost, like the old flow), dedup by content hash.
  const invRows = DB.get('inventory_movements');
  const existing = new Map(invRows.map((r) => [inventoryMovementKey(r), r]));
  const toSave = [];
  const queued = new Set();
  let zeroCost = 0;
  const rawForPM = []; // {itemCode, description, supplier, unitCost, rowDate} for PM/supplier sync
  const rawForPMFull = []; // adds qty for the per-day rollups

  mappedRows.forEach((m) => {
    const itemCode = String(m.item_code || '').trim();
    const description = String(m.description || '').trim();
    const unitCost = toNum(m.unit_cost);
    const qty = toNum(m.qty);
    const totalCost = unitCost * qty;   // total_cost is always auto-computed
    if ((!itemCode && !description) || !(unitCost > 0)) { zeroCost++; return; }
    const rowDate = normDate(m.date_delivered) || importDate;
    const supplier = String(m.supplier || '').trim();
    const row = {
      id: genId(), type: 'Incoming', itemCode, description,
      category: String(m.category || '').trim() || 'Uncategorized', supplier,
      unitCost: unitCost > 0 ? unitCost : (qty > 0 ? totalCost / qty : 0), qty,
      totalCost, documentNo: String(m.document_no || '').trim(), uom: String(m.uom || '').trim(),
      dateDelivered: rowDate, notes: 'Imported from MIS file',
    };
    const key = inventoryMovementKey(row, importDate);
    const already = existing.get(key);
    const fsId = inventoryFirestoreDocId(already || row);
    if (!queued.has(fsId)) {
      queued.add(fsId);
      const target = already || row;
      target._firestoreId = fsId;
      if (!already) { invRows.push(row); existing.set(key, row); }
      toSave.push(target);
    }
    rawForPM.push({ itemCode, description, supplier, unitCost: row.unitCost, rowDate });
    rawForPMFull.push({ itemCode, description, supplier, unitCost: row.unitCost, qty: row.qty, rowDate });
  });
  DB.set('inventory_movements', invRows);

  // 2) Write inventoryData (chunked, fresh batch per commit).
  let inserted = 0;
  for (let s = 0; s < toSave.length; s += FS_BATCH) {
    const chunk = toSave.slice(s, s + FS_BATCH);
    await commitFreshBatchWithRetry(() => {
      const batch = db.batch();
      chunk.forEach((r) => { const fr = { ...r }; delete fr._firestoreId; batch.set(db.collection('inventoryData').doc(r._firestoreId || inventoryFirestoreDocId(r)), fr, { merge: true }); });
      return batch;
    }, Math.min(s + chunk.length, toSave.length));
    inserted += chunk.length;
    if (onProgress) onProgress(inserted, toSave.length, `Saving inventory ${inserted}/${toSave.length}…`);
    await sleep(200);
  }

  // 3) Suppliers upsert (distinct names).
  const supByName = new Map();
  rawForPM.forEach((r) => { const n = r.supplier; const k = n.toLowerCase(); if (n && !supByName.has(k)) supByName.set(k, n); });
  const supList = [...supByName.values()];
  for (let s = 0; s < supList.length; s += FS_BATCH) {
    const chunk = supList.slice(s, s + FS_BATCH);
    await commitFreshBatchWithRetry(() => {
      const batch = db.batch();
      chunk.forEach((name) => batch.set(db.collection('suppliers').doc(supplierFirestoreDocId(name)),
        { id: supplierFirestoreDocId(name), name, category: '', address: '', contactPerson: '', phone: '', email: '', notes: '', status: 'Active' }, { merge: true }));
      return batch;
    }, Math.min(s + chunk.length, supList.length));
    await sleep(200);
  }

  // 4) Product Master sync (adds new item codes, appends cost history).
  let productsUpdated = 0;
  try {
    await loadProductMasterFromFirestore('', false);
    const existingProducts = productMasterRows().map(normalizeProductCostData);
    const byCode = new Map(existingProducts.map((p) => [String(p.itemCode || p.code || '').trim().toLowerCase(), p]).filter(([c]) => c));
    const changed = new Map();
    rawForPM.forEach((r) => {
      if (!r.itemCode || !(Number(r.unitCost) > 0)) return;
      const key = r.itemCode.toLowerCase();
      let p = byCode.get(key);
      const entry = { date: r.rowDate || importDate, unitCost: Number(r.unitCost), supplier: r.supplier };
      const hkey = `${entry.date}|${entry.unitCost}`;
      if (p) { if (p.costHistory.some((h) => `${h.date}|${Number(h.unitCost)}` === hkey)) { changed.set(key, p); return; } }
      else { p = normalizeProductCostData({ id: genId(), itemCode: r.itemCode, productName: r.description, category: 'Uncategorized', supplier: r.supplier, costHistory: [], status: 'Active' }); byCode.set(key, p); existingProducts.push(p); }
      p.costHistory.push(entry);
      const norm = normalizeProductCostData(p);
      Object.assign(p, norm, { productName: p.productName || r.description, supplier: r.supplier || p.supplier || '', lastUpdated: norm.latestDate });
      changed.set(key, p);
    });
    const toUpsert = [...changed.values()];
    await upsertProductMasterRowsInFirestore(toUpsert, () => {}, { batchSize: 200, commitBatch: (b) => b.commit(), delay: () => sleep(200) });
    cacheProductMasterRows(existingProducts);
    productsUpdated = toUpsert.length;
  } catch (e) { console.warn('Product Master sync failed:', e); }

  // 5) PER-DAY ROLLUPS + purchases totals + itemCost + uploads tracking.
  //    Consolidate in memory, then REPLACE each date's docs (idempotent).
  const byDate = new Map();  // date -> { items: Map(code -> {name,qty,unit_cost,total_cost}), totalQty, totalCost }
  const itemLatest = new Map(); // code -> { unit_cost, effective_date, name }
  rawForPMFull.forEach((r) => {
    const date = r.rowDate || importDate;
    if (!byDate.has(date)) byDate.set(date, { items: new Map(), totalQty: 0, totalCost: 0 });
    const day = byDate.get(date);
    let it = day.items.get(r.itemCode);
    if (!it) { it = { name: r.description, qty: 0, unit_cost: r.unitCost, total_cost: 0, supplier: r.supplier || '' }; day.items.set(r.itemCode, it); }
    it.qty += r.qty;
    if (r.unitCost > 0) it.unit_cost = r.unitCost;      // latest nonzero cost wins within the day
    it.total_cost = Math.round(it.qty * it.unit_cost * 100) / 100;
    if (r.name) it.name = r.description || it.name;
    if (r.supplier && !it.supplier) it.supplier = r.supplier;
    // latest-delivery-wins cost per item (across the whole file)
    const prev = itemLatest.get(r.itemCode);
    if (!prev || date >= prev.effective_date) itemLatest.set(r.itemCode, { unit_cost: r.unitCost, effective_date: date, name: r.description || (prev && prev.name) || '' });
  });

  const importDates = [...byDate.keys()].sort();
  let itemDays = 0;
  const dailyWrites = [];   // {ref, data}
  const purchaseWrites = [];
  byDate.forEach((day, date) => {
    const items = {};
    let dQty = 0, dCost = 0;
    day.items.forEach((it, code) => {
      const total = Math.round(it.qty * it.unit_cost * 100) / 100;
      items[code] = { name: it.name || '', qty: it.qty, unit_cost: it.unit_cost, total_cost: total, supplier: it.supplier || '' };
      dQty += it.qty; dCost += total; itemDays++;
    });
    dCost = Math.round(dCost * 100) / 100;
    dailyWrites.push({ date, data: { items, totals: { qty: dQty, total_cost: dCost }, lastUpdated: firebase.firestore.FieldValue.serverTimestamp() } });
    purchaseWrites.push({ date, data: { total_cost: dCost, qty: dQty, lastUpdated: firebase.firestore.FieldValue.serverTimestamp() } });
  });

  // SIZE GUARD: each inventoryDaily day-doc is ONE document (1 MiB cap). Fail fast
  // before any write if a single day would exceed ~900 KB.
  const INV_DOC_SOFT_LIMIT = 900 * 1024;
  for (const w of dailyWrites) {
    let bytes = 0;
    try { bytes = new Blob([JSON.stringify(w.data, (k, v) => (v && v._methodName ? 0 : v))]).size; }
    catch (e) { bytes = Object.keys(w.data.items || {}).length * 160; }
    if (bytes > INV_DOC_SOFT_LIMIT) {
      const count = Object.keys(w.data.items || {}).length;
      const err = new Error(`Day ${w.date} is too large to store in one document (${count.toLocaleString()} items, ~${Math.round(bytes / 1024)} KB; limit ~900 KB). Nothing was imported. Split this date into a smaller file.`);
      err.isDuplicateBlock = true;   // reuse the clean single-message render path
      throw err;
    }
  }

  // Idempotent REPLACE: write each inventoryDaily day-doc as its OWN commit — never
  // several large day-docs in one transaction (avoids "Transaction too big").
  const dailyWrittenDates = [];
  for (let i = 0; i < dailyWrites.length; i++) {
    const w = dailyWrites[i];
    try {
      await commitFreshBatchWithRetry(() => {
        const batch = db.batch();
        batch.set(db.collection('inventoryDaily').doc(w.date), w.data);
        return batch;
      }, i + 1);
    } catch (e) {
      const remaining = dailyWrites.slice(i).map((x) => x.date);
      const err = new Error(`Saving inventory stopped at ${w.date}: ${e.message}\nWritten OK: ${dailyWrittenDates.join(', ') || '(none)'}\nNOT written: ${remaining.join(', ')}\nNo upload record was saved. Delete/Replace the written date(s) if you retry.`);
      err.isDuplicateBlock = true;
      throw err;
    }
    dailyWrittenDates.push(w.date);
    await sleep(120);
  }
  for (let s = 0; s < purchaseWrites.length; s += FS_BATCH) {
    const chunk = purchaseWrites.slice(s, s + FS_BATCH);
    await commitFreshBatchWithRetry(() => {
      const batch = db.batch();
      chunk.forEach((w) => batch.set(db.collection('dailyPurchases').doc(w.date), w.data));
      return batch;
    }, Math.min(s + chunk.length, purchaseWrites.length));
    await sleep(150);
  }
  // itemCost: latest delivery wins.
  const itemCostList = [...itemLatest.entries()];
  for (let s = 0; s < itemCostList.length; s += FS_BATCH) {
    const chunk = itemCostList.slice(s, s + FS_BATCH);
    await commitFreshBatchWithRetry(() => {
      const batch = db.batch();
      chunk.forEach(([code, c]) => batch.set(db.collection('itemCost').doc(code), { unit_cost: c.unit_cost, effective_date: c.effective_date, name: c.name, lastUpdated: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }));
      return batch;
    }, Math.min(s + chunk.length, itemCostList.length));
    await sleep(150);
  }

  // 5b) COST-MATCH HOOK: newly-imported item costs backfill any sales that were
  //     uploaded first (cost-blind). Order-independent — inventory always wins.
  //     Reads salesDaily day-docs, applies itemLatest cost per item_code, writes
  //     cost/profit into products[code] and totals, and shrinks awaitingCost*.
  try {
    const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
    const costFor = (code) => {
      const c = itemLatest.get(code);
      return c && c.unit_cost > 0 ? c.unit_cost : null;
    };
    const salesSnap = await db.collection('salesDaily').get();
    const salesUpdates = [];
    salesSnap.forEach((doc) => {
      const data = doc.data() || {};
      const products = data.products || {};
      let changed = false;
      let tCost = 0, tProfit = 0, awItems = 0, awRevenue = 0;
      Object.keys(products).forEach((code) => {
        const p = products[code];
        const units = num(p.units), revenue = num(p.revenue);
        let uc = (p.unit_cost != null ? num(p.unit_cost) : null);
        if (uc == null || uc <= 0) {
          const nc = costFor(code);
          if (nc != null) { uc = nc; p.unit_cost = nc; changed = true; }
        }
        if (uc != null && uc > 0) {
          const cost = Math.round(units * uc * 100) / 100;
          const profit = Math.round((revenue - cost) * 100) / 100;
          p.cost = cost; p.profit = profit;
          tCost += cost; tProfit += profit;
        } else {
          awItems++; awRevenue += revenue;
        }
      });
      if (changed) {
        const totals = data.totals || {};
        totals.cost = Math.round(tCost * 100) / 100;
        totals.profit = Math.round(tProfit * 100) / 100;
        salesUpdates.push({ id: doc.id, data: {
          products, totals,
          awaitingCostItemCount: awItems,
          awaitingCostRevenue: Math.round(awRevenue * 100) / 100,
          lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
        } });
      }
    });
    let matched = 0;
    for (let s = 0; s < salesUpdates.length; s += FS_BATCH) {
      const chunk = salesUpdates.slice(s, s + FS_BATCH);
      await commitFreshBatchWithRetry(() => {
        const batch = db.batch();
        chunk.forEach((w) => batch.set(db.collection('salesDaily').doc(w.id), w.data, { merge: true }));
        return batch;
      }, Math.min(s + chunk.length, salesUpdates.length));
      await sleep(150);
    }
    matched = salesUpdates.length;
    if (matched > 0) { try { showToast(`✅ Matched costs into ${matched} sales day(s).`, 'success'); } catch (e) {} }
  } catch (e) { console.warn('sales cost-match failed:', e); }

  // uploads tracking record (one per import).
  try {
    await db.collection('uploads').add({
      type: 'inventory', dates: importDates,
      fileName: (typeof MIS_SOURCE_FILE !== 'undefined' && MIS_SOURCE_FILE) || '',
      rowCount: mappedRows.length, itemDays,
      uploadedBy: (typeof currentUserFullName === 'function' ? currentUserFullName() : (typeof getCurrentUser === 'function' ? getCurrentUser().username : '')) || 'Unknown',
      uploadedAt: new Date().toISOString(),
    });
  } catch (e) { console.warn('uploads record failed:', e); }

  try { logAudit('Import', 'MIS Inventory', `Imported ${inserted} raw rows, ${itemDays} item-days across ${importDates.length} dates, ${productsUpdated} products, ${supList.length} suppliers`); } catch (e) {}
  invTable.render(); renderSummary(); refreshInventoryAggregates();
  try { rematchUnderReview().then(({ moved }) => { if (moved > 0) showToast(`✅ ${moved} Under Review item(s) matched and moved to Sales Data!`, 'success'); }); } catch (e) {}

  return { inserted, summary: `${mappedRows.length.toLocaleString()} file rows → ${itemDays.toLocaleString()} item-days across ${importDates.length} date(s); ${supList.length.toLocaleString()} new suppliers.${zeroCost ? ` (${zeroCost} zero-cost skipped)` : ''}` };
}

document.getElementById('btn-import-mis').addEventListener('click', () => {
  if (typeof EPCImport === 'undefined') { resetMISModal(); openModal('modal-mis'); return; }
  EPCImport.openImportDialog({
    fieldSet: 'inventory_mis',
    title: 'Import Inventory (map columns)',
    skipDuplicateCheck: true,
    importer: misImportMappedRows,
    onDone: () => { invTable.render(); renderSummary(); },
  });
});
vsInit();
function watchInventoryProductMaster() {
  const db = getFirestoreDB();
  if (!db) return;
  db.collection('productMaster').onSnapshot(snapshot => {
    const rows = snapshot.docs.map(doc => normalizeProductCostData({ _firestoreId:doc.id, ...doc.data() }));
    cacheProductMasterRows(rows);
    invalidateInvSupplierMap();
    // Re-resolve supplier on already-loaded rollup rows now that PM is available.
    const movs = DB.get('inventory_movements') || [];
    let changed = false;
    movs.forEach((m) => {
      if (m._fromRollup && !m.supplier) {
        const s = inventorySupplierForCode(m.itemCode);
        if (s) { m.supplier = s; changed = true; }
      }
    });
    if (changed) DB.set('inventory_movements', movs);
    invTable.render();
  }, err => console.error('[Inventory] Product Master listener failed:', err));
}

// Load-on-demand: the movements table + KPIs start EMPTY and are filled only when
// the user sets the Date filter and clicks Generate — so opening the page costs
// almost nothing (no full-history scan). The Date column filter is the query window.
function seedInventoryDateFilter() {
  const now = new Date();
  const first = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  invTable.filters.dateDelivered = { from: first, to: last };
  // Reflect the default into the rendered date inputs.
  const cell = document.querySelector('#inv-thead .filter-row [data-col="dateDelivered"]');
  if (cell) {
    const inputs = cell.querySelectorAll('input[type="date"]');
    if (inputs[0]) inputs[0].value = first;
    if (inputs[1]) inputs[1].value = last;
  }
}

DB.set('inventory_movements', []);   // start empty; Generate fills it
Promise.all([
  loadSuppliersFromFirestore(),
  loadProductMasterFromFirestore()
])
  .then(() => {
    invTable.render();          // builds header + filter row + Generate button
    seedInventoryDateFilter();  // default the Date window to the current month
    renderSummary();            // shows blank KPIs until Generate
    watchInventoryProductMaster();
    generateInventory();        // auto-run once for the default month
  })
  .catch(err => console.error('[Inventory] Firestore load failed:', err));

// (end of MIS import section)

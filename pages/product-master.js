
initSidebar('product-master');

const PROD_CATS = ['Grains','Cooking Essentials','Condiments','Instant Food','Dairy & Eggs'];
const UOM_DEFAULTS = ['kg','g','L','mL','pack','piece','tray','box'];

let _pmSalesRows = [];
let _pmInventoryRows = [];
let _pmStockByCode = new Map();
let activeProductDetailId = '';
let productDetailPage = 1;
const PRODUCT_DETAIL_PAGE_SIZE = 100;

function initUOMDropdown(sel, selected) {
  const extras = DB.get('uom_extras');
  const all    = [...UOM_DEFAULTS, ...extras.filter(e => !UOM_DEFAULTS.includes(e))];
  sel.innerHTML = '<option value="">Select UOM…</option>' +
    all.map(u => `<option value="${u}"${u===selected?' selected':''}>${u}</option>`).join('') +
    '<option value="__add">+ Add UOM</option>';
  sel.addEventListener('change', function() {
    if (this.value === '__add') {
      const name = prompt('New unit of measure:');
      if (name && name.trim()) {
        extras.push(name.trim()); DB.set('uom_extras', extras);
        initUOMDropdown(sel, name.trim());
      } else { this.value = ''; }
    }
  });
}

function productCode(p) { return p.itemCode || p.code || ''; }
function productName(p) { return p.productName || p.name || ''; }
function productCategory(p) { return String(p.category || '').trim(); }
function productCost(p) { return p.latestCost ?? p.unitCost ?? p.cost ?? 0; }
function productLatestDate(p) { return p.latestDate || p.costHistory?.[p.costHistory.length - 1]?.date || ''; }
function productSupplier(p) { return p.supplier || ''; }
function productReorderPoint(p) { return p.reorderPoint || 0; }
function productCodeKey(value) { return String(value || '').trim().toLowerCase(); }
function emptyProductStock() { return { unitsIn: 0, inventoryOut: 0, unitsSold: 0, unitsOut: 0, onHand: 0 }; }
function ensureStockBucket(code) {
  const key = productCodeKey(code);
  if (!key) return emptyProductStock();
  if (!_pmStockByCode.has(key)) _pmStockByCode.set(key, emptyProductStock());
  return _pmStockByCode.get(key);
}
function rebuildProductStockIndex() {
  _pmStockByCode = new Map();
  _pmInventoryRows.forEach(row => {
    const bucket = ensureStockBucket(row.itemCode || row.code);
    const qty = Number(row.qty ?? row.quantity) || 0;
    if (String(row.type || '').toLowerCase() === 'incoming') bucket.unitsIn += qty;
    if (String(row.type || '').toLowerCase() === 'outgoing') bucket.inventoryOut += qty;
  });
  _pmSalesRows.forEach(row => {
    const bucket = ensureStockBucket(row.itemCode || row.code);
    bucket.unitsSold += Number(row.unitsSold ?? row.qty ?? row.quantity) || 0;
  });
  _pmStockByCode.forEach(bucket => {
    bucket.unitsOut = bucket.inventoryOut + bucket.unitsSold;
    bucket.onHand = bucket.unitsIn - bucket.unitsOut;
  });
}
function productStockMetrics(code) {
  const key = productCodeKey(code);
  return key ? (_pmStockByCode.get(key) || emptyProductStock()) : emptyProductStock();
}
function populateProductSupplierSelect(selected = '') {
  const msg = document.getElementById('p-supplier-empty');
  const suppliers = DB.get('suppliers');
  setSupplierPickerValue('p-supplier', selected || '');
  msg.style.display = suppliers.length ? 'none' : '';
}
function getProductMaster() {
  return getCachedProductMasterRows();
}
function setProductMaster(products) {
  cacheProductMasterRows(products);
  syncProductMasterToFirestore(products);
}
function cleanupProductMasterData(syncFirestore = true) {
  let products = getProductMaster();
  const before = products.length;
  products = products.filter(p => productCode(p).toString().trim() !== '');
  const seen = new Set();
  products = products.filter(p => {
    const code = productCode(p).toString().trim();
    if (seen.has(code)) return false;
    seen.add(code);
    if (!p.id) p.id = genId();
    Object.assign(p, normalizeProductCostData({ ...p, itemCode: code }));
    return true;
  });
  cacheProductMasterRows(products);
  if (before !== products.length) {
    if (syncFirestore) syncProductMasterToFirestore(products);
  }
}
function showPMToast(html, type = 'success', ms = 5000) {
  const prev = document.getElementById('pm-toast'); if (prev) prev.remove();
  const bg = type === 'success' ? '#16a34a' : type === 'warning' ? '#d97706' : '#1A56DB';
  const el = document.createElement('div');
  el.id = 'pm-toast';
  el.style.cssText = `position:fixed;bottom:24px;right:24px;background:${bg};color:white;
    padding:13px 18px;border-radius:10px;font-size:13.5px;font-weight:600;
    font-family:'Figtree',sans-serif;z-index:9999;max-width:390px;line-height:1.5;
    box-shadow:0 4px 20px rgba(0,0,0,0.18);cursor:pointer`;
  el.innerHTML = html;
  el.onclick = () => el.remove();
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; } }, ms - 300);
  setTimeout(() => { if (el.parentNode) el.remove(); }, ms);
}
function resetProdForm() {
  document.getElementById('prod-edit-id').value = '';
  document.getElementById('modal-prod-title').textContent = 'Add Product';
  ['p-code','p-name','p-notes'].forEach(id => document.getElementById(id).value='');
  document.getElementById('p-cost').value    = '';
  document.getElementById('p-reorder').value = '';
  initCatDropdown(document.getElementById('p-category'), 'prod', PROD_CATS);
  initUOMDropdown(document.getElementById('p-uom'), '');
  populateProductSupplierSelect('');
}

const PROD_TABLE = {
  sortKey: null,
  sortDir: 'asc',
  filters: { code:'', name:'', category:'', uom:'', costMin:'', costMax:'', supplier:'', reorderMin:'', reorderMax:'', status:'' },
  rows: [],
  filteredRows: [],
  page: 1,
  pageSize: 100,
  selected: new Set(),
};
let pendingProductDeleteIds = [];
let productDeleteInProgress = false;

const PROD_COLUMNS = [
  { key:'select', label:'<input type="checkbox" id="prod-select-all" aria-label="Select all visible products" onchange="toggleAllVisibleProducts(this.checked)">', sortable:false },
  { key:'code', label:'Item Code' },
  { key:'name', label:'Product Name' },
  { key:'category', label:'Category' },
  { key:'uom', label:'UOM' },
  { key:'unitsIn', label:'Units In' },
  { key:'unitsSold', label:'Units Sold' },
  { key:'onHand', label:'Units On Hand' },
  { key:'cost', label:'Latest Cost' },
  { key:'latestDate', label:'Last Updated' },
  { key:'supplier', label:'Supplier' },
  { key:'reorder', label:'Reorder Pt.' },
  { key:'status', label:'Status' },
  { key:'actions', label:'Actions', sortable:false },
];

function productStatus(p) { return p.status || 'Active'; }

function sortValue(p, key) {
  if (key === 'code') return productCode(p);
  if (key === 'name') return productName(p);
  if (key === 'category') return productCategory(p);
  if (key === 'uom') return p.uom || '';
  if (key === 'unitsIn') return productStockMetrics(productCode(p)).unitsIn;
  if (key === 'unitsSold') return productStockMetrics(productCode(p)).unitsSold;
  if (key === 'onHand') return productStockMetrics(productCode(p)).onHand;
  if (key === 'cost') return productCost(p);
  if (key === 'latestDate') return productLatestDate(p);
  if (key === 'supplier') return productSupplier(p);
  if (key === 'reorder') return productReorderPoint(p);
  if (key === 'status') return productStatus(p);
  return '';
}

function renderSummary(rows = getProductMaster()) {
  const prods     = rows;
  const totalVal  = prods.reduce((s,p) => s+productCost(p), 0);
  const totalOnHand = prods.reduce((sum, p) => sum + productStockMetrics(productCode(p)).onHand, 0);
  document.getElementById('prod-summary').innerHTML = `
    <div class="summary-card"><div class="kpi-label">Total Products</div><div class="kpi-value">${prods.length}</div></div>
    <div class="summary-card"><div class="kpi-label">Units On Hand</div><div class="kpi-value">${totalOnHand.toLocaleString()}</div></div>
    <div class="summary-card"><div class="kpi-label">Total Unit Cost Value</div><div class="kpi-value">${formatPeso(totalVal)}</div></div>`;
}

function renderProductHeaders() {
  document.getElementById('prod-header-row').innerHTML = PROD_COLUMNS.map(col => {
    const sortable = col.sortable !== false;
    const active = PROD_TABLE.sortKey === col.key;
    const icon = active ? (PROD_TABLE.sortDir === 'asc' ? '↑' : '↓') : '⇅';
    return `<th ${sortable ? `class="sortable${active ? ' is-sorted' : ''}" onclick="setProductSort('${col.key}')"` : ''}>
      <span class="th-label">${col.label}</span>${sortable ? `<span class="sort-icon ${active ? 'sort-active' : ''}">${icon}</span>` : ''}
    </th>`;
  }).join('');

  const cats = [...new Set(getProductMaster().map(productCategory).filter(Boolean))].sort();
  document.getElementById('prod-filter-row').innerHTML = `
    <th class="filter-cell-empty select-col"></th>
    <th class="filter-cell"><input class="col-filter" type="text" value="${PROD_TABLE.filters.code}" oninput="setProductFilter('code', this.value)" placeholder="Filter…"></th>
    <th class="filter-cell"><input class="col-filter" type="text" value="${PROD_TABLE.filters.name}" oninput="setProductFilter('name', this.value)" placeholder="Filter…"></th>
    <th class="filter-cell"><select class="col-filter" onchange="setProductFilter('category', this.value)">
      <option value="">All</option>
      <option value="__missing"${PROD_TABLE.filters.category==='__missing'?' selected':''}>Missing</option>
      ${cats.map(c => `<option value="${c}"${PROD_TABLE.filters.category===c?' selected':''}>${c}</option>`).join('')}
    </select></th>
    <th class="filter-cell"><input class="col-filter" type="text" value="${PROD_TABLE.filters.uom}" oninput="setProductFilter('uom', this.value)" placeholder="Filter…"></th>
    <th class="filter-cell-empty"></th>
    <th class="filter-cell-empty"></th>
    <th class="filter-cell-empty"></th>
    <th class="filter-cell"><div class="col-filter-range">
      <input class="col-filter" type="number" value="${PROD_TABLE.filters.costMin}" oninput="setProductFilter('costMin', this.value)" placeholder="Min" min="0" step="any">
      <span class="range-sep">–</span>
      <input class="col-filter" type="number" value="${PROD_TABLE.filters.costMax}" oninput="setProductFilter('costMax', this.value)" placeholder="Max" min="0" step="any">
    </div></th>
    <th class="filter-cell-empty"></th>
    <th class="filter-cell"><input class="col-filter" type="text" value="${PROD_TABLE.filters.supplier}" oninput="setProductFilter('supplier', this.value)" placeholder="Filter…"></th>
    <th class="filter-cell"><div class="col-filter-range">
      <input class="col-filter" type="number" value="${PROD_TABLE.filters.reorderMin}" oninput="setProductFilter('reorderMin', this.value)" placeholder="Min" min="0" step="any">
      <span class="range-sep">–</span>
      <input class="col-filter" type="number" value="${PROD_TABLE.filters.reorderMax}" oninput="setProductFilter('reorderMax', this.value)" placeholder="Max" min="0" step="any">
    </div></th>
    <th class="filter-cell"><select class="col-filter" onchange="setProductFilter('status', this.value)">
      <option value="">All</option>
      <option value="Active"${PROD_TABLE.filters.status==='Active'?' selected':''}>Active</option>
      <option value="Inactive"${PROD_TABLE.filters.status==='Inactive'?' selected':''}>Inactive</option>
    </select></th>
    <th class="filter-cell-empty"></th>`;
}

function setProductSort(key) {
  if (PROD_TABLE.sortKey === key) PROD_TABLE.sortDir = PROD_TABLE.sortDir === 'asc' ? 'desc' : 'asc';
  else { PROD_TABLE.sortKey = key; PROD_TABLE.sortDir = 'asc'; }
  renderTable();
}

function setProductFilter(key, value) {
  PROD_TABLE.filters[key] = value;
  PROD_TABLE.page = 1;
  renderTable();
}

function clearProductFilters() {
  Object.keys(PROD_TABLE.filters).forEach(k => PROD_TABLE.filters[k] = '');
  document.getElementById('search-prod').value = '';
  PROD_TABLE.page = 1;
  renderTable();
}

function syncProductSelectionUI() {
  const products = getProductMaster();
  const existingIds = new Set(products.map(p => p.id));
  [...PROD_TABLE.selected].forEach(id => { if (!existingIds.has(id)) PROD_TABLE.selected.delete(id); });
  const visibleIds = PROD_TABLE.rows.map(p => p.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => PROD_TABLE.selected.has(id));
  const someVisibleSelected = visibleIds.some(id => PROD_TABLE.selected.has(id));

  document.querySelectorAll('.pm-row-select').forEach(cb => {
    cb.checked = PROD_TABLE.selected.has(cb.value);
  });

  const master = document.getElementById('prod-select-all');
  if (master) {
    master.checked = allVisibleSelected;
    master.indeterminate = !allVisibleSelected && someVisibleSelected;
    master.disabled = visibleIds.length === 0;
  }

  const count = PROD_TABLE.selected.size;
  document.getElementById('prod-bulk-bar').classList.toggle('open', count > 0);
  document.getElementById('prod-bulk-count').textContent = `${count} item${count === 1 ? '' : 's'} selected`;

  const allProductsSelected = products.length > 0 && count === products.length;
  const canSelectAll = allVisibleSelected && products.length > visibleIds.length && !allProductsSelected;
  document.getElementById('pm-select-all-banner').classList.toggle('open', canSelectAll);
  if (canSelectAll) {
    document.getElementById('pm-select-page-message').textContent =
      `${visibleIds.length} item${visibleIds.length === 1 ? '' : 's'} on this page are selected.`;
    document.getElementById('btn-select-all-products').textContent =
      `Select all ${products.length.toLocaleString()} items in Product Master`;
  }
}

function toggleProductSelection(id, checked) {
  if (checked) PROD_TABLE.selected.add(id);
  else PROD_TABLE.selected.delete(id);
  syncProductSelectionUI();
}

function toggleAllVisibleProducts(checked) {
  PROD_TABLE.rows.forEach(p => {
    if (checked) PROD_TABLE.selected.add(p.id);
    else PROD_TABLE.selected.delete(p.id);
  });
  syncProductSelectionUI();
}

function clearProductSelection() {
  PROD_TABLE.selected.clear();
  syncProductSelectionUI();
}

function selectAllProducts() {
  getProductMaster().forEach(product => PROD_TABLE.selected.add(product.id));
  syncProductSelectionUI();
}

function deleteSelectedProducts() {
  openProductDeleteModal([...PROD_TABLE.selected]);
}

function openProductDeleteModal(ids) {
  if (productDeleteInProgress) return;
  const existingIds = new Set(getProductMaster().map(product => product.id));
  pendingProductDeleteIds = [...new Set(ids)].filter(id => existingIds.has(id));
  if (!pendingProductDeleteIds.length) return;
  const count = pendingProductDeleteIds.length;
  document.getElementById('delete-products-title').textContent =
    `Delete ${count.toLocaleString()} item${count === 1 ? '' : 's'}?`;
  setProductDeleteModalBusy(false);
  openModal('modal-delete-products');
}

function closeProductDeleteModal() {
  if (productDeleteInProgress) return;
  pendingProductDeleteIds = [];
  setProductDeleteModalBusy(false);
  closeModal('modal-delete-products');
}

function setProductDeleteModalBusy(isBusy, label = 'Delete') {
  productDeleteInProgress = isBusy;
  document.getElementById('btn-close-delete-products').disabled = isBusy;
  document.getElementById('btn-cancel-delete-products').disabled = isBusy;
  const confirmButton = document.getElementById('btn-confirm-delete-products');
  confirmButton.disabled = isBusy;
  confirmButton.innerHTML = label;
}

function productDeleteProgressLabel(percent) {
  return `<span class="pm-spinner"></span>Deleting... ${percent}%`;
}

async function deleteProductMasterRows(ids, onProgress) {
  const selectedIds = new Set(ids);
  const products = getProductMaster().filter(product => selectedIds.has(product.id));
  const firestoreIds = new Set(products.map(product => product._firestoreId).filter(Boolean));
  const codes = new Set(products
    .map(product => String(productCode(product)).trim().toLowerCase())
    .filter(Boolean));
  const db = getFirestoreDB();
  if (!db) throw new Error('Database unavailable.');

  const snapshot = await db.collection('productMaster').get();
  const documents = snapshot.docs.filter(doc => {
    const data = doc.data();
    const code = String(data.itemCode || data.code || '').trim().toLowerCase();
    return firestoreIds.has(doc.id) || codes.has(code);
  });
  if (!documents.length) {
    onProgress(100);
    return;
  }

  const batchSize = 499;
  const totalBatches = Math.ceil(documents.length / batchSize);
  for (let start = 0; start < documents.length; start += batchSize) {
    const batch = db.batch();
    documents.slice(start, start + batchSize).forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    const completed = Math.min(totalBatches, Math.floor(start / batchSize) + 1);
    onProgress(Math.round((completed / totalBatches) * 100));
  }
}

async function confirmProductDelete() {
  const ids = [...pendingProductDeleteIds];
  if (!ids.length || productDeleteInProgress) return;
  setProductDeleteModalBusy(true, productDeleteProgressLabel(0));
  try {
    await deleteProductMasterRows(ids, percent => {
      document.getElementById('btn-confirm-delete-products').innerHTML = productDeleteProgressLabel(percent);
    });
    const deletedIds = new Set(ids);
    cacheProductMasterRows(getProductMaster().filter(product => !deletedIds.has(product.id)));
    PROD_TABLE.selected.clear();
    document.getElementById('btn-confirm-delete-products').textContent = '✓ Deleted!';
    await new Promise(resolve => setTimeout(resolve, 1000));
    productDeleteInProgress = false;
    closeProductDeleteModal();
    PROD_TABLE.page = 1;
    renderTable();
    checkMissingCategories();
    showPMToast(`${ids.length.toLocaleString()} item${ids.length === 1 ? '' : 's'} deleted from Product Master.`, 'success');
    logAudit('Delete', 'Product Master',
      `Deleted ${ids.length.toLocaleString()} product${ids.length === 1 ? '' : 's'}`);
  } catch (error) {
    console.error('[Product Master] Delete failed:', error);
    alert('Unable to delete the selected products. Please try again.');
    setProductDeleteModalBusy(false);
  }
}

function productFiltersActive() {
  return document.getElementById('search-prod').value.trim() ||
    Object.values(PROD_TABLE.filters).some(v => String(v).trim() !== '');
}

function getFilteredProducts() {
  const q = document.getElementById('search-prod').value.trim().toLowerCase();
  const f = PROD_TABLE.filters;
  let rows = getProductMaster().filter(p => {
    const code = productCode(p);
    const name = productName(p);
    const cat = productCategory(p);
    const cost = productCost(p);
    const reorder = productReorderPoint(p);
    const supplier = productSupplier(p);
    const status = productStatus(p);
    if (q && ![code, name, cat, supplier].some(v => String(v || '').toLowerCase().includes(q))) return false;
    if (f.code && !code.toLowerCase().includes(f.code.toLowerCase())) return false;
    if (f.name && !name.toLowerCase().includes(f.name.toLowerCase())) return false;
    if (f.category === '__missing' && cat) return false;
    if (f.category && f.category !== '__missing' && cat !== f.category) return false;
    if (f.uom && !String(p.uom || '').toLowerCase().includes(f.uom.toLowerCase())) return false;
    if (f.costMin !== '' && cost < Number(f.costMin)) return false;
    if (f.costMax !== '' && cost > Number(f.costMax)) return false;
    if (f.supplier && !supplier.toLowerCase().includes(f.supplier.toLowerCase())) return false;
    if (f.reorderMin !== '' && reorder < Number(f.reorderMin)) return false;
    if (f.reorderMax !== '' && reorder > Number(f.reorderMax)) return false;
    if (f.status && status !== f.status) return false;
    return true;
  });

  if (PROD_TABLE.sortKey) {
    const dir = PROD_TABLE.sortDir === 'asc' ? 1 : -1;
    rows = rows.slice().sort((a,b) => {
      const va = sortValue(a, PROD_TABLE.sortKey);
      const vb = sortValue(b, PROD_TABLE.sortKey);
      let cmp = 0;
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
      else cmp = String(va || '').localeCompare(String(vb || ''));
      return cmp * dir;
    });
  }
  return rows;
}

function productPageCount(total) {
  return Math.max(1, Math.ceil(total / PROD_TABLE.pageSize));
}

function productPageButtons(current, totalPages) {
  const pages = new Set([1, totalPages, current - 1, current, current + 1]);
  if (current <= 2) pages.add(3);
  if (current >= totalPages - 1) pages.add(totalPages - 2);
  return [...pages]
    .filter(p => p >= 1 && p <= totalPages)
    .sort((a,b) => a - b);
}

function setProductPage(page) {
  PROD_TABLE.page = Math.min(Math.max(1, page), productPageCount(PROD_TABLE.filteredRows.length));
  renderTable();
}

function renderProductPagination(total) {
  const totalPages = productPageCount(total);
  const start = total === 0 ? 0 : (PROD_TABLE.page - 1) * PROD_TABLE.pageSize + 1;
  const end = Math.min(PROD_TABLE.page * PROD_TABLE.pageSize, total);
  const pageButtons = productPageButtons(PROD_TABLE.page, totalPages);
  let last = 0;
  const controls = pageButtons.map(page => {
    const gap = page - last > 1 ? '<span class="page-ellipsis">…</span>' : '';
    last = page;
    return `${gap}<button class="page-btn ${page === PROD_TABLE.page ? 'active' : ''}" onclick="setProductPage(${page})">${page}</button>`;
  }).join('');

  document.getElementById('prod-pagination').innerHTML = `
    <div class="pagination-info">Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} products</div>
    <div class="pagination-controls">
      <button class="page-btn" onclick="setProductPage(${PROD_TABLE.page - 1})" ${PROD_TABLE.page <= 1 ? 'disabled' : ''}>‹ Prev</button>
      ${controls}
      <button class="page-btn" onclick="setProductPage(${PROD_TABLE.page + 1})" ${PROD_TABLE.page >= totalPages ? 'disabled' : ''}>Next ›</button>
    </div>`;
}

function renderTable() {
  renderProductHeaders();
  let filteredRows = getFilteredProducts();
  PROD_TABLE.filteredRows = filteredRows;
  PROD_TABLE.page = Math.min(PROD_TABLE.page, productPageCount(filteredRows.length));
  const start = (PROD_TABLE.page - 1) * PROD_TABLE.pageSize;
  const rows = filteredRows.slice(start, start + PROD_TABLE.pageSize);
  PROD_TABLE.rows = rows;
  document.getElementById('btn-clear-prod-filters').style.display = productFiltersActive() ? '' : 'none';
  renderSummary(getProductMaster());
  renderProductPagination(filteredRows.length);

  const tbody = document.getElementById('prod-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="14"><div class="empty-state"><div class="empty-icon">📦</div><p>No products yet. Click "Add Product" to get started.</p></div></td></tr>';
    syncProductSelectionUI();
    return;
  }
  tbody.innerHTML = rows.map(p => {
    const code       = productCode(p);
    const name       = productName(p);
    const cat        = productCategory(p);
    const cost       = productCost(p);
    const reorder    = productReorderPoint(p);
    const stock      = productStockMetrics(code);
    const isLowStock = reorder > 0 && stock.onHand <= reorder;
    const status     = isLowStock ? 'badge-red' : 'badge-green';
    const statusLabel= isLowStock ? 'Low Stock' : (p.status || 'Active');
    const missingCat = !cat;
    const trClass    = missingCat ? ' class="pm-missing-cat"' : '';
    const catCell    = missingCat
      ? `<span class="badge badge-amber" style="font-size:10px;vertical-align:middle;margin-right:5px">Missing</span><button class="btn btn-outline btn-xs pm-edit-btn" type="button" data-id="${p.id}">Edit</button>`
      : cat;
    return `<tr data-prod-id="${p.id}"${trClass}>
      <td class="select-col"><input type="checkbox" class="pm-row-select" value="${p.id}" aria-label="Select product" onchange="toggleProductSelection('${p.id}', this.checked)"></td>
      <td class="mono"><strong>${code}</strong></td>
      <td>${name}</td>
      <td class="cat-cell">${catCell}</td>
      <td class="mono">${p.uom||'—'}</td>
      <td class="mono">${stock.unitsIn.toLocaleString()}</td>
      <td class="mono">${stock.unitsSold.toLocaleString()}</td>
      <td class="mono"><strong>${stock.onHand.toLocaleString()}</strong></td>
      <td class="mono">${formatPeso(cost)}</td>
      <td>${productLatestDate(p) ? formatDate(productLatestDate(p)) : '—'}</td>
      <td>${productSupplier(p)||'—'}</td>
      <td class="mono">${reorder||'—'}</td>
      <td><span class="badge ${status}">${statusLabel}</span></td>
      <td>
        <div class="action-btns">
          <button class="btn btn-outline btn-xs pm-edit-btn" type="button" data-id="${p.id}">Edit</button>
          <button class="btn btn-danger btn-xs pm-delete-btn" type="button" data-id="${p.id}">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  syncProductSelectionUI();
}

function exportProductsCSV() {
  const rows = getFilteredProducts();
  exportRowsToCSV(`product-master-${todayISO()}.csv`, [
    { label:'Item Code', value: productCode },
    { label:'Product Name', value: productName },
    { label:'Category', value: row => productCategory(row) || 'Uncategorized' },
    { label:'UOM', value: row => row.uom || '' },
    { label:'Units In', value: row => productStockMetrics(productCode(row)).unitsIn },
    { label:'Units Sold', value: row => productStockMetrics(productCode(row)).unitsSold },
    { label:'Units On Hand', value: row => productStockMetrics(productCode(row)).onHand },
    { label:'Latest Cost', value: productCost },
    { label:'Last Updated', value: row => csvDate(productLatestDate(row)) },
    { label:'Supplier', value: productSupplier },
    { label:'Reorder Point', value: productReorderPoint },
    { label:'Status', value: productStatus },
  ], rows);
  alert(`${rows.length.toLocaleString()} product records exported to CSV.`);
}

// After a PM category update, push the new category to every matching salesData doc in the background.
// Matches on salesData.itemCode === itemCode (exact string, no normalization).
async function syncSalesDataCategoryInBackground(itemCode, category) {
  const fsdb = getFirestoreDB();
  if (!fsdb || !itemCode) return;
  try {
    const snap = await fsdb.collection('salesData').where('itemCode', '==', itemCode).get();
    if (snap.empty) return;
    const BATCH_SIZE = 200;
    for (let i = 0; i < snap.docs.length; i += BATCH_SIZE) {
      const batch = fsdb.batch();
      snap.docs.slice(i, i + BATCH_SIZE).forEach(doc => batch.update(doc.ref, { category }));
      await batch.commit();
    }
  } catch (err) {
    console.error('[PM] salesData category sync failed:', err);
  }
}

async function syncInventoryAssignmentInBackground(itemCode, supplier, category) {
  const code = String(itemCode || '').trim();
  if (!code) return;

  const rows = DB.get('inventory_movements');
  rows.forEach(row => {
    if (String(row.itemCode || '').trim() === code) Object.assign(row, { supplier, category });
  });
  DB.set('inventory_movements', rows);

  const fsdb = getFirestoreDB();
  if (!fsdb) return;
  const snap = await fsdb.collection('inventoryData').where('itemCode', '==', code).get();
  const BATCH_SIZE = 200;
  for (let start = 0; start < snap.docs.length; start += BATCH_SIZE) {
    const batch = fsdb.batch();
    snap.docs.slice(start, start + BATCH_SIZE)
      .forEach(doc => batch.update(doc.ref, { supplier, category }));
    await batch.commit();
  }
}

async function saveProduct() {
  const code = document.getElementById('p-code').value.trim();
  const name = document.getElementById('p-name').value.trim();
  const cat  = document.getElementById('p-category').value;
  const uom  = document.getElementById('p-uom').value;
  const cost = parsePeso(document.getElementById('p-cost').value);
  const supplier = document.getElementById('p-supplier').value;

  const editId = document.getElementById('prod-edit-id').value;
  const products = getProductMaster();
  const existing = editId ? products.find(p=>p.id===editId) : null;
  if (!code||!name||!cost) { alert('Item Code, Product Name, and Unit Cost are required.'); return; }
  const codeConflict = products.find(p=>productCode(p)===code && p.id!==editId);
  if (codeConflict) { alert(`Item code "${code}" already exists.`); return; }

  const oldCategory = existing ? productCategory(existing) : null;
  const categoryChanged = editId && cat !== oldCategory;
  const changedFields = [];
  if (existing && productName(existing) !== name) {
    changedFields.push(`name: ${productName(existing)} -> ${name}`);
  }
  if (existing && oldCategory !== cat) {
    changedFields.push(`category: ${oldCategory || 'Uncategorized'} -> ${cat || 'Uncategorized'}`);
  }
  if (existing && productSupplier(existing) !== supplier) {
    changedFields.push(`supplier: ${productSupplier(existing) || 'none'} -> ${supplier || 'none'}`);
  }

  const costHistory = [...(existing?.costHistory || [])];
  if (!existing || Number(productCost(existing)) !== Number(cost)) {
    costHistory.push({ date: todayISO(), unitCost: cost, supplier });
  }
  const record = normalizeProductCostData({ code, itemCode:code, name, productName:name, category:cat, uom: uom || existing?.uom || '', cost, unitCost:cost, latestCost:cost, costHistory, srp:0,
    supplier,
    reorderPoint:parseInt(document.getElementById('p-reorder').value)||0,
    status:'Active',
    notes:document.getElementById('p-notes').value });

  if (editId) {
    const idx = products.findIndex(p => p.id === editId);
    if (idx !== -1) products[idx] = { ...products[idx], ...record };
  } else {
    record.id = genId();
    products.push(record);
  }
  // Update local cache only — Firestore write is done below with a targeted field-query upsert
  // so we never trigger the full delete+replace cycle that would wipe docs from other pages.
  cacheProductMasterRows(products);

  closeModal('modal-product');
  renderTable(); checkMissingCategories();

  // Targeted Firestore upsert: find doc by itemCode field, update in-place or create new
  const fsdb = getFirestoreDB();
  if (fsdb) {
    try {
      const pmSnap = await fsdb.collection('productMaster')
        .where('itemCode', '==', String(code).trim())
        .limit(1)
        .get();
      const firestoreRecord = cleanFirestoreProduct(record);
      if (!pmSnap.empty) {
        await pmSnap.docs[0].ref.update(firestoreRecord);
      } else {
        await fsdb.collection('productMaster').add({
          ...firestoreRecord,
          itemCode: String(code).trim()
        });
      }
    } catch (err) {
      console.error('[Product Master] Firestore upsert failed:', err);
    }
  }

  // Background: push the new category to all matching salesData docs
  if (categoryChanged && code && cat) {
    syncSalesDataCategoryInBackground(code, cat);
  }
  try {
    await syncInventoryAssignmentInBackground(code, supplier, cat);
  } catch (err) {
    console.error('[PM] Inventory assignment sync failed:', err);
    alert('Product saved, but matching inventory rows could not be updated. Please try saving again.');
  }
  logAudit(editId ? 'Edit' : 'Create', 'Product Master',
    `${editId ? 'Edited' : 'Added'} product ${code}${changedFields.length ? ' - ' + changedFields.join(', ') : ''}`);

  // For new products only: re-match any Under Review items that now have a PM record
  if (!editId) {
    rematchUnderReview()
      .then(({ moved }) => {
        if (moved > 0) {
          showPMToast(
            `✅ ${moved} Under Review item${moved > 1 ? 's' : ''} matched and moved to Sales Data!`,
            'success'
          );
        }
      })
      .catch(err => console.error('[rematchUnderReview] Error:', err));
  }
}

function editProd(id) {
  const p = getProductMaster().find(x=>x.id===id);
  if (!p) return;
  document.getElementById('prod-edit-id').value = p.id;
  document.getElementById('modal-prod-title').textContent = 'Edit Product';
  document.getElementById('p-code').value    = productCode(p);
  document.getElementById('p-name').value    = productName(p);
  document.getElementById('p-cost').value    = formatNum(productCost(p));
  document.getElementById('p-reorder').value = productReorderPoint(p)||'';
  document.getElementById('p-notes').value   = p.notes||'';
  initCatDropdown(document.getElementById('p-category'), 'prod', PROD_CATS);
  document.getElementById('p-category').value = productCategory(p);
  initUOMDropdown(document.getElementById('p-uom'), p.uom);
  populateProductSupplierSelect(productSupplier(p));
  openModal('modal-product');
}

function deleteProd(id) {
  openProductDeleteModal([id]);
}

function handleProductTableClick(e) {
  const editBtn = e.target.closest('.pm-edit-btn');
  if (editBtn) {
    e.preventDefault();
    e.stopPropagation();
    editProd(editBtn.dataset.id);
    return;
  }
  const deleteBtn = e.target.closest('.pm-delete-btn');
  if (deleteBtn) {
    e.preventDefault();
    e.stopPropagation();
    deleteProd(deleteBtn.dataset.id);
    return;
  }
  if (e.target.closest('input, button, a, select')) return;
  const row = e.target.closest('[data-prod-id]');
  if (row) openProductDetail(row.dataset.prodId);
}

function pmEsc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pagedProductDetailRows(rows) {
  const totalPages = Math.max(1, Math.ceil(rows.length / PRODUCT_DETAIL_PAGE_SIZE));
  productDetailPage = Math.min(Math.max(1, productDetailPage), totalPages);
  const start = (productDetailPage - 1) * PRODUCT_DETAIL_PAGE_SIZE;
  return {
    totalPages,
    start,
    end: Math.min(start + PRODUCT_DETAIL_PAGE_SIZE, rows.length),
    rows: rows.slice(start, start + PRODUCT_DETAIL_PAGE_SIZE)
  };
}

function productDetailPaginationHtml(totalRows, totalPages, start, end) {
  if (!totalRows || totalPages <= 1) {
    return `<div class="pagination-info">Showing ${totalRows ? '1' : '0'}–${totalRows.toLocaleString()} of ${totalRows.toLocaleString()} history rows</div>`;
  }
  return `
    <div class="pagination-bar pm-detail-pagination">
      <div class="pagination-info">Showing ${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${totalRows.toLocaleString()} history rows</div>
      <div class="pagination-controls">
        <button class="page-btn" onclick="setProductDetailPage(${productDetailPage - 1})" ${productDetailPage <= 1 ? 'disabled' : ''}>‹ Prev</button>
        <span class="pagination-info">Page ${productDetailPage.toLocaleString()} of ${totalPages.toLocaleString()}</span>
        <button class="page-btn" onclick="setProductDetailPage(${productDetailPage + 1})" ${productDetailPage >= totalPages ? 'disabled' : ''}>Next ›</button>
      </div>
    </div>`;
}

function setProductDetailPage(page) {
  productDetailPage = Math.max(1, page);
  renderProductDetailView();
}

function showProductCatalogView() {
  activeProductDetailId = '';
  productDetailPage = 1;
  document.getElementById('product-catalog-view').style.display = '';
  document.getElementById('product-detail-view').style.display = 'none';
  document.getElementById('pm-tab-catalog').classList.add('active');
  document.getElementById('pm-tab-detail').classList.remove('active');
  document.getElementById('pm-tab-detail').textContent = 'Product Detail';
}

function openProductDetail(id) {
  activeProductDetailId = id;
  productDetailPage = 1;
  renderProductDetailView();
}

function renderProductDetailView() {
  const id = activeProductDetailId;
  const product = getProductMaster().find(p => p.id === id);
  if (!product) {
    showProductCatalogView();
    return;
  }
  const normalized = normalizeProductCostData(product);
  const stock = productStockMetrics(productCode(normalized));
  const history = [...normalized.costHistory].sort((a, b) => b.date.localeCompare(a.date));
  const paged = pagedProductDetailRows(history);
  document.getElementById('product-catalog-view').style.display = 'none';
  document.getElementById('product-detail-view').style.display = '';
  document.getElementById('pm-tab-catalog').classList.remove('active');
  document.getElementById('pm-tab-detail').classList.add('active');
  document.getElementById('pm-tab-detail').textContent = productName(normalized) || productCode(normalized) || 'Product Detail';
  document.getElementById('pm-detail-page-title').textContent = productName(normalized) || 'Product Detail';
  document.getElementById('pm-detail-page-body').innerHTML = `
    <div class="pm-detail-grid">
      <div><span>Item Code</span><strong class="mono">${pmEsc(productCode(normalized))}</strong></div>
      <div><span>Category</span><strong>${pmEsc(productCategory(normalized)) || '—'}</strong></div>
      <div class="pm-latest-cost"><span>Latest Cost</span><strong>${formatPeso(normalized.latestCost)}</strong></div>
      <div><span>Last Updated</span><strong>${normalized.latestDate ? formatDate(normalized.latestDate) : '—'}</strong></div>
      <div><span>Units In</span><strong class="mono">${stock.unitsIn.toLocaleString()}</strong></div>
      <div><span>Units Sold</span><strong class="mono">${stock.unitsSold.toLocaleString()}</strong></div>
      <div><span>Inventory Released</span><strong class="mono">${stock.inventoryOut.toLocaleString()}</strong></div>
      <div><span>Units On Hand</span><strong class="mono">${stock.onHand.toLocaleString()}</strong></div>
    </div>
    <div class="pm-history-wrap">
      <table>
        <thead><tr><th>Date</th><th>Unit Cost</th><th>Supplier</th></tr></thead>
        <tbody>${paged.rows.length
          ? paged.rows.map(entry => `<tr><td>${formatDate(entry.date)}</td><td class="mono">${formatPeso(entry.unitCost)}</td><td>${pmEsc(entry.supplier) || '—'}</td></tr>`).join('')
          : '<tr><td colspan="3">No cost history yet.</td></tr>'}</tbody>
      </table>
    </div>
    ${productDetailPaginationHtml(history.length, paged.totalPages, paged.start, paged.end)}
    <div class="pm-average-cost">Average Cost <strong>${formatPeso(normalized.averageCost)}</strong></div>`;
}

function openProductFromURL() {
  const requestedCode = String(new URLSearchParams(window.location.search).get('itemCode') || '').trim();
  if (!requestedCode) return;
  const lowerCode = requestedCode.toLowerCase();
  const product = getProductMaster().find(item =>
    String(productCode(item) || '').trim().toLowerCase() === lowerCode);
  if (!product) return;

  Object.keys(PROD_TABLE.filters).forEach(key => PROD_TABLE.filters[key] = '');
  document.getElementById('search-prod').value = requestedCode;
  const filtered = getFilteredProducts();
  const index = filtered.findIndex(item => item.id === product.id);
  PROD_TABLE.page = Math.max(1, Math.floor(Math.max(0, index) / PROD_TABLE.pageSize) + 1);
  renderTable();

  const row = [...document.querySelectorAll('#prod-tbody tr[data-prod-id]')]
    .find(element => element.dataset.prodId === String(product.id));
  if (row) {
    row.classList.add('pm-url-highlight');
    row.scrollIntoView({ behavior:'smooth', block:'center' });
  }
  openProductDetail(product.id);
}

function checkMissingCategories() {
  const missing = getProductMaster().filter(p => !productCategory(p));
  const banner  = document.getElementById('pm-cat-warning');
  if (!banner) return;
  if (missing.length > 0) {
    banner.classList.add('open');
    document.getElementById('pm-cat-warning-text').textContent =
      `⚠ ${missing.length} item${missing.length === 1 ? ' is' : 's are'} missing a category. Please edit them to ensure accurate reporting.`;
  } else {
    banner.classList.remove('open');
  }
}

document.getElementById('btn-add-product').addEventListener('click', () => { resetProdForm(); openModal('modal-product'); });
document.getElementById('btn-export-products').addEventListener('click', exportProductsCSV);
initSupplierPicker('p-supplier', 'p-supplier-search', 'p-supplier-results');
document.getElementById('btn-save-product').addEventListener('click', saveProduct);
document.getElementById('search-prod').addEventListener('input', () => { PROD_TABLE.page = 1; renderTable(); });
document.getElementById('btn-clear-prod-filters').addEventListener('click', clearProductFilters);
document.getElementById('btn-delete-products').addEventListener('click', deleteSelectedProducts);
document.getElementById('btn-clear-prod-selection').addEventListener('click', clearProductSelection);
document.getElementById('btn-select-all-products').addEventListener('click', selectAllProducts);
document.getElementById('btn-confirm-delete-products').addEventListener('click', confirmProductDelete);
document.getElementById('modal-delete-products').addEventListener('click', event => {
  if (productDeleteInProgress && event.target === event.currentTarget) event.stopPropagation();
}, true);
document.addEventListener('keydown', event => {
  if (productDeleteInProgress && event.key === 'Escape') event.stopPropagation();
}, true);
document.getElementById('prod-tbody').addEventListener('click', handleProductTableClick);

getProductMaster();
cleanupProductMasterData(false);
rebuildProductStockIndex();
renderTable();
checkMissingCategories();
Promise.all([
  loadSuppliersFromFirestore(),
  loadProductMasterFromFirestore('productName'),
  loadInventoryFromFirestore().then(rows => {
    _pmInventoryRows = rows || [];
  }),
  (async () => {
    const fsdb = getFirestoreDB();
    if (!fsdb) return;
    try {
      const snap = await fsdb.collection('salesData').get();
      if (!snap.empty) _pmSalesRows = snap.docs.map(d => ({ _firestoreId: d.id, ...d.data() }));
    } catch (e) {
      console.warn('[Product Master] salesData load failed:', e);
    }
  })()
])
  .then(() => {
    cleanupProductMasterData();
    rebuildProductStockIndex();
    populateProductSupplierSelect();
    renderTable();
    checkMissingCategories();
    openProductFromURL();
  })
  .catch(err => console.error('[Product Master] Firestore load failed:', err));

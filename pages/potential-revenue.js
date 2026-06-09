initSidebar('potential-revenue');

let potentialSubtab = 'included';
let potentialDetailCode = '';
let potentialPage = 1;
let potentialLastSearch = '';
let potentialSortKey = 'potentialRevenue';
let potentialSortDir = 'desc';
let potentialFilters = {};
let salesAspByCode = {};
const selectedPotentialCodes = new Set();
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

function invEsc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

function saleToOutgoingRow(sale, index) {
  const code = inventoryCode(sale.itemCode ?? sale.code);
  const qty = Number(sale.unitsSold ?? sale.quantity ?? sale.qty ?? sale.unitSold ?? sale.soldQty) || 0;
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
    _derived: true
  };
}

function applySalesOutgoing(sales) {
  const base = DB.get('inventory_movements').filter(row => !row._derived);
  const derived = sales.map(saleToOutgoingRow).filter(Boolean);
  DB.set('inventory_movements', [...base, ...derived]);

  const totals = {};
  sales.forEach(sale => {
    const code = inventoryCode(sale.itemCode ?? sale.code);
    const qty = Number(sale.unitsSold ?? sale.quantity ?? sale.qty ?? sale.unitSold ?? sale.soldQty) || 0;
    const revenue = salesRevenueValue(sale, qty);
    if (!code || qty <= 0 || revenue <= 0) return;
    if (!totals[code]) totals[code] = { qty: 0, revenue: 0 };
    totals[code].qty += qty;
    totals[code].revenue += revenue;
  });
  salesAspByCode = Object.fromEntries(
    Object.entries(totals).map(([code, value]) => [code, value.revenue / value.qty])
  );
  renderSummary();
  renderPotentialRevenueTable();
}

function watchSalesOutgoing() {
  const db = getFirestoreDB();
  if (!db) return;
  db.collection('salesData').get()
    .then(snap => applySalesOutgoing(snap.docs.map(doc => ({ _firestoreId: doc.id, ...doc.data() }))))
    .catch(err => console.error('[Potential Revenue] salesData get() failed:', err));
  db.collection('salesData').onSnapshot(
    snap => applySalesOutgoing(snap.docs.map(doc => ({ _firestoreId: doc.id, ...doc.data() }))),
    err => console.error('[Potential Revenue] salesData listener failed:', err)
  );
}

function watchPotentialProductMaster() {
  const db = getFirestoreDB();
  if (!db) return;
  db.collection('productMaster').onSnapshot(snapshot => {
    cacheProductMasterRows(snapshot.docs.map(doc => normalizeProductCostData({ _firestoreId: doc.id, ...doc.data() })));
    renderSummary();
    renderPotentialRevenueTable();
  }, err => console.error('[Potential Revenue] Product Master listener failed:', err));
}

function getPotentialMarkupSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(POTENTIAL_MARKUP_KEY) || '{}');
    return {
      globalMarkup: Number(parsed.globalMarkup) || 0,
      categoryMarkup: parsed.categoryMarkup && typeof parsed.categoryMarkup === 'object' ? parsed.categoryMarkup : {},
      itemOverrides: parsed.itemOverrides && typeof parsed.itemOverrides === 'object' ? parsed.itemOverrides : {},
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
  return Number.isFinite(categoryValue) && categoryValue > 0 ? categoryValue : settings.globalMarkup;
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
    if (!grouped.has(code)) {
      grouped.set(code, {
        itemCode: code,
        rows: [],
        incomingRows: [],
        outgoingRows: [],
        incomingQty: 0,
        outgoingQty: 0
      });
    }
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
    const avgSellingPrice = salesAspByCode[group.itemCode] || 0;
    const override = settings.itemOverrides?.[group.itemCode] || {};
    const manualPrice = Number(override.sellingPrice) || 0;
    const manualMarkup = Number(override.markupPercent) || 0;
    const markupPercent = potentialMarkupForCategory(category);
    const manualMarkupSellingPrice = unitCost > 0 && manualMarkup > 0 ? unitCost * (1 + manualMarkup / 100) : 0;
    const markupSellingPrice = unitCost > 0 && markupPercent > 0 ? unitCost * (1 + markupPercent / 100) : 0;
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

function renderSummary() {
  const rows = potentialRevenueRows();
  const included = potentialRevenueIncludedRows();
  const review = potentialRevenueReviewRows();
  const remainingUnits = rows.reduce((sum, row) => sum + row.remainingQty, 0);
  document.getElementById('potential-summary').innerHTML = `
    <div class="summary-card">
      <div class="kpi-label">Total Potential Revenue</div>
      <div class="kpi-value green">${formatPeso(totalPotentialRevenue())}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Included Items</div>
      <div class="kpi-value blue">${included.length.toLocaleString()}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">For Review</div>
      <div class="kpi-value red">${review.length.toLocaleString()}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Remaining Units</div>
      <div class="kpi-value">${remainingUnits.toLocaleString()}</div>
    </div>`;
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
          <input class="col-filter" type="number" placeholder="Min" value="${invEsc(filter?.min || '')}" onchange="setPotentialRangeFilter('${column.key}', 'min', this.value)">
          <span>–</span>
          <input class="col-filter" type="number" placeholder="Max" value="${invEsc(filter?.max || '')}" onchange="setPotentialRangeFilter('${column.key}', 'max', this.value)">
        </div>
      </th>`;
  }
  if (column.type === 'select') {
    const options = potentialFilterOptions(column.key, baseRows);
    return `
      <th>
        <select class="col-filter" onchange="setPotentialFilter('${column.key}', this.value)">
          <option value="">All</option>
          ${options.map(option => `<option value="${invEsc(option)}" ${filter === option ? 'selected' : ''}>${invEsc(option)}</option>`).join('')}
        </select>
      </th>`;
  }
  return `
    <th>
      <input class="col-filter" type="text" placeholder="Filter..." value="${invEsc(filter || '')}" onchange="setPotentialFilter('${column.key}', this.value)">
    </th>`;
}

function renderPotentialTableHead(baseRows) {
  return `
    <tr class="header-row">
      <th class="select-col"><input type="checkbox" id="potential-select-all" aria-label="Select visible potential revenue rows" onchange="toggleAllVisiblePotential(this.checked)"></th>
      ${POTENTIAL_COLUMNS.map(column => `
        <th class="sortable ${potentialSortKey === column.key ? 'is-sorted' : ''}" onclick="setPotentialSort('${column.key}')">
          ${column.label} ${potentialSortIcon(column.key)}
        </th>`).join('')}
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

function clearPotentialFilters() {
  potentialFilters = {};
  potentialSortKey = 'potentialRevenue';
  potentialSortDir = 'desc';
  potentialPage = 1;
  potentialLastSearch = '';
  selectedPotentialCodes.clear();
  document.getElementById('search-inv').value = '';
  renderPotentialRevenueTable();
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
  document.getElementById('potential-category-markup').value = settings.categoryMarkup?.[categorySelect.value] || '';
}

function potentialBaseRowsForActiveSubtab() {
  return potentialSubtab === 'review' ? potentialRevenueReviewRows() : potentialRevenueIncludedRows();
}

function potentialRowsForActiveSubtab() {
  return sortPotentialRows(
    potentialSearchRows(potentialBaseRowsForActiveSubtab()).filter(potentialPassesFilters)
  );
}

function renderPotentialPagination(total) {
  const el = document.getElementById('inv-pagination');
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
  bar.classList.toggle('open', count > 0 && potentialSubtab !== 'detail');
  document.getElementById('potential-bulk-count').textContent = `${count.toLocaleString()} item${count === 1 ? '' : 's'} selected`;
  document.getElementById('potential-bulk-markup-wrap').style.display = potentialSubtab === 'review' ? 'flex' : 'none';
  document.getElementById('btn-apply-selected-potential-markup').style.display = potentialSubtab === 'review' ? '' : 'none';
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
  syncPotentialBulkBar(potentialRowsForActiveSubtab().slice((potentialPage - 1) * POTENTIAL_PAGE_SIZE, potentialPage * POTENTIAL_PAGE_SIZE));
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
    settings.itemOverrides[code] = { ...(settings.itemOverrides[code] || {}), markupPercent: markup, sellingPrice: 0 };
  });
  savePotentialMarkupSettings(settings);
  selectedPotentialCodes.clear();
  document.getElementById('potential-bulk-markup').value = '';
  potentialSubtab = 'included';
  potentialPage = 1;
  renderSummary();
  renderPotentialRevenueTable();
  showToast('Markup applied to selected potential revenue items.', 'success');
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

  document.getElementById('btn-clear-inv').style.display = hasPotentialFilters() ? '' : 'none';
  renderPotentialMarkupControls();
  document.getElementById('potential-revenue-panel').classList.toggle('hide-settings', potentialSubtab !== 'review');
  document.getElementById('potential-subtab-included').classList.toggle('active', potentialSubtab === 'included');
  document.getElementById('potential-subtab-review').classList.toggle('active', potentialSubtab === 'review');
  document.getElementById('potential-subtab-detail').classList.remove('open', 'active');
  document.getElementById('inv-thead').innerHTML = renderPotentialTableHead(baseRows);

  if (!rows.length) {
    document.getElementById('inv-tbody').innerHTML = `<tr><td colspan="10"><div class="empty-state"><p>${
      potentialSubtab === 'review' ? 'No items need selling price review.' : 'No items are included in potential revenue yet.'
    }</p></div></td></tr>`;
    renderPotentialPagination(0);
    syncPotentialBulkBar([]);
    return;
  }

  document.getElementById('inv-tbody').innerHTML = pageRows.map(row => `
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
      <td><span class="badge ${row.effectiveSellingPrice > 0 ? 'badge-green' : 'badge-gray'}">${row.effectiveSellingPrice > 0 ? 'Included' : 'For review'}</span></td>
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
  const incomingRows = row.incomingRows.slice().sort((a, b) => String(b.dateDelivered || '').localeCompare(String(a.dateDelivered || '')));
  const outgoingRows = row.outgoingRows.slice().sort((a, b) => String(b.dateDelivered || '').localeCompare(String(a.dateDelivered || '')));
  return `
    <button class="btn btn-outline-gray btn-sm potential-back" type="button" onclick="setPotentialSubtab('${row.effectiveSellingPrice > 0 ? 'included' : 'review'}')">Back to ${row.effectiveSellingPrice > 0 ? 'Inclusions' : 'For Review'}</button>
    <div class="potential-manual-editor">
      <label>Manual selling price
        <input type="number" min="0" step="0.01" id="potential-manual-price" value="${row.manualPrice || ''}" placeholder="0.00">
      </label>
      <label>Manual markup
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
  settings.itemOverrides[code] = { sellingPrice: price, markupPercent: price > 0 ? 0 : markup };
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
  document.getElementById('inv-pagination').innerHTML = '';
  document.getElementById('potential-bulk-bar').classList.remove('open');
  document.getElementById('potential-revenue-panel').classList.add('hide-settings');
  document.getElementById('potential-subtab-included').classList.remove('active');
  document.getElementById('potential-subtab-review').classList.remove('active');
  document.getElementById('potential-subtab-detail').classList.add('open', 'active');
  document.getElementById('potential-subtab-detail').textContent = row ? `${row.description || row.itemCode}` : 'Item Detail';
  document.getElementById('inv-thead').innerHTML = '';
  document.getElementById('inv-tbody').innerHTML = row
    ? `<tr><td class="potential-detail-cell">${potentialDetailHtml(row)}</td></tr>`
    : '<tr><td><div class="empty-state"><p>The selected item could not be found.</p></div></td></tr>';
}

function openPotentialDetail(itemCode) {
  potentialDetailCode = inventoryCode(itemCode);
  potentialSubtab = 'detail';
  renderPotentialRevenueTable();
}

function exportPotentialCSV() {
  const rows = potentialRowsForActiveSubtab();
  exportRowsToCSV(`potential-revenue-${todayISO()}.csv`, [
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
    { label:'Status', value: row => row.effectiveSellingPrice > 0 ? 'Included' : 'For review' }
  ], rows);
  showToast(`${rows.length.toLocaleString()} potential revenue records exported to CSV.`, 'success');
}

document.getElementById('search-inv').addEventListener('input', () => renderPotentialRevenueTable());
document.getElementById('btn-export-potential').addEventListener('click', exportPotentialCSV);
document.getElementById('btn-save-potential-markup').addEventListener('click', savePotentialMarkup);
document.getElementById('btn-apply-selected-potential-markup').addEventListener('click', applySelectedPotentialMarkup);
document.getElementById('btn-delete-selected-potential').addEventListener('click', deleteSelectedPotentialItems);
document.getElementById('btn-clear-potential-selection').addEventListener('click', clearPotentialSelection);
document.getElementById('potential-category-select').addEventListener('change', () => {
  const settings = getPotentialMarkupSettings();
  document.getElementById('potential-category-markup').value =
    settings.categoryMarkup?.[document.getElementById('potential-category-select').value] || '';
});

Promise.all([
  loadInventoryFromFirestore(),
  loadProductMasterFromFirestore()
])
  .then(() => {
    renderSummary();
    renderPotentialRevenueTable();
    watchPotentialProductMaster();
    watchSalesOutgoing();
  })
  .catch(err => console.error('[Potential Revenue] Firestore load failed:', err));

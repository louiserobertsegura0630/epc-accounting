// ─── Month Filter ─────────────────────────────────────────────────────────────
function populateMonthFilter() {
  const months = [...new Set(_salesData.map(r => r.date?.slice(0, 7)))].filter(Boolean).sort().reverse();
  const sel = document.getElementById('filter-month');
  sel.innerHTML = '<option value="">All Months</option>' +
    months.map(m => {
      const [y, mo] = m.split('-');
      return `<option value="${m}"${m === salesFilters.month ? ' selected' : ''}>
        ${new Date(y, mo - 1, 1).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })}
      </option>`;
    }).join('');
}

// ─── Render: Summary Cards ────────────────────────────────────────────────────
function renderSummary(rows) {
  const tot            = getPOSTotals(rows);
  const avgMargin      = tot.revenue > 0 ? (tot.profit / tot.revenue * 100).toFixed(1) : '0.0';
  const pendingRevenue = _reviewData.reduce((s, r) => s + (r.totalRevenue || 0), 0);
  const pendingCard    = `<div class="summary-card" style="border-color:#f59e0b">
        <div class="kpi-label" style="color:#d97706">Pending Revenue</div>
        <div class="kpi-value pending-revenue-value" style="color:#d97706">${formatPeso(pendingRevenue)}</div>
        <div style="font-size:11px;color:#92400e;margin-top:2px">cost entry needed</div>
      </div>`;
  document.getElementById('pos-summary').innerHTML = `
    <div class="summary-card"><div class="kpi-label">Total Revenue</div><div class="kpi-value green">${formatPeso(tot.revenue)}</div></div>
    <div class="summary-card"><div class="kpi-label">Total COGS</div><div class="kpi-value red">${formatPeso(tot.cogs)}</div></div>
    <div class="summary-card"><div class="kpi-label">Gross Profit</div><div class="kpi-value blue">${formatPeso(tot.profit)}</div></div>
    <div class="summary-card"><div class="kpi-label">Avg Margin %</div><div class="kpi-value">${avgMargin}%</div></div>
    ${pendingCard}`;
  document.getElementById('cost-method-summary').textContent =
    `COGS computed using: ${costMethod === 'average' ? 'Average Price' : 'Latest Price'}`;
}

function updateSummaryCards(rows) {
  renderSummary(rows);
}

// ─── Render: Sales Data Table ─────────────────────────────────────────────────
const SALES_FILTER_DEFAULTS = {
  query: '',
  month: '',
  toolbarFlag: '',
  sortKey: 'date',
  sortDir: 'desc',
  columns: {
    date: { from:'', to:'' },
    itemCode: '',
    productName: '',
    category: '',
    unitsSold: { min:'', max:'' },
    discount: { min:'', max:'' },
    srpwdDiscount: { min:'', max:'' },
    sellingPrice: { min:'', max:'' },
    totalRevenue: { min:'', max:'' },
    grossProfit: { min:'', max:'' },
    margin: { min:'', max:'' },
    flag: ''
  }
};

function freshSalesFilterDefaults() {
  return JSON.parse(JSON.stringify(SALES_FILTER_DEFAULTS));
}

function loadSalesDataFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem('salesDataFilters')) || {};
    return {
      ...SALES_FILTER_DEFAULTS,
      ...saved,
      columns: {
        ...SALES_FILTER_DEFAULTS.columns,
        ...(saved.columns || {}),
        date: { ...SALES_FILTER_DEFAULTS.columns.date, ...(saved.columns?.date || {}) },
        unitsSold: { ...SALES_FILTER_DEFAULTS.columns.unitsSold, ...(saved.columns?.unitsSold || {}) },
        discount: { ...SALES_FILTER_DEFAULTS.columns.discount, ...(saved.columns?.discount || {}) },
        srpwdDiscount: { ...SALES_FILTER_DEFAULTS.columns.srpwdDiscount, ...(saved.columns?.srpwdDiscount || {}) },
        sellingPrice: { ...SALES_FILTER_DEFAULTS.columns.sellingPrice, ...(saved.columns?.sellingPrice || {}) },
        totalRevenue: { ...SALES_FILTER_DEFAULTS.columns.totalRevenue, ...(saved.columns?.totalRevenue || {}) },
        grossProfit: { ...SALES_FILTER_DEFAULTS.columns.grossProfit, ...(saved.columns?.grossProfit || {}) },
        margin: { ...SALES_FILTER_DEFAULTS.columns.margin, ...(saved.columns?.margin || {}) }
      }
    };
  } catch {
    return freshSalesFilterDefaults();
  }
}

salesFilters = loadSalesDataFilters();

function saveSalesDataFilters() {
  localStorage.setItem('salesDataFilters', JSON.stringify(salesFilters));
}

function salesFlagType(row) {
  return getSalesMarginFlag(row)?.type || 'normal';
}

function matchesSalesFlagFilter(row, value) {
  const flag = salesFlagType(row);
  if (!value) return true;
  if (value === 'flagged') return flag !== 'normal';
  return flag === value;
}

function matchesSalesRange(value, range) {
  const number = Number(value) || 0;
  if (range?.min !== '' && range?.min != null && number < Number(range.min)) return false;
  if (range?.max !== '' && range?.max != null && number > Number(range.max)) return false;
  return true;
}

function salesSortValue(row, key) {
  if (key === 'flag') return salesFlagType(row);
  if (['unitsSold','discount','srpwdDiscount','sellingPrice','totalRevenue','grossProfit','margin'].includes(key)) {
    return Number(row[key]) || 0;
  }
  return String(row[key] || '').toLowerCase();
}

function getFilteredSalesRows() {
  const { columns } = salesFilters;
  const query = salesFilters.query.toLowerCase().trim();
  return [..._salesData]
    .filter(row => !salesFilters.month || row.date?.startsWith(salesFilters.month))
    .filter(row => !query || [row.itemCode, row.productName, row.category]
      .some(value => String(value || '').toLowerCase().includes(query)))
    .filter(row => !columns.date.from || String(row.date || '') >= columns.date.from)
    .filter(row => !columns.date.to || String(row.date || '') <= columns.date.to)
    .filter(row => !columns.itemCode || String(row.itemCode || '').toLowerCase().includes(columns.itemCode.toLowerCase()))
    .filter(row => !columns.productName || String(row.productName || '').toLowerCase().includes(columns.productName.toLowerCase()))
    .filter(row => !columns.category || String(row.category || '') === columns.category)
    .filter(row => matchesSalesRange(row.unitsSold, columns.unitsSold))
    .filter(row => matchesSalesRange(row.discount, columns.discount))
    .filter(row => matchesSalesRange(row.srpwdDiscount, columns.srpwdDiscount))
    .filter(row => matchesSalesRange(row.sellingPrice, columns.sellingPrice))
    .filter(row => matchesSalesRange(row.totalRevenue, columns.totalRevenue))
    .filter(row => matchesSalesRange(row.grossProfit, columns.grossProfit))
    .filter(row => matchesSalesRange(row.margin, columns.margin))
    .filter(row => matchesSalesFlagFilter(row, columns.flag))
    .filter(row => matchesSalesFlagFilter(row, salesFilters.toolbarFlag))
    .sort((a, b) => {
      const aValue = salesSortValue(a, salesFilters.sortKey);
      const bValue = salesSortValue(b, salesFilters.sortKey);
      const comparison = typeof aValue === 'number' && typeof bValue === 'number'
        ? aValue - bValue
        : String(aValue).localeCompare(String(bValue));
      return comparison * (salesFilters.sortDir === 'asc' ? 1 : -1);
    });
}

function getVisibleSalesRows(filteredRows = getFilteredSalesRows()) {
  const start = (salesPage - 1) * SALES_PG;
  return filteredRows.slice(start, start + SALES_PG);
}

function salesFilterOption(value, label, selectedValue) {
  return `<option value="${esc(value)}"${value === selectedValue ? ' selected' : ''}>${esc(label)}</option>`;
}

function salesRangeFilter(key) {
  const range = salesFilters.columns[key];
  return `<div class="col-filter-range">
    <input class="col-filter" type="number" placeholder="Min" step="any" value="${esc(range.min)}" onchange="setSalesRangeFilter('${key}', 'min', this.value)">
    <span class="range-sep">–</span>
    <input class="col-filter" type="number" placeholder="Max" step="any" value="${esc(range.max)}" onchange="setSalesRangeFilter('${key}', 'max', this.value)">
  </div>`;
}

function renderSalesFilterRow() {
  const categories = [...new Set(_salesData.map(row => String(row.category || '').trim()).filter(Boolean))].sort();
  const columns = salesFilters.columns;
  document.getElementById('sales-filter-row').innerHTML = `
    <th class="filter-cell-empty"></th>
    <th class="filter-cell"><div class="col-filter-range sales-filter-date">
      <input class="col-filter" type="date" value="${esc(columns.date.from)}" onchange="setSalesDateFilter('from', this.value)">
      <span class="range-sep">–</span>
      <input class="col-filter" type="date" value="${esc(columns.date.to)}" onchange="setSalesDateFilter('to', this.value)">
    </div></th>
    <th class="filter-cell"><input class="col-filter sales-filter-text" type="text" value="${esc(columns.itemCode)}" placeholder="Filter..." onchange="setSalesColumnFilter('itemCode', this.value)"></th>
    <th class="filter-cell"><input class="col-filter sales-filter-text" type="text" value="${esc(columns.productName)}" placeholder="Filter..." onchange="setSalesColumnFilter('productName', this.value)"></th>
    <th class="filter-cell"><select class="col-filter sales-filter-category" onchange="setSalesColumnFilter('category', this.value)">
      ${salesFilterOption('', 'All Categories', columns.category)}
      ${categories.map(category => salesFilterOption(category, category, columns.category)).join('')}
    </select></th>
    <th class="filter-cell">${salesRangeFilter('unitsSold')}</th>
    <th class="filter-cell">${salesRangeFilter('discount')}</th>
    <th class="filter-cell">${salesRangeFilter('srpwdDiscount')}</th>
    <th class="filter-cell">${salesRangeFilter('sellingPrice')}</th>
    <th class="filter-cell">${salesRangeFilter('totalRevenue')}</th>
    <th class="filter-cell">${salesRangeFilter('grossProfit')}</th>
    <th class="filter-cell">${salesRangeFilter('margin')}</th>
    <th class="filter-cell"><select class="col-filter sales-filter-flag" onchange="setSalesColumnFilter('flag', this.value)">
      ${salesFilterOption('', 'All', columns.flag)}
      ${salesFilterOption('loss', '🔴 Loss', columns.flag)}
      ${salesFilterOption('high', '🟡 High Margin', columns.flag)}
      ${salesFilterOption('normal', '✅ Normal', columns.flag)}
    </select></th>`;
}

function resetSalesPageAndRender() {
  salesPage = 1;
  saveSalesDataFilters();
  renderAll();
}

function setSalesColumnFilter(key, value) {
  salesFilters.columns[key] = value;
  resetSalesPageAndRender();
}

function setSalesRangeFilter(key, part, value) {
  salesFilters.columns[key][part] = value;
  resetSalesPageAndRender();
}

function setSalesDateFilter(part, value) {
  salesFilters.columns.date[part] = value;
  resetSalesPageAndRender();
}

function setSalesSort(key) {
  if (salesFilters.sortKey === key) {
    salesFilters.sortDir = salesFilters.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    salesFilters.sortKey = key;
    salesFilters.sortDir = key === 'date' ? 'desc' : 'asc';
  }
  resetSalesPageAndRender();
}

function activeSalesFilterCount() {
  const columns = salesFilters.columns;
  return [
    salesFilters.query,
    salesFilters.month,
    salesFilters.toolbarFlag,
    columns.date.from || columns.date.to,
    columns.itemCode,
    columns.productName,
    columns.category,
    columns.unitsSold.min || columns.unitsSold.max,
    columns.discount.min || columns.discount.max,
    columns.srpwdDiscount.min || columns.srpwdDiscount.max,
    columns.sellingPrice.min || columns.sellingPrice.max,
    columns.totalRevenue.min || columns.totalRevenue.max,
    columns.grossProfit.min || columns.grossProfit.max,
    columns.margin.min || columns.margin.max,
    columns.flag
  ].filter(value => String(value || '').trim() !== '').length;
}

function refreshSalesFilterUI() {
  document.getElementById('search-pos').value = salesFilters.query;
  document.getElementById('filter-sales-flag').value = salesFilters.toolbarFlag;
  document.getElementById('filter-month').value = salesFilters.month;
  const count = activeSalesFilterCount();
  document.getElementById('sales-active-filter-count').textContent =
    count ? `${count} filter${count === 1 ? '' : 's'} active` : '';
  document.querySelectorAll('[data-sales-sort]').forEach(icon => {
    const active = icon.dataset.salesSort === salesFilters.sortKey;
    icon.textContent = active ? (salesFilters.sortDir === 'asc' ? '↑' : '↓') : '⇅';
    icon.classList.toggle('sort-active', active);
    icon.closest('th')?.classList.toggle('is-sorted', active);
  });
  renderSalesFilterRow();
}

function clearSalesFilters() {
  salesFilters = freshSalesFilterDefaults();
  resetSalesPageAndRender();
}

function getSalesMarginFlag(row) {
  const margin = Number(row.margin) || 0;
  if (Number(row.grossProfit) < 0 || margin < marginLowThreshold) {
    return { type:'loss', rowClass:'sales-row-loss', badgeClass:'badge-red', label:'🔴 Loss' };
  }
  if (margin > marginHighThreshold) {
    return { type:'high', rowClass:'sales-row-high', badgeClass:'badge-amber', label:'🟡 High Margin' };
  }
  return null;
}

function renderMarginFlagSummary() {
  const flags = _salesData.map(getSalesMarginFlag).filter(Boolean);
  const banner = document.getElementById('margin-flag-summary');
  if (!flags.length) {
    banner.classList.remove('open');
    banner.textContent = '';
    return;
  }
  const high = flags.filter(flag => flag.type === 'high').length;
  const loss = flags.filter(flag => flag.type === 'loss').length;
  const notes = [
    `${high.toLocaleString()} high margin (above ${marginHighThreshold}%)`,
    marginLowThreshold === 0
      ? `${loss.toLocaleString()} negative margin`
      : `${loss.toLocaleString()} loss / below ${marginLowThreshold}%`
  ];
  banner.textContent = `⚠️ ${flags.length.toLocaleString()} items flagged: ${notes.join(', ')}`;
  banner.classList.add('open');
}

function goToSalesPage(page) {
  salesPage = page;
  renderAll();
}

function renderSalesPagination(filteredRows) {
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / SALES_PG));
  if (salesPage > totalPages) salesPage = 1;
  const start = filteredRows.length ? (salesPage - 1) * SALES_PG + 1 : 0;
  const end = Math.min(salesPage * SALES_PG, filteredRows.length);
  document.getElementById('sales-page-info').textContent =
    filteredRows.length === _salesData.length
      ? `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${_salesData.length.toLocaleString()}`
      : `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${filteredRows.length.toLocaleString()} filtered results (${_salesData.length.toLocaleString()} total)`;
  document.getElementById('sales-pagination').innerHTML = totalPages <= 1 ? '' :
    `<button onclick="goToSalesPage(${salesPage - 1})" ${salesPage === 1 ? 'disabled' : ''}>Prev</button>` +
    `<span class="pagination-info">Page ${salesPage} / ${totalPages}</span>` +
    `<button onclick="goToSalesPage(${salesPage + 1})" ${salesPage === totalPages ? 'disabled' : ''}>Next</button>`;
}

function renderTable(rows) {
  const tbody = document.getElementById('pos-tbody');
  if (!rows.length) {
    const message = _salesData.length
      ? 'No sales records match your active filters.'
      : 'No sales data yet. Upload an XLS, XLSX, or CSV file above.';
    tbody.innerHTML = `<tr><td colspan="13"><div class="empty-state"><div class="empty-icon">📊</div><p>${message}</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const flag = getSalesMarginFlag(r);
    return `<tr data-sales-id="${r._id}" class="${flag?.rowClass || ''}">
    <td class="sales-select-col"><input type="checkbox" class="sales-row-select" value="${r._id}" aria-label="Select ${esc(r.productName) || esc(r.itemCode)}" onchange="toggleSalesSelection('${r._id}', this.checked)"></td>
    <td>${formatDate(r.date)}</td>
    <td class="mono">${esc(r.itemCode)}</td>
    <td>${esc(r.productName)}</td>
    <td>${esc(r.category) || '—'}</td>
    <td class="mono">${(r.unitsSold || 0).toLocaleString()}</td>
    <td class="mono">${formatPeso(r.discount)}</td>
    <td class="mono">${formatPeso(r.srpwdDiscount)}</td>
    <td class="mono">${formatPeso(r.sellingPrice)}</td>
    <td class="mono"><strong>${formatPeso(r.totalRevenue)}</strong></td>
    <td class="mono" style="color:${Number(r.grossProfit) < 0 ? '#dc2626' : 'var(--success)'}">${formatPeso(r.grossProfit)}</td>
    <td class="mono">${r.margin}%</td>
    <td>${flag ? `<span class="badge ${flag.badgeClass} sales-flag-badge">${flag.label}</span>` : ''}</td>
  </tr>`;
  }).join('');
}

function renderSalesData(rows) {
  renderSalesPagination(rows);
  const pageRows = getVisibleSalesRows(rows);
  renderTable(pageRows);
  syncSalesSelectionUI(pageRows);
}

function renderAll() {
  populateMonthFilter();
  refreshSalesFilterUI();
  const rows = applyFiltersAndSort();
  updateSummaryCards(rows);
  renderFlagBanner();
  renderSalesData(rows);
  renderUnderReview();
  applySalesPagePermissions();
}

async function openSalesDetail(id) {
  const row = _salesData.find(item => item._id === id);
  if (!row) return;
  activeSalesDetailId = id;
  pmData = null;
  document.getElementById('sales-detail-title').textContent = row.productName || row.itemCode || 'Sales Record Details';
  document.getElementById('btn-open-product-master').href =
    `product-master.html?itemCode=${encodeURIComponent(row.itemCode || '')}`;
  // Scaffold the two independent sections immediately so Sales Info is editable right away
  document.getElementById('sales-detail-body').innerHTML =
    '<div id="sales-info-section"></div>' +
    '<hr class="sales-detail-divider">' +
    '<div id="cost-info-section"><p style="color:var(--text-secondary);font-size:13px">Loading cost info…</p></div>';
  renderSalesInfo(row);
  openModal('modal-sales-detail');
  // Fetch PM data once in the background; never block or clear Sales Info
  try {
    const pmResult = await lookupProductMasterByItemCode(row.itemCode);
    if (activeSalesDetailId !== id) return; // modal was closed or switched
    pmData = pmResult;
    renderCostInfo(pmData);
  } catch (err) {
    console.error('[POS Sales Detail] Product Master lookup failed:', err);
    const costSection = document.getElementById('cost-info-section');
    if (costSection) costSection.innerHTML =
      '<p style="color:#dc2626;font-size:13px">Could not load the Product Master record.</p>';
  }
}

function renderFlagBanner() {
  renderMarginFlagSummary();
}

function applyFiltersAndSort() {
  return getFilteredSalesRows();
}

function openItemDetailModal(id) {
  return openSalesDetail(id);
}

// Renders only the editable Sales Info section into #sales-info-section.
// Never touches #cost-info-section.
function renderSalesInfo(row) {
  const section = document.getElementById('sales-info-section');
  if (!section) return;
  const otherCategories = [...new Set(
    _salesData.map(r => String(r.category || '').trim()).filter(c => c && c !== 'Uncategorized')
  )].sort();
  const allCategories = ['Uncategorized', ...otherCategories];
  const currentCategory = row.category || 'Uncategorized';
  const roundedSellingPrice = Math.round((Number(row.sellingPrice || 0)) * 100) / 100;

  section.innerHTML = `
    <h3 class="sales-detail-section-title">Sales Info</h3>
    <div class="sales-record-editor">
      <label>Product Name
        <input class="form-input" id="sales-detail-product-name" type="text" value="${esc(row.productName || '')}">
      </label>
      <label>Item Code
        <input class="form-input" id="sales-detail-item-code" type="text" value="${esc(row.itemCode || '')}">
      </label>
      <label>Category
        <select class="form-input" id="sales-detail-category">
          ${allCategories.map(cat => `<option value="${esc(cat)}"${cat === currentCategory ? ' selected' : ''}>${esc(cat)}</option>`).join('')}
        </select>
      </label>
      <label>Date
        <input class="form-input" id="sales-detail-date" type="date" value="${esc(row.date)}">
      </label>
      <label>Units Sold
        <input class="form-input" id="sales-detail-units-sold" type="number" min="0" step="any" value="${Number(row.unitsSold || 0)}">
      </label>
      <label>Selling Price
        <input class="form-input" id="sales-detail-selling-price" type="number" min="0" step="0.01" value="${roundedSellingPrice}">
      </label>
    </div>
    <div class="sales-record-totals">
      <div><span>Total Revenue</span><strong id="sales-detail-total-revenue">${formatPeso(row.totalRevenue)}</strong></div>
      <div><span>Gross Profit</span><strong id="sales-detail-gross-profit">${formatPeso(row.grossProfit)}</strong></div>
      <div><span>Margin %</span><strong id="sales-detail-margin">${Number(row.margin || 0).toFixed(1)}%</strong></div>
    </div>
    <div class="sales-record-actions">
      <button class="btn btn-primary" type="button" id="btn-save-sales-detail" onclick="saveSalesDetailChanges()">Save Changes</button>
      <span class="sales-record-saved" id="sales-detail-saved"></span>
    </div>`;
  bindSalesDetailPreviewEvents();
  recomputeSalesDetailPreview();
}

// Renders only the read-only Cost Info section into #cost-info-section.
// Never touches #sales-info-section.
function renderCostInfo(product) {
  const section = document.getElementById('cost-info-section');
  if (!section) return;
  const header = '<h3 class="sales-detail-section-title">Cost Information from Product Master <span class="sales-detail-readonly-label">read only</span></h3>';
  if (!product) {
    section.innerHTML = header +
      '<p style="color:#d97706;font-size:13px">No Product Master record was found for this item code.</p>' +
      '<p class="sales-product-master-note">💡 Cost data comes from Product Master</p>';
    return;
  }
  const history = [...(product.costHistory || [])]
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  section.innerHTML = `${header}
    <div class="sales-product-master-summary">
      <div><span>Latest Cost</span><strong>${formatPeso(product.latestCost)}</strong></div>
      <div><span>Average Cost</span><strong>${formatPeso(product.averageCost)}</strong></div>
      <div><span>Last Updated</span><strong>${product.latestDate ? formatDate(product.latestDate) : '—'}</strong></div>
    </div>
    <div class="sales-history-wrap">
      <table>
        <thead><tr><th>Date</th><th>Unit Cost</th><th>Supplier</th></tr></thead>
        <tbody>${history.length
          ? history.map(entry => `<tr><td>${entry.date ? formatDate(entry.date) : '—'}</td><td class="mono">${formatPeso(entry.unitCost)}</td><td>${esc(entry.supplier) || '—'}</td></tr>`).join('')
          : '<tr><td colspan="3">No cost history yet.</td></tr>'}</tbody>
      </table>
    </div>
    <p class="sales-product-master-note">💡 Cost data comes from Product Master</p>`;
}

// Called when the user changes the Item Code input; re-fetches PM and refreshes Cost Info only.
async function refreshCostInfoForItemCode(itemCode) {
  const costSection = document.getElementById('cost-info-section');
  if (!costSection) return;
  costSection.innerHTML = '<p style="color:var(--text-secondary);font-size:13px">Loading cost info…</p>';
  document.getElementById('btn-open-product-master').href =
    `product-master.html?itemCode=${encodeURIComponent(itemCode || '')}`;
  try {
    pmData = await lookupProductMasterByItemCode(itemCode);
    renderCostInfo(pmData);
  } catch (err) {
    console.error('[POS Sales Detail] PM re-fetch failed:', err);
    if (document.getElementById('cost-info-section')) {
      document.getElementById('cost-info-section').innerHTML =
        '<p style="color:#dc2626;font-size:13px">Could not load the Product Master record.</p>';
    }
  }
}

// Query Product Master by itemCode field value (never by doc ID).
async function lookupProductMasterByItemCode(rawItemCode) {
  const normalizedCode = String(rawItemCode || '').trim();

  const pmSnap = await db.collection('productMaster')
    .where('itemCode', '==', normalizedCode)
    .limit(1)
    .get();

  const pmDocData = pmSnap.empty ? null : pmSnap.docs[0].data();
  const pmDocId   = pmSnap.empty ? null : pmSnap.docs[0].id;
  return pmDocData ? { ...pmDocData, _id: pmDocId } : null;
}

function getSalesDetailValues() {
  const row = _salesData.find(item => item._id === activeSalesDetailId);
  if (!row) return null;
  const unitsSold    = Number(document.getElementById('sales-detail-units-sold')?.value) || 0;
  const sellingPrice = Number(document.getElementById('sales-detail-selling-price')?.value) || 0;
  const date         = document.getElementById('sales-detail-date')?.value || '';
  const productName  = document.getElementById('sales-detail-product-name')?.value?.trim() || row.productName || '';
  const itemCode     = document.getElementById('sales-detail-item-code')?.value?.trim() || row.itemCode || '';
  const category     = document.getElementById('sales-detail-category')?.value || row.category || 'Uncategorized';
  const unitCost     = Number(row.unitCost) || 0;
  const totalRevenue = unitsSold * sellingPrice;
  const totalCost    = unitsSold * unitCost;
  const grossProfit  = totalRevenue - totalCost;
  const margin       = totalRevenue > 0 ? Number((grossProfit / totalRevenue * 100).toFixed(1)) : 0;
  return { date, productName, itemCode, category, unitsSold, sellingPrice, unitCost, totalRevenue, totalCost, grossProfit, margin };
}

function recomputeSalesDetailPreview() {
  const values = getSalesDetailValues();
  if (!values) return;
  document.getElementById('sales-detail-total-revenue').textContent = formatPeso(values.totalRevenue);
  document.getElementById('sales-detail-gross-profit').textContent = formatPeso(values.grossProfit);
  document.getElementById('sales-detail-margin').textContent = `${values.margin.toFixed(1)}%`;
  document.getElementById('sales-detail-saved').textContent = '';
}

function reviewFilterOption(value, label, selectedValue) {
  return `<option value="${esc(value)}"${value === selectedValue ? ' selected' : ''}>${esc(label)}</option>`;
}

function reviewRangeFilter(key) {
  const range = reviewFilters.columns[key];
  return `<div class="col-filter-range">
    <input class="col-filter" type="number" placeholder="Min" step="any" value="${esc(range.min)}" onchange="setReviewRangeFilter('${key}', 'min', this.value)">
    <span class="range-sep">–</span>
    <input class="col-filter" type="number" placeholder="Max" step="any" value="${esc(range.max)}" onchange="setReviewRangeFilter('${key}', 'max', this.value)">
  </div>`;
}

function renderReviewFilterRow() {
  const categories = [...new Set(_reviewData.map(row => String(row.category || '').trim()).filter(Boolean))].sort();
  const columns = reviewFilters.columns;
  document.getElementById('review-filter-row').innerHTML = `
    <th class="filter-cell-empty"></th>
    <th class="filter-cell"><div class="col-filter-range review-filter-date">
      <input class="col-filter" type="date" value="${esc(columns.date.from)}" onchange="setReviewDateFilter('from', this.value)">
      <span class="range-sep">–</span>
      <input class="col-filter" type="date" value="${esc(columns.date.to)}" onchange="setReviewDateFilter('to', this.value)">
    </div></th>
    <th class="filter-cell"><input class="col-filter review-filter-text" type="text" value="${esc(columns.itemCode)}" placeholder="Filter..." onchange="setReviewColumnFilter('itemCode', this.value)"></th>
    <th class="filter-cell"><input class="col-filter review-filter-text" type="text" value="${esc(columns.productName)}" placeholder="Filter..." onchange="setReviewColumnFilter('productName', this.value)"></th>
    <th class="filter-cell"><select class="col-filter review-filter-category" onchange="setReviewColumnFilter('category', this.value)">
      ${reviewFilterOption('', 'All Categories', columns.category)}
      ${categories.map(category => reviewFilterOption(category, category, columns.category)).join('')}
    </select></th>
    <th class="filter-cell">${reviewRangeFilter('unitsSold')}</th>
    <th class="filter-cell">${reviewRangeFilter('sellingPrice')}</th>
    <th class="filter-cell">${reviewRangeFilter('totalRevenue')}</th>
    <th class="filter-cell">${reviewRangeFilter('discount')}</th>
    <th class="filter-cell">${reviewRangeFilter('srpwdDiscount')}</th>
    <th class="filter-cell-empty"></th>`;
}

function activeReviewFilterCount() {
  const columns = reviewFilters.columns;
  return [
    reviewFilters.query,
    columns.date.from || columns.date.to,
    columns.itemCode,
    columns.productName,
    columns.category,
    columns.unitsSold.min || columns.unitsSold.max,
    columns.sellingPrice.min || columns.sellingPrice.max,
    columns.totalRevenue.min || columns.totalRevenue.max,
    columns.discount.min || columns.discount.max,
    columns.srpwdDiscount.min || columns.srpwdDiscount.max
  ].filter(value => String(value || '').trim() !== '').length;
}

function refreshReviewFilterUI() {
  document.getElementById('review-search').value = reviewFilters.query;
  const count = activeReviewFilterCount();
  document.getElementById('review-active-filter-count').textContent =
    count ? `${count} filter${count === 1 ? '' : 's'} active` : '';
  document.querySelectorAll('[data-review-sort]').forEach(icon => {
    const active = icon.dataset.reviewSort === reviewFilters.sortKey;
    icon.textContent = active ? (reviewFilters.sortDir === 'asc' ? '↑' : '↓') : '⇅';
    icon.classList.toggle('sort-active', active);
    icon.closest('th')?.classList.toggle('is-sorted', active);
  });
  renderReviewFilterRow();
}

function renderUnderReview() {
  const allRows = [..._reviewData].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const count   = allRows.length;

  const badge = document.getElementById('review-badge');
  badge.textContent   = count;
  badge.style.display = count > 0 ? '' : 'none';

  const infoBar = document.getElementById('review-info-bar');
  if (count > 0) {
    const pendingRev = allRows.reduce((s, r) => s + (r.totalRevenue || 0), 0);
    infoBar.style.display = '';
    infoBar.innerHTML = `<strong>⚠ ${count} item${count !== 1 ? 's' : ''} pending cost entry.</strong>
      &nbsp;Total pending revenue: <strong>${formatPeso(pendingRev)}</strong>.
      Enter each item's Unit Cost and click <em>Add to Product Master</em> to move it to Sales Data.`;
  } else {
    infoBar.style.display = 'none';
  }

  const tbody   = document.getElementById('review-tbody');
  const toolbar = document.getElementById('review-toolbar');

  if (!count) {
    toolbar.style.display = 'none';
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state">
      <div class="empty-icon">✅</div>
      <p>No items under review. All imported items have known costs.</p>
    </div></td></tr>`;
    syncReviewSelectionUI([]);
    return;
  }

  const filtered = getFilteredReviewRows();

  const totalPages = Math.max(1, Math.ceil(filtered.length / REVIEW_PG));
  if (reviewPage > totalPages) reviewPage = 1;
  const start    = (reviewPage - 1) * REVIEW_PG;
  const pageRows = filtered.slice(start, start + REVIEW_PG);
  const end      = Math.min(start + REVIEW_PG, filtered.length);

  toolbar.style.display = '';
  document.getElementById('review-page-info').textContent =
    filtered.length < count
      ? `${filtered.length} match${filtered.length !== 1 ? 'es' : ''}. Showing ${start + 1}-${end}`
      : `Showing ${start + 1}–${end} of ${count}`;
  refreshReviewFilterUI();

  const pgEl = document.getElementById('review-pagination');
  pgEl.innerHTML = totalPages <= 1 ? '' :
    `<button onclick="goToReviewPage(${reviewPage - 1})" ${reviewPage === 1 ? 'disabled' : ''}>Prev</button>` +
    `<span class="pagination-info">Page ${reviewPage} / ${totalPages}</span>` +
    `<button onclick="goToReviewPage(${reviewPage + 1})" ${reviewPage === totalPages ? 'disabled' : ''}>Next</button>`;

  if (!pageRows.length) {
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state">
      <p>No Under Review items match your search.</p>
    </div></td></tr>`;
    syncReviewSelectionUI([]);
    return;
  }

  tbody.innerHTML = pageRows.map(r => `<tr>
    <td class="review-select-col"><input type="checkbox" class="review-row-select" value="${r._id}" aria-label="Select ${esc(r.productName) || esc(r.itemCode)}" onchange="toggleReviewSelection('${r._id}', this.checked)"></td>
    <td>${formatDate(r.date)}</td>
    <td class="mono">${esc(r.itemCode)}</td>
    <td>${esc(r.productName) || '—'}</td>
    <td>${esc(r.category) || '—'}</td>
    <td class="mono">${(r.unitsSold || 0).toLocaleString()}</td>
    <td class="mono">${formatPeso(r.sellingPrice)}</td>
    <td class="mono"><strong>${formatPeso(r.totalRevenue)}</strong></td>
    <td class="mono">${formatPeso(r.discount)}</td>
    <td class="mono">${formatPeso(r.srpwdDiscount)}</td>
    <td class="review-action-col">
      <div class="review-actions">
        <input type="text" class="review-cost-input" id="rc-${r._id}" placeholder="Unit cost" autocomplete="off">
        <button class="btn btn-primary btn-xs" onclick="saveReviewRow('${r._id}')">
          Add to Product Master
        </button>
        <button class="btn btn-danger btn-xs review-delete-icon" type="button" title="Delete item" aria-label="Delete ${esc(r.productName) || esc(r.itemCode)}" onclick="openReviewDeleteModal(['${r._id}'])">🗑️</button>
      </div>
    </td>
  </tr>`).join('');
  syncReviewSelectionUI(pageRows);
}

// ─── Import Message ───────────────────────────────────────────────────────────
function showImportMessage(type, html) {
  const msg = document.createElement('div');
  msg.className = `alert ${type === 'error' ? 'alert-danger' : 'alert-info'} mb-24`;
  msg.innerHTML = html;
  const ref = document.getElementById('pos-summary');
  ref.parentNode.insertBefore(msg, ref);
  setTimeout(() => msg.remove(), 7000);
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

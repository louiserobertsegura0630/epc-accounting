// ─── Re-match Under Review ────────────────────────────────────────────────────
document.getElementById('btn-rematch-now').addEventListener('click', async function () {
  if (!requireSalesEditAccess()) return;
  const btn    = this;
  const result = document.getElementById('rematch-result');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Matching…';
  result.textContent = '';
  result.className   = '';
  try {
    const { moved } = await rematchUnderReview();
    if (moved > 0) {
      result.textContent = `✅ ${moved} item${moved > 1 ? 's' : ''} moved to Sales Data`;
      result.className   = 'ok';
    } else {
      result.textContent = 'No new matches found';
      result.className   = '';
    }
  } catch (err) {
    console.error('[Rematch] Error:', err);
    result.textContent = 'Rematching failed. Please review the console for details.';
    result.className   = 'err';
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 Re-match with Product Master';
  }
});

// ─── Drop Zone ────────────────────────────────────────────────────────────────
const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('click',    () => { if (!fileInput.disabled && canEditSalesPage()) fileInput.click(); });
dropZone.addEventListener('dragover',  e => {
  e.preventDefault();
  if (canEditSalesPage()) dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('dragover');
  if (fileInput.disabled || !requireSalesEditAccess()) return;
  if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', function() {
  if (!requireSalesEditAccess()) { this.value = ''; return; }
  if (this.files[0]) processFile(this.files[0]);
  this.value = '';
});

function syncSalesSelectionUI(pageRows = getVisibleSalesRows()) {
  const existingIds = new Set(_salesData.map(row => row._id));
  [...selectedSalesIds].forEach(id => {
    if (!existingIds.has(id)) selectedSalesIds.delete(id);
  });
  document.querySelectorAll('.sales-row-select').forEach(cb => {
    cb.checked = selectedSalesIds.has(cb.value);
  });

  const visibleIds = pageRows.map(row => row._id);
  const selectedVisible = visibleIds.filter(id => selectedSalesIds.has(id)).length;
  const pageSelect = document.getElementById('sales-select-page');
  pageSelect.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
  pageSelect.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  pageSelect.disabled = visibleIds.length === 0;

  const count = selectedSalesIds.size;
  document.getElementById('sales-bulk-count').textContent =
    `${count.toLocaleString()} item${count !== 1 ? 's' : ''} selected`;
  document.getElementById('sales-bulk-toolbar').classList.toggle('open', count > 0);

  const allSelected = _salesData.length > 0 && count === _salesData.length;
  const canSelectAll = visibleIds.length > 0 && selectedVisible === visibleIds.length &&
    _salesData.length > visibleIds.length && !allSelected;
  document.getElementById('sales-select-all-banner').classList.toggle('open', canSelectAll);
  if (canSelectAll) {
    document.getElementById('sales-select-page-message').textContent =
      `${visibleIds.length} item${visibleIds.length !== 1 ? 's' : ''} on this page are selected.`;
    document.getElementById('btn-select-all-sales').textContent =
      `Select all ${_salesData.length.toLocaleString()} items in Sales Data`;
  }
}

function toggleSalesSelection(id, checked) {
  if (!canEditSalesPage()) return;
  if (checked) selectedSalesIds.add(id);
  else selectedSalesIds.delete(id);
  syncSalesSelectionUI();
}

function toggleVisibleSalesRows(checked) {
  if (!canEditSalesPage()) return;
  getVisibleSalesRows().forEach(row => {
    if (checked) selectedSalesIds.add(row._id);
    else selectedSalesIds.delete(row._id);
  });
  syncSalesSelectionUI();
}

function deselectAllSalesRows() {
  selectedSalesIds.clear();
  syncSalesSelectionUI();
}

function selectAllSalesRows() {
  if (!canEditSalesPage()) return;
  _salesData.forEach(row => selectedSalesIds.add(row._id));
  syncSalesSelectionUI();
}

let _itemCodeRefreshTimer = null;

function bindSalesDetailPreviewEvents() {
  ['sales-detail-units-sold', 'sales-detail-selling-price'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', recomputeSalesDetailPreview);
  });
  // When item code changes, refresh Cost Info (debounced to avoid a fetch per keystroke)
  const itemCodeInput = document.getElementById('sales-detail-item-code');
  if (itemCodeInput) {
    itemCodeInput.addEventListener('input', () => {
      clearTimeout(_itemCodeRefreshTimer);
      _itemCodeRefreshTimer = setTimeout(
        () => refreshCostInfoForItemCode(itemCodeInput.value.trim()),
        600
      );
    });
  }
}

function openSalesDeleteModal(ids) {
  if (!requireSalesEditAccess()) return;
  if (salesDeleteInProgress) return;
  pendingSalesDeleteIds = [...new Set(ids)].filter(id => _salesData.some(row => row._id === id));
  if (!pendingSalesDeleteIds.length) return;
  const count = pendingSalesDeleteIds.length;
  document.getElementById('delete-sales-title').textContent =
    `Delete ${count.toLocaleString()} item${count !== 1 ? 's' : ''}?`;
  setSalesDeleteModalBusy(false);
  openModal('modal-delete-sales');
}

function closeSalesDeleteModal() {
  if (salesDeleteInProgress) return;
  pendingSalesDeleteIds = [];
  setSalesDeleteModalBusy(false);
  closeModal('modal-delete-sales');
}

function setSalesDeleteModalBusy(isBusy, label = 'Delete') {
  salesDeleteInProgress = isBusy;
  document.getElementById('btn-close-delete-sales').disabled = isBusy;
  document.getElementById('btn-cancel-delete-sales').disabled = isBusy;
  const btn = document.getElementById('btn-confirm-delete-sales');
  btn.disabled = isBusy;
  btn.innerHTML = label;
}

function salesDeleteProgressLabel(percent) {
  return `<span class="spinner"></span>Deleting... ${percent}%`;
}

async function confirmSalesDelete() {
  if (!requireSalesEditAccess()) return;
  const ids = [...pendingSalesDeleteIds];
  if (!ids.length || salesDeleteInProgress) return;
  setSalesDeleteModalBusy(true, salesDeleteProgressLabel(0));
  try {
    await deleteSalesRows(ids, percent => {
      document.getElementById('btn-confirm-delete-sales').innerHTML =
        salesDeleteProgressLabel(percent);
    });
    const deletedIds = new Set(ids);
    _salesData = _salesData.filter(row => !deletedIds.has(row._id));
    selectedSalesIds.clear();
    document.getElementById('btn-confirm-delete-sales').textContent = '✓ Deleted!';
    await new Promise(resolve => setTimeout(resolve, 1000));
    salesDeleteInProgress = false;
    closeSalesDeleteModal();
    salesPage = 1;
    renderAll();
    logAudit('Delete', 'Sales Record',
      `Deleted ${ids.length.toLocaleString()} sales record${ids.length === 1 ? '' : 's'}`);
  } catch (err) {
    console.error('deleteSalesRows error:', err);
    alert('Could not delete the selected sales records. Please check your connection and try again.');
    setSalesDeleteModalBusy(false);
  }
}

// ─── Tab Switching ────────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  document.getElementById('tab-sales').classList.toggle('active',  tab === 'sales');
  document.getElementById('tab-review').classList.toggle('active', tab === 'review');
  document.getElementById('panel-sales').style.display  = tab === 'sales'  ? '' : 'none';
  document.getElementById('panel-review').style.display = tab === 'review' ? '' : 'none';
  updateRecordsQueryControls();
  if (tab === 'review' && salesRangeStart && salesRangeEnd && !reviewRecordsLoaded) {
    loadSelectedRecords(false);
  }
}

// ─── Under Review ─────────────────────────────────────────────────────────────
function goToReviewPage(p) {
  reviewPage = p;
  renderUnderReview();
}

function saveReviewFilters() {
  localStorage.setItem('underReviewFilters', JSON.stringify(reviewFilters));
}

function matchesReviewRange(value, range) {
  const number = Number(value) || 0;
  if (range?.min !== '' && range?.min != null && number < Number(range.min)) return false;
  if (range?.max !== '' && range?.max != null && number > Number(range.max)) return false;
  return true;
}

function reviewSortValue(row, key) {
  if (['unitsSold', 'sellingPrice', 'totalRevenue', 'discount', 'srpwdDiscount'].includes(key)) return Number(row[key]) || 0;
  return String(row[key] || '').toLowerCase();
}

function getFilteredReviewRows() {
  const { columns } = reviewFilters;
  const query = reviewFilters.query.toLowerCase().trim();
  return [..._reviewData]
    .filter(row => !query || [row.itemCode, row.productName, row.category]
      .some(value => String(value || '').toLowerCase().includes(query)))
    .filter(row => !columns.date.from || String(row.date || '') >= columns.date.from)
    .filter(row => !columns.date.to || String(row.date || '') <= columns.date.to)
    .filter(row => !columns.itemCode || String(row.itemCode || '').toLowerCase().includes(columns.itemCode.toLowerCase()))
    .filter(row => !columns.productName || String(row.productName || '').toLowerCase().includes(columns.productName.toLowerCase()))
    .filter(row => !columns.category || String(row.category || '') === columns.category)
    .filter(row => matchesReviewRange(row.unitsSold, columns.unitsSold))
    .filter(row => matchesReviewRange(row.sellingPrice, columns.sellingPrice))
    .filter(row => matchesReviewRange(row.totalRevenue, columns.totalRevenue))
    .filter(row => matchesReviewRange(row.discount, columns.discount))
    .filter(row => matchesReviewRange(row.srpwdDiscount, columns.srpwdDiscount))
    .sort((a, b) => {
      const aValue = reviewSortValue(a, reviewFilters.sortKey);
      const bValue = reviewSortValue(b, reviewFilters.sortKey);
      const comparison = typeof aValue === 'number' && typeof bValue === 'number'
        ? aValue - bValue
        : String(aValue).localeCompare(String(bValue));
      return comparison * (reviewFilters.sortDir === 'asc' ? 1 : -1);
    });
}

function getVisibleReviewRows(filteredRows = getFilteredReviewRows()) {
  const start = (reviewPage - 1) * REVIEW_PG;
  return filteredRows.slice(start, start + REVIEW_PG);
}

function resetReviewPageAndRender() {
  reviewPage = 1;
  saveReviewFilters();
  renderUnderReview();
}

function setReviewColumnFilter(key, value) {
  reviewFilters.columns[key] = value;
  resetReviewPageAndRender();
}

function setReviewRangeFilter(key, part, value) {
  reviewFilters.columns[key][part] = value;
  resetReviewPageAndRender();
}

function setReviewDateFilter(part, value) {
  reviewFilters.columns.date[part] = value;
  resetReviewPageAndRender();
}

function setReviewSort(key) {
  if (reviewFilters.sortKey === key) {
    reviewFilters.sortDir = reviewFilters.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    reviewFilters.sortKey = key;
    reviewFilters.sortDir = key === 'date' ? 'desc' : 'asc';
  }
  resetReviewPageAndRender();
}

function clearReviewFilters() {
  reviewFilters = freshReviewFilterDefaults();
  resetReviewPageAndRender();
}

function syncReviewSelectionUI(pageRows = getVisibleReviewRows()) {
  const existingIds = new Set(_reviewData.map(r => r._id));
  [...selectedReviewIds].forEach(id => {
    if (!existingIds.has(id)) selectedReviewIds.delete(id);
  });

  document.querySelectorAll('.review-row-select').forEach(cb => {
    cb.checked = selectedReviewIds.has(cb.value);
  });

  const pageSelect = document.getElementById('review-select-page');
  const visibleIds = pageRows.map(r => r._id);
  const selectedVisible = visibleIds.filter(id => selectedReviewIds.has(id)).length;
  pageSelect.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
  pageSelect.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  pageSelect.disabled = visibleIds.length === 0;

  const count = selectedReviewIds.size;
  document.getElementById('review-bulk-count').textContent =
    `${count} item${count !== 1 ? 's' : ''} selected`;
  document.getElementById('btn-delete-review-selected').textContent =
    count > 1 ? 'Delete All Selected' : 'Delete Selected';
  document.getElementById('review-bulk-toolbar').classList.toggle('open', count > 0);

  const filteredRows = getFilteredReviewRows();
  const allSelected = filteredRows.length > 0 && count === filteredRows.length;
  const canSelectAll = visibleIds.length > 0 && selectedVisible === visibleIds.length &&
    filteredRows.length > visibleIds.length && !allSelected;
  const banner = document.getElementById('review-select-all-banner');
  banner.classList.toggle('open', canSelectAll);
  if (canSelectAll) {
    document.getElementById('review-select-page-message').textContent =
      `${visibleIds.length} item${visibleIds.length !== 1 ? 's' : ''} on this page are selected.`;
    document.getElementById('btn-select-all-review').textContent =
      `Select all ${filteredRows.length.toLocaleString()} matching items in Under Review`;
  }
}

function toggleReviewSelection(id, checked) {
  if (!canEditSalesPage()) return;
  if (checked) selectedReviewIds.add(id);
  else selectedReviewIds.delete(id);
  syncReviewSelectionUI();
}

function toggleVisibleReviewRows(checked) {
  if (!canEditSalesPage()) return;
  getVisibleReviewRows().forEach(row => {
    if (checked) selectedReviewIds.add(row._id);
    else selectedReviewIds.delete(row._id);
  });
  syncReviewSelectionUI();
}

function deselectAllReviewRows() {
  selectedReviewIds.clear();
  syncReviewSelectionUI();
}

function selectAllReviewRows() {
  if (!canEditSalesPage()) return;
  getFilteredReviewRows().forEach(row => selectedReviewIds.add(row._id));
  syncReviewSelectionUI();
}

function openReviewDeleteModal(ids) {
  if (!requireSalesEditAccess()) return;
  pendingReviewDeleteIds = [...new Set(ids)].filter(id => _reviewData.some(r => r._id === id));
  if (!pendingReviewDeleteIds.length) return;
  const count = pendingReviewDeleteIds.length;
  document.getElementById('delete-review-title').textContent =
    count > 1
      ? `Delete all ${count.toLocaleString()} selected items?`
      : 'Delete this item?';
  document.getElementById('delete-review-message').textContent =
    count > 1
      ? `This will permanently remove all ${count.toLocaleString()} selected items from Under Review. This cannot be undone.`
      : 'This will permanently remove this item from Under Review. This cannot be undone.';
  setReviewDeleteModalBusy(false);
  openModal('modal-delete-review');
}

function closeReviewDeleteModal() {
  if (reviewDeleteInProgress) return;
  pendingReviewDeleteIds = [];
  setReviewDeleteModalBusy(false);
  closeModal('modal-delete-review');
}

function setReviewDeleteModalBusy(isBusy, label = 'Delete') {
  reviewDeleteInProgress = isBusy;
  document.getElementById('btn-close-delete-review').disabled = isBusy;
  document.getElementById('btn-cancel-delete-review').disabled = isBusy;
  const btn = document.getElementById('btn-confirm-delete-review');
  btn.disabled = isBusy;
  btn.innerHTML = label;
}

function reviewDeleteProgressLabel(pct) {
  return `<span class="spinner"></span>Deleting... ${pct}%`;
}

async function confirmReviewDelete() {
  if (!requireSalesEditAccess()) return;
  const ids = [...pendingReviewDeleteIds];
  if (!ids.length) return;
  setReviewDeleteModalBusy(true, reviewDeleteProgressLabel(0));
  try {
    await deleteReviewRows(ids, pct => {
      document.getElementById('btn-confirm-delete-review').innerHTML =
        reviewDeleteProgressLabel(pct);
    });
    const deletedIds = new Set(ids);
    _reviewData = _reviewData.filter(row => !deletedIds.has(row._id));
    selectedReviewIds.clear();
    document.getElementById('btn-confirm-delete-review').textContent = '✓ Deleted!';
    await new Promise(resolve => setTimeout(resolve, 1000));
    reviewDeleteInProgress = false;
    closeReviewDeleteModal();
    renderAll();
    logAudit('Delete', 'Under Review',
      `Deleted ${ids.length.toLocaleString()} under-review item${ids.length === 1 ? '' : 's'}`);
  } catch (err) {
    console.error('deleteReviewRows error:', err);
    alert('Could not delete the selected items. Please check your connection and try again.');
    setReviewDeleteModalBusy(false);
  }
}

// ─── CSV Export — column definitions ─────────────────────────────────────────
// Each entry: { header: string, value: row => string }
// Matches the on-screen table column order for each tab exactly.

const SALES_DATA_EXPORT_COLS = [
  { header: 'Date',                   value: r => r.date ?? '' },
  { header: 'Item Code',              value: r => r.itemCode ?? '' },
  { header: 'Product Name',           value: r => r.productName ?? '' },
  { header: 'Category',               value: r => r.category ?? '' },
  { header: 'Selling Price',          value: r => r.sellingPrice ?? '' },
  { header: 'Quantity',               value: r => r.unitsSold ?? '' },
  { header: 'Discount',               value: r => r.discount ?? '' },
  { header: 'SR/PWD Discount',        value: r => r.srpwdDiscount ?? '' },
  { header: 'Total Revenue Received', value: r => r.totalRevenue ?? '' },
  { header: 'Unit Cost',              value: r => r.unitCost ?? '' },
  { header: 'Gross Profit',           value: r => r.grossProfit ?? '' },
  { header: 'Margin %',               value: r => Number(r.margin || 0).toFixed(4) },
  { header: 'Flag',                   value: r => salesFlagType(r) },
];

const UNDER_REVIEW_EXPORT_COLS = [
  { header: 'Date',                   value: r => r.date ?? '' },
  { header: 'Item Code',              value: r => r.itemCode ?? '' },
  { header: 'Product Name',           value: r => r.productName ?? '' },
  { header: 'Category',               value: r => r.category ?? '' },
  { header: 'Selling Price',          value: r => r.sellingPrice ?? '' },
  { header: 'Quantity',               value: r => r.unitsSold ?? '' },
  { header: 'Discount',               value: r => r.discount ?? '' },
  { header: 'SR/PWD Discount',        value: r => r.srpwdDiscount ?? '' },
  { header: 'Total Revenue Received', value: r => r.totalRevenue ?? '' },
];

// ─── CSV helpers ──────────────────────────────────────────────────────────────
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCSV(cols, rows) {
  const header = cols.map(c => csvEscape(c.header)).join(',');
  const body   = rows.map(r => cols.map(c => csvEscape(c.value(r))).join(','));
  return [header, ...body].join('\n');
}

function triggerCSVDownload(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ─── Export chooser modal ─────────────────────────────────────────────────────
function openExportChooser() {
  const range = validateSelectedRecordRange();
  if (!range) return;
  document.getElementById('export-chooser-progress').textContent = '';
  document.getElementById('btn-export-chooser-go').disabled = false;
  document.getElementById('btn-export-chooser-go').textContent = 'Export';
  openModal('modal-export-chooser');
}

async function runExportFromChooser() {
  const range = validateSelectedRecordRange();
  if (!range) return;
  const { start, end } = range;

  const choice = document.querySelector('input[name="export-dataset"]:checked')?.value ?? 'sales';
  const goBtn  = document.getElementById('btn-export-chooser-go');
  const prog   = document.getElementById('export-chooser-progress');
  const exportBtn = document.getElementById('btn-export-sales-csv');

  goBtn.disabled = true;
  exportBtn.disabled = true;

  const doExport = async (label, colDef, fetchFn, fileSlug) => {
    const total = label === 'Sales Data' ? salesTotalRecords : reviewTotalRecords;
    const totalStr = total != null ? ` / ${total.toLocaleString()}` : '';
    prog.textContent = `Exporting ${label}… 0${totalStr}`;
    goBtn.textContent = `Exporting…`;

    const onProgress = n => {
      prog.textContent = `Exporting ${label}… ${n.toLocaleString()}${totalStr}`;
    };

    const rows = await fetchFn(start, end, onProgress);
    if (!rows || !rows.length) {
      prog.textContent = `No records found for ${label} in this date range.`;
      return false;
    }
    triggerCSVDownload(rowsToCSV(colDef, rows), `${fileSlug}_${start}_to_${end}.csv`);
    return rows.length;
  };

  try {
    if (choice === 'sales' || choice === 'both') {
      const n = await doExport('Sales Data', SALES_DATA_EXPORT_COLS, exportSalesDataRange, 'sales-data');
      if (choice === 'sales' && n === false) return; // empty — keep modal open
    }
    if (choice === 'review' || choice === 'both') {
      const n = await doExport('Under Review', UNDER_REVIEW_EXPORT_COLS, exportUnderReviewRange, 'under-review');
      if (choice === 'review' && n === false) return;
    }
    const totalExported = choice === 'both' ? 'both files' : 'done';
    prog.textContent = `✅ Export complete (${totalExported})`;
    goBtn.textContent = 'Done';
    setTimeout(() => closeModal('modal-export-chooser'), 1200);
  } catch (err) {
    console.error('[Export] CSV export failed:', err);
    prog.textContent = `Export failed: ${err.message}`;
    goBtn.disabled = false;
    goBtn.textContent = 'Retry';
  } finally {
    exportBtn.disabled = false;
  }
}

// ─── Manual Sales Entry ───────────────────────────────────────────────────────
function salesCSVValue(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

let manualSalesProduct = null;

function resetManualSalesEntryModal() {
  manualSalesProduct = null;
  [
    'sales-entry-item-code',
    'sales-entry-product-name',
    'sales-entry-category',
    'sales-entry-qty',
    'sales-entry-price',
    'sales-entry-total'
  ].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('sales-entry-date').value = todayISO();
  document.getElementById('sales-entry-cost-preview').textContent =
    'Enter an item code to load Product Master cost.';
}

async function refreshManualSalesProduct() {
  const code = document.getElementById('sales-entry-item-code').value.trim();
  manualSalesProduct = code ? await lookupProductMasterByItemCode(code) : null;
  document.getElementById('sales-entry-product-name').value =
    manualSalesProduct?.productName || manualSalesProduct?.name || '';
  document.getElementById('sales-entry-category').value =
    manualSalesProduct?.category || 'Uncategorized';
  document.getElementById('sales-entry-cost-preview').textContent = manualSalesProduct
    ? `Unit cost: ${formatPeso(productCostForMethod(manualSalesProduct))}`
    : 'No Product Master record found for this item code.';
  updateManualSalesTotal();
}

function updateManualSalesTotal() {
  const qty = Number(document.getElementById('sales-entry-qty').value) || 0;
  const price = Number(document.getElementById('sales-entry-price').value) || 0;
  document.getElementById('sales-entry-total').value = formatPeso(qty * price);
}

async function saveManualSalesEntryFromModal() {
  if (!requireSalesEditAccess()) return;
  const date = document.getElementById('sales-entry-date').value;
  const itemCode = document.getElementById('sales-entry-item-code').value.trim();
  const unitsSold = Number(document.getElementById('sales-entry-qty').value) || 0;
  const sellingPrice = Number(document.getElementById('sales-entry-price').value) || 0;
  if (itemCode && (!manualSalesProduct ||
      String(manualSalesProduct.itemCode || manualSalesProduct.code || '').trim() !== itemCode)) {
    await refreshManualSalesProduct();
  }
  if (!date || !itemCode || unitsSold <= 0 || sellingPrice < 0 || !manualSalesProduct) {
    alert('Please enter a valid date, item code, quantity, and selling price.');
    return;
  }

  const inventoryCostMap = await loadInventoryUnitCostMap([itemCode]);
  const unitCost = inventoryUnitCostForCode(inventoryCostMap, itemCode) || productCostForMethod(manualSalesProduct);
  const totalRevenue = unitsSold * sellingPrice;
  const totalCost = unitsSold * unitCost;
  const grossProfit = salesGrossProfitAmount({ unitsSold, unitCost, totalCost, sellingPrice, totalRevenue });
  const margin = salesMarginPercent(grossProfit, { unitsSold, unitCost, totalCost, sellingPrice, totalRevenue });
  const doc = {
    date,
    itemCode,
    productName: manualSalesProduct.productName || manualSalesProduct.name || '',
    category: manualSalesProduct.category || 'Uncategorized',
    unitsSold,
    unitCost,
    totalCost,
    sellingPrice,
    totalRevenue,
    grossProfit,
    margin,
    importedAt: new Date().toISOString(),
    filename: 'Manual Entry',
    costMethod
  };
  doc.nameLower = salesNameLower(doc.productName);

  const button = document.getElementById('btn-save-sales-entry');
  button.disabled = true;
  button.textContent = 'Saving...';
  try {
    const saved = await saveManualSalesEntry(doc);
    _salesData.unshift(saved);
    closeModal('modal-sales-entry');
    renderAll();
    logAudit('Create', 'Sales Record',
      `Added manual sale ${itemCode} - ${unitsSold.toLocaleString()} units on ${formatDate(date)}`);
  } catch (err) {
    console.error('[Manual Sales Entry] Save failed:', err);
    alert('Could not save this sales entry. Please check your connection and try again.');
  } finally {
    button.disabled = false;
    button.textContent = 'Save Entry';
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────
function validateSelectedRecordRange() {
  const start = document.getElementById('records-date-start').value;
  const end = document.getElementById('records-date-end').value;
  if (!start || !end) {
    alert('Select a start and end date first.');
    return null;
  }
  if (start > end) {
    alert('Start date must be before or equal to end date.');
    return null;
  }
  return { start, end };
}

function setRecordsLoading(isLoading) {
  salesRecordsLoading = activeTab === 'sales' && isLoading;
  reviewRecordsLoading = activeTab === 'review' && isLoading;
  document.getElementById('btn-show-records').disabled = isLoading;
  document.getElementById('btn-load-more-records').disabled = isLoading;
  document.getElementById('records-load-limit').disabled = isLoading;
  document.getElementById('records-query-status').textContent = isLoading ? 'Loading records...' : '';
}

function updateRecordsQueryControls() {
  const loadMore = document.getElementById('btn-load-more-records');
  const isSales = activeTab === 'sales';
  const hasMore = isSales ? salesHasMoreRecords : reviewHasMoreRecords;
  const loaded = isSales ? salesRecordsLoaded : reviewRecordsLoaded;
  const searchMode = isSales ? salesSearchMode : reviewSearchMode;
  const loadedCount = isSales ? salesBrowseData.length : reviewBrowseData.length;
  const total = isSales ? salesTotalRecords : reviewTotalRecords;
  loadMore.style.display = loaded && hasMore ? '' : 'none';
  loadMore.disabled = searchMode || !hasMore;
  if (searchMode) {
    document.getElementById('records-query-status').textContent =
      `Search results for '${isSales ? salesSearchTerm : reviewSearchTerm}'`;
  } else if (loaded) {
    document.getElementById('records-query-status').textContent =
      total == null
        ? `${loadedCount.toLocaleString()} shown | total unavailable`
        : `${loadedCount.toLocaleString()} shown | ${total.toLocaleString()} total`;
  } else {
    document.getElementById('records-query-status').textContent = '';
  }
  document.getElementById('btn-clear-sales-search').style.display = salesSearchMode ? '' : 'none';
  document.getElementById('btn-clear-review-search').style.display = reviewSearchMode ? '' : 'none';
}

async function loadSelectedRecords(append = false) {
  const range = validateSelectedRecordRange();
  if (!range) return;
  if (!append || range.start !== salesRangeStart || range.end !== salesRangeEnd) {
    const rangeChanged = range.start !== salesRangeStart || range.end !== salesRangeEnd;
    salesRangeStart = range.start;
    salesRangeEnd = range.end;
    if (rangeChanged) {
      salesLastDocSnapshot = null;
      salesHasMoreRecords = false;
      salesRecordsLoaded = false;
      salesTotalRecords = null;
      salesTotalRevenue = null;
      salesBrowseData = [];
      salesSearchMode = false;
      salesSearchTerm = '';
      _salesData = [];
      selectedSalesIds.clear();
      reviewLastDocSnapshot = null;
      reviewHasMoreRecords = false;
      reviewRecordsLoaded = false;
      reviewTotalRecords = null;
      reviewTotalRevenue = null;
      reviewBrowseData = [];
      reviewSearchMode = false;
      reviewSearchTerm = '';
      _reviewData = [];
      selectedReviewIds.clear();
    }
    if (activeTab === 'sales') {
      salesLastDocSnapshot = null;
      salesHasMoreRecords = false;
      salesRecordsLoaded = false;
      salesTotalRecords = null;
      salesTotalRevenue = null;
      salesBrowseData = [];
      salesSearchMode = false;
      salesSearchTerm = '';
      _salesData = [];
      selectedSalesIds.clear();
    } else {
      reviewLastDocSnapshot = null;
      reviewHasMoreRecords = false;
      reviewRecordsLoaded = false;
      reviewTotalRecords = null;
      reviewTotalRevenue = null;
      reviewBrowseData = [];
      reviewSearchMode = false;
      reviewSearchTerm = '';
      _reviewData = [];
      selectedReviewIds.clear();
    }
  }

  setRecordsLoading(true);
  try {
    if (activeTab === 'sales') {
      _salesData = await loadSalesData({ append });
      salesPage = 1;
      selectedSalesIds.clear();
    } else {
      _reviewData = await loadUnderReview({ append });
      reviewPage = 1;
      selectedReviewIds.clear();
    }
  } catch (err) {
    console.error('[Sales Records] Range load failed:', err);
    if (typeof showDatabaseConnectionBanner === 'function') showDatabaseConnectionBanner();
    showImportMessage('error', "Can't reach the database. Records were not loaded.");
  } finally {
    setRecordsLoading(false);
    renderAll();
    updateRecordsQueryControls();
  }
}

async function runRecordSearch() {
  const isSales = activeTab === 'sales';
  const input = document.getElementById(isSales ? 'search-pos' : 'review-search');
  const term = input.value.trim();
  if (!term) {
    alert('Enter an item code or product name to search.');
    return;
  }
  setRecordsLoading(true);
  try {
    if (isSales) {
      _salesData = await searchSalesData(term);
      salesPage = 1;
      selectedSalesIds.clear();
    } else {
      _reviewData = await searchUnderReview(term);
      reviewPage = 1;
      selectedReviewIds.clear();
    }
  } catch (err) {
    console.error('[Sales Records] Search failed:', err);
    if (typeof showDatabaseConnectionBanner === 'function') showDatabaseConnectionBanner();
    const indexUrl = String(err?.message || '').match(/https:\/\/console\.firebase\.google\.com[^\s)]+/)?.[0];
    showImportMessage('error', indexUrl
      ? `Search needs a Firestore index. Click the index link in the browser console or open this link: <a href="${indexUrl}" target="_blank" rel="noopener">Create index</a>.`
      : 'Search failed. Please check your connection and try again.');
  } finally {
    setRecordsLoading(false);
    renderAll();
    updateRecordsQueryControls();
  }
}

function clearRecordSearch(tab = activeTab) {
  if (tab === 'sales') {
    salesSearchMode = false;
    salesSearchTerm = '';
    document.getElementById('search-pos').value = '';
    salesFilters.query = '';
    _salesData = salesBrowseData;
    salesHasMoreRecords = salesTotalRecords == null
      ? salesBrowseData.length >= getRecordsLoadLimit()
      : salesBrowseData.length < salesTotalRecords;
    salesPage = 1;
    selectedSalesIds.clear();
  } else {
    reviewSearchMode = false;
    reviewSearchTerm = '';
    document.getElementById('review-search').value = '';
    reviewFilters.query = '';
    _reviewData = reviewBrowseData;
    reviewHasMoreRecords = reviewTotalRecords == null
      ? reviewBrowseData.length >= getRecordsLoadLimit()
      : reviewBrowseData.length < reviewTotalRecords;
    reviewPage = 1;
    selectedReviewIds.clear();
  }
  renderAll();
  updateRecordsQueryControls();
}

document.getElementById('btn-show-records').addEventListener('click', () => loadSelectedRecords(false));
document.getElementById('btn-load-more-records').addEventListener('click', () => loadSelectedRecords(true));
document.getElementById('btn-export-sales-csv').addEventListener('click', openExportChooser);
document.getElementById('btn-export-chooser-go').addEventListener('click', runExportFromChooser);
document.getElementById('records-load-limit').addEventListener('change', () => getRecordsLoadLimit());
document.getElementById('records-load-limit').addEventListener('blur', () => getRecordsLoadLimit());
document.getElementById('btn-search-sales').addEventListener('click', runRecordSearch);
document.getElementById('btn-search-review').addEventListener('click', runRecordSearch);
document.getElementById('btn-clear-sales-search').addEventListener('click', () => clearRecordSearch('sales'));
document.getElementById('btn-clear-review-search').addEventListener('click', () => clearRecordSearch('review'));
document.getElementById('btn-add-sales-entry').addEventListener('click', () => {
  if (!requireSalesEditAccess()) return;
  resetManualSalesEntryModal();
  openModal('modal-sales-entry');
});
document.getElementById('sales-entry-item-code').addEventListener('blur', refreshManualSalesProduct);
document.getElementById('sales-entry-qty').addEventListener('input', updateManualSalesTotal);
document.getElementById('sales-entry-price').addEventListener('input', updateManualSalesTotal);
document.getElementById('btn-save-sales-entry').addEventListener('click', saveManualSalesEntryFromModal);
document.getElementById('filter-month').addEventListener('change', () => {
  salesFilters.month = document.getElementById('filter-month').value;
  resetSalesPageAndRender();
});
document.getElementById('search-pos').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') runRecordSearch();
});
document.getElementById('filter-sales-flag').addEventListener('change', function() {
  salesFilters.toolbarFlag = this.value;
  resetSalesPageAndRender();
});
document.getElementById('btn-clear-sales-filters').addEventListener('click', clearSalesFilters);
document.getElementById('margin-high-threshold').value = marginHighThreshold;
document.getElementById('margin-low-threshold').value = marginLowThreshold;
document.getElementById('btn-apply-margin-thresholds').addEventListener('click', () => {
  if (!requireSalesEditAccess()) return;
  const high = Number(document.getElementById('margin-high-threshold').value);
  const low  = Number(document.getElementById('margin-low-threshold').value);
  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    alert('Please enter valid margin thresholds.');
    return;
  }
  marginHighThreshold = high;
  marginLowThreshold = low;
  localStorage.setItem('marginHighThreshold', String(high));
  localStorage.setItem('marginLowThreshold', String(low));
  logAudit('Settings', 'Sales Margin Thresholds', `Updated margin thresholds - high ${high}%, low ${low}%`);
  renderAll();
});
document.getElementById('pos-tbody').addEventListener('click', event => {
  if (event.target.closest('input, button, a, select')) return;
  const row = event.target.closest('[data-sales-id]');
  if (row) openItemDetailModal(row.dataset.salesId);
});
document.getElementById('sales-select-page').addEventListener('change', function() {
  toggleVisibleSalesRows(this.checked);
});
document.getElementById('btn-delete-sales-selected').addEventListener('click', () => {
  openSalesDeleteModal([...selectedSalesIds]);
});
document.getElementById('btn-deselect-sales').addEventListener('click', deselectAllSalesRows);
document.getElementById('btn-select-all-sales').addEventListener('click', selectAllSalesRows);
document.getElementById('btn-confirm-delete-sales').addEventListener('click', confirmSalesDelete);
document.getElementById('modal-delete-sales').addEventListener('click', function(e) {
  if (salesDeleteInProgress && e.target === this) e.stopImmediatePropagation();
});
document.querySelectorAll('input[name="cost-method"]').forEach(input => {
  input.checked = input.value === costMethod;
  input.addEventListener('change', function() {
    if (!requireSalesEditAccess()) {
      this.checked = this.value === costMethod;
      return;
    }
    if (!this.checked) return;
    costMethod = this.value;
    localStorage.setItem('costMethod', costMethod);
    logAudit('Settings', 'Sales COGS Method', `Changed COGS method to ${costMethod === 'average' ? 'Average Price' : 'Latest Price'}`);
    recomputeAllSalesCOGS();
  });
});
document.getElementById('review-search').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') runRecordSearch();
});
document.getElementById('btn-clear-review-filters').addEventListener('click', clearReviewFilters);
document.getElementById('review-select-page').addEventListener('change', function() {
  toggleVisibleReviewRows(this.checked);
});
document.getElementById('btn-delete-review-selected').addEventListener('click', () => {
  if (!requireSalesEditAccess()) return;
  openReviewDeleteModal([...selectedReviewIds]);
});
document.getElementById('btn-deselect-review').addEventListener('click', deselectAllReviewRows);
document.getElementById('btn-select-all-review').addEventListener('click', selectAllReviewRows);
document.getElementById('btn-confirm-delete-review').addEventListener('click', confirmReviewDelete);
document.getElementById('modal-delete-review').addEventListener('click', function(e) {
  if (reviewDeleteInProgress && e.target === this) e.stopImmediatePropagation();
});
document.addEventListener('keydown', function(e) {
  if ((salesDeleteInProgress || reviewDeleteInProgress) && e.key === 'Escape') e.stopImmediatePropagation();
}, true);

// ─── Page initialisation — render empty until a bounded range is requested ───
async function initPage() {
  const overlay = document.getElementById('page-loading');
  const now = new Date();
  const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const end = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()).padStart(2, '0')}`;
  document.getElementById('records-date-start').value = start;
  document.getElementById('records-date-end').value = end;
  overlay.style.display = 'none';
  renderAll();
  updateRecordsQueryControls();
}

function handleSalesAuthReady() {
  salesPageAuthReady = true;
  applySalesPagePermissions();
  renderAll();
  if (canEditSalesPage() && _salesData.some(row => row.costMethod !== costMethod)) {
    recomputeAllSalesCOGS();
  }
}

document.addEventListener('epc-auth-ready', handleSalesAuthReady);
if (typeof hasEPCSession === 'function' && hasEPCSession()) handleSalesAuthReady();

initPage();

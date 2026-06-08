
initSidebar('purchases');

let purchaseImportPreviewRows = [];

// ─── Additions list ──────────────────────────────────────────────────────────
function addAdditionRow(desc = '', amount = '') {
  const list = document.getElementById('additions-list');
  const row  = document.createElement('div');
  row.className = 'addition-row';
  row.innerHTML = `
    <input type="text" class="form-input" placeholder="Description (e.g. Freight, Rebate)" value="${desc}">
    <input type="text" class="form-input addition-amount" data-currency placeholder="0.00" value="${amount}">
    <button type="button" class="remove-btn" title="Remove">×</button>`;

  row.querySelector('.remove-btn').addEventListener('click', () => { row.remove(); calcFields(); });
  row.querySelector('.addition-amount').addEventListener('input', calcFields);
  row.querySelector('.addition-amount').addEventListener('blur', function() {
    const v = parsePeso(this.value);
    if (this.value !== '') this.value = formatNum(v);
  });
  row.querySelector('.addition-amount').addEventListener('focus', function() {
    const v = parsePeso(this.value);
    this.value = v || '';
  });

  list.appendChild(row);
  row.querySelector('input[type="text"]').focus();
  calcFields();
}

function getAdditions() {
  return [...document.querySelectorAll('#additions-list .addition-row')].map(row => ({
    desc:   row.querySelector('input[type="text"]').value.trim(),
    amount: parsePeso(row.querySelector('.addition-amount').value) || 0,
  })).filter(a => a.amount > 0 || a.desc);
}

document.getElementById('btn-add-addition').addEventListener('click', () => addAdditionRow());

// ─── Purchase ledger import ─────────────────────────────────────────────────
function normalizePurchaseHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseLedgerMoney(value) {
  const text = String(value ?? '').replace(/php/ig, '').replace(/,/g, '').trim();
  if (!text || text === '-') return 0;
  const num = Number(text);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function parseLedgerText(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const serial = (Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) - Date.UTC(1899, 11, 30)) / 86400000;
    return Number.isInteger(serial) ? String(serial) : String(Number(serial.toFixed(5)));
  }
  const text = String(value ?? '').trim();
  return !text || text === '-' ? '' : text;
}

function parseLedgerDate(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) return localLedgerISO(value);
  if (typeof value === 'number' && typeof XLSX !== 'undefined') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return localLedgerISO(new Date(parsed.y, parsed.m - 1, parsed.d));
  }
  const text = String(value).trim();
  if (!text || text === '-') return '';
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : localLedgerISO(parsed);
}

function localLedgerISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function emptyLedgerRow(row) {
  return row.every(cell => String(cell ?? '').trim() === '');
}

function ledgerCell(row, headerMap, name) {
  const index = headerMap.get(normalizePurchaseHeader(name));
  return index == null ? '' : row[index];
}

function ledgerRowToPurchase(row, headerMap) {
  const date = parseLedgerDate(ledgerCell(row, headerMap, 'Check Voucher Date'));
  const netAmount = parseLedgerMoney(ledgerCell(row, headerMap, 'Purchase Net of Vat'));
  const inputVAT = parseLedgerMoney(ledgerCell(row, headerMap, 'VAT'));
  const grossAmount = parseLedgerMoney(ledgerCell(row, headerMap, 'Purchase Gross of Vat'));
  const discounts = parseLedgerMoney(ledgerCell(row, headerMap, 'Discounts'));
  const badOrder = parseLedgerMoney(ledgerCell(row, headerMap, 'Bad Orders'));
  const returnsValue = parseLedgerMoney(ledgerCell(row, headerMap, 'Returns'));
  const noStock = parseLedgerMoney(ledgerCell(row, headerMap, 'No Stock'));
  const lacking = parseLedgerMoney(ledgerCell(row, headerMap, 'Lacking'));
  const ewtAmount = parseLedgerMoney(ledgerCell(row, headerMap, 'EWT'));
  const netPayment = parseLedgerMoney(ledgerCell(row, headerMap, 'Net Payment'));
  const runningBalance = parseLedgerMoney(ledgerCell(row, headerMap, 'Running Balance'));
  const otherIncome = parseLedgerMoney(ledgerCell(row, headerMap, 'Other Income'));
  const otherDeductions = parseLedgerMoney(ledgerCell(row, headerMap, 'Other Deductions'));
  const ewtRate = ewtAmount > 0 && netAmount > 0 ? Number((ewtAmount / netAmount * 100).toFixed(2)) : '';
  const totalDeductions = discounts + badOrder + returnsValue + noStock + lacking + otherDeductions;
  const additions = otherIncome ? [{ desc:'Other Income', amount:otherIncome }] : [];
  const checkVoucherNumber = parseLedgerText(ledgerCell(row, headerMap, 'Check Voucher #'));
  const salesInvoiceNumber = parseLedgerText(ledgerCell(row, headerMap, 'Sales Invoice Number'));
  const checkNumber = parseLedgerText(ledgerCell(row, headerMap, 'Check #'));
  const supplier = parseLedgerText(ledgerCell(row, headerMap, 'Supplier')) ||
    parseLedgerText(ledgerCell(row, headerMap, 'Supplier Name')) ||
    'Imported Ledger';

  return {
    id:genId(),
    supplier,
    date,
    checkVoucherNumber,
    deliveryReceiptDate:parseLedgerDate(ledgerCell(row, headerMap, 'Delivery Receipt Date')),
    salesInvoiceNumber,
    checkNumber,
    netAmount,
    total:netAmount,
    inputVAT,
    inputVATCreditable:true,
    grossAmount,
    discounts,
    badOrder,
    returns:returnsValue,
    noStock,
    lacking,
    ewtRate,
    ewtAmount,
    netPayment,
    runningBalance,
    otherIncome,
    otherDeduction:otherDeductions,
    additions,
    totalAdditions:otherIncome,
    totalDeductions,
    netPayable:netPayment || (grossAmount - ewtAmount - totalDeductions + otherIncome),
    status:'Pending',
    remittanceDate:'',
    notes:[
      checkVoucherNumber ? `CV #${checkVoucherNumber}` : '',
      salesInvoiceNumber ? `SI #${salesInvoiceNumber}` : '',
      checkNumber ? `Check #${checkNumber}` : ''
    ].filter(Boolean).join(' · ')
  };
}

async function parsePurchaseLedgerFile(file) {
  if (typeof XLSX === 'undefined') throw new Error('SheetJS is not loaded.');
  const workbook = XLSX.read(await file.arrayBuffer(), { type:'array', cellDates:false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header:1, raw:true, defval:'', blankrows:false });
  const headers = rows[0] || [];
  const headerMap = new Map(headers.map((header, index) => [normalizePurchaseHeader(header), index]));
  const parsed = rows.slice(1)
    .filter(row => !emptyLedgerRow(row))
    .map(row => ledgerRowToPurchase(row, headerMap))
    .filter(row => row.date || row.checkVoucherNumber || row.netAmount || row.grossAmount);
  return parsed;
}

function renderPurchaseImportPreview(rows, fileName) {
  purchaseImportPreviewRows = rows;
  document.getElementById('purchase-import-summary').textContent =
    `${rows.length.toLocaleString()} rows parsed from ${fileName}. ${rows.length.toLocaleString()} ready to import.`;
  const preview = rows.slice(0, 50);
  document.getElementById('purchase-import-preview-body').innerHTML = preview.length ? preview.map(row => `
    <tr>
      <td>${row.date ? formatDate(row.date) : '—'}</td>
      <td class="mono">${row.checkVoucherNumber || '—'}</td>
      <td>${row.deliveryReceiptDate ? formatDate(row.deliveryReceiptDate) : '—'}</td>
      <td class="mono">${row.salesInvoiceNumber || '—'}</td>
      <td class="mono">${row.checkNumber || '—'}</td>
      <td class="mono">${formatPeso(row.netAmount)}</td>
      <td class="mono">${formatPeso(row.inputVAT)}</td>
      <td class="mono">${formatPeso(row.grossAmount)}</td>
      <td class="mono">${formatPeso(row.ewtAmount)}</td>
      <td class="mono">${formatPeso(row.netPayment)}</td>
    </tr>
  `).join('') : '<tr><td colspan="10"><div class="empty-state"><p>No rows found.</p></div></td></tr>';
  openModal('modal-purchase-import');
}

async function handlePurchaseImportFile(file) {
  if (!/\.(csv|xls|xlsx)$/i.test(file.name)) {
    alert('Please upload a CSV, XLS, or XLSX file.');
    return;
  }
  try {
    const rows = await parsePurchaseLedgerFile(file);
    renderPurchaseImportPreview(rows, file.name);
  } catch (error) {
    console.error('[Purchases] Import parse failed:', error);
    alert(`Could not parse purchase ledger: ${error.message}`);
  }
}

function confirmPurchaseImport() {
  if (!purchaseImportPreviewRows.length) return;
  const purchases = DB.get('purchases');
  DB.set('purchases', [...purchases, ...purchaseImportPreviewRows]);
  logAudit('Import', 'Purchases',
    `Imported ${purchaseImportPreviewRows.length.toLocaleString()} purchase ledger rows`);
  purchaseImportPreviewRows = [];
  closeModal('modal-purchase-import');
  populatePurchasesFilterSuppliers();
  renderTable();
  renderSummary();
}

// ─── Compute all fields ───────────────────────────────────────────────────────
function calcFields() {
  const netAmount  = parsePeso(document.getElementById('f-total').value) || 0;
  const inputVAT   = parsePeso(document.getElementById('f-input-vat').value) || 0;
  const grossAmount = netAmount + inputVAT;
  const rate       = parseFloat(document.getElementById('f-ewt-rate').value) || 0;
  const ewt        = netAmount * rate / 100;
  const editId     = document.getElementById('edit-id').value;
  const existing   = editId ? DB.get('purchases').find(p => p.id === editId) : null;
  const ledgerDeductions = (existing?.discounts || 0) + (existing?.noStock || 0);

  const additions  = getAdditions().reduce((s, a) => s + a.amount, 0);

  const ded = ['f-bad-order','f-lacking','f-returns','f-other-ded']
                .reduce((s, id) => s + (parsePeso(document.getElementById(id).value) || 0), ledgerDeductions);

  const netPayable = grossAmount - ewt - ded + additions;

  document.getElementById('f-gross-amount').value  = formatNum(grossAmount);
  document.getElementById('f-ewt-amount').value    = formatNum(ewt);
  document.getElementById('f-total-add').value     = formatNum(additions);
  document.getElementById('f-total-ded').value     = formatNum(ded);
  document.getElementById('f-net-payable').value   = formatNum(netPayable);
}

document.getElementById('f-total').addEventListener('input', function() {
  const net = parsePeso(this.value) || 0;
  document.getElementById('f-input-vat').value = net ? formatNum(net * 0.12) : '';
  calcFields();
});
document.getElementById('f-input-vat').addEventListener('input', calcFields);
['f-ewt-rate','f-bad-order','f-lacking','f-returns','f-other-ded'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', calcFields);
});

// ─── Reset form ───────────────────────────────────────────────────────────────
function resetForm() {
  document.getElementById('edit-id').value = '';
  document.getElementById('modal-purchase-title').textContent = 'Add Purchase';
  ['f-total','f-input-vat','f-bad-order','f-lacking','f-returns','f-other-ded','f-notes'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('f-date').value = todayISO();
  document.getElementById('f-ewt-rate').value = '2';
  document.getElementById('f-input-vat-creditable').value = 'yes';
  document.getElementById('additions-list').innerHTML = '';
  calcFields();
  populateSupplierDropdown(document.getElementById('f-supplier'));
}

// ─── Summary ──────────────────────────────────────────────────────────────────
function renderSummary() {
  const purch      = DB.get('purchases');
  const totalNet   = purch.reduce((s,p) => s+(p.netAmount??p.total??0), 0);
  const totalVAT   = purch.reduce((s,p) => s+(p.inputVAT||0), 0);
  const totalGross = purch.reduce((s,p) => s+(p.grossAmount??((p.netAmount??p.total??0)+(p.inputVAT||0))), 0);
  const totalEwt   = purch.reduce((s,p) => s+(p.ewtAmount||0), 0);

  document.getElementById('summary-row').innerHTML = `
    <div class="summary-card">
      <div class="kpi-label">Total Net Amount (Excl. VAT)</div>
      <div class="kpi-value">${formatPeso(totalNet)}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Total Input VAT</div>
      <div class="kpi-value" style="color:#b45309">${formatPeso(totalVAT)}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Total Gross Amount</div>
      <div class="kpi-value blue">${formatPeso(totalGross)}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Total EWT Withheld</div>
      <div class="kpi-value" style="color:var(--primary)">${formatPeso(totalEwt)}</div>
    </div>`;
}

// ─── Sort & Filter State ──────────────────────────────────────────────────────
let pSortCol = 'date', pSortDir = 'desc';
let purchaseCurrentPage = 1;
const selectedPurchaseIds = new Set();
const purchaseColumnFilters = {};
const PURCHASE_ROWS_PER_PAGE = 100;
const PURCHASE_LEDGER_COLUMNS = [
  { key:'date', label:'Check Voucher Date', type:'date', value:p => p.date || '' },
  { key:'supplier', label:'Supplier', type:'text', value:p => p.supplier || '' },
  { key:'checkVoucherNumber', label:'Check Voucher #', type:'text', value:p => p.checkVoucherNumber || '' },
  { key:'deliveryReceiptDate', label:'Delivery Receipt Date', type:'date', value:p => p.deliveryReceiptDate || '' },
  { key:'salesInvoiceNumber', label:'Sales Invoice Number', type:'text', value:p => cleanLedgerIdentifier(p.salesInvoiceNumber) },
  { key:'checkNumber', label:'Check #', type:'text', value:p => cleanLedgerIdentifier(p.checkNumber) },
  { key:'netAmount', label:'Purchase Net of Vat', type:'money', value:p => Number(p.netAmount ?? p.total ?? 0) || 0 },
  { key:'inputVAT', label:'VAT', type:'money', value:p => Number(p.inputVAT || 0) || 0 },
  { key:'grossAmount', label:'Purchase Gross of Vat', type:'money', value:p => Number(p.grossAmount ?? ((p.netAmount ?? p.total ?? 0) + (p.inputVAT || 0))) || 0 },
  { key:'discounts', label:'Discounts', type:'money', value:p => Number(p.discounts || 0) || 0 },
  { key:'badOrder', label:'Bad Orders', type:'money', value:p => Number(p.badOrder || 0) || 0 },
  { key:'returns', label:'Returns', type:'money', value:p => Number(p.returns || 0) || 0 },
  { key:'noStock', label:'No Stock', type:'money', value:p => Number(p.noStock || 0) || 0 },
  { key:'lacking', label:'Lacking', type:'money', value:p => Number(p.lacking || 0) || 0 },
  { key:'ewtAmount', label:'EWT', type:'money', value:p => Number(p.ewtAmount || 0) || 0 },
  { key:'netPayment', label:'Net Payment', type:'money', value:p => Number(p.netPayment ?? p.netPayable ?? 0) || 0 },
  { key:'runningBalance', label:'Running Balance', type:'money', value:p => Number(p.runningBalance || 0) || 0 },
  { key:'otherIncome', label:'Other Income', type:'money', value:p => Number(p.otherIncome || p.totalAdditions || 0) || 0 },
  { key:'otherDeduction', label:'Other Deductions', type:'money', value:p => Number(p.otherDeduction ?? p.otherDeductions ?? 0) || 0 },
];

function escPurchase(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function purchaseColumn(key) {
  return PURCHASE_LEDGER_COLUMNS.find(column => column.key === key);
}

function purchaseColumnValue(row, key) {
  const column = purchaseColumn(key);
  return column ? column.value(row) : row[key];
}

function cleanLedgerIdentifier(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return parseLedgerText(value);
  const text = String(value ?? '').trim();
  if (/\bGMT[+-]\d{4}\b/.test(text)) {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parseLedgerText(parsed);
  }
  return text;
}

function populatePurchasesFilterSuppliers() {
  const sel  = document.getElementById('filter-supplier-purchases');
  const prev = sel.value;
  const names = new Set([
    ...DB.get('suppliers').map(s => s.name).filter(Boolean),
    ...DB.get('purchases').map(p => p.supplier).filter(Boolean)
  ]);
  sel.innerHTML = '<option value="">All Suppliers</option>' +
    [...names].sort().map(name => `<option value="${name}">${name}</option>`).join('');
  sel.value = prev;
}

function ensurePurchaseSupplierOption(select, supplier) {
  if (!supplier || [...select.options].some(option => option.value === supplier)) return;
  select.insertAdjacentHTML('beforeend', `<option value="${supplier}">${supplier}</option>`);
}

function getPurchaseRows() {
  const search   = document.getElementById('search-purchases').value.toLowerCase();
  const dateFrom = document.getElementById('filter-date-from').value;
  const dateTo   = document.getElementById('filter-date-to').value;
  const supplier = document.getElementById('filter-supplier-purchases').value;

  let rows = DB.get('purchases');
  if (search) rows = rows.filter(p => [
    p.supplier, p.notes, p.checkVoucherNumber, p.salesInvoiceNumber, p.checkNumber
  ].some(value => String(value || '').toLowerCase().includes(search)));
  if (dateFrom)      rows = rows.filter(p => p.date >= dateFrom);
  if (dateTo)        rows = rows.filter(p => p.date <= dateTo);
  if (supplier)      rows = rows.filter(p => p.supplier === supplier);
  rows = rows.filter(row => PURCHASE_LEDGER_COLUMNS.every(column => purchaseFilterMatches(row, column)));

  rows.sort((a, b) => {
    let av = purchaseColumnValue(a, pSortCol), bv = purchaseColumnValue(b, pSortCol);
    if (typeof av === 'string' || typeof bv === 'string') {
      av = String(av || '').toLowerCase(); bv = String(bv || '').toLowerCase();
    } else {
      av = Number(av) || 0; bv = Number(bv) || 0;
    }
    if (av < bv) return pSortDir === 'asc' ? -1 : 1;
    if (av > bv) return pSortDir === 'asc' ? 1 : -1;
    return 0;
  });
  return rows;
}

function purchaseFilterMatches(row, column) {
  const filter = purchaseColumnFilters[column.key];
  if (!filter) return true;
  const value = purchaseColumnValue(row, column.key);
  if (column.type === 'date') {
    return (!filter.from || String(value || '') >= filter.from) &&
      (!filter.to || String(value || '') <= filter.to);
  }
  if (column.type === 'money') {
    const num = Number(value) || 0;
    return (filter.min === '' || filter.min == null || num >= Number(filter.min)) &&
      (filter.max === '' || filter.max == null || num <= Number(filter.max));
  }
  return !filter.text || String(value || '').toLowerCase().includes(String(filter.text).toLowerCase());
}

function setPurchaseColumnFilter(key, value, part = 'text') {
  purchaseColumnFilters[key] = purchaseColumnFilters[key] || {};
  purchaseColumnFilters[key][part] = value;
  purchaseCurrentPage = 1;
  renderTable();
}

function setPurchaseSort(col) {
  pSortDir = pSortCol === col ? (pSortDir === 'asc' ? 'desc' : 'asc') : 'desc';
  pSortCol = col;
  renderTable();
}

function purchaseFilterInput(column) {
  const filter = purchaseColumnFilters[column.key] || {};
  if (column.type === 'date') {
    return `<div class="purchase-filter-range">
      <input type="date" class="purchase-filter-input" value="${filter.from || ''}" onchange="setPurchaseColumnFilter('${column.key}',this.value,'from')">
      <input type="date" class="purchase-filter-input" value="${filter.to || ''}" onchange="setPurchaseColumnFilter('${column.key}',this.value,'to')">
    </div>`;
  }
  if (column.type === 'money') {
    return `<div class="purchase-filter-range">
      <input type="number" class="purchase-filter-input" placeholder="Min" value="${filter.min || ''}" onchange="setPurchaseColumnFilter('${column.key}',this.value,'min')">
      <input type="number" class="purchase-filter-input" placeholder="Max" value="${filter.max || ''}" onchange="setPurchaseColumnFilter('${column.key}',this.value,'max')">
    </div>`;
  }
  return `<input type="text" class="purchase-filter-input" placeholder="Filter..." value="${escPurchase(filter.text || '')}" onchange="setPurchaseColumnFilter('${column.key}',this.value,'text')">`;
}

function renderPurchaseHeader(pageRows) {
  const allVisibleSelected = pageRows.length > 0 && pageRows.every(row => selectedPurchaseIds.has(row.id));
  const someVisibleSelected = pageRows.some(row => selectedPurchaseIds.has(row.id));
  document.getElementById('purchases-thead').innerHTML = `
    <tr>
      <th class="purchase-select-col"><input type="checkbox" id="purchase-select-visible" ${allVisibleSelected ? 'checked' : ''} aria-label="Select visible purchases"></th>
      ${PURCHASE_LEDGER_COLUMNS.map(column => `
        <th class="sortable" data-col="${column.key}" onclick="setPurchaseSort('${column.key}')">
          ${column.label} <span class="sort-icon">${pSortCol === column.key ? (pSortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
        </th>`).join('')}
      <th>Actions</th>
    </tr>
    <tr class="purchase-filter-row">
      <th></th>
      ${PURCHASE_LEDGER_COLUMNS.map(column => `<th>${purchaseFilterInput(column)}</th>`).join('')}
      <th><button class="btn btn-outline-gray btn-xs" type="button" onclick="clearPurchaseColumnFilters()">Clear</button></th>
    </tr>`;
  const selectVisible = document.getElementById('purchase-select-visible');
  selectVisible.indeterminate = someVisibleSelected && !allVisibleSelected;
  selectVisible.addEventListener('change', () => toggleVisiblePurchases(pageRows, selectVisible.checked));
}

function clearPurchaseColumnFilters() {
  Object.keys(purchaseColumnFilters).forEach(key => delete purchaseColumnFilters[key]);
  purchaseCurrentPage = 1;
  renderTable();
}

function renderPurchaseCell(row, column) {
  const value = purchaseColumnValue(row, column.key);
  if (column.type === 'money') return `<td class="mono">${formatPeso(value)}</td>`;
  if (column.type === 'date') return `<td>${value ? formatDate(value) : '—'}</td>`;
  return `<td>${value ? escPurchase(value) : '—'}</td>`;
}

function updatePurchaseBulkToolbar(filteredRows = getPurchaseRows(), pageRows = []) {
  const count = selectedPurchaseIds.size;
  const allPageSelected = pageRows.length > 0 && pageRows.every(row => selectedPurchaseIds.has(row.id));
  const allFilteredSelected = filteredRows.length > 0 && filteredRows.every(row => selectedPurchaseIds.has(row.id));
  const canSelectAllFiltered = count > 0 && allPageSelected && filteredRows.length > pageRows.length && !allFilteredSelected;
  const toolbar = document.getElementById('purchase-bulk-toolbar');
  toolbar.classList.toggle('open', count > 0);
  document.getElementById('purchase-bulk-count').textContent =
    `${count.toLocaleString()} purchase${count === 1 ? '' : 's'} selected`;
  const selectAllFiltered = document.getElementById('btn-select-all-filtered-purchases');
  selectAllFiltered.style.display = canSelectAllFiltered ? '' : 'none';
  selectAllFiltered.textContent = `Select all ${filteredRows.length.toLocaleString()} matching purchases`;
}

function togglePurchaseSelection(id, checked) {
  if (checked) selectedPurchaseIds.add(id);
  else selectedPurchaseIds.delete(id);
  renderTable();
}

function toggleVisiblePurchases(rows, checked) {
  rows.forEach(row => {
    if (checked) selectedPurchaseIds.add(row.id);
    else selectedPurchaseIds.delete(row.id);
  });
  renderTable();
}

function clearPurchaseSelection() {
  selectedPurchaseIds.clear();
  renderTable();
}

function selectAllFilteredPurchases() {
  getPurchaseRows().forEach(row => selectedPurchaseIds.add(row.id));
  renderTable();
}

function deleteSelectedPurchases() {
  const ids = [...selectedPurchaseIds];
  if (!ids.length) return;
  confirmDelete(`Delete <strong>${ids.length.toLocaleString()}</strong> selected purchase records? This cannot be undone.`, () => {
    const removeIds = new Set(ids);
    DB.set('purchases', DB.get('purchases').filter(row => !removeIds.has(row.id)));
    selectedPurchaseIds.clear();
    populatePurchasesFilterSuppliers();
    renderTable();
    renderSummary();
    logAudit('Delete', 'Purchases', `Deleted ${ids.length} selected purchase records`);
  });
}

function purchaseTotalPages(rowCount) {
  return Math.max(1, Math.ceil(rowCount / PURCHASE_ROWS_PER_PAGE));
}

function purchasePageRows(rows) {
  const start = (purchaseCurrentPage - 1) * PURCHASE_ROWS_PER_PAGE;
  return rows.slice(start, start + PURCHASE_ROWS_PER_PAGE);
}

function setPurchasePage(page) {
  const totalPages = purchaseTotalPages(getPurchaseRows().length);
  purchaseCurrentPage = Math.min(Math.max(1, page), totalPages);
  renderTable();
}

function purchasePageNumbers(totalPages) {
  const pages = new Set([1, totalPages, purchaseCurrentPage]);
  for (let i = purchaseCurrentPage - 2; i <= purchaseCurrentPage + 2; i++) {
    if (i >= 1 && i <= totalPages) pages.add(i);
  }
  return [...pages].sort((a, b) => a - b);
}

function renderPurchasePagination(filteredCount) {
  const totalPages = purchaseTotalPages(filteredCount);
  const start = filteredCount ? (purchaseCurrentPage - 1) * PURCHASE_ROWS_PER_PAGE + 1 : 0;
  const end = Math.min(purchaseCurrentPage * PURCHASE_ROWS_PER_PAGE, filteredCount);
  const pageNumbers = purchasePageNumbers(totalPages);
  const buttons = [];
  let last = 0;
  pageNumbers.forEach(page => {
    if (page - last > 1) buttons.push('<span class="purchase-page-ellipsis">...</span>');
    buttons.push(`<button class="purchase-page-btn ${page === purchaseCurrentPage ? 'active' : ''}" type="button" onclick="setPurchasePage(${page})">${page}</button>`);
    last = page;
  });
  document.getElementById('purchase-pagination').innerHTML = `
    <span class="purchase-page-info">Showing ${start.toLocaleString()}-${end.toLocaleString()} of ${filteredCount.toLocaleString()} purchases</span>
    <div class="purchase-page-controls">
      <button class="purchase-page-btn" type="button" ${purchaseCurrentPage === 1 ? 'disabled' : ''} onclick="setPurchasePage(${purchaseCurrentPage - 1})">Prev</button>
      ${buttons.join('')}
      <button class="purchase-page-btn" type="button" ${purchaseCurrentPage === totalPages ? 'disabled' : ''} onclick="setPurchasePage(${purchaseCurrentPage + 1})">Next</button>
    </div>`;
}

// ─── Table ────────────────────────────────────────────────────────────────────
function renderTable() {
  const allRows = DB.get('purchases');
  const rows    = getPurchaseRows();
  const existingIds = new Set(allRows.map(row => row.id));
  selectedPurchaseIds.forEach(id => {
    if (!existingIds.has(id)) selectedPurchaseIds.delete(id);
  });
  const totalPages = purchaseTotalPages(rows.length);
  if (purchaseCurrentPage > totalPages) purchaseCurrentPage = totalPages;
  const pageRows = purchasePageRows(rows);
  const start = rows.length ? (purchaseCurrentPage - 1) * PURCHASE_ROWS_PER_PAGE + 1 : 0;
  const end = Math.min(purchaseCurrentPage * PURCHASE_ROWS_PER_PAGE, rows.length);

  document.getElementById('purchases-count').textContent =
    rows.length === allRows.length
      ? `Showing ${start}-${end} of ${allRows.length} records`
      : `Showing ${start}-${end} of ${rows.length} filtered records`;

  renderPurchaseHeader(pageRows);
  updatePurchaseBulkToolbar(rows, pageRows);
  renderPurchasePagination(rows.length);

  const tbody = document.getElementById('purchases-tbody');
  if (!pageRows.length) {
    const msg = allRows.length
      ? 'No purchases match the current filters.'
      : 'No purchases yet. Click "Add Purchase" to get started.';
    tbody.innerHTML = `<tr><td colspan="${PURCHASE_LEDGER_COLUMNS.length + 2}"><div class="empty-state"><div class="empty-icon">🧾</div><p>${msg}</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = pageRows.map(p => `
    <tr>
      <td class="purchase-select-col">
        <input type="checkbox" class="purchase-row-select" aria-label="Select purchase"
          ${selectedPurchaseIds.has(p.id) ? 'checked' : ''}
          onchange="togglePurchaseSelection('${p.id}', this.checked)">
      </td>
      ${PURCHASE_LEDGER_COLUMNS.map(column => renderPurchaseCell(p, column)).join('')}
      <td>
        <div class="action-btns">
          <button class="btn btn-outline btn-xs" onclick="editPurchase('${p.id}')">Edit</button>
          <button class="btn btn-danger btn-xs" onclick="deletePurchase('${p.id}')">Delete</button>
        </div>
      </td>
    </tr>`).join('');
}

function exportPurchasesCSV() {
  const rows = getPurchaseRows();
  exportRowsToCSV(`purchases-${todayISO()}.csv`, PURCHASE_LEDGER_COLUMNS.map(column => ({
    label: column.label,
    value: row => column.type === 'date' ? csvDate(purchaseColumnValue(row, column.key)) : purchaseColumnValue(row, column.key)
  })), rows);
  alert(`${rows.length.toLocaleString()} purchase records exported to CSV.`);
}

// ─── Save ─────────────────────────────────────────────────────────────────────
function savePurchase() {
  const supplier  = document.getElementById('f-supplier').value;
  const date      = document.getElementById('f-date').value;
  const netAmount = parsePeso(document.getElementById('f-total').value);
  if (!supplier || !date || !netAmount) { alert('Supplier, date, and net amount are required.'); return; }

  const inputVAT        = parsePeso(document.getElementById('f-input-vat').value);
  const inputVATCreditable = document.getElementById('f-input-vat-creditable').value !== 'no';
  const grossAmount     = netAmount + inputVAT;
  const ewtRate         = parseFloat(document.getElementById('f-ewt-rate').value) || 0;
  const ewtAmount       = netAmount * ewtRate / 100;

  const additions       = getAdditions();
  const totalAdditions  = additions.reduce((s,a) => s + a.amount, 0);

  const badOrder        = parsePeso(document.getElementById('f-bad-order').value);
  const lacking         = parsePeso(document.getElementById('f-lacking').value);
  const returns_        = parsePeso(document.getElementById('f-returns').value);
  const otherDeduction  = parsePeso(document.getElementById('f-other-ded').value);
  const editId = document.getElementById('edit-id').value;
  const existingPurchase = editId ? DB.get('purchases').find(p => p.id === editId) : null;
  const discounts = existingPurchase?.discounts || 0;
  const noStock = existingPurchase?.noStock || 0;
  const totalDeductions = discounts + badOrder + lacking + returns_ + noStock + otherDeduction;

  const netPayable = grossAmount - ewtAmount - totalDeductions + totalAdditions;

  const record = {
    supplier, date, netAmount, inputVAT, inputVATCreditable, grossAmount,
    ewtRate, ewtAmount,
    additions, totalAdditions,
    discounts, badOrder, lacking, returns: returns_, noStock, otherDeduction,
    totalDeductions, netPayable,
    status: 'Pending', remittanceDate: '',
    notes: document.getElementById('f-notes').value,
  };

  if (editId) {
    record.status         = existingPurchase?.status         || 'Pending';
    record.remittanceDate = existingPurchase?.remittanceDate || '';
    DB.update('purchases', editId, record);
  } else {
    record.id = genId();
    DB.push('purchases', record);
  }

  closeModal('modal-purchase');
  populatePurchasesFilterSuppliers();
  renderTable();
  renderSummary();
  logAudit(editId ? 'Edit' : 'Create', 'Purchase',
    `${editId ? 'Edited' : 'Added'} purchase from ${supplier} - ${formatPeso(netAmount)} on ${formatDate(date)}`);
}

// ─── Edit ─────────────────────────────────────────────────────────────────────
function editPurchase(id) {
  const p = DB.get('purchases').find(x => x.id === id);
  if (!p) return;

  document.getElementById('edit-id').value = p.id;
  document.getElementById('modal-purchase-title').textContent = 'Edit Purchase';
  populateSupplierDropdown(document.getElementById('f-supplier'));
  ensurePurchaseSupplierOption(document.getElementById('f-supplier'), p.supplier);
  document.getElementById('f-supplier').value   = p.supplier;
  document.getElementById('f-date').value        = p.date;
  const net = p.netAmount ?? p.total ?? 0;
  document.getElementById('f-total').value       = formatNum(net);
  document.getElementById('f-input-vat').value   = p.inputVAT != null ? formatNum(p.inputVAT) : formatNum(net * 0.12);
  document.getElementById('f-input-vat-creditable').value = p.inputVATCreditable === false ? 'no' : 'yes';
  document.getElementById('f-ewt-rate').value    = String(p.ewtRate);
  document.getElementById('f-bad-order').value   = p.badOrder       ? formatNum(p.badOrder)       : '';
  document.getElementById('f-lacking').value     = p.lacking        ? formatNum(p.lacking)        : '';
  document.getElementById('f-returns').value     = p.returns        ? formatNum(p.returns)        : '';
  document.getElementById('f-other-ded').value   = p.otherDeduction ? formatNum(p.otherDeduction) : '';
  document.getElementById('f-notes').value       = p.notes || '';

  document.getElementById('additions-list').innerHTML = '';
  (p.additions || []).forEach(a => addAdditionRow(a.desc, a.amount ? formatNum(a.amount) : ''));

  calcFields();
  openModal('modal-purchase');
}

// ─── Delete ───────────────────────────────────────────────────────────────────
function deletePurchase(id) {
  const p = DB.get('purchases').find(x => x.id === id);
  confirmDelete(`Delete purchase from <strong>${p?.supplier}</strong>?`, () => {
    DB.remove('purchases', id);
    selectedPurchaseIds.delete(id);
    renderTable();
    renderSummary();
    logAudit('Delete', 'Purchase', `Deleted purchase from ${p?.supplier || id}`);
  });
}

document.getElementById('btn-add-purchase').addEventListener('click', () => { resetForm(); openModal('modal-purchase'); });
document.getElementById('btn-export-purchases')?.addEventListener('click', exportPurchasesCSV);
document.getElementById('btn-export-filtered-purchases')?.addEventListener('click', exportPurchasesCSV);
document.getElementById('btn-save-purchase').addEventListener('click', savePurchase);
document.getElementById('btn-import-purchases').addEventListener('click', () => document.getElementById('purchase-import-file').click());
document.getElementById('btn-browse-purchase-import').addEventListener('click', event => {
  event.stopPropagation();
  document.getElementById('purchase-import-file').click();
});
document.getElementById('purchase-import-file').addEventListener('change', event => {
  if (event.target.files[0]) handlePurchaseImportFile(event.target.files[0]);
  event.target.value = '';
});
document.getElementById('btn-confirm-purchase-import').addEventListener('click', confirmPurchaseImport);
document.getElementById('btn-delete-selected-purchases').addEventListener('click', deleteSelectedPurchases);
document.getElementById('btn-clear-purchase-selection').addEventListener('click', clearPurchaseSelection);
document.getElementById('btn-select-all-filtered-purchases').addEventListener('click', selectAllFilteredPurchases);
document.getElementById('btn-cancel-purchase-import').addEventListener('click', () => {
  purchaseImportPreviewRows = [];
  closeModal('modal-purchase-import');
});
document.getElementById('btn-close-purchase-import').addEventListener('click', () => {
  purchaseImportPreviewRows = [];
  closeModal('modal-purchase-import');
});
const purchaseImportDropzone = document.getElementById('purchase-import-dropzone');
purchaseImportDropzone.addEventListener('click', () => document.getElementById('purchase-import-file').click());
purchaseImportDropzone.addEventListener('dragover', event => {
  event.preventDefault();
  purchaseImportDropzone.classList.add('dragover');
});
purchaseImportDropzone.addEventListener('dragleave', () => purchaseImportDropzone.classList.remove('dragover'));
purchaseImportDropzone.addEventListener('drop', event => {
  event.preventDefault();
  purchaseImportDropzone.classList.remove('dragover');
  if (event.dataTransfer.files[0]) handlePurchaseImportFile(event.dataTransfer.files[0]);
});

// ─── Filter wiring ────────────────────────────────────────────────────────────
populatePurchasesFilterSuppliers();
['search-purchases', 'filter-date-from', 'filter-date-to'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    purchaseCurrentPage = 1;
    renderTable();
  });
});
document.getElementById('filter-supplier-purchases').addEventListener('change', () => {
  purchaseCurrentPage = 1;
  renderTable();
});
document.getElementById('btn-clear-filters-purchases').addEventListener('click', () => {
  ['search-purchases','filter-date-from','filter-date-to'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('filter-supplier-purchases').value = '';
  Object.keys(purchaseColumnFilters).forEach(key => delete purchaseColumnFilters[key]);
  purchaseCurrentPage = 1;
  renderTable();
});

renderTable();
renderSummary();
loadSuppliersFromFirestore()
  .then(populatePurchasesFilterSuppliers)
  .catch(err => console.error('[Purchases] Supplier Firestore load failed:', err));

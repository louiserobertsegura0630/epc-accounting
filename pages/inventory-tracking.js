
initSidebar('inventory-tracking');

const INV_CATS = ['Grains','Cooking Essentials','Condiments','Instant Food','Dairy & Eggs'];
let selectedOutgoingProduct = null;
let outgoingSearchTimer = null;
let outgoingSearchQuery = '';

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
  const code = inventoryCode(sale.itemCode);
  const qty  = Number(sale.unitsSold) || 0;
  if (!code || qty <= 0) return null;
  const unitCost = Number(sale.unitCost) || 0;
  const raw = sale.date;
  const date = raw && typeof raw.toDate === 'function'
    ? raw.toDate().toISOString().slice(0, 10)
    : String(raw || '').slice(0, 10);
  return {
    id: `sale-${sale._firestoreId || sale.id || `${code}|${date}|${qty}|${index}`}`,
    type: 'Outgoing',
    itemCode: code,
    description: sale.productName || sale.description || '',
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

// Replace the derived sales-outgoing rows in the movements array with a fresh
// set built from the given sales records, then repaint table + summary.
function applySalesOutgoing(sales) {
  const real    = DB.get('inventory_movements').filter(row => !row._derived);
  const derived = (sales || []).map(saleToOutgoingRow).filter(Boolean);
  DB.set('inventory_movements', [...real, ...derived]);
  invTable.render();
  renderSummary();
}

// Live source of truth: the Sales page writes to the 'salesData' collection.
// onSnapshot fires once immediately (initial load) and again on every upload.
function watchSalesOutgoing() {
  const db = getFirestoreDB();
  if (!db) {
    applySalesOutgoing(DB.get('pos_sales'));
    return;
  }
  db.collection('salesData').onSnapshot(snap => {
    const sales = snap.docs.map(doc => ({ _firestoreId: doc.id, ...doc.data() }));
    applySalesOutgoing(sales);
  }, err => console.error('[Inventory] salesData listener failed:', err));
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
    document.getElementById('tab-'+t).classList.toggle('active', t===tab);
  });
  const labels = { all:'All Movements', incoming:'Incoming Movements', outgoing:'Outgoing Movements' };
  document.getElementById('tab-label').textContent = labels[tab];
  invTable.setTab(tab);
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
  const movs = DB.get('inventory_movements');
  const inVal  = movs.filter(m=>m.type==='Incoming').reduce((s,m)=>s+(m.totalCost||0),0);
  const outVal = movs.filter(m=>m.type==='Outgoing').reduce((s,m)=>s+(m.totalCost||0),0);
  document.getElementById('inv-summary').innerHTML = `
    <div class="summary-card">
      <div class="kpi-label">Total Incoming Value</div>
      <div class="kpi-value green">${formatPeso(inVal)}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Total Outgoing Value</div>
      <div class="kpi-value red">${formatPeso(outVal)}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Net Movement</div>
      <div class="kpi-value ${(inVal-outVal)>=0?'blue':''}">${formatPeso(inVal-outVal)}</div>
    </div>`;
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

function invCurrentPageRows(rows = invFilteredRows()) {
  const start = (invTable.page - 1) * invTable.pageSize;
  return rows.slice(start, start + invTable.pageSize);
}

function syncBulkSelectionUI() {
  const existing = new Set(DB.get('inventory_movements').map(m => m.id));
  const filtered = invFilteredRows().filter(r => !r._derived);
  const filteredSet = new Set(filtered.map(r => r.id));
  [...selectedInvIds].forEach(id => {
    if (!existing.has(id) || !filteredSet.has(id)) selectedInvIds.delete(id);
  });

  const filteredIds = filtered.map(r => r.id);
  const selectedCount = selectedInvIds.size;
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every(id => selectedInvIds.has(id));
  const someFilteredSelected = filteredIds.some(id => selectedInvIds.has(id));

  document.querySelectorAll('.inv-row-select').forEach(cb => {
    cb.checked = selectedInvIds.has(cb.value);
  });

  const selectAll = document.getElementById('inv-select-all');
  if (selectAll) {
    selectAll.checked = allFilteredSelected;
    selectAll.indeterminate = !allFilteredSelected && someFilteredSelected;
    selectAll.disabled = filteredIds.length === 0;
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
  invFilteredRows().filter(row => !row._derived).forEach(row => {
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

    for (let start = 0; start < rows.length; start += 200) {
      const batch = fsdb.batch();
      const chunk = rows.slice(start, start + 200);
      chunk.forEach(row => {
        batch.set(fsdb.collection('inventoryData').doc(inventoryFirestoreDocId(row)), row);
      });
      await commitWithRetry(batch, start + chunk.length);
      await sleep(300);
    }

    rows.forEach(row => DB.push('inventory_movements', row));
    logAudit('Create', 'Inventory',
      `Bulk make-outgoing - ${rows.length.toLocaleString()} product records created on ${formatDate(date)}`);
    selectedInvIds.clear();
    closeModal('modal-make-outgoing');
    invTable.render();
    renderSummary();
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
document.getElementById('btn-export-inv').addEventListener('click', exportInventoryCSV);
document.getElementById('btn-save-inv').addEventListener('click', saveInv);
document.getElementById('btn-make-outgoing').addEventListener('click', openMakeOutgoingModal);
document.getElementById('btn-confirm-make-outgoing').addEventListener('click', saveBulkOutgoing);
document.getElementById('btn-delete-selected').addEventListener('click', openBulkDeleteModal);
document.getElementById('btn-deselect-inv').addEventListener('click', deselectAllInvRows);
document.getElementById('btn-cancel-bulk-delete').addEventListener('click', () => closeModal('modal-bulk-delete'));
document.getElementById('btn-confirm-bulk-delete').addEventListener('click', confirmBulkDelete);
renderSummary();

// ─── TrackingTable ────────────────────────────────────────────────────────────
const invTable = new TrackingTable({
  id: 'inv',
  storageKey: 'inventory_movements',
  dateField: 'dateDelivered',
  theadId: 'inv-thead',
  tbodyId: 'inv-tbody',
  clearBtnId: 'btn-clear-inv',
  quickSearchId: 'search-inv',
  paginationId: 'inv-pagination',
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
    { key:'_actions',      label:'Actions',     sortable:false, filterable:false },
  ],
  renderRow: m => `<tr${m._derived ? ' class="inv-derived-row"' : ''}>
      <td class="select-col">${m._derived ? '' : `<input type="checkbox" class="inv-row-select" value="${m.id}" aria-label="Select inventory entry" onchange="toggleInvRowSelection('${m.id}', this.checked)">`}</td>
      <td class="mono">${m.itemCode}</td>
      <td>${formatDate(m.dateDelivered)}</td>
      <td><span class="badge ${m.type==='Incoming'?'badge-green':'badge-red'}">${m.type}</span></td>
      <td>${invEsc(inventoryDisplayDescription(m))}</td>
      <td>${invEsc(inventoryDisplayCategory(m))}</td>
      <td>${m.supplier||'—'}</td>
      <td class="mono">${m.qty.toLocaleString()}</td>
      <td class="mono">${formatPeso(m.unitCost)}</td>
      <td class="mono"><strong>${formatPeso(m.totalCost)}</strong></td>
      <td>
        ${m._derived
          ? '<span class="badge badge-blue" title="Generated from a POS sale — manage it on the Sales page">POS Sale</span>'
          : `<div class="action-btns">
          <button class="btn btn-outline btn-xs" onclick="editInv('${m.id}')">Edit</button>
          <button class="btn btn-danger btn-xs" onclick="deleteInv('${m.id}')">Delete</button>
        </div>`}
      </td>
    </tr>`,
  emptyHtml: '<tr><td colspan="11"><div class="empty-state"><div class="empty-icon">📦</div><p>No inventory movements yet.</p></div></td></tr>',
});
const baseInvRender = invTable.render.bind(invTable);
invTable.render = function() {
  baseInvRender();
  syncBulkSelectionUI();
};
invTable.render();

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
  const src  = document.getElementById('mis-worker-src').textContent;
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

async function commitWithRetry(batch, currentRow, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
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
  const BATCH      = 200;
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
    const end = Math.min(start + BATCH, toImport.length);
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
    const batchSize = 200;
    let saved = 0;
    for (let start = 0; start < rows.length; start += batchSize) {
      const chunk = rows.slice(start, start + batchSize);
      const batch = db.batch();
      chunk.forEach(row => {
        const firestoreId = row._firestoreId || inventoryFirestoreDocId(row);
        const firestoreRow = { ...row };
        delete firestoreRow._firestoreId;
        batch.set(db.collection('inventoryData').doc(firestoreId), firestoreRow, { merge: true });
      });
      await commitWithRetry(batch, Math.min(start + chunk.length, rows.length));
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
        commitBatch: (batch, currentRow) => commitWithRetry(batch, currentRow),
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
    for (let start = 0; start < importedSuppliers.length; start += BATCH) {
      const chunk = importedSuppliers.slice(start, start + BATCH);
      const batch = db.batch();
      chunk.forEach(supplier => {
        batch.set(
          db.collection('suppliers').doc(supplierFirestoreDocId(supplier.name)),
          supplier,
          { merge: true }
        );
      });
      await commitWithRetry(batch, Math.min(start + chunk.length, importedSuppliers.length));
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

document.getElementById('btn-import-mis').addEventListener('click', () => { resetMISModal(); openModal('modal-mis'); });
vsInit();
function watchInventoryProductMaster() {
  const db = getFirestoreDB();
  if (!db) return;
  db.collection('productMaster').onSnapshot(snapshot => {
    const rows = snapshot.docs.map(doc => normalizeProductCostData({ _firestoreId:doc.id, ...doc.data() }));
    cacheProductMasterRows(rows);
    invTable.render();
  }, err => console.error('[Inventory] Product Master listener failed:', err));
}

Promise.all([
  loadInventoryFromFirestore(),
  loadSuppliersFromFirestore(),
  loadProductMasterFromFirestore()
])
  .then(() => {
    invTable.render();
    renderSummary();
    watchInventoryProductMaster();
    watchSalesOutgoing();
  })
  .catch(err => console.error('[Inventory] Firestore load failed:', err));

// (end of MIS import section)

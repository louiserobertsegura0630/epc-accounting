
initSidebar('suppliers');

const SUP_CATS = ['Grains','Cooking Essentials','Condiments','Instant Food','Dairy & Eggs','Supplies'];
let ACTIVE_SUPPLIER_ID = null;
const ASSIGN_SELECTED = new Set();
const ASSIGN_PICKER = { page: 1, pageSize: 50, filtered: [], rows: [] };
const ASSIGN_REVIEW = { page: 1, pageSize: 50, rows: [] };
const DETAIL_PRODUCTS = { page: 1, pageSize: 20 };

// ─── Supplier table state ─────────────────────────────────────────────────────
const SUP_STATE = {
  page: 1, pageSize: 50, sortKey: null, sortDir: 1,
  search: '', filterName: '', filterCat: '',
  filterContact: '', filterPhone: '', filterEmail: '', filterStatus: '',
};
const selectedSupIds = new Set(); // always stores String(id)
let allSuppliersSelected = false;
let pendingSupplierDeleteIds = [];
let pendingSupplierDeleteName = '';
let supplierDeleteInProgress = false;

// ─── ID helpers ───────────────────────────────────────────────────────────────
// MIS-imported suppliers get numeric IDs; manually-added ones get genId() strings.
// Always compare as strings so both work.
function findSupplier(id) {
  return DB.get('suppliers').find(s => String(s.id) === String(id));
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function supplierFirestoreDocId(supplier) {
  return String(supplier._firestoreId || supplier.id || '').trim();
}

async function saveSupplierToFirestore(supplier) {
  const db = getFirestoreDB();
  if (!db) throw new Error('Database unavailable.');
  const docId = supplierFirestoreDocId(supplier);
  if (!docId) throw new Error('Supplier ID is missing.');
  const clean = { ...supplier };
  delete clean._firestoreId;
  await db.collection('suppliers').doc(docId).set(clean, { merge: true });
  supplier._firestoreId = docId;
}

// Shared products section HTML (used by both view and edit mode renders)
function productsBlock(products) {
  return `<div style="border-top:1px solid var(--card-border);padding-top:14px;margin-top:4px">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px">
      <div>
        <div style="font-size:0.75rem;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Products Supplied</div>
        <div style="font-size:0.875rem;color:#64748b" id="supplier-products-count">${products.length.toLocaleString()} product${products.length === 1 ? '' : 's'} assigned</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
        <button class="btn btn-outline btn-sm" onclick="openAssignProducts('${ACTIVE_SUPPLIER_ID}')">Edit / Assign Products</button>
        <button class="btn btn-danger btn-sm" onclick="removeAllSupplierProducts('${ACTIVE_SUPPLIER_ID}')" ${products.length ? '' : 'disabled'}>Remove All</button>
      </div>
    </div>
    <div class="supplier-products-list" id="supplier-products-list"></div>
    <div class="pagination-bar" id="supplier-products-pagination" style="margin-top:10px;border:1px solid var(--card-border);border-radius:8px"></div>
  </div>`;
}

// ─── Product Master helpers ───────────────────────────────────────────────────
function getProductMaster() {
  return getCachedProductMasterRows();
}

function setProductMaster(products) {
  cacheProductMasterRows(products);
  syncProductMasterToFirestore(products);
}

function productCode(p) { return p.itemCode || p.code || ''; }
function productName(p) { return p.productName || p.name || ''; }
function productCost(p) { return p.unitCost ?? p.cost ?? 0; }
function supplierProducts(name) {
  return getProductMaster().filter(p => String(p.supplier || '').trim() === String(name || '').trim());
}

function supplierProductCounts() {
  const counts = new Map();
  getProductMaster().forEach(p => {
    const supplier = String(p.supplier || '').trim();
    if (!supplier) return;
    counts.set(supplier, (counts.get(supplier) || 0) + 1);
  });
  return counts;
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showSupToast(html, type = 'success', ms = 5000) {
  const prev = document.getElementById('sup-toast'); if (prev) prev.remove();
  const bg = type === 'success' ? '#16a34a' : type === 'warning' ? '#d97706' : '#1A56DB';
  const el = document.createElement('div');
  el.id = 'sup-toast';
  el.style.cssText = `position:fixed;bottom:24px;right:24px;background:${bg};color:white;
    padding:13px 18px;border-radius:10px;font-size:0.875rem;font-weight:600;
    font-family:'Figtree',sans-serif;z-index:9999;max-width:390px;line-height:1.5;
    box-shadow:0 4px 20px rgba(0,0,0,0.18);cursor:pointer`;
  el.innerHTML = html;
  el.onclick = () => el.remove();
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; } }, ms - 300);
  setTimeout(() => { if (el.parentNode) el.remove(); }, ms);
}

// ─── Pager helpers (assign-products / supplier-detail modals) ─────────────────
function pageCount(total, pageSize) {
  return Math.max(1, Math.ceil(total / pageSize));
}

function pageButtons(current, totalPages) {
  const pages = new Set([1, totalPages, current - 1, current, current + 1]);
  if (current <= 2) pages.add(3);
  if (current >= totalPages - 1) pages.add(totalPages - 2);
  return [...pages].filter(p => p >= 1 && p <= totalPages).sort((a,b) => a - b);
}

function renderPager(targetId, total, page, pageSize, setter) {
  const totalPages = pageCount(total, pageSize);
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  let last = 0;
  const controls = pageButtons(page, totalPages).map(p => {
    const gap = p - last > 1 ? '<span class="page-ellipsis">…</span>' : '';
    last = p;
    return `${gap}<button class="page-btn ${p === page ? 'active' : ''}" onclick="${setter}(${p})">${p}</button>`;
  }).join('');
  document.getElementById(targetId).innerHTML = `
    <div class="pagination-info">Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} products</div>
    <div class="pagination-controls">
      <button class="page-btn" onclick="${setter}(${page - 1})" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
      ${controls}
      <button class="page-btn" onclick="${setter}(${page + 1})" ${page >= totalPages ? 'disabled' : ''}>Next ›</button>
    </div>`;
}

// ─── Logo upload ──────────────────────────────────────────────────────────────
document.getElementById('sup-logo').addEventListener('change', function() {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('sup-logo-preview').innerHTML =
      `<img src="${e.target.result}" style="width:60px;height:60px;border-radius:8px;object-fit:contain;border:1px solid var(--card-border)">`;
    document.getElementById('sup-logo').dataset.base64 = e.target.result;
  };
  reader.readAsDataURL(file);
});

// ─── Form ─────────────────────────────────────────────────────────────────────
function resetSupForm() {
  document.getElementById('sup-edit-id').value = '';
  document.getElementById('modal-sup-title').textContent = 'Add Supplier';
  ['sup-name','sup-contact','sup-phone','sup-email','sup-notes'].forEach(id => document.getElementById(id).value='');
  document.getElementById('sup-address').value = '';
  document.getElementById('sup-logo').value    = '';
  document.getElementById('sup-logo').dataset.base64 = '';
  document.getElementById('sup-logo-preview').innerHTML = '';
  initCatDropdown(document.getElementById('sup-cat'), 'sup', SUP_CATS);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
function renderSummary() {
  const sups = DB.get('suppliers');
  const cats = [...new Set(sups.map(s=>s.category).filter(Boolean))];
  document.getElementById('sup-dir-summary').innerHTML = `
    <div class="summary-card"><div class="kpi-label">Total Suppliers</div><div class="kpi-value">${sups.length}</div></div>
    <div class="summary-card"><div class="kpi-label">Categories</div><div class="kpi-value">${cats.length}</div></div>`;
}

// ─── Category filter dropdown (filter row) ────────────────────────────────────
function renderCatFilter() {
  const cats = [...new Set(DB.get('suppliers').map(s=>s.category))].filter(Boolean).sort();
  const sel  = document.getElementById('filter-sup-cat');
  sel.innerHTML = '<option value="">All</option>' +
    cats.map(c => `<option value="${c}"${c === SUP_STATE.filterCat ? ' selected' : ''}>${c}</option>`).join('');
}

// ─── Supplier table — filtering, sorting, pagination ─────────────────────────
function supGetFiltered() {
  let rows = DB.get('suppliers');
  const { search, filterName, filterCat, filterContact, filterPhone, filterEmail, filterStatus } = SUP_STATE;

  if (search) {
    const lq = search.toLowerCase();
    rows = rows.filter(s =>
      s.name?.toLowerCase().includes(lq) ||
      s.category?.toLowerCase().includes(lq) ||
      s.contact?.toLowerCase().includes(lq) ||
      s.email?.toLowerCase().includes(lq)
    );
  }
  if (filterName)    rows = rows.filter(s => s.name?.toLowerCase().includes(filterName.toLowerCase()));
  if (filterCat)     rows = rows.filter(s => s.category === filterCat);
  if (filterContact) rows = rows.filter(s => s.contact?.toLowerCase().includes(filterContact.toLowerCase()));
  if (filterPhone)   rows = rows.filter(s => s.phone?.toLowerCase().includes(filterPhone.toLowerCase()));
  if (filterEmail)   rows = rows.filter(s => s.email?.toLowerCase().includes(filterEmail.toLowerCase()));
  if (filterStatus)  rows = rows.filter(s => (s.status || 'Active') === filterStatus);

  if (SUP_STATE.sortKey) {
    const key = SUP_STATE.sortKey;
    const dir = SUP_STATE.sortDir;
    rows = [...rows].sort((a, b) => {
      const av = (key === 'status' ? (a.status || 'Active') : (a[key] || '')).toLowerCase();
      const bv = (key === 'status' ? (b.status || 'Active') : (b[key] || '')).toLowerCase();
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }
  return rows;
}

function supSort(key) {
  if (SUP_STATE.sortKey === key) SUP_STATE.sortDir *= -1;
  else { SUP_STATE.sortKey = key; SUP_STATE.sortDir = 1; }
  supRender();
}

function setSupPage(page) {
  const total = supGetFiltered().length;
  const totalPages = Math.max(1, Math.ceil(total / SUP_STATE.pageSize));
  SUP_STATE.page = Math.min(Math.max(1, page), totalPages);
  supRender();
}

function getSupPageRows(filtered) {
  const start = (SUP_STATE.page - 1) * SUP_STATE.pageSize;
  return filtered.slice(start, start + SUP_STATE.pageSize);
}

function renderSortArrows() {
  ['name','category','contact','phone','email','status'].forEach(k => {
    const el = document.getElementById('sup-sort-' + k);
    if (!el) return;
    el.textContent = SUP_STATE.sortKey === k ? (SUP_STATE.sortDir === 1 ? ' ↑' : ' ↓') : '';
  });
}

function renderSupPagination(total) {
  const { page, pageSize } = SUP_STATE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end   = Math.min(page * pageSize, total);
  const pageNums = new Set([1, totalPages, page - 1, page, page + 1]);
  if (page <= 2) pageNums.add(3);
  if (page >= totalPages - 1) pageNums.add(totalPages - 2);
  const sorted = [...pageNums].filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  let last = 0;
  const controls = sorted.map(p => {
    const gap = p - last > 1 ? '<span class="page-ellipsis">…</span>' : '';
    last = p;
    return `${gap}<button class="page-btn ${p === page ? 'active' : ''}" onclick="setSupPage(${p})">${p}</button>`;
  }).join('');
  const el = document.getElementById('sup-dir-pagination');
  if (!el) return;
  el.innerHTML = `
    <div class="pagination-info">Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} suppliers</div>
    <div class="pagination-controls">
      <button class="page-btn" onclick="setSupPage(${page - 1})" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
      ${controls}
      <button class="page-btn" onclick="setSupPage(${page + 1})" ${page >= totalPages ? 'disabled' : ''}>Next ›</button>
    </div>`;
}

// ─── Bulk selection ───────────────────────────────────────────────────────────
function syncSupBulkBar() {
  const suppliers  = DB.get('suppliers');
  const allIds     = new Set(suppliers.map(s => String(s.id)));
  const filtered   = supGetFiltered();

  // Drop selections only for deleted rows. Selection can span pages and filters.
  [...selectedSupIds].forEach(id => {
    if (!allIds.has(id)) selectedSupIds.delete(id);
  });

  const pageRows = getSupPageRows(filtered);
  const pageIds  = pageRows.map(r => String(r.id));
  const allPageSelected  = pageIds.length > 0 && pageIds.every(id => selectedSupIds.has(id));
  const somePageSelected = pageIds.some(id => selectedSupIds.has(id));

  const master = document.getElementById('sup-select-all');
  if (master) {
    master.checked       = allPageSelected;
    master.indeterminate = !allPageSelected && somePageSelected;
    master.disabled      = pageIds.length === 0;
  }

  // Sync individual checkboxes using data-id (set during render)
  document.querySelectorAll('.sup-row-select').forEach(cb => {
    cb.checked = selectedSupIds.has(cb.dataset.id);
  });

  const count   = selectedSupIds.size;
  const bar     = document.getElementById('sup-bulk-bar');
  const countEl = document.getElementById('sup-bulk-count');
  if (bar && countEl) {
    bar.classList.toggle('open', count > 0);
    countEl.textContent = `${count.toLocaleString()} supplier${count !== 1 ? 's' : ''} selected`;
  }

  const canSelectAll = allPageSelected && suppliers.length > pageIds.length && !allSuppliersSelected;
  document.getElementById('sup-select-all-banner').classList.toggle('open', canSelectAll);
  if (canSelectAll) {
    document.getElementById('sup-select-page-message').textContent =
      `${pageIds.length.toLocaleString()} supplier${pageIds.length !== 1 ? 's' : ''} on this page are selected.`;
    document.getElementById('btn-select-all-suppliers').textContent =
      `Select all ${suppliers.length.toLocaleString()} suppliers`;
  }
}

function toggleSupRow(id, checked) {
  allSuppliersSelected = false;
  if (checked) selectedSupIds.add(String(id));
  else selectedSupIds.delete(String(id));
  syncSupBulkBar();
}

function toggleAllVisibleSup(checked) {
  allSuppliersSelected = false;
  const filtered = supGetFiltered();
  getSupPageRows(filtered).forEach(r => {
    if (checked) selectedSupIds.add(String(r.id));
    else selectedSupIds.delete(String(r.id));
  });
  syncSupBulkBar();
}

function deselectAllSup() {
  allSuppliersSelected = false;
  selectedSupIds.clear();
  supRender();
}

function selectAllSuppliers() {
  allSuppliersSelected = true;
  DB.get('suppliers').forEach(supplier => selectedSupIds.add(String(supplier.id)));
  syncSupBulkBar();
}

function openBulkDeleteSupModal() {
  openSupDeleteModal([...selectedSupIds]);
}

function openSupDeleteModal(ids, supplierName = '') {
  if (supplierDeleteInProgress) return;
  const existingIds = new Set(DB.get('suppliers').map(supplier => String(supplier.id)));
  pendingSupplierDeleteIds = [...new Set(ids.map(String))].filter(id => existingIds.has(id));
  if (!pendingSupplierDeleteIds.length) return;
  pendingSupplierDeleteName = supplierName;
  const count = pendingSupplierDeleteIds.length;
  document.getElementById('sup-bulk-delete-title').textContent = supplierName
    ? `Delete ${supplierName}?`
    : `Delete ${count.toLocaleString()} supplier${count !== 1 ? 's' : ''}?`;
  document.getElementById('sup-bulk-delete-body').textContent = supplierName
    ? 'This will permanently remove this supplier. This cannot be undone.'
    : 'This will permanently remove these suppliers. This cannot be undone.';
  setSupDeleteModalBusy(false);
  openModal('modal-bulk-delete-sup');
}

function closeSupDeleteModal() {
  if (supplierDeleteInProgress) return;
  pendingSupplierDeleteIds = [];
  pendingSupplierDeleteName = '';
  setSupDeleteModalBusy(false);
  closeModal('modal-bulk-delete-sup');
}

function setSupDeleteModalBusy(isBusy, label = 'Delete') {
  supplierDeleteInProgress = isBusy;
  document.getElementById('btn-close-sup-delete').disabled = isBusy;
  document.getElementById('btn-cancel-sup-bulk-delete').disabled = isBusy;
  const confirmButton = document.getElementById('btn-confirm-sup-bulk-delete');
  confirmButton.disabled = isBusy;
  confirmButton.innerHTML = label;
}

function supDeleteProgressLabel(percent) {
  return `<span class="sup-spinner"></span>Deleting... ${percent}%`;
}

function sleepSup(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function deleteSuppliersFromFirestore(ids, deleteAll, onProgress) {
  const db = getFirestoreDB();
  if (!db) throw new Error('Database unavailable.');
  const selectedIds = new Set(ids.map(String));
  const selectedNames = new Set(DB.get('suppliers')
    .filter(supplier => selectedIds.has(String(supplier.id)))
    .map(supplier => String(supplier.name || '').trim().toLowerCase())
    .filter(Boolean));
  const snapshot = await db.collection('suppliers').get();
  const documents = deleteAll
    ? snapshot.docs
    : snapshot.docs.filter(doc => {
        const data = doc.data();
        return selectedIds.has(String(doc.id)) ||
          selectedIds.has(String(data.id)) ||
          selectedNames.has(String(data.name || '').trim().toLowerCase());
      });
  if (!documents.length) {
    onProgress(100);
    return;
  }
  const batchSize = 200;
  const totalBatches = Math.ceil(documents.length / batchSize);
  for (let start = 0; start < documents.length; start += batchSize) {
    const batch = db.batch();
    documents.slice(start, start + batchSize).forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    onProgress(Math.round((Math.floor(start / batchSize) + 1) / totalBatches * 100));
    await sleepSup(300);
  }
}

async function confirmBulkDeleteSup() {
  const ids = [...pendingSupplierDeleteIds];
  if (!ids.length || supplierDeleteInProgress) return;
  setSupDeleteModalBusy(true, supDeleteProgressLabel(0));
  try {
    await deleteSuppliersFromFirestore(ids, allSuppliersSelected, percent => {
      document.getElementById('btn-confirm-sup-bulk-delete').innerHTML = supDeleteProgressLabel(percent);
    });
    const selectedSet  = new Set(ids);
    const toDelete     = DB.get('suppliers').filter(s => selectedSet.has(String(s.id)));
    const deletedNames = new Set(toDelete.map(s => s.name));
    if (deletedNames.size) {
      setProductMaster(getProductMaster().map(p =>
        deletedNames.has(String(p.supplier || '').trim()) ? { ...p, supplier: '' } : p
      ));
    }
    DB.set('suppliers', DB.get('suppliers').filter(s => !selectedSet.has(String(s.id))));
    const count = ids.length;
    allSuppliersSelected = false;
    selectedSupIds.clear();
    document.getElementById('btn-confirm-sup-bulk-delete').textContent = '✓ Deleted!';
    await sleepSup(1000);
    supplierDeleteInProgress = false;
    closeSupDeleteModal();
    SUP_STATE.page = 1;
    supRender(); renderSummary(); renderCatFilter();
    showSupToast(`${count} supplier${count !== 1 ? 's' : ''} deleted.`, 'success');
    logAudit('Delete', 'Supplier',
      `Deleted ${count.toLocaleString()} supplier${count !== 1 ? 's' : ''}`);
  } catch (err) {
    console.error('[Suppliers] Delete failed:', err);
    alert('Could not delete the selected suppliers. Please check your connection and try again.');
    setSupDeleteModalBusy(false);
  }
}

function resetSupFilters() {
  Object.assign(SUP_STATE, {
    search:'', filterName:'', filterCat:'', filterContact:'',
    filterPhone:'', filterEmail:'', filterStatus:'', page: 1,
  });
  document.getElementById('search-sup-dir').value      = '';
  document.getElementById('filter-sup-name').value     = '';
  document.getElementById('filter-sup-cat').value      = '';
  document.getElementById('filter-sup-contact').value  = '';
  document.getElementById('filter-sup-phone').value    = '';
  document.getElementById('filter-sup-email').value    = '';
  document.getElementById('filter-sup-status').value   = '';
  supRender();
}

// ─── Main render ──────────────────────────────────────────────────────────────
function supRender() {
  const filtered   = supGetFiltered();
  const total      = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / SUP_STATE.pageSize));
  if (SUP_STATE.page > totalPages) SUP_STATE.page = totalPages;

  const pageRows = getSupPageRows(filtered);
  const counts   = supplierProductCounts();
  const tbody    = document.getElementById('sup-dir-tbody');
  const hasFilters = SUP_STATE.search || SUP_STATE.filterName || SUP_STATE.filterCat ||
    SUP_STATE.filterContact || SUP_STATE.filterPhone || SUP_STATE.filterEmail || SUP_STATE.filterStatus;

  if (!pageRows.length) {
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><div class="empty-icon">🚚</div><p>${
      !hasFilters ? 'No suppliers yet. Click "Add Supplier" to get started.' : 'No suppliers match your filters.'
    }</p></div></td></tr>`;
  } else {
    // Rows use data-id and data-action; no inline onclick/onchange — handled by tbody delegation below
    tbody.innerHTML = pageRows.map(s => {
      const sid = String(s.id);
      const logoHtml = s.logo
        ? `<img src="${s.logo}" style="width:32px;height:32px;border-radius:6px;object-fit:contain;border:1px solid var(--card-border)">`
        : `<div style="width:32px;height:32px;border-radius:6px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;color:#64748b">${s.name.slice(0,2).toUpperCase()}</div>`;
      const productCount = counts.get(s.name) || 0;
      const status = s.status || 'Active';
      return `<tr class="supplier-row" data-id="${sid}">
        <td class="sup-select-col"><input type="checkbox" class="sup-row-select" data-id="${sid}" aria-label="Select supplier" ${selectedSupIds.has(sid) ? 'checked' : ''}></td>
        <td>${logoHtml}</td>
        <td><strong style="color:var(--primary)">${s.name}</strong> <span class="badge badge-blue" style="margin-left:6px">${productCount.toLocaleString()} products</span></td>
        <td><span class="badge badge-blue">${s.category||'—'}</span></td>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.875rem;color:#64748b">${s.address||'—'}</td>
        <td>${s.contact||'—'}</td>
        <td class="mono" style="font-size:0.875rem">${s.phone||'—'}</td>
        <td style="font-size:0.875rem">${s.email||'—'}</td>
        <td><span class="badge ${status === 'Active' ? 'badge-green' : 'badge-gray'}">${status}</span></td>
        <td>
          <div class="action-btns">
            <button class="btn btn-outline btn-xs" data-action="edit" data-id="${sid}">Edit</button>
            <button class="btn btn-danger btn-xs" data-action="delete" data-id="${sid}">Delete</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  renderSortArrows();
  renderSupPagination(total);
  syncSupBulkBar();
}

// ─── Tbody event delegation (row click, edit, delete, checkbox) ───────────────
document.getElementById('sup-dir-tbody').addEventListener('click', e => {
  // Checkbox toggle: update selection, stop here (don't open detail)
  if (e.target.classList.contains('sup-row-select')) {
    toggleSupRow(e.target.dataset.id, e.target.checked);
    return;
  }
  // Checkbox cell: absorb click without opening detail
  if (e.target.closest('.sup-select-col')) return;

  // Action buttons (Edit / Delete)
  const btn = e.target.closest('[data-action]');
  if (btn) {
    const { action, id } = btn.dataset;
    if (action === 'edit')   editSupplier(id);
    if (action === 'delete') deleteSupplier(id);
    return;
  }

  // Anywhere else on the row → open detail modal
  const row = e.target.closest('.supplier-row');
  if (row) viewSupplier(row.dataset.id);
});

// ─── View supplier detail ─────────────────────────────────────────────────────
function viewSupplier(id, editMode = false) {
  const s = findSupplier(id);
  if (!s) return;
  ACTIVE_SUPPLIER_ID = String(s.id);
  DETAIL_PRODUCTS.page = 1;
  if (editMode) renderEditMode(s);
  else renderViewMode(s);
  openModal('modal-view-sup');
}

function renderViewMode(s) {
  const products = supplierProducts(s.name);
  const logo = s.logo ? `<img src="${s.logo}" style="width:60px;height:60px;border-radius:10px;object-fit:contain;border:1px solid var(--card-border);margin-bottom:16px">` : '';
  document.getElementById('modal-sup-view-title').textContent = 'Supplier Details';
  document.getElementById('view-sup-body').innerHTML = `
    ${logo}
    <div style="display:grid;gap:10px">
      <div><div style="font-size:0.75rem;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Name</div><div style="font-size:15px;font-weight:700">${s.name}</div></div>
      <div><div style="font-size:0.75rem;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Category</div><span class="badge badge-blue">${s.category||'—'}</span></div>
      <div><div style="font-size:0.75rem;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Address</div><div style="font-size:0.875rem">${s.address||'—'}</div></div>
      <div class="form-row form-row-3">
        <div><div style="font-size:0.75rem;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Contact</div><div style="font-size:0.875rem">${s.contact||'—'}</div></div>
        <div><div style="font-size:0.75rem;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Phone</div><div style="font-size:0.875rem">${s.phone||'—'}</div></div>
        <div><div style="font-size:0.75rem;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Email</div><div style="font-size:0.875rem">${s.email||'—'}</div></div>
      </div>
      ${s.notes ? `<div><div style="font-size:0.75rem;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Notes</div><div style="font-size:0.875rem;color:#64748b">${s.notes}</div></div>` : ''}
      ${productsBlock(products)}
    </div>`;
  document.getElementById('view-sup-footer').innerHTML = `
    <button class="btn btn-outline-gray" onclick="closeModal('modal-view-sup')">Close</button>
    <button class="btn btn-primary" onclick="enterEditMode()">Edit Info</button>`;
  renderSupplierProductsSection();
}

function renderEditMode(s) {
  const products = supplierProducts(s.name);
  const allCats = [...new Set([...SUP_CATS, ...DB.get('suppliers').map(r => r.category).filter(Boolean)])].sort();
  const catOptions = `<option value="">— No category —</option>` +
    allCats.map(c => `<option value="${c}"${c === (s.category || '') ? ' selected' : ''}>${c}</option>`).join('');
  document.getElementById('modal-sup-view-title').textContent = 'Edit Supplier';
  document.getElementById('view-sup-body').innerHTML = `
    <div style="display:grid;gap:14px">
      <div class="form-row form-row-2">
        <div class="form-group">
          <label class="form-label">Supplier Name <span class="req">*</span></label>
          <input type="text" class="form-input" id="vsup-name" value="${escHtml(s.name)}">
        </div>
        <div class="form-group">
          <label class="form-label">Category</label>
          <select class="form-select" id="vsup-cat">${catOptions}</select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Address</label>
        <textarea class="form-textarea" id="vsup-address" style="min-height:60px">${escHtml(s.address||'')}</textarea>
      </div>
      <div class="form-row form-row-3">
        <div class="form-group">
          <label class="form-label">Contact Person</label>
          <input type="text" class="form-input" id="vsup-contact" value="${escHtml(s.contact||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Phone</label>
          <input type="text" class="form-input" id="vsup-phone" value="${escHtml(s.phone||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Email</label>
          <input type="email" class="form-input" id="vsup-email" value="${escHtml(s.email||'')}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea class="form-textarea" id="vsup-notes">${escHtml(s.notes||'')}</textarea>
      </div>
      ${productsBlock(products)}
    </div>`;
  document.getElementById('view-sup-footer').innerHTML = `
    <button class="btn btn-outline-gray" onclick="cancelEditMode()">Cancel</button>
    <button class="btn btn-primary" onclick="saveSupplierInfo()">Save Changes</button>`;
  renderSupplierProductsSection();
}

function enterEditMode() {
  const s = findSupplier(ACTIVE_SUPPLIER_ID);
  if (s) renderEditMode(s);
}

function cancelEditMode() {
  const s = findSupplier(ACTIVE_SUPPLIER_ID);
  if (s) renderViewMode(s);
}

async function saveSupplierInfo() {
  const s = findSupplier(ACTIVE_SUPPLIER_ID);
  if (!s) return;
  const name = document.getElementById('vsup-name').value.trim();
  if (!name) { alert('Supplier Name is required.'); return; }
  const oldName = s.name;
  const record = {
    name,
    category: document.getElementById('vsup-cat').value,
    address:  document.getElementById('vsup-address').value,
    contact:  document.getElementById('vsup-contact').value,
    phone:    document.getElementById('vsup-phone').value,
    email:    document.getElementById('vsup-email').value,
    notes:    document.getElementById('vsup-notes').value,
  };
  DB.update('suppliers', s.id, record);
  try {
    await saveSupplierToFirestore(findSupplier(s.id));
  } catch (err) {
    console.error('[Suppliers] Save failed:', err);
    alert('Could not save the supplier to the database. Please try again.');
    return;
  }
  if (oldName !== name) {
    setProductMaster(getProductMaster().map(p =>
      String(p.supplier || '').trim() === oldName ? { ...p, supplier: name } : p
    ));
  }
  const updated = findSupplier(ACTIVE_SUPPLIER_ID);
  renderViewMode(updated);
  supRender(); renderSummary(); renderCatFilter();
  showSupToast('Supplier updated successfully.', 'success');
  logAudit('Edit', 'Supplier',
    `Edited supplier ${oldName}${oldName !== name ? ` -> ${name}` : ''}`);
}

function setSupplierProductsPage(page) {
  const supplier = findSupplier(ACTIVE_SUPPLIER_ID);
  const total = supplier ? supplierProducts(supplier.name).length : 0;
  DETAIL_PRODUCTS.page = Math.min(Math.max(1, page), pageCount(total, DETAIL_PRODUCTS.pageSize));
  renderSupplierProductsSection();
}

function renderSupplierProductsSection() {
  const supplier = findSupplier(ACTIVE_SUPPLIER_ID);
  const list  = document.getElementById('supplier-products-list');
  const pager = document.getElementById('supplier-products-pagination');
  const count = document.getElementById('supplier-products-count');
  if (!supplier || !list || !pager || !count) return;
  const products = supplierProducts(supplier.name);
  DETAIL_PRODUCTS.page = Math.min(DETAIL_PRODUCTS.page, pageCount(products.length, DETAIL_PRODUCTS.pageSize));
  const start    = (DETAIL_PRODUCTS.page - 1) * DETAIL_PRODUCTS.pageSize;
  const pageRows = products.slice(start, start + DETAIL_PRODUCTS.pageSize);
  count.textContent = `${products.length.toLocaleString()} product${products.length === 1 ? '' : 's'} assigned`;
  if (!pageRows.length) {
    list.innerHTML = '<div class="empty-state" style="padding:24px"><p>No products assigned to this supplier.</p></div>';
  } else {
    list.innerHTML = pageRows.map(p => {
      const code = String(productCode(p));
      return `<div class="supplier-product-row">
        <span class="mono">${code}</span>
        <strong>${productName(p) || '—'}</strong>
        <span class="mono">${formatPeso(productCost(p))}</span>
        <button class="btn btn-outline-gray btn-xs" onclick="removeSupplierProduct('${ACTIVE_SUPPLIER_ID}', '${code.replace(/'/g, "\\'")}')">Remove</button>
      </div>`;
    }).join('');
  }
  renderPager('supplier-products-pagination', products.length, DETAIL_PRODUCTS.page, DETAIL_PRODUCTS.pageSize, 'setSupplierProductsPage');
}

function removeSupplierProduct(supplierId, itemCode) {
  const supplier = findSupplier(supplierId);
  if (!supplier) return;
  setProductMaster(getProductMaster().map(p =>
    String(productCode(p)) === String(itemCode) && String(p.supplier || '').trim() === supplier.name
      ? { ...p, supplier:'' }
      : p
  ));
  renderSupplierProductsSection();
  supRender();
}

function removeAllSupplierProducts(supplierId) {
  const supplier = findSupplier(supplierId);
  if (!supplier) return;
  const count = supplierProducts(supplier.name).length;
  if (!count) return;
  confirmDelete(`Remove all ${count.toLocaleString()} product assignment${count === 1 ? '' : 's'} from <strong>${supplier.name}</strong>?`, () => {
    setProductMaster(getProductMaster().map(p =>
      String(p.supplier || '').trim() === supplier.name ? { ...p, supplier:'' } : p
    ));
    DETAIL_PRODUCTS.page = 1;
    viewSupplier(ACTIVE_SUPPLIER_ID);
    supRender();
  });
}

// ─── Assign Products modal ────────────────────────────────────────────────────
function openAssignProducts(id) {
  const supplier = findSupplier(id);
  if (!supplier) return;
  ACTIVE_SUPPLIER_ID = String(supplier.id);
  ASSIGN_SELECTED.clear();
  ASSIGN_PICKER.page = 1;
  supplierProducts(supplier.name).forEach(p => ASSIGN_SELECTED.add(String(productCode(p))));
  document.getElementById('assign-products-title').textContent = `Assign Products to ${supplier.name}`;
  document.getElementById('assign-product-search').value = '';
  showAssignSelection();
  renderProductPicker();
  openModal('modal-assign-products');
}

function showAssignSelection() {
  document.getElementById('assign-selection-view').style.display = '';
  document.getElementById('assign-review-view').style.display = 'none';
  document.getElementById('btn-review-assign-products').style.display = '';
  document.getElementById('btn-back-assign-selection').style.display = 'none';
  document.getElementById('btn-confirm-assign-products').style.display = 'none';
}

function showAssignReview() {
  const supplier = findSupplier(ACTIVE_SUPPLIER_ID);
  if (!supplier) return;
  const selected = new Set(ASSIGN_SELECTED);
  const selectedProducts = getProductMaster().filter(p => selected.has(String(productCode(p))));
  ASSIGN_REVIEW.page = 1;
  ASSIGN_REVIEW.rows = selectedProducts;
  document.getElementById('assign-selection-view').style.display = 'none';
  document.getElementById('assign-review-view').style.display = '';
  document.getElementById('btn-review-assign-products').style.display = 'none';
  document.getElementById('btn-back-assign-selection').style.display = '';
  document.getElementById('btn-confirm-assign-products').style.display = '';
  document.getElementById('assign-review-message').textContent =
    `You are about to assign ${selectedProducts.length.toLocaleString()} products to ${supplier.name}.`;
  renderAssignReviewList();
}

function setAssignReviewPage(page) {
  ASSIGN_REVIEW.page = Math.min(Math.max(1, page), pageCount(ASSIGN_REVIEW.rows.length, ASSIGN_REVIEW.pageSize));
  renderAssignReviewList();
}

function renderAssignReviewList() {
  const rows = ASSIGN_REVIEW.rows;
  const start = (ASSIGN_REVIEW.page - 1) * ASSIGN_REVIEW.pageSize;
  const pageRows = rows.slice(start, start + ASSIGN_REVIEW.pageSize);
  document.getElementById('assign-review-list').innerHTML = pageRows.length
    ? pageRows.map(p => `<div class="supplier-product-row assign-review-row">
        <span class="mono">${productCode(p)}</span>
        <strong>${productName(p) || '—'}</strong>
        <span class="mono">${formatPeso(productCost(p))}</span>
      </div>`).join('')
    : '<div class="empty-state" style="padding:24px"><p>No products selected.</p></div>';
  renderPager('assign-review-pagination', rows.length, ASSIGN_REVIEW.page, ASSIGN_REVIEW.pageSize, 'setAssignReviewPage');
}

function assignPickerPageCount(total) {
  return Math.max(1, Math.ceil(total / ASSIGN_PICKER.pageSize));
}

function assignPickerPageButtons(current, totalPages) {
  const pages = new Set([1, totalPages, current - 1, current, current + 1]);
  if (current <= 2) pages.add(3);
  if (current >= totalPages - 1) pages.add(totalPages - 2);
  return [...pages].filter(p => p >= 1 && p <= totalPages).sort((a,b) => a - b);
}

function setAssignProductPage(page) {
  ASSIGN_PICKER.page = Math.min(Math.max(1, page), assignPickerPageCount(ASSIGN_PICKER.filtered.length));
  renderProductPicker();
}

function renderAssignProductPagination(total) {
  const totalPages = assignPickerPageCount(total);
  const start = total === 0 ? 0 : (ASSIGN_PICKER.page - 1) * ASSIGN_PICKER.pageSize + 1;
  const end   = Math.min(ASSIGN_PICKER.page * ASSIGN_PICKER.pageSize, total);
  const btns  = assignPickerPageButtons(ASSIGN_PICKER.page, totalPages);
  let last = 0;
  const controls = btns.map(page => {
    const gap = page - last > 1 ? '<span class="page-ellipsis">…</span>' : '';
    last = page;
    return `${gap}<button class="page-btn ${page === ASSIGN_PICKER.page ? 'active' : ''}" onclick="setAssignProductPage(${page})">${page}</button>`;
  }).join('');
  document.getElementById('assign-product-pagination').innerHTML = `
    <div class="pagination-info">Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} products</div>
    <div class="pagination-controls">
      <button class="page-btn" onclick="setAssignProductPage(${ASSIGN_PICKER.page - 1})" ${ASSIGN_PICKER.page <= 1 ? 'disabled' : ''}>‹ Prev</button>
      ${controls}
      <button class="page-btn" onclick="setAssignProductPage(${ASSIGN_PICKER.page + 1})" ${ASSIGN_PICKER.page >= totalPages ? 'disabled' : ''}>Next ›</button>
    </div>`;
}

function renderProductPicker() {
  const q = document.getElementById('assign-product-search').value.trim().toLowerCase();
  const products = getProductMaster();
  const visible = products.filter(p => {
    const code = String(productCode(p));
    const name = String(productName(p));
    return !q || code.toLowerCase().includes(q) || name.toLowerCase().includes(q);
  });
  ASSIGN_PICKER.filtered = visible;
  ASSIGN_PICKER.page = Math.min(ASSIGN_PICKER.page, assignPickerPageCount(visible.length));
  const start    = (ASSIGN_PICKER.page - 1) * ASSIGN_PICKER.pageSize;
  const pageRows = visible.slice(start, start + ASSIGN_PICKER.pageSize);
  ASSIGN_PICKER.rows = pageRows;
  const list = document.getElementById('assign-product-list');
  if (!pageRows.length) {
    list.innerHTML = '<div class="empty-state" style="padding:24px"><p>No products match your search.</p></div>';
  } else {
    list.innerHTML = pageRows.map(p => {
      const code    = String(productCode(p));
      const checked = ASSIGN_SELECTED.has(code) ? 'checked' : '';
      return `<label class="product-picker-row">
        <input type="checkbox" class="assign-product-check" value="${code}" ${checked}>
        <span class="mono">${code}</span>
        <strong>${productName(p) || '—'}</strong>
        <span class="mono">${formatPeso(productCost(p))}</span>
      </label>`;
    }).join('');
  }
  renderAssignProductPagination(visible.length);
  const visibleCodes        = pageRows.map(p => String(productCode(p)));
  const allVisibleSelected  = visibleCodes.length > 0 && visibleCodes.every(code => ASSIGN_SELECTED.has(code));
  const someVisibleSelected = visibleCodes.some(code => ASSIGN_SELECTED.has(code));
  const master = document.getElementById('assign-product-select-all');
  master.checked       = allVisibleSelected;
  master.indeterminate = !allVisibleSelected && someVisibleSelected;
  master.disabled      = visibleCodes.length === 0;
  document.getElementById('assign-product-count').textContent = `${ASSIGN_SELECTED.size.toLocaleString()} selected`;
}

function confirmAssignProducts() {
  const supplier = findSupplier(ACTIVE_SUPPLIER_ID);
  if (!supplier) return;
  const selected      = new Set(ASSIGN_SELECTED);
  const selectedCount = selected.size;
  const products = getProductMaster().map(p => {
    const code = String(productCode(p));
    if (selected.has(code)) return { ...p, supplier: supplier.name };
    if (String(p.supplier || '').trim() === supplier.name) return { ...p, supplier: '' };
    return p;
  });
  setProductMaster(products);
  closeModal('modal-assign-products');
  DETAIL_PRODUCTS.page = 1;
  viewSupplier(ACTIVE_SUPPLIER_ID);
  supRender();
  renderSummary();
  showSupToast(`${selectedCount.toLocaleString()} products successfully assigned to ${supplier.name}.`, 'success');
}

// ─── Save / Edit / Delete supplier ───────────────────────────────────────────
async function saveSupplier() {
  const name = document.getElementById('sup-name').value.trim();
  const cat  = document.getElementById('sup-cat').value;
  if (!name) { alert('Supplier Name is required.'); return; }

  const record = {
    name, category: cat,
    address: document.getElementById('sup-address').value,
    logo:    document.getElementById('sup-logo').dataset.base64 || null,
    contact: document.getElementById('sup-contact').value,
    phone:   document.getElementById('sup-phone').value,
    email:   document.getElementById('sup-email').value,
    notes:   document.getElementById('sup-notes').value,
  };

  const editId = document.getElementById('sup-edit-id').value;
  let savedSupplier;
  if (editId) {
    const existing = findSupplier(editId);
    if (!record.logo && existing?.logo) record.logo = existing.logo;
    DB.update('suppliers', existing?.id ?? editId, record);
    savedSupplier = findSupplier(existing?.id ?? editId);
    if (existing && existing.name !== name) {
      setProductMaster(getProductMaster().map(p =>
        String(p.supplier || '').trim() === existing.name ? { ...p, supplier: name } : p
      ));
    }
  } else {
    record.id = genId();
    DB.push('suppliers', record);
    savedSupplier = record;
  }

  try {
    await saveSupplierToFirestore(savedSupplier);
  } catch (err) {
    console.error('[Suppliers] Save failed:', err);
    alert('Could not save the supplier to the database. Please try again.');
    return;
  }

  closeModal('modal-supplier');
  supRender(); renderSummary(); renderCatFilter();
  logAudit(editId ? 'Edit' : 'Create', 'Supplier',
    `${editId ? 'Edited' : 'Added'} supplier ${name}`);
}

function editSupplier(id) {
  viewSupplier(id, true);
}

function deleteSupplier(id) {
  const s = findSupplier(id);
  if (!s) return;
  allSuppliersSelected = false;
  openSupDeleteModal([String(s.id)], s.name);
}

// ─── Event listeners ──────────────────────────────────────────────────────────
document.getElementById('btn-add-supplier').addEventListener('click', () => { resetSupForm(); openModal('modal-supplier'); });
document.getElementById('btn-save-supplier').addEventListener('click', saveSupplier);

// Search & filter inputs → reset to page 1 and re-render
document.getElementById('search-sup-dir').addEventListener('input', () => {
  SUP_STATE.search = document.getElementById('search-sup-dir').value;
  SUP_STATE.page = 1; supRender();
});
document.getElementById('filter-sup-name').addEventListener('input', () => {
  SUP_STATE.filterName = document.getElementById('filter-sup-name').value;
  SUP_STATE.page = 1; supRender();
});
document.getElementById('filter-sup-cat').addEventListener('change', () => {
  SUP_STATE.filterCat = document.getElementById('filter-sup-cat').value;
  SUP_STATE.page = 1; supRender();
});
document.getElementById('filter-sup-contact').addEventListener('input', () => {
  SUP_STATE.filterContact = document.getElementById('filter-sup-contact').value;
  SUP_STATE.page = 1; supRender();
});
document.getElementById('filter-sup-phone').addEventListener('input', () => {
  SUP_STATE.filterPhone = document.getElementById('filter-sup-phone').value;
  SUP_STATE.page = 1; supRender();
});
document.getElementById('filter-sup-email').addEventListener('input', () => {
  SUP_STATE.filterEmail = document.getElementById('filter-sup-email').value;
  SUP_STATE.page = 1; supRender();
});
document.getElementById('filter-sup-status').addEventListener('change', () => {
  SUP_STATE.filterStatus = document.getElementById('filter-sup-status').value;
  SUP_STATE.page = 1; supRender();
});

document.getElementById('btn-clear-sup-filters').addEventListener('click', resetSupFilters);

// Bulk delete
document.getElementById('btn-delete-sup-selected').addEventListener('click', openBulkDeleteSupModal);
document.getElementById('btn-deselect-sup').addEventListener('click', deselectAllSup);
document.getElementById('btn-select-all-suppliers').addEventListener('click', selectAllSuppliers);
document.getElementById('btn-confirm-sup-bulk-delete').addEventListener('click', confirmBulkDeleteSup);
document.getElementById('modal-bulk-delete-sup').addEventListener('click', event => {
  if (supplierDeleteInProgress && event.target === event.currentTarget) event.stopPropagation();
}, true);
document.addEventListener('keydown', event => {
  if (supplierDeleteInProgress && event.key === 'Escape') event.stopPropagation();
}, true);

// Assign-products modal
document.getElementById('assign-product-search').addEventListener('input', () => {
  ASSIGN_PICKER.page = 1; renderProductPicker();
});
document.getElementById('assign-product-list').addEventListener('change', e => {
  if (!e.target.classList.contains('assign-product-check')) return;
  if (e.target.checked) ASSIGN_SELECTED.add(e.target.value);
  else ASSIGN_SELECTED.delete(e.target.value);
  renderProductPicker();
});
document.getElementById('assign-product-select-all').addEventListener('change', function() {
  ASSIGN_PICKER.rows.forEach(product => {
    const code = String(productCode(product));
    if (this.checked) ASSIGN_SELECTED.add(code);
    else ASSIGN_SELECTED.delete(code);
  });
  renderProductPicker();
});
document.getElementById('btn-review-assign-products').addEventListener('click', showAssignReview);
document.getElementById('btn-back-assign-selection').addEventListener('click', () => {
  showAssignSelection(); renderProductPicker();
});
document.getElementById('btn-confirm-assign-products').addEventListener('click', confirmAssignProducts);

// ─── Init ─────────────────────────────────────────────────────────────────────
renderSummary();
renderCatFilter();
supRender();
Promise.all([
  loadSuppliersFromFirestore(),
  loadProductMasterFromFirestore()
])
  .then(() => { renderSummary(); renderCatFilter(); supRender(); })
  .catch(err => console.error('[Suppliers] Firestore load failed:', err));

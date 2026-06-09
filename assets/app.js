/* ─── EPC Accounting Portal — Shared App JS ─────────────────────────────── */

// ─── Storage Helpers ────────────────────────────────────────────────────────
// Large shared collections live in Firestore. Keep only an in-memory view for
// synchronous rendering; never serialize these datasets into localStorage.
const FIRESTORE_ONLY_KEYS = new Set([
  'productMaster', 'productmaster', 'product_master', 'products',
  'salesData', 'underReviewData', 'importHistory', 'inventoryData',
  'inventory_movements', 'suppliers', 'eSalesRecords'
]);
const _runtimeData = Object.create(null);
[
  'productMaster', 'productmaster', 'product_master', 'products',
  'salesData', 'underReviewData', 'importHistory', 'inventoryData',
  'inventory_movements', 'suppliers', 'eSalesRecords'
].forEach(key => localStorage.removeItem(key));

const DB = {
  get(key) {
    if (FIRESTORE_ONLY_KEYS.has(key)) return _runtimeData[key] || [];
    try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
  },
  getObj(key, d={}) { try { return JSON.parse(localStorage.getItem(key)) || d;  } catch { return d;  } },
  set(key, val) {
    if (FIRESTORE_ONLY_KEYS.has(key)) {
      _runtimeData[key] = val;
      return;
    }
    localStorage.setItem(key, JSON.stringify(val));
  },
  push(key, item)   { const a = DB.get(key); a.push(item); DB.set(key, a); return a; },
  update(key, id, upd) {
    const a = DB.get(key);
    const i = a.findIndex(x => x.id === id);
    if (i !== -1) a[i] = { ...a[i], ...upd };
    DB.set(key, a);
    return a;
  },
  remove(key, id) {
    const a = DB.get(key).filter(x => x.id !== id);
    DB.set(key, a);
    return a;
  }
};

// ─── Firebase / Product Master bridge ──────────────────────────────────────
// Product Master keeps an in-memory cache because existing pages use
// synchronous reads while rendering. Firestore is the shared source of truth.
const EPC_FIREBASE_CONFIG = {
  apiKey:            'AIzaSyBm2ASuGDvYBgG7_G1xHryeIyv3kOaEYZg',
  authDomain:        'palo-grocerette-accounting.firebaseapp.com',
  projectId:         'palo-grocerette-accounting',
  storageBucket:     'palo-grocerette-accounting.firebasestorage.app',
  messagingSenderId: '46771511408',
  appId:             '1:46771511408:web:0b2cd68d0f8f4405a154b5'
};
const EPC_FIRESTORE_EMULATOR_HOST = 'localhost';
const EPC_FIRESTORE_EMULATOR_PORT = 8080;
let _firestoreEmulatorConnected = false;
let _firestoreConnectionLogged = false;

function isLocalhostRuntime() {
  if (typeof window === 'undefined') return false;
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname);
}

function isFirestoreEmulatorActive() {
  return _firestoreEmulatorConnected && isLocalhostRuntime();
}

function connectFirestoreEmulatorIfLocal(db) {
  if (!db) return;
  const currentUrl = typeof window !== 'undefined' ? window.location.href : '';
  const currentHostname = typeof window !== 'undefined' ? window.location.hostname : '';
  if (!isLocalhostRuntime()) {
    if (!_firestoreConnectionLogged) {
      console.log('Firestore URL:', currentUrl);
      console.log('Firestore hostname:', currentHostname || '(empty)');
      console.log('Firestore emulator active:', false);
      console.log("🌐 CONNECTED TO PRODUCTION FIRESTORE");
      _firestoreConnectionLogged = true;
    }
    return;
  }
  if (_firestoreEmulatorConnected) return;
  if (typeof db.useEmulator === 'function') {
    db.useEmulator(EPC_FIRESTORE_EMULATOR_HOST, EPC_FIRESTORE_EMULATOR_PORT);
    _firestoreEmulatorConnected = true;
    console.log('Firestore URL:', currentUrl);
    console.log('Firestore hostname:', currentHostname);
    console.log('Firestore emulator active:', true);
    console.log("✅ CONNECTED TO FIRESTORE EMULATOR");
    _firestoreConnectionLogged = true;
  }
}

// Initialize immediately so any page script can call firebase.auth() /
// firebase.firestore() directly without going through the lazy helpers first.
if (typeof firebase !== 'undefined' && !firebase.apps.length) {
  firebase.initializeApp(EPC_FIREBASE_CONFIG);
}
if (typeof firebase !== 'undefined' && typeof firebase.firestore === 'function') {
  connectFirestoreEmulatorIfLocal(firebase.firestore());
}
let _productMasterWriteQueue = Promise.resolve();

function getFirestoreDB() {
  if (typeof firebase === 'undefined') return null;
  if (!firebase.apps.length) firebase.initializeApp(EPC_FIREBASE_CONFIG);
  if (typeof firebase.firestore !== 'function') return null;
  const db = firebase.firestore();
  connectFirestoreEmulatorIfLocal(db);
  return db;
}

function cacheProductMasterRows(rows) {
  DB.set('productMaster', rows);
}

function getCachedProductMasterRows() {
  return DB.get('productMaster');
}

function normalizeCostHistoryEntry(entry) {
  const unitCost = Number(entry?.unitCost) || 0;
  if (unitCost <= 0) return null;
  return {
    date: String(entry?.date || todayISO()).slice(0, 10),
    unitCost,
    supplier: String(entry?.supplier || '').trim()
  };
}

function normalizeProductCostData(product) {
  const normalized = { ...product };
  let history = Array.isArray(product.costHistory)
    ? product.costHistory.map(normalizeCostHistoryEntry).filter(Boolean)
    : [];
  if (!history.length) {
    const legacyCost = Number(product.latestCost ?? product.unitCost ?? product.cost) || 0;
    if (legacyCost > 0) {
      history = [{
        date: String(product.latestDate || product.updatedAt || todayISO()).slice(0, 10),
        unitCost: legacyCost,
        supplier: String(product.supplier || '').trim()
      }];
    }
  }
  history.sort((a, b) => a.date.localeCompare(b.date));
  const latest = history[history.length - 1];
  const averageCost = history.length
    ? history.reduce((sum, entry) => sum + entry.unitCost, 0) / history.length
    : 0;
  normalized.costHistory = history;
  normalized.latestCost = latest?.unitCost || 0;
  normalized.latestDate = latest?.date || '';
  normalized.averageCost = averageCost;
  normalized.unitCost = normalized.latestCost;
  normalized.cost = normalized.latestCost;
  return normalized;
}

function cleanFirestoreProduct(row) {
  const clean = normalizeProductCostData(row);
  delete clean._firestoreId;
  return clean;
}

function productMasterFirestoreDocId(row) {
  return String(row.itemCode || row.code || '').trim();
}

async function replaceProductMasterInFirestore(rows) {
  const db = getFirestoreDB();
  if (!db) return;
  const snap = await db.collection('productMaster').get();
  const BATCH_SIZE = 499;

  for (let i = 0; i < snap.docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    let pendingWrites = 0;
    snap.docs.slice(i, i + BATCH_SIZE).forEach(doc => {
      batch.delete(doc.ref);
      pendingWrites += 1;
    });
    if (pendingWrites > 0) await batch.commit();
  }
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = db.batch();
    let pendingWrites = 0;
    rows.slice(i, i + BATCH_SIZE).forEach(row => {
      const docId = productMasterFirestoreDocId(row);
      if (docId) {
        batch.set(db.collection('productMaster').doc(docId), cleanFirestoreProduct(row));
        pendingWrites += 1;
      }
    });
    if (pendingWrites > 0) await batch.commit();
  }
}

function syncProductMasterToFirestore(rows) {
  const snapshot = rows.map(row => ({ ...row }));
  _productMasterWriteQueue = _productMasterWriteQueue
    .catch(() => {})
    .then(() => replaceProductMasterInFirestore(snapshot))
    .catch(err => console.error('[Product Master] Firestore sync failed:', err));
  return _productMasterWriteQueue;
}

async function loadProductMasterFromFirestore(orderByField = '', seedIfEmpty = true) {
  const db = getFirestoreDB();
  if (!db) return getCachedProductMasterRows();
  let query = db.collection('productMaster');
  if (orderByField) query = query.orderBy(orderByField);
  const snap = await query.get();
  if (snap.empty) {
    cacheProductMasterRows([]);
    return [];
  }
  const rows = snap.docs.map(doc => normalizeProductCostData({ _firestoreId: doc.id, ...doc.data() }));
  cacheProductMasterRows(rows);
  return rows;
}

async function upsertProductMasterRowsInFirestore(rows, onProgress, options = {}) {
  const db = getFirestoreDB();
  const normalizedRows = rows.map(row => Object.assign(row, normalizeProductCostData(row)));
  if (!normalizedRows.length) return normalizedRows;
  const BATCH_SIZE = options.batchSize || 499;
  const commitBatch = options.commitBatch || ((batch) => batch.commit());
  const delay = options.delay || (() => Promise.resolve());
  if (db) {
    let written = 0;
    const legacyDocIds = new Set();
    for (let i = 0; i < normalizedRows.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = normalizedRows.slice(i, i + BATCH_SIZE);
      let pendingWrites = 0;
      chunk.forEach(row => {
        const docId = productMasterFirestoreDocId(row);
        if (!docId) return;
        if (row._firestoreId && row._firestoreId !== docId) legacyDocIds.add(row._firestoreId);
        const ref = db.collection('productMaster').doc(docId);
        row._firestoreId = ref.id;
        batch.set(ref, cleanFirestoreProduct(row), { merge: true });
        pendingWrites += 1;
      });
      if (pendingWrites > 0) {
        await commitBatch(batch, Math.min(i + BATCH_SIZE, normalizedRows.length));
        await delay();
      }
      written += chunk.length;
      if (onProgress) onProgress(written, normalizedRows.length);
    }
    const staleIds = [...legacyDocIds];
    for (let i = 0; i < staleIds.length; i += BATCH_SIZE) {
      const batch = db.batch();
      let pendingWrites = 0;
      staleIds.slice(i, i + BATCH_SIZE).forEach(id => {
        batch.delete(db.collection('productMaster').doc(id));
        pendingWrites += 1;
      });
      if (pendingWrites > 0) {
        await commitBatch(batch, normalizedRows.length);
        await delay();
      }
    }
  }
  const cachedRows = getCachedProductMasterRows();
  const byCode = new Map(cachedRows.map(row => [String(row.itemCode || row.code || '').trim().toLowerCase(), row]));
  normalizedRows.forEach(row => byCode.set(String(row.itemCode || row.code || '').trim().toLowerCase(), row));
  cacheProductMasterRows([...byCode.values()]);
  return normalizedRows;
}

async function loadSuppliersFromFirestore() {
  const db = getFirestoreDB();
  if (!db) return DB.get('suppliers');
  const snap = await db.collection('suppliers').get();
  const rows = snap.docs.map(doc => ({ _firestoreId: doc.id, ...doc.data() }));
  DB.set('suppliers', rows);
  return rows;
}

async function loadInventoryFromFirestore() {
  const db = getFirestoreDB();
  if (!db) return DB.get('inventory_movements');
  const snap = await db.collection('inventoryData').get();
  const rows = snap.docs.map(doc => ({ _firestoreId: doc.id, ...doc.data() }));
  DB.set('inventory_movements', rows);
  return rows;
}

// Purchases live in the Firestore 'purchases' collection. On first run against
// an empty collection, any existing local purchases are migrated up so nothing
// is lost. The local cache stays only for synchronous rendering.
async function loadPurchasesFromFirestore() {
  const localRows = DB.get('purchases');
  const db = getFirestoreDB();
  if (!db) return localRows;
  const snap = await db.collection('purchases').get();
  const firestoreRows = snap.docs.map(doc => ({ _firestoreId: doc.id, ...doc.data() }));
  if (firestoreRows.length) {
    DB.set('purchases', firestoreRows);
    return firestoreRows;
  }
  for (const row of localRows) {
    const docId = row.id || genId();
    row.id = docId;
    const clean = { ...row };
    delete clean._firestoreId;
    await db.collection('purchases').doc(docId).set(clean, { merge: true });
    row._firestoreId = docId;
  }
  if (localRows.length) DB.set('purchases', localRows);
  return localRows;
}

// ─── Utilities ──────────────────────────────────────────────────────────────
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

function formatPeso(n) {
  const num = parseFloat(n) || 0;
  return '₱' + num.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatNum(n) {
  const num = parseFloat(n) || 0;
  return num.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function parsePeso(s) {
  if (typeof s === 'number') return s;
  return parseFloat(String(s).replace(/[₱,\s]/g, '')) || 0;
}
function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-PH', { year:'numeric', month:'short', day:'numeric' });
}
function todayISO() { return new Date().toISOString().slice(0,10); }

function pct(num, den) {
  if (!den) return '0.0%';
  return ((num / den) * 100).toFixed(1) + '%';
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvDate(value) {
  if (!value) return '';
  const iso = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return `${String(parsed.getMonth() + 1).padStart(2, '0')}/${String(parsed.getDate()).padStart(2, '0')}/${parsed.getFullYear()}`;
}

function exportRowsToCSV(filename, columns, rows) {
  const header = columns.map(col => csvCell(col.label)).join(',');
  const body = rows.map(row => columns.map(col => {
    const value = typeof col.value === 'function' ? col.value(row) : row[col.value || col.key];
    return csvCell(value);
  }).join(','));
  const blob = new Blob([[header, ...body].join('\n')], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return rows.length;
}

// ─── Word (.doc) export helpers ───────────────────────────────────────────────
// Generates an HTML-based .doc that Microsoft Word opens natively (no library).
function wordEsc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Serialize a rendered <table> to clean HTML, dropping filter/input rows.
function serializeTableToWord(table) {
  if (!table) return '';
  const trs = [...table.rows].filter(tr => !tr.querySelector('input, select'));
  const body = trs.map(tr => `<tr>${[...tr.cells].map(cell => {
    const tag = cell.tagName.toLowerCase() === 'th' ? 'th' : 'td';
    return `<${tag}>${wordEsc(cell.innerText.replace(/\s+/g, ' ').trim())}</${tag}>`;
  }).join('')}</tr>`).join('');
  return `<table border="1" cellspacing="0" cellpadding="4">${body}</table>`;
}

// Serialize a table for Excel, forcing every cell to TEXT so long numeric codes
// (e.g. 4800361410816) aren't mangled into scientific notation (4.8E+12).
function serializeTableToExcel(table) {
  if (!table) return '';
  const trs = [...table.rows].filter(tr => !tr.querySelector('input, select'));
  const body = trs.map(tr => `<tr>${[...tr.cells].map(cell => {
    const tag = cell.tagName.toLowerCase() === 'th' ? 'th' : 'td';
    return `<${tag} style="mso-number-format:'\\@'">${wordEsc(cell.innerText.replace(/\s+/g, ' ').trim())}</${tag}>`;
  }).join('')}</tr>`).join('');
  return `<table>${body}</table>`;
}

// ─── PDF export (in-page print-to-PDF, no library, no popup window) ────────────
// Renders the report into a hidden #report-print-area on the CURRENT page and
// calls window.print(); a print stylesheet hides everything else, so only the
// native print dialog appears (user picks "Save as PDF"). Graphs fit the page.
function ensurePrintArea() {
  let area = document.getElementById('report-print-area');
  if (area) return area;
  area = document.createElement('div');
  area.id = 'report-print-area';
  document.body.appendChild(area);
  const style = document.createElement('style');
  style.textContent = `
    #report-print-area { display:none; }
    #report-print-area h1 { font-size:20px; margin:0 0 4px; }
    #report-print-area p.meta { color:#64748b; font-size:12px; margin:0 0 12px; }
    #report-print-area img { max-width:100%; height:auto; display:block; margin:12px 0; }
    #report-print-area table { border-collapse:collapse; width:100%; margin:12px 0; font-size:11px; }
    #report-print-area th, #report-print-area td { border:1px solid #999; padding:4px 6px; text-align:left; }
    #report-print-area th { background:#f1f5f9; }
    @media print {
      @page { size:A4; margin:14mm; }
      body > *:not(#report-print-area) { display:none !important; }
      #report-print-area { display:block !important; }
      #report-print-area table { page-break-inside:auto; }
      #report-print-area tr { page-break-inside:avoid; }
      #report-print-area thead { display:table-header-group; }
    }`;
  document.head.appendChild(style);
  return area;
}

function printReportPDF(title, bodyHtml) {
  const area = ensurePrintArea();
  area.innerHTML = `${bodyHtml}<p class="meta">Generated ${new Date().toLocaleString('en-PH')} — EPC Commercial Corporation</p>`;
  const prevTitle = document.title;   // the saved-PDF filename defaults to the title
  document.title = title;
  window.print();
  document.title = prevTitle;
}

// ─── Excel export (HTML-based .xls, no library) ───────────────────────────────
function downloadExcel(title, bodyHtml) {
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${wordEsc(String(title).slice(0, 31))}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>table{border-collapse:collapse} th,td{border:1px solid #999;padding:4px 8px} th{background:#f1f5f9;font-weight:bold}</style>
</head><body>${bodyHtml}</body></html>`;
  const blob = new Blob(['﻿', html], { type:'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${String(title).replace(/[^\w]+/g, '-').toLowerCase().replace(/^-|-$/g, '')}-${todayISO()}.xls`;
  link.click();
  URL.revokeObjectURL(url);
}

// ─── Number input auto-format ────────────────────────────────────────────────
function initNumberFormatting(container) {
  const root = container || document;
  root.querySelectorAll('input[data-currency]').forEach(el => {
    el.addEventListener('blur', function() {
      const v = parsePeso(this.value);
      if (this.value !== '') this.value = formatNum(v);
    });
    el.addEventListener('focus', function() {
      const v = parsePeso(this.value);
      this.value = v || '';
    });
  });
}

// ─── Confirmation Dialog ────────────────────────────────────────────────────
function confirmDelete(msg, cb) {
  const el = document.createElement('div');
  el.className = 'confirm-dialog';
  el.innerHTML = `<div class="confirm-card">
    <h3>Confirm Delete</h3>
    <p>${msg || 'This action cannot be undone.'}</p>
    <div class="confirm-buttons">
      <button class="btn btn-outline-gray btn-sm" id="_cc">Cancel</button>
      <button class="btn btn-danger btn-sm" id="_co">Delete</button>
    </div></div>`;
  document.body.appendChild(el);
  el.querySelector('#_cc').onclick = () => el.remove();
  el.querySelector('#_co').onclick = () => { el.remove(); cb(); };
  el.addEventListener('click', e => { if (e.target === el) el.remove(); });
}

// ─── Modal Helpers ──────────────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.add('open'); el.querySelector('.modal-card')?.scrollTo(0,0); }
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}
function initModals() {
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('open'); });
  });
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', function() {
      const m = this.closest('.modal-overlay');
      if (m) m.classList.remove('open');
    });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const open = document.querySelector('.modal-overlay.open');
      if (open) open.classList.remove('open');
    }
  });
}

// ─── Category Dropdown ──────────────────────────────────────────────────────
function refreshCatDropdown(sel, storageKey, defaults, selected) {
  const extras = DB.get(storageKey + '_cats');
  const all = [...defaults, ...extras.filter(e => !defaults.includes(e))];
  const cur = selected !== undefined ? selected : sel.value;
  sel.innerHTML = '<option value="">Select category...</option>' +
    all.map(c => `<option value="${c}"${c===cur?' selected':''}>${c}</option>`).join('') +
    '<option value="__add">+ Add Category</option>';
}
function initCatDropdown(sel, storageKey, defaults) {
  if (!sel) return;
  refreshCatDropdown(sel, storageKey, defaults);
  sel.addEventListener('focus', function() { this._prev = this.value; });
  sel.addEventListener('change', function() {
    if (this.value === '__add') showAddCatModal(this, storageKey, defaults);
  });
}
function showAddCatModal(sel, storageKey, defaults) {
  const el = document.createElement('div');
  el.className = 'mini-modal';
  el.innerHTML = `<div class="mini-modal-card">
    <h3>Add New Category</h3>
    <div class="form-group">
      <label class="form-label">Category Name</label>
      <input type="text" class="form-input" id="_catinput" placeholder="e.g. Beverages">
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
      <button class="btn btn-outline-gray btn-sm" id="_catcancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="_catsave">Add</button>
    </div></div>`;
  document.body.appendChild(el);
  const inp = el.querySelector('#_catinput');
  inp.focus();
  el.querySelector('#_catcancel').onclick = () => { sel.value = sel._prev||''; el.remove(); };
  el.querySelector('#_catsave').onclick = () => {
    const name = inp.value.trim();
    if (!name) { inp.focus(); return; }
    const cats = DB.get(storageKey + '_cats');
    if (!cats.includes(name)) { cats.push(name); DB.set(storageKey + '_cats', cats); }
    refreshCatDropdown(sel, storageKey, defaults, name);
    el.remove();
  };
  el.addEventListener('click', e => { if (e.target===el) { sel.value = sel._prev||''; el.remove(); } });
  inp.addEventListener('keydown', e => {
    if (e.key==='Enter') el.querySelector('#_catsave').click();
    if (e.key==='Escape') el.querySelector('#_catcancel').click();
  });
}

// ─── Supplier Dropdown ──────────────────────────────────────────────────────
function populateSupplierDropdown(sel, allowNew=true) {
  if (!sel) return;
  const suppliers = DB.get('suppliers');
  sel.innerHTML = '<option value="">Select supplier...</option>' +
    suppliers.map(s => `<option value="${s.name}">${s.name}</option>`).join('') +
    (allowNew ? '<option value="__new">+ Add New Supplier</option>' : '');
}

function supplierPickerEsc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function ensureSharedSupplier(name) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return null;
  const key = cleanName.toLowerCase();
  const existing = DB.get('suppliers')
    .find(supplier => String(supplier.name || '').trim().toLowerCase() === key);
  if (existing) return existing;

  const supplier = { id:genId(), name:cleanName, category:'', status:'Active' };
  const db = getFirestoreDB();
  if (db) await db.collection('suppliers').doc(supplier.id).set(supplier, { merge:true });
  DB.push('suppliers', supplier);
  logAudit('Create', 'Supplier', `Added supplier ${cleanName}`);
  return supplier;
}

function initSupplierPicker(valueId, searchId, resultsId) {
  const valueEl = document.getElementById(valueId);
  const searchEl = document.getElementById(searchId);
  const resultsEl = document.getElementById(resultsId);
  if (!valueEl || !searchEl || !resultsEl || searchEl._supplierPickerReady) return;
  searchEl._supplierPickerReady = true;

  function setValue(value = '') {
    valueEl.value = value;
    searchEl.value = value;
    resultsEl.innerHTML = '';
    const emptyMessage = document.getElementById(`${valueId}-empty`);
    if (emptyMessage) emptyMessage.style.display = DB.get('suppliers').length ? 'none' : '';
  }

  function render() {
    const typed = searchEl.value.trim();
    const query = typed.toLowerCase();
    const matches = DB.get('suppliers')
      .filter(supplier => String(supplier.name || '').toLowerCase().includes(query))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
      .slice(0, 8);
    const hasExact = matches.some(supplier => String(supplier.name || '').toLowerCase() === query);
    resultsEl.innerHTML = matches.map(supplier =>
      `<button type="button" data-supplier="${encodeURIComponent(supplier.name)}">${supplierPickerEsc(supplier.name)}</button>`
    ).join('') + (typed && !hasExact
      ? `<button type="button" class="supplier-picker-add" data-add-supplier="${encodeURIComponent(typed)}">+ Add "${supplierPickerEsc(typed)}" as new supplier</button>`
      : '');
  }

  searchEl.addEventListener('input', () => {
    valueEl.value = '';
    render();
  });
  searchEl.addEventListener('focus', render);
  resultsEl.addEventListener('click', async event => {
    const option = event.target.closest('[data-supplier],[data-add-supplier]');
    if (!option) return;
    if (option.dataset.addSupplier) {
      try {
        const supplier = await ensureSharedSupplier(decodeURIComponent(option.dataset.addSupplier));
        if (supplier) setValue(supplier.name);
      } catch (err) {
        console.error('[Suppliers] Inline add failed:', err);
        alert('Could not add the supplier. Please try again.');
      }
    } else {
      setValue(decodeURIComponent(option.dataset.supplier));
    }
  });
  searchEl._setSupplierValue = setValue;
}

function setSupplierPickerValue(valueId, value = '') {
  const valueEl = document.getElementById(valueId);
  const searchEl = document.getElementById(`${valueId}-search`);
  const resultsEl = document.getElementById(`${valueId}-results`);
  if (!valueEl || !searchEl || !resultsEl) return;
  valueEl.value = value;
  searchEl.value = value;
  resultsEl.innerHTML = '';
  const emptyMessage = document.getElementById(`${valueId}-empty`);
  if (emptyMessage) emptyMessage.style.display = DB.get('suppliers').length ? 'none' : '';
}

// ─── Table Search ───────────────────────────────────────────────────────────
function initTableSearch(inputSel, tbodySel) {
  const inp = typeof inputSel==='string' ? document.getElementById(inputSel) : inputSel;
  const tbd = typeof tbodySel==='string' ? document.getElementById(tbodySel) : tbodySel;
  if (!inp || !tbd) return;
  inp.addEventListener('input', function() {
    const q = this.value.toLowerCase();
    tbd.querySelectorAll('tr').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

// ─── Sidebar ────────────────────────────────────────────────────────────────
const ICONS = {
  grid:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
  bag:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>`,
  receipt:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16l3-2 3 2 3-2 3 2V4a2 2 0 00-2-2z"/><line x1="8" y1="9" x2="14" y2="9"/><line x1="8" y1="13" x2="14" y2="13"/></svg>`,
  card:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`,
  upload:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/></svg>`,
  package:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
  layers:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
  doc:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  pct:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>`,
  box:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>`,
  truck:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`,
  chart:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
  users:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>`,
  calc:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="10" y2="14"/><line x1="14" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="10" y2="18"/><line x1="14" y1="18" x2="16" y2="18"/></svg>`,
  book:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>`
};

const NAV = [
  { section:'OVERVIEW' },
  { href:'dashboard.html', icon:'grid',    label:'Dashboard',         key:'dashboard' },
  { section:'TRANSACTIONS' },
  { href:'pos-import.html',icon:'upload',  label:'Sales',             key:'pos-import' },
  { href:'purchases-ewt.html', icon:'bag', label:'Purchases',         key:'purchases' },
  { href:'expenses.html',  icon:'card',    label:'Expenses',          key:'expenses' },
  { section:'TRACKING' },
  { href:'inventory-tracking.html', icon:'package', label:'Inventory Tracking', key:'inventory-tracking' },
  { href:'potential-revenue.html', icon:'chart', label:'Potential Revenue', key:'potential-revenue' },
  { href:'supplies-tracking.html', icon:'layers', label:'Supplies Tracking', key:'supplies' },
  { section:'FINANCIAL' },
  { href:'tax-monitoring.html',   icon:'pct', label:'Tax Monitoring',   key:'tax-monitoring' },
  { href:'e-sales.html',          icon:'chart', label:'E-Sales Records', key:'e-sales' },
  { section:'MASTER DATA' },
  { href:'product-master.html', icon:'box',   label:'Product Master', key:'product-master' },
  { href:'suppliers.html',      icon:'truck',  label:'Suppliers',      key:'suppliers' },
  { section:'REPORTS' },
  { href:'reports.html',        icon:'chart',  label:'Reports',        key:'reports' },
  { section:'SYSTEM' },
  { href:'settings.html',       icon:'users',  label:'Settings',       key:'settings' },
  { href:'audit-log.html',      icon:'receipt', label:'Audit Log',     key:'audit-log' },
];

const AUDIT_LOG_KEY = 'auditLog';
const EPC_AUTH_DOMAIN = '@palogrocerette.local';
const EPC_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
let _idleLogoutTimer = null;
let _idleLogoutEventsBound = false;

// Canonical role tokens that match firestore.rules ('accountant'|'limited'|'viewer').
// Accepts any casing or spacing the admin may have typed in the Firestore console.
function _normalizeRole(raw) {
  switch (String(raw || '').trim().toLowerCase()) {
    case 'accountant':                  return 'accountant';
    case 'limited':
    case 'limited access':
    case 'limited-access':             return 'limited';
    default:                           return 'viewer';
  }
}

// Human-readable label used in the sidebar and Settings page role field.
function roleDisplayName(role) {
  switch (role) {
    case 'accountant': return 'Accountant';
    case 'limited':    return 'Limited Access';
    default:           return 'Viewer';
  }
}

function userRoleDocumentPath(uid) {
  return `users/${uid}`;
}

function logLocalUserRoleSeedInfo(firebaseUser) {
  if (!isFirestoreEmulatorActive() || !firebaseUser?.uid) return;
  const username = String(firebaseUser.email || '').replace(EPC_AUTH_DOMAIN, '');
  console.log('Firestore user role path:', userRoleDocumentPath(firebaseUser.uid));
  console.log(
    'Seed local Accountant role:',
    `node scripts/seed-local-accountant.js ${firebaseUser.uid} ${username}`
  );
}

function logLoadedUserRole(firebaseUser, snap, data, normalizedRole) {
  const path = userRoleDocumentPath(firebaseUser.uid);
  console.log('Loaded Firestore user role path:', path);
  console.log('Loaded Firestore user role document exists:', snap.exists);
  console.log('Loaded Firestore user role raw value:', data.role);
  console.log('Loaded Firestore user role normalized value:', normalizedRole);
  if (isFirestoreEmulatorActive() && normalizedRole === 'viewer') {
    console.warn(
      'Local emulator role is Viewer. Seed the emulator user doc shown above, then refresh the app.'
    );
  }
}

// In-memory user state — populated once by onAuthStateChanged inside initSidebar.
// login.html never calls initSidebar, so _currentEPCUser stays null there (intentional).
let _currentEPCUser = null;

// Remove any legacy credentials left by the old fake-auth system on every page load.
['epc_users', 'epc_current_user'].forEach(k => localStorage.removeItem(k));

function getFirebaseAuth() {
  if (typeof firebase === 'undefined') return null;
  if (!firebase.apps.length) firebase.initializeApp(EPC_FIREBASE_CONFIG);
  return firebase.auth();
}

function getCurrentUser() {
  return _currentEPCUser || { uid:'', username:'', firstName:'', middleName:'', lastName:'', role:'viewer' };
}

function hasEPCSession() {
  return Boolean(_currentEPCUser);
}

function logoutEPCUser() {
  logAudit('Logout', 'User Session', `${currentUserFullName()} logged out`);
  _currentEPCUser = null;
  sessionStorage.setItem('epc_signed_out_at', String(Date.now()));
  const auth = getFirebaseAuth();
  const doRedirect = () => { location.replace('login.html'); };
  if (auth) auth.signOut().then(doRedirect).catch(doRedirect);
  else doRedirect();
}

function idleLogoutEPCUser() {
  if (!_currentEPCUser) return;
  logAudit('Auto Logout', 'User Session', `${currentUserFullName()} was signed out after 5 minutes of inactivity`);
  _currentEPCUser = null;
  sessionStorage.setItem('epc_signed_out_at', String(Date.now()));
  const auth = getFirebaseAuth();
  const doRedirect = () => { location.replace('login.html'); };
  if (auth) auth.signOut().then(doRedirect).catch(doRedirect);
  else doRedirect();
}

function resetIdleLogoutTimer() {
  if (!_currentEPCUser) return;
  clearTimeout(_idleLogoutTimer);
  _idleLogoutTimer = setTimeout(idleLogoutEPCUser, EPC_IDLE_TIMEOUT_MS);
}

function startIdleLogoutWatch() {
  resetIdleLogoutTimer();
  if (_idleLogoutEventsBound) return;
  _idleLogoutEventsBound = true;
  ['click', 'keydown', 'scroll', 'touchstart', 'mousemove'].forEach(eventName => {
    window.addEventListener(eventName, resetIdleLogoutTimer, { passive:true });
  });
}

function stopIdleLogoutWatch() {
  clearTimeout(_idleLogoutTimer);
  _idleLogoutTimer = null;
}

function currentUserFullName(user = getCurrentUser()) {
  return [user.firstName, user.middleName, user.lastName].filter(Boolean).join(' ');
}

function currentUserInitials(user = getCurrentUser()) {
  const first = String(user.firstName || user.username || 'U').trim()[0] || 'U';
  const last = String(user.lastName || '').trim()[0] || '';
  return (first + last).toUpperCase();
}

function auditUserName(user = getCurrentUser()) {
  return currentUserFullName(user) || user.username || roleDisplayName(user.role);
}

function canCurrentUserEdit(activeKey) {
  const role = getCurrentUser().role;                       // already normalized to lowercase token
  if (role === 'accountant') return true;
  if (role === 'limited') return activeKey !== 'pos-import'; // edit all pages except sales
  return activeKey === 'settings';                           // viewer: own settings only
}

function applyRolePermissions(activeKey) {
  if (canCurrentUserEdit(activeKey)) return;
  const mutationPattern = /(add|save|delete|remove|import|upload|confirm|assign|update|edit|clear-all|remit|browse)/i;
  document.querySelectorAll('button, input[type="file"]').forEach(element => {
    const signature = `${element.id || ''} ${element.className || ''} ${element.getAttribute('onclick') || ''} ${element.textContent || ''}`;
    if (element.closest('.sidebar')) return;
    if (element.matches('[data-report-tab], .tab-btn, .page-btn, .purchase-page-btn')) return;
    if (mutationPattern.test(signature)) {
      element.disabled = true;
      element.classList.add('role-disabled');
      element.title = 'View-only access';
    }
  });
  document.querySelectorAll('.action-btns, .bulk-action-bar, .purchase-bulk-toolbar, .pm-select-all-banner, #esales-bulk-toolbar, #esales-select-all-banner')
    .forEach(element => element.style.display = 'none');
}

function logAudit(action, target, details) {
  const entries = DB.get(AUDIT_LOG_KEY);
  const entry = {
    id: genId(),
    timestamp: new Date().toISOString(),
    user: auditUserName(),
    uid: getCurrentUser().uid || '',
    role: getCurrentUser().role,
    action: String(action || '').trim(),
    target: String(target || '').trim(),
    details: String(details || '').trim()
  };
  entries.push(entry);
  DB.set(AUDIT_LOG_KEY, entries.slice(-5000));

  const db = getFirestoreDB();
  if (db) {
    db.collection(AUDIT_LOG_KEY).doc(entry.id).set(entry)
      .catch(err => console.error('[Audit Log] Firestore write failed:', err));
  }
}

function buildSidebar(activeKey) {
  const user = getCurrentUser();
  const nav = NAV.map(item => {
    if (item.section) return `<div class="nav-section-label">${item.section}</div>`;
    const active = item.key === activeKey ? ' active' : '';
    return `<a class="nav-item${active}" href="${item.href}" data-label="${item.label}">${ICONS[item.icon]||''}<span>${item.label}</span></a>`;
  }).join('');

  return `<aside class="sidebar">
    <div class="sidebar-logo">
      <img src="../logo.jpeg" alt="EPC Commercial Corporation" class="logo-img"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="logo-monogram" style="display:none">EPC</div>
      <div class="logo-text">
        <span class="logo-company">EPC Commercial Corporation</span>
        <span class="logo-portal">Accounting Portal</span>
      </div>
    </div>
    <nav class="sidebar-nav">${nav}</nav>
    <div class="sidebar-footer">
      <div class="user-pill">
        <div class="user-avatar">${currentUserInitials(user)}</div>
        <div class="user-info">
          <span class="user-name">${currentUserFullName(user)}</span>
          <span class="user-role">${roleDisplayName(user.role)}</span>
        </div>
      </div>
      <div class="sidebar-footer-actions">
        <button class="btn-logout" onclick="logoutEPCUser()">Logout</button>
      </div>
    </div>
  </aside>
  <button class="sidebar-toggle" id="sidebar-toggle-btn" aria-label="Toggle sidebar">
    <svg id="sidebar-toggle-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  </button>`;
}

function _updateToggleIcon(collapsed) {
  const icon = document.getElementById('sidebar-toggle-icon');
  if (!icon) return;
  icon.querySelector('polyline').setAttribute('points', collapsed ? '9 18 15 12 9 6' : '15 18 9 12 15 6');
}

function rebuildSidebar(activeKey) {
  const c = document.getElementById('sidebar-container');
  if (c) c.innerHTML = buildSidebar(activeKey);
  setTimeout(() => applyRolePermissions(activeKey), 0);
  setTimeout(() => applyRolePermissions(activeKey), 500);
  setTimeout(() => applyRolePermissions(activeKey), 1500);
}

function initSidebar(activeKey) {
  // Hide body until auth resolves so no page content flashes before redirect.
  document.body.style.visibility = 'hidden';

  const auth = getFirebaseAuth();
  if (!auth) { location.replace('login.html'); return; }

  window.addEventListener('pageshow', event => {
    if (event.persisted && (sessionStorage.getItem('epc_signed_out_at') || !auth.currentUser)) {
      _currentEPCUser = null;
      location.replace('login.html');
    }
  });

  auth.onAuthStateChanged(async (firebaseUser) => {
    if (!firebaseUser) {
      stopIdleLogoutWatch();
      location.replace('login.html');
      return;
    }
    sessionStorage.removeItem('epc_signed_out_at');

    // Load role + profile from Firestore users/{uid}
    try {
      const db = getFirestoreDB();
      if (db) {
        logLocalUserRoleSeedInfo(firebaseUser);
        const snap = await db.collection('users').doc(firebaseUser.uid).get();
        const data = snap.exists ? snap.data() : {};
        const normalizedRole = _normalizeRole(data.role);
        logLoadedUserRole(firebaseUser, snap, data, normalizedRole);
        _currentEPCUser = {
          uid:        firebaseUser.uid,
          username:   data.username   || firebaseUser.email.replace(EPC_AUTH_DOMAIN, ''),
          firstName:  data.firstName  || '',
          middleName: data.middleName || '',
          lastName:   data.lastName   || '',
          role:       normalizedRole,
        };
      } else {
        _currentEPCUser = {
          uid:        firebaseUser.uid,
          username:   firebaseUser.email.replace(EPC_AUTH_DOMAIN, ''),
          firstName:'', middleName:'', lastName:'', role:'viewer',
        };
      }
    } catch (err) {
      console.error('[Auth] Failed to load user profile from Firestore:', err);
      _currentEPCUser = {
        uid:        firebaseUser.uid,
        username:   firebaseUser.email.replace(EPC_AUTH_DOMAIN, ''),
        firstName:'', middleName:'', lastName:'', role:'viewer',
      };
    }

    // Build sidebar only on first auth resolution (avoids duplicate toggle listeners).
    const c = document.getElementById('sidebar-container');
    if (c && !c.dataset.built) {
      c.dataset.built = '1';
      c.innerHTML = buildSidebar(activeKey);

      const collapsed = localStorage.getItem('_sidebar_collapsed') === '1';
      if (collapsed) {
        document.body.classList.add('sidebar-collapsed');
        _updateToggleIcon(true);
      }

      const btn = document.getElementById('sidebar-toggle-btn');
      if (btn) {
        btn.addEventListener('click', () => {
          const isCollapsed = document.body.classList.toggle('sidebar-collapsed');
          localStorage.setItem('_sidebar_collapsed', isCollapsed ? '1' : '0');
          _updateToggleIcon(isCollapsed);
        });
      }
    }

    document.body.style.visibility = '';
    startIdleLogoutWatch();
    // Signal that auth + user profile are ready so page scripts can read getCurrentUser().
    document.dispatchEvent(new CustomEvent('epc-auth-ready'));
    setTimeout(() => applyRolePermissions(activeKey), 0);
    setTimeout(() => applyRolePermissions(activeKey), 500);
    setTimeout(() => applyRolePermissions(activeKey), 1500);
  });
}

// ─── Seed Data ──────────────────────────────────────────────────────────────
function seedData() {
  if (localStorage.getItem('_epc_seeded')) return;

  DB.set('purchases',             []);
  DB.set('expenses',              []);
  DB.set('supplies_movements',    []);
  DB.set('pos_sales',             []);
  DB.set('pos_review',            []);
  DB.set('esales',                []);
  DB.set('eSalesRecords',         []);
  DB.set('ewt_remittances',       []);
  DB.set('quarterly_tax_paid',    0);
  localStorage.setItem('_epc_seeded', '1');
}

// ─── POS Sales Aggregation Helpers ──────────────────────────────────────────
function getPOSByMonth(month) {
  // month = 'YYYY-MM'
  return DB.get('pos_sales').filter(r => r.date && r.date.startsWith(month));
}
function getPOSTotals(rows) {
  return rows.reduce((acc, r) => {
    acc.revenue  += r.totalRevenue  || 0;
    acc.cogs     += r.totalCost     || 0;
    acc.profit   += r.grossProfit   || 0;
    acc.unitsSold += r.unitsSold    || 0;
    return acc;
  }, { revenue:0, cogs:0, profit:0, unitsSold:0 });
}

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  // Version-based data flush — clears all old EPC sample data on first load
  const DATA_VERSION = 'pg_v1';
  if (localStorage.getItem('_epc_data_version') !== DATA_VERSION) {
    ['purchases','expenses','pos_sales','pos_review','esales','eSalesRecords','products','suppliers',
     'inventory_movements','supplies_movements','ewt_remittances','quarterly_tax_paid',
     '_epc_seeded','inv_cats','prod_cats','exp_cats','uom_extras'].forEach(k => localStorage.removeItem(k));
    localStorage.setItem('_epc_data_version', DATA_VERSION);
  }
  seedData();
  initModals();
  initNumberFormatting();
});

// ─── TrackingTable — shared column filter/sort engine ────────────────────────
// Used by Inventory Tracking and Supplies Tracking pages.
// cfg: { id, storageKey, dateField, theadId, tbodyId, clearBtnId,
//        quickSearchId, columns[], renderRow, emptyHtml }
// column: { key, label, sortable, filterable, filterType, filterOptions,
//           filterPlaceholder, sortVal, filterVal }
// filterType: 'text' | 'dropdown' | 'date-range' | 'num-range'
class TrackingTable {
  static _reg = {};
  static get(id) { return TrackingTable._reg[id]; }

  constructor(cfg) {
    this.cfg         = cfg;
    this.activeTab   = 'all';
    this.sortCol     = null;
    this.sortDir     = 'asc';
    this.filters     = {};
    this.quickSearch = '';
    this.page        = 1;
    this.pageSize    = 100;
    TrackingTable._reg[cfg.id] = this;
    this._buildHeaders();
    this._bindQuickSearch();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────
  setTab(tab) { this.activeTab = tab; this.page = 1; this.render(); }

  setSort(colKey) {
    if (this.sortCol === colKey) {
      if (this.sortDir === 'asc') { this.sortDir = 'desc'; }
      else                        { this.sortCol = null; this.sortDir = 'asc'; }
    } else {
      this.sortCol = colKey; this.sortDir = 'asc';
    }
    this.page = 1;
    this._refreshSortIcons();
    this.render();
  }

  setFilter(colKey, val) {
    this.filters[colKey] = val;
    this.page = 1;
    this._refreshFilterDots();
    this.render();
  }

  setRangeFilter(colKey, part, val) {
    if (!this.filters[colKey] || typeof this.filters[colKey] !== 'object')
      this.filters[colKey] = {};
    this.filters[colKey][part] = val;
    this.page = 1;
    this._refreshFilterDots();
    this.render();
  }

  clearAll() {
    this.filters     = {};
    this.sortCol     = null;
    this.sortDir     = 'asc';
    this.quickSearch = '';
    this.page        = 1;
    const thead = document.getElementById(this.cfg.theadId);
    thead?.querySelectorAll('.col-filter').forEach(el => { el.value = ''; });
    const qs = document.getElementById(this.cfg.quickSearchId);
    if (qs) qs.value = '';
    this._refreshSortIcons();
    this._refreshFilterDots();
    this.render();
  }

  hasActive() {
    const hasF = Object.values(this.filters).some(v => {
      if (v == null) return false;
      if (typeof v === 'object') return !!(v.from || v.to || (v.min !== '' && v.min != null) || (v.max !== '' && v.max != null));
      return String(v).trim() !== '';
    });
    return hasF || !!this.sortCol || !!this.quickSearch.trim();
  }

  render() {
    this._refreshDynamicDropdowns();
    const processed  = this._getProcessed();
    const totalPages = Math.max(1, Math.ceil(processed.length / this.pageSize));
    if (this.page > totalPages) this.page = totalPages;

    const start    = (this.page - 1) * this.pageSize;
    const pageRows = processed.slice(start, start + this.pageSize);

    const tbody = document.getElementById(this.cfg.tbodyId);
    if (!processed.length) {
      tbody.innerHTML = typeof this.cfg.emptyHtml === 'function'
        ? this.cfg.emptyHtml(this.activeTab)
        : this.cfg.emptyHtml;
    } else {
      tbody.innerHTML = pageRows.map(r => this.cfg.renderRow(r)).join('');
    }
    this._renderPagination(processed.length);
    this._refreshClearBtn();
  }

  setPage(p) {
    this.page = p;
    this.render();
  }

  getProcessedRows() {
    return this._getProcessed();
  }

  _renderPagination(total) {
    const el = document.getElementById(this.cfg.paginationId);
    if (!el) return;
    const { page, pageSize } = this;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (total === 0) { el.innerHTML = ''; return; }
    const from = (page - 1) * pageSize + 1;
    const to   = Math.min(page * pageSize, total);
    const id   = this.cfg.id;
    const btns = this._pageWindow(page, totalPages).map(n =>
      n === '…'
        ? `<span class="page-ellipsis">…</span>`
        : `<button class="page-btn${n === page ? ' active' : ''}" onclick="TrackingTable.get('${id}').setPage(${n})">${n}</button>`
    ).join('');
    el.innerHTML = `
      <div class="pagination-info">Showing ${from}–${to} of ${total} entries</div>
      <div class="pagination-controls">
        <button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="TrackingTable.get('${id}').setPage(${page - 1})">‹ Prev</button>
        ${btns}
        <button class="page-btn" ${page >= totalPages ? 'disabled' : ''} onclick="TrackingTable.get('${id}').setPage(${page + 1})">Next ›</button>
      </div>`;
  }

  _pageWindow(cur, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const out = [];
    let last = 0;
    for (let i = 1; i <= total; i++) {
      if (i === 1 || i === total || (i >= cur - 2 && i <= cur + 2)) {
        if (last && i - last > 1) out.push('…');
        out.push(i);
        last = i;
      }
    }
    return out;
  }

  // ─── Private ─────────────────────────────────────────────────────────────────
  _getProcessed() {
    const { storageKey, dateField } = this.cfg;
    let rows = DB.get(storageKey).sort((a, b) =>
      (b[dateField] || '').localeCompare(a[dateField] || '')
    );
    // Tab filter
    if (this.activeTab === 'incoming') rows = rows.filter(r => r.type === 'Incoming');
    if (this.activeTab === 'outgoing') rows = rows.filter(r => r.type === 'Outgoing');
    if (typeof this.cfg.tabFilter === 'function') {
      rows = rows.filter(r => this.cfg.tabFilter(r, this.activeTab));
    }
    // Quick search (across all text-filterable columns)
    if (this.quickSearch.trim()) {
      const q = this.quickSearch.trim().toLowerCase();
      const tCols = this.cfg.columns.filter(c => c.filterable && c.filterType === 'text');
      rows = rows.filter(r => tCols.some(c =>
        String(c.filterVal ? c.filterVal(r) : r[c.key] || '').toLowerCase().includes(q)));
    }
    // Column filters
    rows = rows.filter(r => this._passesFilters(r));
    // Sort
    if (this.sortCol) {
      const col = this.cfg.columns.find(c => c.key === this.sortCol);
      const dir = this.sortDir === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const va = col?.sortVal ? col.sortVal(a) : a[this.sortCol];
        const vb = col?.sortVal ? col.sortVal(b) : b[this.sortCol];
        let cmp = 0;
        if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
        else cmp = String(va ?? '').localeCompare(String(vb ?? ''));
        return cmp * dir;
      });
    }
    return rows;
  }

  _passesFilters(row) {
    return this.cfg.columns.every(col => {
      if (!col.filterable) return true;
      const fv = this.filters[col.key];
      if (fv == null || fv === '') return true;
      const value = col.filterVal ? col.filterVal(row) : row[col.key];
      if (col.filterType === 'text') {
        return !String(fv).trim() ||
          String(value || '').toLowerCase().includes(String(fv).trim().toLowerCase());
      }
      if (col.filterType === 'dropdown') {
        return !fv || value === fv;
      }
      if (col.filterType === 'date-range') {
        const d = row[col.key] || '';
        if (typeof fv === 'object') {
          if (fv.from && d < fv.from) return false;
          if (fv.to   && d > fv.to)   return false;
        }
        return true;
      }
      if (col.filterType === 'num-range') {
        const n = Number(row[col.key]) || 0;
        if (typeof fv === 'object') {
          if (fv.min !== '' && fv.min != null && !isNaN(fv.min) && n < Number(fv.min)) return false;
          if (fv.max !== '' && fv.max != null && !isNaN(fv.max) && n > Number(fv.max)) return false;
        }
        return true;
      }
      return true;
    });
  }

  _buildHeaders() {
    const thead = document.getElementById(this.cfg.theadId);
    if (!thead) return;
    const id = this.cfg.id;

    const headerCells = this.cfg.columns.map(col => {
      const sortAttr = col.sortable
        ? `class="sortable" onclick="TrackingTable.get('${id}').setSort('${col.key}')"`
        : 'class=""';
      const sortIcon = col.sortable
        ? `<span class="sort-icon" data-sort-icon="${col.key}">⇅</span>`
        : '';
      return `<th data-col="${col.key}" ${sortAttr}>
        <span class="th-label">${col.label}</span>${sortIcon}
      </th>`;
    }).join('');

    const filterCells = this.cfg.columns.map(col =>
      col.filterable
        ? `<th class="filter-cell" data-col="${col.key}">${this._buildFilterInput(col)}</th>`
        : `<th class="filter-cell-empty" data-col="${col.key}"></th>`
    ).join('');

    thead.innerHTML =
      `<tr class="header-row">${headerCells}</tr>` +
      `<tr class="filter-row">${filterCells}</tr>`;
  }

  _buildFilterInput(col) {
    const self = `TrackingTable.get('${this.cfg.id}')`;
    if (col.filterType === 'text') {
      return `<input class="col-filter" type="text" placeholder="${col.filterPlaceholder || '…'}"
        oninput="${self}.setFilter('${col.key}', this.value)">`;
    }
    if (col.filterType === 'dropdown') {
      const opts = this._getDropdownOptions(col);
      return `<select class="col-filter" data-dyn-col="${col.key}"
        onchange="${self}.setFilter('${col.key}', this.value)">
        <option value="">All</option>${opts}</select>`;
    }
    if (col.filterType === 'date-range') {
      return `<div class="col-filter-range">
        <input class="col-filter" type="date"
          oninput="${self}.setRangeFilter('${col.key}','from',this.value)">
        <span class="range-sep">–</span>
        <input class="col-filter" type="date"
          oninput="${self}.setRangeFilter('${col.key}','to',this.value)">
      </div>`;
    }
    if (col.filterType === 'num-range') {
      return `<div class="col-filter-range">
        <input class="col-filter" type="number" placeholder="Min" min="0" step="any"
          oninput="${self}.setRangeFilter('${col.key}','min',this.value)">
        <span class="range-sep">–</span>
        <input class="col-filter" type="number" placeholder="Max" min="0" step="any"
          oninput="${self}.setRangeFilter('${col.key}','max',this.value)">
      </div>`;
    }
    return '';
  }

  _getDropdownOptions(col) {
    const opts = typeof col.filterOptions === 'function' ? col.filterOptions() : (col.filterOptions || []);
    return opts.map(o => `<option value="${o}">${o}</option>`).join('');
  }

  _refreshDynamicDropdowns() {
    const thead = document.getElementById(this.cfg.theadId);
    if (!thead) return;
    this.cfg.columns.forEach(col => {
      if (col.filterable && col.filterType === 'dropdown' && typeof col.filterOptions === 'function') {
        const sel = thead.querySelector(`[data-dyn-col="${col.key}"]`);
        if (!sel) return;
        const cur = sel.value;
        sel.innerHTML = `<option value="">All</option>` + this._getDropdownOptions(col);
        if (cur) sel.value = cur;
      }
    });
  }

  _refreshSortIcons() {
    const thead = document.getElementById(this.cfg.theadId);
    if (!thead) return;
    thead.querySelectorAll('[data-sort-icon]').forEach(el => {
      const key = el.dataset.sortIcon;
      const th  = el.closest('th');
      if (this.sortCol === key) {
        el.textContent = this.sortDir === 'asc' ? '↑' : '↓';
        el.classList.add('sort-active');
        th.classList.add('is-sorted');
      } else {
        el.textContent = '⇅';
        el.classList.remove('sort-active');
        th.classList.remove('is-sorted');
      }
    });
  }

  _refreshFilterDots() {
    const thead = document.getElementById(this.cfg.theadId);
    if (!thead) return;
    this.cfg.columns.forEach(col => {
      const th = thead.querySelector(`[data-col="${col.key}"]`);
      if (!th) return;
      const fv = this.filters[col.key];
      let active = false;
      if (fv != null) {
        if (typeof fv === 'object') {
          active = !!(fv.from || fv.to ||
            (fv.min !== '' && fv.min != null) ||
            (fv.max !== '' && fv.max != null));
        } else {
          active = String(fv).trim() !== '';
        }
      }
      th.classList.toggle('has-filter', active);
    });
  }

  _refreshClearBtn() {
    const btn = document.getElementById(this.cfg.clearBtnId);
    if (btn) btn.style.display = this.hasActive() ? '' : 'none';
  }

  _bindQuickSearch() {
    const el = document.getElementById(this.cfg.quickSearchId);
    if (!el) return;
    el.addEventListener('input', e => {
      this.quickSearch = e.target.value;
      this.page = 1;
      this._refreshFilterDots();
      this.render();
    });
  }
}

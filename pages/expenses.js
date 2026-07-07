
initSidebar('expenses');

// Fallback account list, used only until the Chart of Accounts is loaded from
// Firestore. The real, managed list lives in the `expenseAccounts` collection
// (see the Chart of Accounts page).
const EXP_CATS = ['Selling Expenses','Administrative Expenses','Utilities','Rent','Salaries & Wages','Depreciation','Miscellaneous'];

// Load the shared Chart of Accounts (expense accounts) from Firestore into the
// local mirror so the Account dropdown reflects what's managed on that page.
async function loadExpenseAccounts() {
  const db = getFirestoreDB();
  if (!db) return DB.get('expenseAccounts');
  try {
    const snap = await db.collection('expenseAccounts').get();
    const rows = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    DB.set('expenseAccounts', rows);
    return rows;
  } catch (err) {
    console.warn('[Expenses] Chart of Accounts load failed:', err);
    return DB.get('expenseAccounts');
  }
}

// Names for the Account dropdown/filter: the managed Chart of Accounts, falling
// back to the defaults if it hasn't loaded (or is empty).
function expenseAccountNames() {
  const managed = DB.get('expenseAccounts').map(a => a.name).filter(Boolean);
  const names = managed.length ? managed : EXP_CATS.slice();
  return [...new Set(names)].sort();
}

// Sentinel value for the inline "+ Add new account…" dropdown option.
const EXP_ADD_ACCOUNT = '__add_new_account__';

// Populate the Account <select> in the expense modal from the Chart of Accounts.
// Includes an inline "+ Add new account…" option that creates the account in
// the shared Chart of Accounts (Firestore `expenseAccounts`).
function populateExpenseAccountDropdown(selected) {
  const sel = document.getElementById('f-exp-cat');
  if (!sel) return;
  const cur = selected !== undefined ? selected : sel.value;
  const names = expenseAccountNames();
  // Keep the current value visible even if it's an account no longer in the list.
  if (cur && cur !== EXP_ADD_ACCOUNT && !names.includes(cur)) names.push(cur);
  sel.innerHTML = '<option value="">Select account...</option>' +
    names.map(n => `<option value="${expEsc(n)}"${n === cur ? ' selected' : ''}>${expEsc(n)}</option>`).join('') +
    `<option value="${EXP_ADD_ACCOUNT}">+ Add new account…</option>`;
}

// Create a new expense account in the shared Chart of Accounts (Firestore
// `expenseAccounts`), so it also shows up on the Chart of Accounts page.
// Returns the account name on success, or null if cancelled/failed.
async function createExpenseAccount() {
  const raw = prompt('New account name:');
  const name = String(raw ?? '').trim();
  if (!name) return null;

  const existing = DB.get('expenseAccounts').find(a =>
    String(a.name || '').trim().toLowerCase() === name.toLowerCase());
  if (existing) { alert('An account with that name already exists.'); return existing.name; }

  const acc = { id: genId(), name };
  try {
    const db = getFirestoreDB();
    if (db) await db.collection('expenseAccounts').doc(acc.id).set(acc, { merge: true });
    DB.push('expenseAccounts', acc);
    logAudit('Create', 'Chart of Accounts', `Added account ${name} (from Expenses)`);
    return name;
  } catch (err) {
    console.error('[Expenses] Create account failed:', err);
    alert('Could not add the account. Please try again.');
    return null;
  }
}

const expTableState = {
  sortKey: 'date',
  sortDir: 'desc',
  filters: {}
};

function expEsc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cleanExpenseFirestoreRow(row) {
  const clean = { ...row };
  delete clean._firestoreId;
  return clean;
}

async function upsertExpenseInFirestore(row) {
  const db = getFirestoreDB();
  if (!db) return;
  const docId = row._firestoreId || row.id;
  await db.collection('expenses').doc(docId).set(cleanExpenseFirestoreRow(row), { merge:true });
  row._firestoreId = docId;
}

async function deleteExpenseFromFirestore(row) {
  const db = getFirestoreDB();
  if (!db || !row) return;
  await db.collection('expenses').doc(row._firestoreId || row.id).delete();
}

async function loadExpensesFromFirestore() {
  const db = getFirestoreDB();
  if (!db) return DB.get('expenses');
  const snapshot = await db.collection('expenses').get();
  const firestoreRows = snapshot.docs.map(doc => ({ _firestoreId:doc.id, ...doc.data() }));
  DB.set('expenses', firestoreRows);
  return firestoreRows;
}

function resetForm() {
  document.getElementById('exp-edit-id').value = '';
  document.getElementById('modal-exp-title').textContent = 'Add Expense';
  document.getElementById('f-exp-name').value = '';
  document.getElementById('f-exp-date').value = todayISO();
  document.getElementById('f-exp-amount').value = '';
  document.getElementById('f-exp-net-amount').value = '';
  document.getElementById('f-exp-vat').value = '';
  document.getElementById('f-exp-desc').value = '';
  document.getElementById('r-business').checked = true;
  document.getElementById('r-deductible').checked = true;
  populateExpenseAccountDropdown('');
}

function expenseGrossAmount(row) {
  return Number(row.grossAmount ?? row.amount ?? 0) || 0;
}

function expenseVATAmount(row) {
  return Number(row.vatAmount ?? row.inputVAT ?? row.vat ?? 0) || 0;
}

function expenseNetAmount(row) {
  const explicit = Number(row.netAmount);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return Math.max(0, expenseGrossAmount(row) - expenseVATAmount(row));
}

function expenseIsDeductible(row) {
  return !(
    row.taxDeductible === false ||
    row.deductible === false ||
    row.taxTreatment === 'Non-deductible' ||
    row.deductibility === 'Non-deductible' ||
    row.taxDeductible === 'no' ||
    row.deductible === 'no'
  );
}

function expenseColumnValue(row, key) {
  if (key === 'taxTreatment') return expenseIsDeductible(row) ? 'Deductible' : 'Non-deductible';
  if (key === 'netAmount') return expenseNetAmount(row);
  if (key === 'vatAmount') return expenseVATAmount(row);
  if (key === 'grossAmount') return expenseGrossAmount(row);
  return row[key] ?? '';
}

const EXPENSE_COLUMNS = [
  { key:'date', label:'Date', type:'date', className:'col-date',
    render: row => formatDate(row.date) },
  { key:'name', label:'Name', type:'text', className:'col-name',
    render: row => `<strong>${expEsc(row.name)}</strong>` },
  { key:'category', label:'Account', type:'dropdown', className:'col-category',
    options: () => [...new Set([...expenseAccountNames(), ...DB.get('expenses').map(row => row.category).filter(Boolean)])].sort() },
  { key:'description', label:'Description', type:'text', className:'col-description',
    render: row => expEsc(row.description || '—') },
  { key:'classification', label:'Class', type:'dropdown', className:'col-classification',
    options:['Business','Personal'],
    render: row => `<span class="badge ${row.classification === 'Business' ? 'badge-green' : 'badge-gray'}">${expEsc(row.classification || '—')}</span>` },
  { key:'taxTreatment', label:'Tax Treatment', type:'dropdown', className:'col-tax',
    options:['Deductible','Non-deductible'],
    render: row => {
      const deductible = expenseIsDeductible(row);
      return `<span class="badge ${deductible ? 'badge-green' : 'badge-gray'}">${deductible ? 'Deductible' : 'Non-deductible'}</span>`;
    } },
  { key:'netAmount', label:'Net Amount', type:'number', className:'col-money',
    render: row => `<span class="mono">${formatPeso(expenseNetAmount(row))}</span>` },
  { key:'vatAmount', label:'VAT', type:'number', className:'col-money',
    render: row => `<span class="mono">${formatPeso(expenseVATAmount(row))}</span>` },
  { key:'grossAmount', label:'Gross Amount', type:'number', className:'col-money',
    render: row => `<strong class="mono">${formatPeso(expenseGrossAmount(row))}</strong>` },
];

function syncExpenseAmountFields(source) {
  const grossEl = document.getElementById('f-exp-amount');
  const netEl = document.getElementById('f-exp-net-amount');
  const vatEl = document.getElementById('f-exp-vat');
  const gross = parsePeso(grossEl.value);
  const net = parsePeso(netEl.value);
  const vat = parsePeso(vatEl.value);

  if (source === 'net' || source === 'vat') {
    if (net || vat) grossEl.value = formatNum(net + vat);
    return;
  }

  if (source === 'gross' && gross) {
    if (vat && gross >= vat) netEl.value = formatNum(gross - vat);
    else if (net && gross >= net) vatEl.value = formatNum(gross - net);
  }
}

function renderSummary() {
  const exps     = DB.get('expenses');
  const bizExps  = exps.filter(e => e.classification==='Business');
  const persExps = exps.filter(e => e.classification==='Personal');
  const bizTotal  = bizExps.reduce((s,e)  => s+(e.amount||0), 0);
  const persTotal = persExps.reduce((s,e) => s+(e.amount||0), 0);

  document.getElementById('exp-summary').innerHTML = `
    <div class="summary-card">
      <div class="kpi-label">Total Business Expenses</div>
      <div class="kpi-value red">${formatPeso(bizTotal)}</div>
      <div class="kpi-sub">Flows to Income Statement</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Total Personal Expenses</div>
      <div class="kpi-value gray">${formatPeso(persTotal)}</div>
      <div class="kpi-sub">Included in report total</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Total Records</div>
      <div class="kpi-value">${exps.length}</div>
    </div>`;

  // Category pills
  const catMap = {};
  bizExps.forEach(e => { catMap[e.category] = (catMap[e.category]||0) + (e.amount||0); });
  document.getElementById('cat-pills-row').innerHTML =
    Object.entries(catMap).map(([c,v]) =>
      `<span class="cat-pill">${c}: ${formatPeso(v)}</span>`).join('');
}

function expenseFilterInput(column) {
  const key = column.key;
  if (column.type === 'date') {
    return `<div class="exp-filter-range">
      <input class="exp-filter-input" type="date" value="${expTableState.filters[key]?.from || ''}"
        oninput="setExpenseRangeFilter('${key}', 'from', this.value)">
      <span>–</span>
      <input class="exp-filter-input" type="date" value="${expTableState.filters[key]?.to || ''}"
        oninput="setExpenseRangeFilter('${key}', 'to', this.value)">
    </div>`;
  }
  if (column.type === 'number') {
    return `<div class="exp-filter-range">
      <input class="exp-filter-input" type="number" min="0" step="any" placeholder="Min" value="${expTableState.filters[key]?.min || ''}"
        oninput="setExpenseRangeFilter('${key}', 'min', this.value)">
      <span>–</span>
      <input class="exp-filter-input" type="number" min="0" step="any" placeholder="Max" value="${expTableState.filters[key]?.max || ''}"
        oninput="setExpenseRangeFilter('${key}', 'max', this.value)">
    </div>`;
  }
  if (column.type === 'dropdown') {
    const options = typeof column.options === 'function' ? column.options() : column.options;
    return `<select class="exp-filter-input" onchange="setExpenseFilter('${key}', this.value)">
      <option value="">All</option>
      ${(options || []).map(option => `<option value="${expEsc(option)}" ${expTableState.filters[key] === option ? 'selected' : ''}>${expEsc(option)}</option>`).join('')}
    </select>`;
  }
  return `<input class="exp-filter-input" type="text" placeholder="Filter..." value="${expEsc(expTableState.filters[key] || '')}"
    oninput="setExpenseFilter('${key}', this.value)">`;
}

function renderExpenseHeader() {
  const thead = document.getElementById('exp-thead');
  thead.innerHTML = `
    <tr>
      ${EXPENSE_COLUMNS.map(column => {
        const active = expTableState.sortKey === column.key;
        const arrow = active ? (expTableState.sortDir === 'asc' ? '↑' : '↓') : '↕';
        return `<th class="sortable ${column.className || ''}" onclick="setExpenseSort('${column.key}')">
          <span>${column.label}</span> <span class="sort-icon ${active ? 'sort-active' : ''}">${arrow}</span>
        </th>`;
      }).join('')}
      <th class="col-actions">Actions</th>
    </tr>
    <tr class="filter-row">
      ${EXPENSE_COLUMNS.map(column => `<th class="${column.className || ''}">${expenseFilterInput(column)}</th>`).join('')}
      <th class="filter-cell-empty"></th>
    </tr>`;
}

function expensePassesColumnFilters(row) {
  return EXPENSE_COLUMNS.every(column => {
    const filter = expTableState.filters[column.key];
    if (filter == null || filter === '') return true;
    const value = expenseColumnValue(row, column.key);
    if (column.type === 'date') {
      if (filter.from && String(value || '') < filter.from) return false;
      if (filter.to && String(value || '') > filter.to) return false;
      return true;
    }
    if (column.type === 'number') {
      const numberValue = Number(value) || 0;
      if (filter.min !== '' && filter.min != null && Number.isFinite(Number(filter.min)) && numberValue < Number(filter.min)) return false;
      if (filter.max !== '' && filter.max != null && Number.isFinite(Number(filter.max)) && numberValue > Number(filter.max)) return false;
      return true;
    }
    if (column.type === 'dropdown') return !filter || value === filter;
    return String(value || '').toLowerCase().includes(String(filter).trim().toLowerCase());
  });
}

function getFilteredExpenseRows() {
  const classFilter = document.getElementById('filter-class').value;
  const query = document.getElementById('search-exp').value.trim().toLowerCase();
  let rows = DB.get('expenses').slice();
  if (classFilter) rows = rows.filter(e => e.classification === classFilter);
  if (query) {
    rows = rows.filter(e => [e.name, e.category, e.description, e.classification, expenseIsDeductible(e) ? 'Deductible' : 'Non-deductible']
      .some(value => String(value || '').toLowerCase().includes(query)));
  }
  rows = rows.filter(expensePassesColumnFilters);

  const sortColumn = EXPENSE_COLUMNS.find(column => column.key === expTableState.sortKey);
  if (sortColumn) {
    const dir = expTableState.sortDir === 'asc' ? 1 : -1;
    rows = rows.sort((a, b) => {
      const av = expenseColumnValue(a, sortColumn.key);
      const bv = expenseColumnValue(b, sortColumn.key);
      let cmp = 0;
      if (sortColumn.type === 'number') cmp = (Number(av) || 0) - (Number(bv) || 0);
      else cmp = String(av || '').localeCompare(String(bv || ''));
      return cmp * dir;
    });
  }
  return rows;
}

function renderTable() {
  const rows = getFilteredExpenseRows();
  const tbody = document.getElementById('exp-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10"><div class="empty-state"><div class="empty-icon">💳</div><p>No expenses recorded yet.</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(e => {
    return `<tr>
      ${EXPENSE_COLUMNS.map(column => `<td class="${column.className || ''}">${column.render ? column.render(e) : expEsc(expenseColumnValue(e, column.key))}</td>`).join('')}
      <td class="col-actions">
        <div class="action-btns">
          <button class="btn btn-outline btn-xs" onclick="editExp('${e.id}')">Edit</button>
          <button class="btn btn-danger btn-xs" onclick="deleteExp('${e.id}')">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function setExpenseSort(key) {
  if (expTableState.sortKey === key) {
    expTableState.sortDir = expTableState.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    expTableState.sortKey = key;
    expTableState.sortDir = 'asc';
  }
  renderExpenseHeader();
  renderTable();
}

function setExpenseFilter(key, value) {
  expTableState.filters[key] = value;
  renderTable();
}

function setExpenseRangeFilter(key, rangeKey, value) {
  expTableState.filters[key] = { ...(expTableState.filters[key] || {}), [rangeKey]: value };
  renderTable();
}

function clearExpenseFilters() {
  expTableState.filters = {};
  expTableState.sortKey = 'date';
  expTableState.sortDir = 'desc';
  document.getElementById('search-exp').value = '';
  document.getElementById('filter-class').value = '';
  renderExpenseHeader();
  renderTable();
}

function exportExpensesCSV() {
  const rows = getFilteredExpenseRows();
  exportRowsToCSV(`expenses-${todayISO()}.csv`, [
    { label:'Date', value: row => csvDate(row.date) },
    { label:'Name', value:'name' },
    { label:'Account', value:'category' },
    { label:'Description', value:'description' },
    { label:'Classification', value:'classification' },
    { label:'Tax Treatment', value: row => expenseIsDeductible(row) ? 'Deductible' : 'Non-deductible' },
    { label:'Net Amount', value: expenseNetAmount },
    { label:'VAT', value: expenseVATAmount },
    { label:'Gross Amount', value: expenseGrossAmount },
  ], rows);
  alert(`${rows.length.toLocaleString()} expense records exported to CSV.`);
}

async function saveExpense() {
  const name  = document.getElementById('f-exp-name').value.trim();
  const date  = document.getElementById('f-exp-date').value;
  const cat   = document.getElementById('f-exp-cat').value;
  let grossAmount = parsePeso(document.getElementById('f-exp-amount').value);
  let netAmount = parsePeso(document.getElementById('f-exp-net-amount').value);
  let vatAmount = parsePeso(document.getElementById('f-exp-vat').value);
  const cls   = document.querySelector('input[name="exp-class"]:checked')?.value;
  const taxTreatment = document.querySelector('input[name="exp-deductible"]:checked')?.value || 'Deductible';
  const taxDeductible = taxTreatment === 'Deductible';

  if (!grossAmount && (netAmount || vatAmount)) grossAmount = netAmount + vatAmount;
  if (!netAmount && grossAmount) netAmount = Math.max(0, grossAmount - vatAmount);
  if (!vatAmount && grossAmount && netAmount && grossAmount >= netAmount) vatAmount = grossAmount - netAmount;

  if (!name||!date||!grossAmount) { alert('Name, date, and gross amount are required.'); return; }

  const record = {
    name,
    date,
    category:cat,
    description:document.getElementById('f-exp-desc').value,
    classification:cls,
    amount:grossAmount,
    grossAmount,
    netAmount,
    vatAmount,
    inputVAT:vatAmount,
    vatCreditable:vatAmount > 0,
    taxTreatment,
    deductibility:taxTreatment,
    taxDeductible,
    deductible:taxDeductible
  };

  const editId = document.getElementById('exp-edit-id').value;
  if (editId) {
    const existing = DB.get('expenses').find(row => row.id === editId);
    record.id = editId;
    record._firestoreId = existing?._firestoreId;
    DB.update('expenses', editId, record);
  }
  else { record.id = genId(); DB.push('expenses', record); }

  closeModal('modal-expense');
  renderExpenseHeader();
  renderTable();
  renderSummary();
  try {
    await upsertExpenseInFirestore(record);
    logAudit(editId ? 'Edit' : 'Create', 'Expense',
      `${editId ? 'Edited' : 'Added'} expense ${name} - ${formatPeso(grossAmount)} on ${formatDate(date)}`);
  } catch (error) {
    console.error('Failed to save expense to database:', error);
    alert('The expense was saved locally but could not sync to the database. Please try again.');
  }
}

function editExp(id) {
  const e = DB.get('expenses').find(x=>x.id===id);
  if (!e) return;
  document.getElementById('exp-edit-id').value = e.id;
  document.getElementById('modal-exp-title').textContent = 'Edit Expense';
  document.getElementById('f-exp-name').value   = e.name;
  document.getElementById('f-exp-date').value   = e.date;
  document.getElementById('f-exp-amount').value = formatNum(expenseGrossAmount(e));
  document.getElementById('f-exp-net-amount').value = formatNum(expenseNetAmount(e));
  document.getElementById('f-exp-vat').value = formatNum(expenseVATAmount(e));
  document.getElementById('f-exp-desc').value   = e.description||'';
  document.querySelector(`input[name="exp-class"][value="${e.classification}"]`).checked = true;
  document.querySelector(`input[name="exp-deductible"][value="${expenseIsDeductible(e) ? 'Deductible' : 'Non-deductible'}"]`).checked = true;
  populateExpenseAccountDropdown(e.category);
  document.getElementById('f-exp-cat').value    = e.category;
  openModal('modal-expense');
}

function deleteExp(id) {
  const e = DB.get('expenses').find(x=>x.id===id);
  confirmDelete(`Delete expense <strong>${e?.name}</strong>?`, async () => {
    try {
      await deleteExpenseFromFirestore(e);
      DB.remove('expenses', id); renderExpenseHeader(); renderTable(); renderSummary();
      logAudit('Delete', 'Expense', `Deleted expense ${e?.name || id}`);
    } catch (error) {
      console.error('Failed to delete expense from database:', error);
      alert('Could not delete the expense. Please try again.');
    }
  });
}

document.getElementById('btn-add-expense').addEventListener('click', () => { resetForm(); openModal('modal-expense'); });
document.getElementById('btn-export-expenses').addEventListener('click', exportExpensesCSV);
document.getElementById('btn-save-expense').addEventListener('click', saveExpense);

// Track the last real selection so we can revert if the user cancels "+ Add new".
let expLastAccount = '';
document.getElementById('f-exp-cat').addEventListener('focus', (e) => { expLastAccount = e.target.value; });
document.getElementById('f-exp-cat').addEventListener('change', async (e) => {
  if (e.target.value !== EXP_ADD_ACCOUNT) { expLastAccount = e.target.value; return; }
  const created = await createExpenseAccount();
  populateExpenseAccountDropdown(created || expLastAccount);
  expLastAccount = created || expLastAccount;
});
document.getElementById('filter-class').addEventListener('change', renderTable);
document.getElementById('search-exp').addEventListener('input', renderTable);
document.getElementById('btn-clear-exp-filters').addEventListener('click', clearExpenseFilters);
document.getElementById('f-exp-amount').addEventListener('input', () => syncExpenseAmountFields('gross'));
document.getElementById('f-exp-net-amount').addEventListener('input', () => syncExpenseAmountFields('net'));
document.getElementById('f-exp-vat').addEventListener('input', () => syncExpenseAmountFields('vat'));

renderSummary();
renderExpenseHeader();
renderTable();
loadExpensesFromFirestore().then(() => {
  renderSummary();
  renderExpenseHeader();
  renderTable();
}).catch(error => console.error('Failed to load expenses from database:', error));
// Load the shared Chart of Accounts so the Account dropdown/filter reflect it.
loadExpenseAccounts().then(() => {
  populateExpenseAccountDropdown();
  renderTable();
}).catch(error => console.error('Failed to load chart of accounts:', error));

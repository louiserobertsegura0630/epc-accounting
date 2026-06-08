
initSidebar('expenses');

const EXP_CATS = ['Selling Expenses','Administrative Expenses','Utilities','Rent','Salaries & Wages','Depreciation','Miscellaneous'];

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
  const localRows = DB.get('expenses');
  const db = getFirestoreDB();
  if (!db) return localRows;
  const snapshot = await db.collection('expenses').get();
  const firestoreRows = snapshot.docs.map(doc => ({ _firestoreId:doc.id, ...doc.data() }));
  if (firestoreRows.length) {
    DB.set('expenses', firestoreRows);
    return firestoreRows;
  }
  for (const row of localRows) await upsertExpenseInFirestore(row);
  return localRows;
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
  initCatDropdown(document.getElementById('f-exp-cat'), 'exp', EXP_CATS);
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

function renderTable() {
  const classFilter = document.getElementById('filter-class').value;
  let rows = DB.get('expenses').sort((a,b) => b.date.localeCompare(a.date));
  if (classFilter) rows = rows.filter(e => e.classification===classFilter);

  const tbody = document.getElementById('exp-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10"><div class="empty-state"><div class="empty-icon">💳</div><p>No expenses recorded yet.</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(e => {
    const badge = e.classification==='Business' ? 'badge-green' : 'badge-gray';
    const deductible = expenseIsDeductible(e);
    const netAmount = expenseNetAmount(e);
    const vatAmount = expenseVATAmount(e);
    const grossAmount = expenseGrossAmount(e);
    return `<tr>
      <td>${formatDate(e.date)}</td>
      <td><strong>${e.name}</strong></td>
      <td>${e.category}</td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.description||'—'}</td>
      <td><span class="badge ${badge}">${e.classification}</span></td>
      <td><span class="badge ${deductible ? 'badge-green' : 'badge-gray'}">${deductible ? 'Deductible' : 'Non-deductible'}</span></td>
      <td class="mono">${formatPeso(netAmount)}</td>
      <td class="mono">${formatPeso(vatAmount)}</td>
      <td class="mono"><strong>${formatPeso(grossAmount)}</strong></td>
      <td>
        <div class="action-btns">
          <button class="btn btn-outline btn-xs" onclick="editExp('${e.id}')">Edit</button>
          <button class="btn btn-danger btn-xs" onclick="deleteExp('${e.id}')">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function getFilteredExpenseRows() {
  const classFilter = document.getElementById('filter-class').value;
  const query = document.getElementById('search-exp').value.trim().toLowerCase();
  let rows = DB.get('expenses').slice().sort((a,b) => String(b.date || '').localeCompare(String(a.date || '')));
  if (classFilter) rows = rows.filter(e => e.classification === classFilter);
  if (query) {
    rows = rows.filter(e => [e.name, e.category, e.description, e.classification, expenseIsDeductible(e) ? 'Deductible' : 'Non-deductible']
      .some(value => String(value || '').toLowerCase().includes(query)));
  }
  return rows;
}

function exportExpensesCSV() {
  const rows = getFilteredExpenseRows();
  exportRowsToCSV(`expenses-${todayISO()}.csv`, [
    { label:'Date', value: row => csvDate(row.date) },
    { label:'Name', value:'name' },
    { label:'Category', value:'category' },
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

  if (!name||!date||!cat||!grossAmount) { alert('Name, date, category, and gross amount are required.'); return; }

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
  initCatDropdown(document.getElementById('f-exp-cat'), 'exp', EXP_CATS);
  document.getElementById('f-exp-cat').value    = e.category;
  openModal('modal-expense');
}

function deleteExp(id) {
  const e = DB.get('expenses').find(x=>x.id===id);
  confirmDelete(`Delete expense <strong>${e?.name}</strong>?`, async () => {
    try {
      await deleteExpenseFromFirestore(e);
      DB.remove('expenses', id); renderTable(); renderSummary();
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
document.getElementById('filter-class').addEventListener('change', renderTable);
document.getElementById('f-exp-amount').addEventListener('input', () => syncExpenseAmountFields('gross'));
document.getElementById('f-exp-net-amount').addEventListener('input', () => syncExpenseAmountFields('net'));
document.getElementById('f-exp-vat').addEventListener('input', () => syncExpenseAmountFields('vat'));
initTableSearch('search-exp', 'exp-tbody');

renderSummary();
renderTable();
loadExpensesFromFirestore().then(() => {
  renderSummary();
  renderTable();
}).catch(error => console.error('Failed to load expenses from database:', error));

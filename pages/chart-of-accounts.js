
initSidebar('chart-of-accounts');

// Chart of Accounts for expenses. Name-only accounts, stored in the Firestore
// `expenseAccounts` collection (one doc per account) so every computer shares
// the same list. The Expenses page reads its Account dropdown from here.
const COA_DEFAULTS = ['Selling Expenses','Administrative Expenses','Utilities','Rent','Salaries & Wages','Depreciation','Miscellaneous'];

// Reserved doc id used as a marker (not a real account) so that first-time
// seeding runs only once. After "Delete All" this marker keeps the list empty.
const COA_SEEDED_FLAG_ID = '__seeded__';

function coaEsc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Firestore persistence (collection: 'expenseAccounts') ───────────────────
// Gather every expense account name that exists across the app's older stores,
// so the Chart of Accounts starts out holding all of them:
//   1) the built-in defaults
//   2) custom categories added via the old "+ Add Category" (categories/exp)
//   3) account names already saved on expense records
async function collectExistingAccountNames(db) {
  const names = new Set();
  COA_DEFAULTS.forEach(n => names.add(n));

  // Custom "+ Add Category" list for expenses (Firestore: categories/exp).
  try {
    const catDoc = await db.collection('categories').doc('exp').get();
    if (catDoc.exists && Array.isArray(catDoc.data().names)) {
      catDoc.data().names.forEach(n => { const c = String(n || '').trim(); if (c) names.add(c); });
    }
  } catch (err) { console.warn('[Chart of Accounts] category merge skipped:', err); }

  // Account names used on saved expense records.
  try {
    const expSnap = await db.collection('expenses').get();
    expSnap.docs.forEach(d => { const c = String(d.data().category || '').trim(); if (c) names.add(c); });
  } catch (err) { console.warn('[Chart of Accounts] expense-record merge skipped:', err); }

  return [...names];
}

async function loadAccountsFromFirestore() {
  const db = getFirestoreDB();
  if (!db) return DB.get('expenseAccounts');
  const snap = await db.collection('expenseAccounts').get();
  // The seeded-marker doc is bookkeeping, not an account — keep it out of the list.
  const seeded = snap.docs.some(doc => doc.id === COA_SEEDED_FLAG_ID);
  let rows = snap.docs.filter(doc => doc.id !== COA_SEEDED_FLAG_ID)
    .map(doc => ({ id: doc.id, ...doc.data() }));

  // First-time population: seed from ALL existing expense categories (defaults +
  // custom "+ Add Category" list + names used on expense records). This runs
  // only while the collection has never been seeded; afterwards this page is
  // authoritative, so accounts you delete (or "Delete All") stay deleted.
  if (!rows.length && !seeded) {
    const seedNames = await collectExistingAccountNames(db);
    rows = seedNames.map(name => ({ id: genId(), name }));
    for (const acc of rows) {
      await db.collection('expenseAccounts').doc(acc.id).set(acc, { merge: true });
    }
    await db.collection('expenseAccounts').doc(COA_SEEDED_FLAG_ID).set({ seeded: true });
  }

  rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  DB.set('expenseAccounts', rows);
  return rows;
}

async function saveAccountToFirestore(account) {
  const db = getFirestoreDB();
  if (db) await db.collection('expenseAccounts').doc(account.id).set(account, { merge: true });
}

async function deleteAccountFromFirestore(id) {
  const db = getFirestoreDB();
  if (db) await db.collection('expenseAccounts').doc(id).delete();
}

async function deleteAllAccountsFromFirestore() {
  const db = getFirestoreDB();
  if (!db) return;
  const snap = await db.collection('expenseAccounts').get();
  // Batch-delete every account, and drop a marker so first-time seeding never
  // re-populates the list after an intentional "Delete All".
  const batch = db.batch();
  snap.docs.forEach(doc => batch.delete(doc.ref));
  batch.set(db.collection('expenseAccounts').doc(COA_SEEDED_FLAG_ID), { seeded: true });
  await batch.commit();
}

async function deleteAccountsByIdFromFirestore(ids) {
  const db = getFirestoreDB();
  if (!db || !ids.length) return;
  // Firestore batches cap at 500 writes; chunk to stay safely under.
  for (let i = 0; i < ids.length; i += 400) {
    const batch = db.batch();
    ids.slice(i, i + 400).forEach(id =>
      batch.delete(db.collection('expenseAccounts').doc(id)));
    await batch.commit();
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────
let coaSearch = '';
const coaSelected = new Set(); // ids of checked accounts

// The set of accounts currently shown (after the search filter), sorted.
function visibleAccounts() {
  const q = coaSearch.trim().toLowerCase();
  return DB.get('expenseAccounts')
    .filter(a => !q || String(a.name || '').toLowerCase().includes(q))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function renderAccounts() {
  const tbody = document.getElementById('account-tbody');
  const rows = visibleAccounts();

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:24px;color:var(--text-muted)">${coaSearch.trim() ? 'No matching accounts.' : 'No accounts yet. Click "Add Account" to create one.'}</td></tr>`;
    syncSelectionUI();
    return;
  }

  tbody.innerHTML = rows.map(a => `
    <tr>
      <td style="text-align:center"><input type="checkbox" class="coa-row-check" data-select="${coaEsc(a.id)}" ${coaSelected.has(String(a.id)) ? 'checked' : ''}></td>
      <td>${coaEsc(a.name)}</td>
      <td style="text-align:right">
        <button class="btn btn-outline-gray btn-xs" data-edit="${coaEsc(a.id)}">Edit</button>
        <button class="btn btn-danger btn-xs" data-delete="${coaEsc(a.id)}">Delete</button>
      </td>
    </tr>`).join('');
  syncSelectionUI();
}

// Show/hide the bulk buttons and keep the select-all checkbox in sync with the
// rows currently visible.
function syncSelectionUI() {
  const rows = visibleAccounts();
  const total = DB.get('expenseAccounts').length;
  const selCount = rows.filter(a => coaSelected.has(String(a.id))).length;

  const countEl = document.getElementById('coa-selected-count');
  if (countEl) countEl.textContent = selCount;

  const delSel = document.getElementById('btn-delete-selected-accounts');
  if (delSel) delSel.style.display = selCount ? '' : 'none';

  const delAll = document.getElementById('btn-delete-all-accounts');
  if (delAll) delAll.style.display = total ? '' : 'none';

  const selectAll = document.getElementById('coa-select-all');
  if (selectAll) {
    selectAll.checked = rows.length > 0 && selCount === rows.length;
    selectAll.indeterminate = selCount > 0 && selCount < rows.length;
  }
}

// ─── Add / Edit ──────────────────────────────────────────────────────────────
function openAddAccount() {
  document.getElementById('account-edit-id').value = '';
  document.getElementById('modal-account-title').textContent = 'Add Account';
  document.getElementById('f-account-name').value = '';
  openModal('modal-account');
  document.getElementById('f-account-name').focus();
}

function openEditAccount(id) {
  const acc = DB.get('expenseAccounts').find(a => String(a.id) === String(id));
  if (!acc) return;
  document.getElementById('account-edit-id').value = acc.id;
  document.getElementById('modal-account-title').textContent = 'Edit Account';
  document.getElementById('f-account-name').value = acc.name || '';
  openModal('modal-account');
  document.getElementById('f-account-name').focus();
}

async function saveAccount() {
  const id   = document.getElementById('account-edit-id').value;
  const name = document.getElementById('f-account-name').value.trim();
  if (!name) { alert('Account name is required.'); return; }

  const accounts = DB.get('expenseAccounts');
  const dup = accounts.find(a =>
    String(a.name || '').trim().toLowerCase() === name.toLowerCase() && String(a.id) !== String(id));
  if (dup) { alert('An account with that name already exists.'); return; }

  const btn = document.getElementById('btn-save-account');
  btn.disabled = true;
  try {
    if (id) {
      const acc = accounts.find(a => String(a.id) === String(id));
      if (acc) {
        acc.name = name;
        await saveAccountToFirestore(acc);
        DB.set('expenseAccounts', accounts);
        logAudit('Edit', 'Chart of Accounts', `Renamed account to ${name}`);
      }
    } else {
      const acc = { id: genId(), name };
      await saveAccountToFirestore(acc);
      DB.push('expenseAccounts', acc);
      logAudit('Create', 'Chart of Accounts', `Added account ${name}`);
    }
    closeModal('modal-account');
    renderAccounts();
  } catch (err) {
    console.error('[Chart of Accounts] Save failed:', err);
    alert('Could not save the account. Please try again.');
  } finally {
    btn.disabled = false;
  }
}

async function deleteAccount(id) {
  const acc = DB.get('expenseAccounts').find(a => String(a.id) === String(id));
  if (!acc) return;
  if (!confirm(`Delete account "${acc.name}"? Existing expenses keep their account name; it just won't appear in the dropdown anymore.`)) return;
  try {
    await deleteAccountFromFirestore(id);
    DB.set('expenseAccounts', DB.get('expenseAccounts').filter(a => String(a.id) !== String(id)));
    coaSelected.delete(String(id));
    logAudit('Delete', 'Chart of Accounts', `Deleted account ${acc.name}`);
    renderAccounts();
  } catch (err) {
    console.error('[Chart of Accounts] Delete failed:', err);
    alert('Could not delete the account. Please try again.');
  }
}

async function deleteAllAccounts() {
  const accounts = DB.get('expenseAccounts');
  if (!accounts.length) { alert('There are no accounts to delete.'); return; }
  if (!confirm(`Delete ALL ${accounts.length} accounts? Existing expenses keep their account name; the accounts just won't appear in the dropdown anymore. This cannot be undone.`)) return;

  const btn = document.getElementById('btn-delete-all-accounts');
  btn.disabled = true;
  try {
    await deleteAllAccountsFromFirestore();
    DB.set('expenseAccounts', []);
    coaSelected.clear();
    logAudit('Delete', 'Chart of Accounts', `Deleted all ${accounts.length} accounts`);
    renderAccounts();
  } catch (err) {
    console.error('[Chart of Accounts] Delete all failed:', err);
    alert('Could not delete all accounts. Please try again.');
  } finally {
    btn.disabled = false;
  }
}

async function deleteSelectedAccounts() {
  const ids = DB.get('expenseAccounts')
    .map(a => String(a.id))
    .filter(id => coaSelected.has(id));
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} selected account${ids.length === 1 ? '' : 's'}? Existing expenses keep their account name; they just won't appear in the dropdown anymore. This cannot be undone.`)) return;

  const btn = document.getElementById('btn-delete-selected-accounts');
  btn.disabled = true;
  try {
    await deleteAccountsByIdFromFirestore(ids);
    const idSet = new Set(ids);
    DB.set('expenseAccounts', DB.get('expenseAccounts').filter(a => !idSet.has(String(a.id))));
    ids.forEach(id => coaSelected.delete(id));
    logAudit('Delete', 'Chart of Accounts', `Deleted ${ids.length} selected accounts`);
    renderAccounts();
  } catch (err) {
    console.error('[Chart of Accounts] Delete selected failed:', err);
    alert('Could not delete the selected accounts. Please try again.');
  } finally {
    btn.disabled = false;
  }
}

// ─── Wiring ──────────────────────────────────────────────────────────────────
document.getElementById('btn-add-account').addEventListener('click', openAddAccount);
document.getElementById('btn-delete-all-accounts').addEventListener('click', deleteAllAccounts);
document.getElementById('btn-delete-selected-accounts').addEventListener('click', deleteSelectedAccounts);
document.getElementById('btn-save-account').addEventListener('click', saveAccount);

// Select-all toggles every currently-visible (filtered) row.
document.getElementById('coa-select-all').addEventListener('change', (e) => {
  const ids = visibleAccounts().map(a => String(a.id));
  if (e.target.checked) ids.forEach(id => coaSelected.add(id));
  else ids.forEach(id => coaSelected.delete(id));
  renderAccounts();
});
document.getElementById('search-account').addEventListener('input', (e) => {
  coaSearch = e.target.value;
  renderAccounts();
});
document.getElementById('account-tbody').addEventListener('click', (e) => {
  const editId = e.target.closest('[data-edit]')?.dataset.edit;
  const delId  = e.target.closest('[data-delete]')?.dataset.delete;
  if (editId) openEditAccount(editId);
  else if (delId) deleteAccount(delId);
});
document.getElementById('account-tbody').addEventListener('change', (e) => {
  const selId = e.target.closest('[data-select]')?.dataset.select;
  if (!selId) return;
  if (e.target.checked) coaSelected.add(String(selId));
  else coaSelected.delete(String(selId));
  syncSelectionUI();
});

renderAccounts();
loadAccountsFromFirestore()
  .then(renderAccounts)
  .catch(err => console.error('[Chart of Accounts] Firestore load failed:', err));

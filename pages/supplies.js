
initSidebar('supplies');

const expandedSupplyRows = new Set();
let suppliesAggregateTotals = null;
let suppliesLastDocSnapshot = null;
let suppliesHasMoreRecords = false;

function supplyUsageHistory(row) {
  if (Array.isArray(row.usageHistory)) return row.usageHistory;
  if (Number(row.totalUsed || 0) > 0) {
    return [{
      unitsUsed:Number(row.totalUsed || 0),
      dateUsed:row.lastUsedDate || row.datePurchased || '',
      issuedTo:row.lastIssuedTo || row.whoReceived || ''
    }];
  }
  return [];
}

function supplyUsedTotal(row) {
  return supplyUsageHistory(row).reduce((sum, item) => sum + (Number(item.unitsUsed) || 0), 0);
}

function supplyOriginalQty(row) {
  return Number(row.originalQty ?? (Number(row.qty || 0) + supplyUsedTotal(row))) || 0;
}

function supplyOnHand(row) {
  return Math.max(0, supplyOriginalQty(row) - supplyUsedTotal(row));
}

function supplyVATAmount(row) {
  return Number(row.vatAmount ?? row.inputVAT ?? row.vat ?? 0) || 0;
}

function supplyGrossAmount(row) {
  const explicit = Number(row.grossAmount ?? row.totalIncomingValue ?? row.purchaseTotalCost);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (row.type === 'Incoming') return supplyOriginalQty(row) * (Number(row.unitCost) || 0);
  return Number(row.totalCost ?? row.amount ?? 0) || 0;
}

function supplyNetAmount(row) {
  const explicit = Number(row.netAmount);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return Math.max(0, supplyGrossAmount(row) - supplyVATAmount(row));
}

function toggleSupplyHistory(id) {
  if (expandedSupplyRows.has(id)) expandedSupplyRows.delete(id);
  else expandedSupplyRows.add(id);
  supTable.render();
}

function cleanSupplyFirestoreRow(row) {
  const clean = { ...row };
  delete clean._firestoreId;
  return clean;
}

async function upsertSupplyInFirestore(row) {
  const db = getFirestoreDB();
  if (!db) return;
  const docId = row._firestoreId || row.id;
  await db.collection('suppliesData').doc(docId).set(epcStamp(cleanSupplyFirestoreRow(row)), { merge: true });
  row._firestoreId = docId;
}

async function deleteSupplyFromFirestore(row) {
  const db = getFirestoreDB();
  if (!db || !row) return;
  await db.collection('suppliesData').doc(row._firestoreId || row.id).delete();
}

async function loadSuppliesFromFirestore() {
  const localRows = DB.get('supplies_movements');
  const db = getFirestoreDB();
  if (!db) return localRows;
  const snapshot = await db.collection('suppliesData').get();
  const firestoreRows = snapshot.docs.map(doc => ({ _firestoreId: doc.id, ...doc.data() }));
  if (firestoreRows.length) {
    DB.set('supplies_movements', firestoreRows);
    return firestoreRows;
  }
  for (const row of localRows) await upsertSupplyInFirestore(row);
  return localRows;
}

function suppliesLoadLimit() {
  return clampRecordsLoadLimit('sup-load-limit');
}

function updateSuppliesLoadMoreControl() {
  const button = document.getElementById('btn-load-more-sup');
  if (!button) return;
  button.style.display = suppliesHasMoreRecords ? '' : 'none';
  button.disabled = !suppliesHasMoreRecords;
}

async function loadSuppliesBatch({ append = false } = {}) {
  const db = getFirestoreDB();
  if (!db) return DB.get('supplies_movements');
  if (!append) suppliesLastDocSnapshot = null;
  let query = db.collection('suppliesData')
    .orderBy(firebase.firestore.FieldPath.documentId())
    .limit(suppliesLoadLimit());
  if (append && suppliesLastDocSnapshot) query = query.startAfter(suppliesLastDocSnapshot);
  const snapshot = await query.get();
  suppliesLastDocSnapshot = snapshot.docs[snapshot.docs.length - 1] || suppliesLastDocSnapshot;
  const rows = snapshot.docs.map(doc => ({ _firestoreId: doc.id, ...doc.data() }));
  DB.set('supplies_movements', append ? [...DB.get('supplies_movements'), ...rows] : rows);
  const total = suppliesAggregateTotals?.count;
  suppliesHasMoreRecords = total == null
    ? snapshot.docs.length === clampRecordsLoadLimit('sup-load-limit', { syncInput: false })
    : DB.get('supplies_movements').length < total;
  updateSuppliesLoadMoreControl();
  return DB.get('supplies_movements');
}

function calcSupTotal() {
  const cost = parsePeso(document.getElementById('s-unit-cost').value) || 0;
  const qty  = parseInt(document.getElementById('s-qty').value) || 0;
  const total = cost * qty;
  document.getElementById('s-total').value = formatNum(total);
  document.getElementById('s-gross-amount').value = total ? formatNum(total) : '';
  syncSupplyAmountFields('gross');
}
document.getElementById('s-unit-cost').addEventListener('input', calcSupTotal);
document.getElementById('s-qty').addEventListener('input', calcSupTotal);
document.getElementById('s-net-amount').addEventListener('input', () => syncSupplyAmountFields('net'));
document.getElementById('s-vat').addEventListener('input', () => syncSupplyAmountFields('vat'));
document.getElementById('s-gross-amount').addEventListener('input', () => syncSupplyAmountFields('gross'));

function syncSupplyAmountFields(source) {
  const grossEl = document.getElementById('s-gross-amount');
  const netEl = document.getElementById('s-net-amount');
  const vatEl = document.getElementById('s-vat');
  const gross = parsePeso(grossEl.value);
  const net = parsePeso(netEl.value);
  const vat = parsePeso(vatEl.value);

  if (source === 'net' || source === 'vat') {
    if (net || vat) {
      grossEl.value = formatNum(net + vat);
      document.getElementById('s-total').value = formatNum(net + vat);
    }
    return;
  }

  if (source === 'gross' && gross) {
    if (vat && gross >= vat) netEl.value = formatNum(gross - vat);
    else if (net && gross >= net) vatEl.value = formatNum(gross - net);
    document.getElementById('s-total').value = formatNum(gross);
  }
}

function setTab(tab) {
  ['all','incoming','outgoing'].forEach(t => {
    document.getElementById('stab-'+t).classList.toggle('active', t===tab);
  });
  const labels = { all:'All Supply Movements', incoming:'Incoming Supplies', outgoing:'Outgoing Supplies' };
  document.getElementById('stab-label').textContent = labels[tab];
  supTable.setTab(tab);
}

function resetForm() {
  document.getElementById('sup-edit-id').value = '';
  document.getElementById('modal-sup-title').textContent = 'Add Supply Entry';
  ['s-item-code','s-name','s-desc','s-unit-cost','s-net-amount','s-vat','s-gross-amount','s-who','s-notes'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('s-qty').value = '';
  document.getElementById('s-total').value = '';
  document.getElementById('s-date').value = todayISO();
  document.getElementById('rs-incoming').checked = true;
  if (supTable.activeTab === 'outgoing') document.getElementById('rs-outgoing').checked = true;
  const results = document.getElementById('s-item-code-results');
  if (results) results.innerHTML = '';
  const hint = document.getElementById('s-item-code-hint');
  if (hint) hint.style.display = 'none';
  clearSupplySource();
  applySupplyTypeMode();
}

function renderSummary() {
  const movs = DB.get('supplies_movements');
  const localInVal = movs.filter(m => m.type === 'Incoming').reduce((sum, row) => {
    return sum + supplyGrossAmount(row);
  }, 0);
  const localOutVal = movs.reduce((sum, row) => {
    const used = supplyUsedTotal(row);
    if (used > 0) return sum + used * (Number(row.unitCost) || 0);
    return sum + (row.type === 'Outgoing' ? (Number(row.totalCost) || 0) : 0);
  }, 0);
  const inVal = suppliesAggregateTotals?.inVal ?? localInVal;
  const outVal = suppliesAggregateTotals?.outVal ?? localOutVal;
  document.getElementById('sup-summary').innerHTML = `
    <div class="summary-card">
      <div class="kpi-label">Total Incoming Value</div>
      <div class="kpi-value green">${formatPeso(inVal)}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Total Issued Value</div>
      <div class="kpi-value red">${formatPeso(outVal)}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Net on Hand</div>
      <div class="kpi-value">${formatPeso(inVal - outVal)}</div>
    </div>`;
}

async function refreshSuppliesAggregates() {
  const db = getFirestoreDB();
  if (!db) return;
  const collection = db.collection('suppliesData');
  const [count, incomingGross, incomingPurchaseCost, outgoingTotalCost] = await Promise.all([
    firestoreCount(collection, 'supplies count'),
    firestoreSum(collection.where('type', '==', 'Incoming'), 'grossAmount', 'supplies incoming gross sum'),
    firestoreSum(collection.where('type', '==', 'Incoming'), 'purchaseTotalCost', 'supplies incoming purchase value sum'),
    firestoreSum(collection.where('type', '==', 'Outgoing'), 'totalCost', 'supplies outgoing value sum')
  ]);
  if (count != null) supTable.setRemoteTotal(count);
  const inVal = incomingGross || incomingPurchaseCost;
  const hasUsageHistory = DB.get('supplies_movements').some(row => supplyUsedTotal(row) > 0);
  suppliesAggregateTotals = {
    count: count ?? suppliesAggregateTotals?.count,
    inVal: inVal || suppliesAggregateTotals?.inVal,
    outVal: hasUsageHistory ? null : (outgoingTotalCost || suppliesAggregateTotals?.outVal)
  };
  suppliesHasMoreRecords = suppliesAggregateTotals.count == null
    ? suppliesHasMoreRecords
    : DB.get('supplies_movements').length < suppliesAggregateTotals.count;
  updateSuppliesLoadMoreControl();
  renderSummary();
}

// ─── Item code autocomplete ──────────────────────────────────────────────────
// Suggestions come from Firestore rather than DB.get('supplies_movements'),
// because that list is empty until "Generate Report" and then holds only one
// batch — suggesting from it would silently omit most recorded item codes.
let supplyItemCodeIndex = null;   // Map<lowercased code, {code, name, description, unitCost, onHand}>
let supplyItemCodeLoad  = null;   // in-flight promise, so concurrent calls share one read
let supplyIncomingRows  = [];     // full incoming rows, for the Outgoing source picker

function buildSupplyItemCodeIndex(rows) {
  // Incoming rows with stock left are the pickable sources for an Outgoing entry.
  supplyIncomingRows = rows
    .filter(row => row.type === 'Incoming')
    .sort((a, b) => String(a.itemCode || a.name || '').localeCompare(String(b.itemCode || b.name || '')));
  const index = new Map();
  rows.forEach(row => {
    const code = String(row.itemCode || '').trim();
    if (!code) return;
    const key = code.toLowerCase();
    const entry = index.get(key) || { code, name: '', description: '', unitCost: 0, onHand: 0 };
    // Incoming adds stock; outgoing rows record issued units against a code.
    if (row.type === 'Incoming') entry.onHand += supplyOnHand(row);
    else entry.onHand -= Number(row.qty || 0);
    // Keep the most descriptive name/cost seen for this code.
    if (!entry.name && row.name) entry.name = String(row.name);
    if (!entry.description && row.description) entry.description = String(row.description);
    if (!entry.unitCost && row.unitCost) entry.unitCost = Number(row.unitCost) || 0;
    index.set(key, entry);
  });
  return index;
}

async function loadSupplyItemCodes({ force = false } = {}) {
  if (supplyItemCodeIndex && !force) return supplyItemCodeIndex;
  if (supplyItemCodeLoad) return supplyItemCodeLoad;
  const db = getFirestoreDB();
  if (!db) {
    supplyItemCodeIndex = buildSupplyItemCodeIndex(DB.get('supplies_movements'));
    return supplyItemCodeIndex;
  }
  supplyItemCodeLoad = db.collection('suppliesData').get()
    .then(snapshot => {
      supplyItemCodeIndex = buildSupplyItemCodeIndex(
        snapshot.docs.map(doc => ({ _firestoreId: doc.id, ...doc.data() })));
      return supplyItemCodeIndex;
    })
    .catch(err => {
      console.error('[Supplies] Item code lookup failed:', err);
      // Fall back to whatever is loaded locally so the field still suggests something.
      supplyItemCodeIndex = buildSupplyItemCodeIndex(DB.get('supplies_movements'));
      return supplyItemCodeIndex;
    })
    .finally(() => { supplyItemCodeLoad = null; });
  return supplyItemCodeLoad;
}

function supplyItemCodeEsc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderSupplyItemCodeResults() {
  const input   = document.getElementById('s-item-code');
  const results = document.getElementById('s-item-code-results');
  const hint    = document.getElementById('s-item-code-hint');
  if (!input || !results) return;

  const query = input.value.trim().toLowerCase();
  const all   = [...(supplyItemCodeIndex?.values() || [])];
  const matches = (query
      ? all.filter(e => e.code.toLowerCase().includes(query) || e.name.toLowerCase().includes(query))
      : all)
    .sort((a, b) => a.code.localeCompare(b.code))
    .slice(0, 8);

  results.innerHTML = matches.map(entry => {
    const detail = [entry.name, `on hand: ${entry.onHand.toLocaleString()}`].filter(Boolean).join(' · ');
    return `<button type="button" data-item-code="${encodeURIComponent(entry.code)}">` +
      `<strong>${supplyItemCodeEsc(entry.code)}</strong>` +
      `<span style="display:block;font-size:12px;color:var(--text-secondary)">${supplyItemCodeEsc(detail)}</span>` +
      `</button>`;
  }).join('');

  if (hint) {
    const unknown = query && !all.some(e => e.code.toLowerCase() === query);
    hint.style.display = unknown ? '' : 'none';
    hint.textContent   = unknown ? 'No recorded supply uses this item code yet.' : '';
  }
}

function applySupplyItemCode(code) {
  const entry = supplyItemCodeIndex?.get(String(code).toLowerCase());
  document.getElementById('s-item-code').value = entry ? entry.code : code;
  document.getElementById('s-item-code-results').innerHTML = '';
  document.getElementById('s-item-code-hint').style.display = 'none';
  if (!entry) return;
  // Prefill the descriptive fields, but never clobber what the user already typed.
  const name = document.getElementById('s-name');
  const desc = document.getElementById('s-desc');
  const cost = document.getElementById('s-unit-cost');
  if (name && !name.value.trim() && entry.name) name.value = entry.name;
  if (desc && !desc.value.trim() && entry.description) desc.value = entry.description;
  if (cost && !parsePeso(cost.value) && entry.unitCost) {
    cost.value = formatNum(entry.unitCost);
    calcSupTotal();
  }
}

// ─── Outgoing source picker ──────────────────────────────────────────────────
// An Outgoing entry draws stock from a specific recorded Incoming row, so the
// user picks that row first and the rest of the form follows from it.
function currentSupplyType() {
  return document.querySelector('input[name="sup-type"]:checked')?.value || 'Incoming';
}

function findIncomingSource(id) {
  return supplyIncomingRows.find(row => String(row.id) === String(id)) || null;
}

// Lists every incoming item in the source-picker modal.
function renderSupplySourceModal() {
  const tbody = document.getElementById('s-source-modal-tbody');
  if (!tbody) return;
  const query = (document.getElementById('s-source-modal-search')?.value || '').trim().toLowerCase();
  const matches = supplyIncomingRows
    .filter(row => !query
      || String(row.itemCode || '').toLowerCase().includes(query)
      || String(row.name || '').toLowerCase().includes(query));

  tbody.innerHTML = matches.length ? matches.map(row => {
    const onHand = supplyOnHand(row);
    const depleted = onHand <= 0;
    return `<tr${depleted ? ' style="opacity:.55"' : ''}>
      <td class="mono">${supplyItemCodeEsc(row.itemCode || '—')}</td>
      <td>${supplyItemCodeEsc(row.name || 'Supply')}</td>
      <td class="mono" style="text-align:right">${onHand.toLocaleString()}</td>
      <td class="mono" style="text-align:right">${formatPeso(row.unitCost)}</td>
      <td style="text-align:right">${depleted
        ? '<span style="font-size:12px;color:var(--text-secondary)">Out of stock</span>'
        : `<button type="button" class="btn btn-primary btn-xs" data-source-id="${supplyItemCodeEsc(row.id)}">Select</button>`}</td>
    </tr>`;
  }).join('')
    : `<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);padding:18px">${
        query ? 'No incoming item matches.' : 'No incoming supplies recorded yet.'}</td></tr>`;
}

function openSupplySourcePicker() {
  document.getElementById('s-source-modal-search').value = '';
  const tbody = document.getElementById('s-source-modal-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:18px;color:var(--text-secondary)">Loading…</td></tr>';
  openModal('modal-supply-source');
  loadSupplyItemCodes().then(renderSupplySourceModal);
}

function renderSupplySourceSummary() {
  const box = document.getElementById('s-source-summary');
  if (!box) return;
  const row = findIncomingSource(document.getElementById('s-source-id').value);
  if (!row) {
    box.innerHTML = `<button type="button" class="btn btn-outline-gray btn-sm" id="btn-pick-supply-source">Choose an item…</button>`;
    return;
  }
  const onHand = supplyOnHand(row);
  box.innerHTML = `
    <div style="padding:12px;border:1px solid var(--card-border);border-radius:8px;background:#f8fafc">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <div style="flex:1">
          <div style="font-weight:800;margin-bottom:4px">${supplyItemCodeEsc(row.name || 'Supply')}</div>
          <div class="mono" style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">${
            supplyItemCodeEsc(row.itemCode || 'No item code')}</div>
          <div>Available on hand: <strong>${onHand.toLocaleString()}</strong></div>
          <div>Total used so far: <strong>${supplyUsedTotal(row).toLocaleString()}</strong></div>
        </div>
        <button type="button" class="btn btn-outline-gray btn-sm" id="btn-pick-supply-source">Change</button>
      </div>
    </div>`;
}

function selectSupplySource(id) {
  const row = findIncomingSource(id);
  if (!row) return;
  document.getElementById('s-source-id').value = row.id;
  // The outgoing entry inherits its identity and cost from the source item.
  document.getElementById('s-item-code').value  = row.itemCode || '';
  document.getElementById('s-name').value       = row.name || '';
  document.getElementById('s-desc').value       = row.description || '';
  document.getElementById('s-unit-cost').value  = formatNum(row.unitCost);
  document.getElementById('s-qty').max          = supplyOnHand(row);
  closeModal('modal-supply-source');
  renderSupplySourceSummary();
  calcSupTotal();
}

function clearSupplySource() {
  const id = document.getElementById('s-source-id');
  if (id) id.value = '';
  document.getElementById('s-qty')?.removeAttribute('max');
  renderSupplySourceSummary();
}

// Outgoing is driven by the source item, so those fields become read-only
// rather than free text — they must match the stock being drawn down.
function applySupplyTypeMode({ promptForSource = false } = {}) {
  const outgoing = currentSupplyType() === 'Outgoing';
  const group = document.getElementById('s-source-group');
  if (group) group.style.display = outgoing ? '' : 'none';
  ['s-item-code', 's-name', 's-desc', 's-unit-cost'].forEach(fieldId => {
    const el = document.getElementById(fieldId);
    if (!el) return;
    el.readOnly = outgoing;
    el.classList.toggle('computed', outgoing);
  });
  if (!outgoing) {
    clearSupplySource();
    return;
  }
  renderSupplySourceSummary();
  // Switching to Outgoing asks which item first — the rest of the form
  // depends on that choice.
  if (promptForSource && !document.getElementById('s-source-id').value) {
    openSupplySourcePicker();
  }
}

async function saveSupply() {
  const itemCode = document.getElementById('s-item-code').value.trim();
  const name = document.getElementById('s-name').value.trim();
  const date = document.getElementById('s-date').value;
  const cost = parsePeso(document.getElementById('s-unit-cost').value);
  const qty  = parseInt(document.getElementById('s-qty').value) || 0;
  let grossAmount = parsePeso(document.getElementById('s-gross-amount').value);
  let netAmount = parsePeso(document.getElementById('s-net-amount').value);
  let vatAmount = parsePeso(document.getElementById('s-vat').value);
  const who  = document.getElementById('s-who').value.trim();
  const type = document.querySelector('input[name="sup-type"]:checked')?.value;

  if (!name||!date||!cost||!qty||!who) { alert('Please fill all required fields.'); return; }

  const editIdEarly = document.getElementById('sup-edit-id').value;
  // A new Outgoing entry draws stock from a specific incoming row.
  let sourceRow = null;
  if (type === 'Outgoing' && !editIdEarly) {
    const sourceId = document.getElementById('s-source-id').value;
    if (!sourceId) { alert('Please pick the incoming item this is taken from.'); return; }
    sourceRow = findIncomingSource(sourceId);
    if (!sourceRow) { alert('That incoming item is no longer available. Please pick it again.'); return; }
    const available = supplyOnHand(sourceRow);
    if (qty > available) {
      alert(`Only ${available.toLocaleString()} unit${available === 1 ? '' : 's'} of ${sourceRow.name || 'this item'} are on hand.`);
      return;
    }
  }

  if (!grossAmount && (netAmount || vatAmount)) grossAmount = netAmount + vatAmount;
  if (!grossAmount) grossAmount = cost * qty;
  if (!netAmount && grossAmount) netAmount = Math.max(0, grossAmount - vatAmount);
  if (!vatAmount && grossAmount && netAmount && grossAmount >= netAmount) vatAmount = grossAmount - netAmount;

  const editId = document.getElementById('sup-edit-id').value;
  const existing = editId ? DB.get('supplies_movements').find(row => row.id === editId) : null;
  const usageHistory = existing ? supplyUsageHistory(existing) : [];
  const totalUsed = usageHistory.reduce((sum, item) => sum + (Number(item.unitsUsed) || 0), 0);
  const originalQty = existing ? supplyOriginalQty(existing) : (type === 'Incoming' ? qty : 0);
  const currentQty = type === 'Incoming' ? Math.max(0, Number(originalQty || 0) - totalUsed) : qty;
  const record = {
    type, itemCode, name, description:document.getElementById('s-desc').value,
    unitCost:cost, qty:currentQty, totalCost:cost*currentQty, whoReceived:who,
    originalQty,
    purchaseTotalCost:grossAmount,
    totalIncomingValue:type === 'Incoming' ? grossAmount : 0,
    grossAmount,
    netAmount,
    vatAmount,
    inputVAT:vatAmount,
    vatCreditable:vatAmount > 0,
    usageHistory,
    totalUsed,
    datePurchased:date, notes:document.getElementById('s-notes').value
  };

  if (editId) {
    Object.assign(record, { id: editId, _firestoreId: existing?._firestoreId });
    DB.update('supplies_movements', editId, record);
  } else {
    record.id = genId();
    if (sourceRow) record.sourceSupplyId = sourceRow.id;
    DB.push('supplies_movements', record);
  }

  // Draw the issued units down from the incoming item they came from, so its
  // on-hand quantity and usage history stay correct.
  let updatedSource = null;
  if (sourceRow) {
    const history = [
      ...supplyUsageHistory(sourceRow),
      { unitsUsed: qty, dateUsed: date, issuedTo: who, outgoingId: record.id }
    ];
    const usedTotal   = history.reduce((sum, item) => sum + (Number(item.unitsUsed) || 0), 0);
    const sourceOrigQty = supplyOriginalQty(sourceRow);
    const remaining   = Math.max(0, sourceOrigQty - usedTotal);
    updatedSource = {
      ...sourceRow,
      originalQty: sourceOrigQty,
      usageHistory: history,
      totalUsed: usedTotal,
      qty: remaining,
      totalCost: remaining * (Number(sourceRow.unitCost) || 0),
      lastUsedDate: date,
      lastIssuedTo: who
    };
    // The source may not be in the loaded page of rows; update it if it is.
    if (DB.get('supplies_movements').some(r => r.id === updatedSource.id)) {
      DB.update('supplies_movements', updatedSource.id, updatedSource);
    }
  }

  closeModal('modal-supply');
  supTable.render();
  renderSummary();
  try {
    await upsertSupplyInFirestore(record);
    if (updatedSource) await upsertSupplyInFirestore(updatedSource);
    // A new/renamed code (or changed stock) must show in the next lookup.
    supplyItemCodeIndex = null;
    refreshSuppliesAggregates();
    logAudit(editId ? 'Edit' : 'Create', 'Supplies',
      `${editId ? 'Edited' : 'Added'} ${type.toLowerCase()} supply - ${qty} units of ${name} on ${formatDate(date)}` +
      (updatedSource ? ` (drawn from ${updatedSource.itemCode || updatedSource.name}, ${updatedSource.qty.toLocaleString()} left)` : ''));
  } catch (err) {
    console.error('[Supplies] Firestore save failed:', err);
    alert('Supply entry was saved locally but could not be synced to the database. Please try again.');
  }
}

function editSup(id) {
  const m = DB.get('supplies_movements').find(x=>x.id===id);
  if (!m) return;
  document.getElementById('sup-edit-id').value  = m.id;
  document.getElementById('modal-sup-title').textContent = 'Edit Supply Entry';
  document.getElementById(m.type==='Incoming'?'rs-incoming':'rs-outgoing').checked = true;
  document.getElementById('s-item-code').value  = m.itemCode || '';
  document.getElementById('s-name').value       = m.name;
  document.getElementById('s-desc').value       = m.description||'';
  document.getElementById('s-unit-cost').value  = formatNum(m.unitCost);
  document.getElementById('s-qty').value        = m.qty;
  document.getElementById('s-net-amount').value = formatNum(supplyNetAmount(m));
  document.getElementById('s-vat').value        = formatNum(supplyVATAmount(m));
  document.getElementById('s-gross-amount').value = formatNum(supplyGrossAmount(m));
  document.getElementById('s-who').value        = m.whoReceived;
  document.getElementById('s-date').value       = m.datePurchased;
  document.getElementById('s-notes').value      = m.notes||'';
  const codeResults = document.getElementById('s-item-code-results');
  if (codeResults) codeResults.innerHTML = '';
  const codeHint = document.getElementById('s-item-code-hint');
  if (codeHint) codeHint.style.display = 'none';
  // Editing never re-deducts stock, so the source picker stays hidden and the
  // descriptive fields stay editable.
  clearSupplySource();
  document.getElementById('s-source-group').style.display = 'none';
  ['s-item-code', 's-name', 's-desc', 's-unit-cost'].forEach(fieldId => {
    const el = document.getElementById(fieldId);
    if (el) { el.readOnly = false; el.classList.remove('computed'); }
  });
  calcSupTotal();
  openModal('modal-supply');
}

// Outgoing entries record stock drawn from a specific incoming row, so they
// cannot outlive it — deleting the incoming item deletes that history with it.
async function findLinkedOutgoingRows(sourceId) {
  const db = getFirestoreDB();
  if (!db) {
    return DB.get('supplies_movements').filter(row => String(row.sourceSupplyId || '') === String(sourceId));
  }
  try {
    const snapshot = await db.collection('suppliesData').where('sourceSupplyId', '==', String(sourceId)).get();
    return snapshot.docs.map(doc => ({ _firestoreId: doc.id, ...doc.data() }));
  } catch (err) {
    console.error('[Supplies] Linked outgoing lookup failed:', err);
    // Fall back to the loaded rows rather than deleting with an unknown blast radius.
    return DB.get('supplies_movements').filter(row => String(row.sourceSupplyId || '') === String(sourceId));
  }
}

async function deleteSup(id) {
  const m = DB.get('supplies_movements').find(x=>x.id===id);
  const linked = m?.type === 'Incoming' ? await findLinkedOutgoingRows(id) : [];
  const linkedNote = linked.length
    ? ` This will also delete <strong>${linked.length.toLocaleString()} outgoing entr${linked.length === 1 ? 'y' : 'ies'}</strong> recorded against it.`
    : '';

  confirmDelete(`Delete supply entry for <strong>${m?.name}</strong>?${linkedNote}`, async () => {
    try {
      for (const row of linked) {
        await deleteSupplyFromFirestore(row);
        DB.remove('supplies_movements', row.id);
      }
      await deleteSupplyFromFirestore(m);
      DB.remove('supplies_movements', id);
      supplyItemCodeIndex = null;
      supTable.render(); renderSummary();
      refreshSuppliesAggregates();
      logAudit('Delete', 'Supplies', `Deleted supply entry ${m?.name || id}` +
        (linked.length ? ` and ${linked.length} linked outgoing entr${linked.length === 1 ? 'y' : 'ies'}` : ''));
    } catch (err) {
      console.error('[Supplies] Firestore delete failed:', err);
      alert('Could not delete the supply entry. Please try again.');
    }
  });
}

function openSupplyUsage(id) {
  const row = DB.get('supplies_movements').find(item => item.id === id);
  if (!row || row.type !== 'Incoming') return;
  const totalUsed = supplyUsedTotal(row);
  const onHand = supplyOnHand(row);
  document.getElementById('usage-supply-id').value = row.id;
  document.getElementById('usage-date').value = todayISO();
  document.getElementById('usage-qty').value = '';
  document.getElementById('usage-who').value = '';
  document.getElementById('usage-supply-summary').innerHTML = `
    <div style="padding:12px;border:1px solid var(--card-border);border-radius:8px;background:#f8fafc">
      <div style="font-weight:800;margin-bottom:4px">${row.name || 'Supply'}</div>
      <div class="mono" style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">${row.itemCode || 'No item code'}</div>
      <div>Current quantity on hand: <strong>${onHand.toLocaleString()}</strong></div>
      <div>Total used so far: <strong>${totalUsed.toLocaleString()}</strong></div>
    </div>`;
  openModal('modal-supply-usage');
}

async function saveSupplyUsage() {
  const id = document.getElementById('usage-supply-id').value;
  const used = Number(document.getElementById('usage-qty').value) || 0;
  const date = document.getElementById('usage-date').value || todayISO();
  const who = document.getElementById('usage-who').value.trim();
  const row = DB.get('supplies_movements').find(item => item.id === id);
  const available = row ? supplyOnHand(row) : 0;
  if (!row || used <= 0 || used > available) {
    alert('Please enter usage greater than 0 and within current quantity on hand.');
    return;
  }

  const usageHistory = [
    ...supplyUsageHistory(row),
    { unitsUsed:used, dateUsed:date, issuedTo:who }
  ];
  const totalUsed = usageHistory.reduce((sum, item) => sum + (Number(item.unitsUsed) || 0), 0);
  const originalQty = supplyOriginalQty(row);
  const qty = Math.max(0, originalQty - totalUsed);

  const updated = {
    ...row,
    originalQty,
    usageHistory,
    totalUsed,
    qty,
    totalCost: qty * (Number(row.unitCost) || 0),
    lastUsedDate: date,
    lastIssuedTo: who
  };

  DB.update('supplies_movements', id, updated);
  try {
    await upsertSupplyInFirestore(updated);
    closeModal('modal-supply-usage');
    supTable.render();
    renderSummary();
    refreshSuppliesAggregates();
    if (typeof logAudit === 'function') {
      logAudit('Edit', 'Supplies',
        `Used ${used.toLocaleString()} of '${row.name}' [${row.itemCode || 'no code'}] on ${formatDate(date)}${who ? ` - issued to ${who}` : ''}`);
    }
  } catch (err) {
    console.error('[Supplies] Usage save failed:', err);
    alert('Usage was saved locally but could not be synced to the database. Please try again.');
  }
}

function exportSuppliesCSV() {
  const rows = supTable.getProcessedRows();
  exportRowsToCSV(`supplies-${todayISO()}.csv`, [
    { label:'Item Code', value: row => row.itemCode || '' },
    { label:'Date', value: row => csvDate(row.datePurchased) },
    { label:'Type', value: row => row.type || '' },
    { label:'Supply Name', value: row => row.name || '' },
    { label:'Description', value: row => row.description || '' },
    { label:'Qty On Hand', value: row => row.type === 'Incoming' ? supplyOnHand(row) : Number(row.qty || 0) },
    { label:'Total Used', value: supplyUsedTotal },
    { label:'Unit Cost', value: row => row.unitCost || 0 },
    { label:'Total', value: row => row.totalCost || 0 },
    { label:'Net Amount', value: supplyNetAmount },
    { label:'Input VAT', value: supplyVATAmount },
    { label:'Gross Amount', value: supplyGrossAmount },
    { label:'Who Received/Released', value: row => row.whoReceived || '' },
    { label:'Notes', value: row => row.notes || '' },
  ], rows);
  alert(`${rows.length.toLocaleString()} supply records exported to CSV.`);
}

document.getElementById('btn-add-supply').addEventListener('click', () => {
  resetForm();
  openModal('modal-supply');
  // Warm the index so the first keystroke can suggest immediately.
  loadSupplyItemCodes().then(renderSupplyItemCodeResults);
  // Opening from the Outgoing tab preselects Outgoing, so ask for the source now.
  if (currentSupplyType() === 'Outgoing') openSupplySourcePicker();
});
document.querySelectorAll('input[name="sup-type"]').forEach(radio => {
  radio.addEventListener('change', () => applySupplyTypeMode({ promptForSource: true }));
});
document.getElementById('s-source-modal-search').addEventListener('input', renderSupplySourceModal);
document.getElementById('s-source-modal-tbody').addEventListener('click', event => {
  const option = event.target.closest('[data-source-id]');
  if (option) selectSupplySource(option.dataset.sourceId);
});
// The summary area holds either "Choose an item…" or "Change", both re-open the picker.
document.getElementById('s-source-summary').addEventListener('click', event => {
  if (event.target.closest('#btn-pick-supply-source')) openSupplySourcePicker();
});
// Backing out of the picker without choosing reverts to Incoming, so the form
// is never left in an Outgoing state with no source item.
function cancelSupplySourcePicker() {
  closeModal('modal-supply-source');
  if (!document.getElementById('s-source-id').value) {
    document.getElementById('rs-incoming').checked = true;
    applySupplyTypeMode();
  }
}
document.getElementById('btn-close-supply-source').addEventListener('click', cancelSupplySourcePicker);
document.getElementById('btn-cancel-supply-source').addEventListener('click', cancelSupplySourcePicker);
document.getElementById('s-item-code').addEventListener('input', () => {
  loadSupplyItemCodes().then(renderSupplyItemCodeResults);
});
document.getElementById('s-item-code').addEventListener('focus', () => {
  loadSupplyItemCodes().then(renderSupplyItemCodeResults);
});
document.getElementById('s-item-code-results').addEventListener('click', event => {
  const option = event.target.closest('[data-item-code]');
  if (option) applySupplyItemCode(decodeURIComponent(option.dataset.itemCode));
});
// Clicking outside the field dismisses the suggestion list.
document.addEventListener('click', event => {
  if (!event.target.closest('#s-item-code') && !event.target.closest('#s-item-code-results')) {
    const results = document.getElementById('s-item-code-results');
    if (results) results.innerHTML = '';
  }
});
document.getElementById('btn-export-supplies').addEventListener('click', exportSuppliesCSV);
document.getElementById('btn-save-supply').addEventListener('click', saveSupply);
document.getElementById('btn-save-supply-usage').addEventListener('click', saveSupplyUsage);
renderSummary();

// ─── TrackingTable ────────────────────────────────────────────────────────────
function supplyHistoryHtml(row) {
  const history = supplyUsageHistory(row)
    .slice()
    .sort((a, b) => String(b.dateUsed || '').localeCompare(String(a.dateUsed || '')));

  if (!history.length) {
    return `<tr class="supply-history-row"><td colspan="13">
      <div class="empty-state" style="padding:16px"><p>No usage history recorded for this supply.</p></div>
    </td></tr>`;
  }

  return `<tr class="supply-history-row"><td colspan="13">
    <div style="padding:10px 14px;background:#f8fafc;border-top:1px solid var(--card-border);border-bottom:1px solid var(--card-border)">
      <table style="width:100%;min-width:420px">
        <thead>
          <tr>
            <th>Units Used</th>
            <th>Date Used</th>
            <th>Issued To</th>
          </tr>
        </thead>
        <tbody>
          ${history.map(item => `<tr>
            <td class="mono">${Number(item.unitsUsed || 0).toLocaleString()}</td>
            <td>${item.dateUsed ? formatDate(item.dateUsed) : '—'}</td>
            <td>${item.issuedTo || '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </td></tr>`;
}

const supTable = new TrackingTable({
  id: 'sup',
  storageKey: 'supplies_movements',
  dateField: 'datePurchased',
  virtual: true,
  theadId: 'sup-thead',
  tbodyId: 'sup-tbody',
  clearBtnId: 'btn-clear-sup',
  quickSearchId: 'search-sup',
  paginationId: 'sup-pagination',
  columns: [
    { key:'itemCode',      label:'Item Code',    sortable:true, filterable:true,  filterType:'text', filterPlaceholder:'Filter…' },
    { key:'datePurchased', label:'Date',         sortable:true, filterable:true,  filterType:'date-range' },
    { key:'type',          label:'Type',         sortable:true, filterable:true,  filterType:'dropdown',
      filterOptions:['Incoming','Outgoing'] },
    { key:'name',          label:'Name',         sortable:true, filterable:true,  filterType:'text', filterPlaceholder:'Filter…' },
    { key:'description',   label:'Description',  sortable:true, filterable:true,  filterType:'text', filterPlaceholder:'Filter…' },
    { key:'qty',           label:'Qty',          sortable:true, filterable:true,  filterType:'num-range', sortVal:r=>r.qty },
    { key:'unitCost',      label:'Unit Cost',    sortable:true, filterable:true,  filterType:'num-range', sortVal:r=>r.unitCost },
    { key:'totalCost',     label:'Total',        sortable:true, filterable:true,  filterType:'num-range', sortVal:r=>r.totalCost },
    { key:'netAmount',     label:'Net Amount',   sortable:true, filterable:true,  filterType:'num-range', sortVal:supplyNetAmount },
    { key:'vatAmount',     label:'Input VAT',    sortable:true, filterable:true,  filterType:'num-range', sortVal:supplyVATAmount },
    { key:'grossAmount',   label:'Gross Amount', sortable:true, filterable:true,  filterType:'num-range', sortVal:supplyGrossAmount },
    { key:'whoReceived',   label:'Who Received', sortable:true, filterable:true,  filterType:'text', filterPlaceholder:'Filter…' },
    { key:'_actions',      label:'Actions',      sortable:false, filterable:false },
  ],
  renderRow: m => {
    const used = supplyUsedTotal(m);
    const onHand = m.type === 'Incoming' ? supplyOnHand(m) : Number(m.qty || 0);
    const expanded = expandedSupplyRows.has(m.id);
    return `<tr>
      <td class="mono">${m.itemCode || '—'}</td>
      <td>${formatDate(m.datePurchased)}</td>
      <td><span class="badge ${m.type==='Incoming'?'badge-green':'badge-red'}">${m.type}</span></td>
      <td><strong>${m.name}</strong></td>
      <td>${m.description||'—'}</td>
      <td class="mono">${onHand.toLocaleString()}<div style="font-size:0.75rem;color:#64748b">Total used: ${used.toLocaleString()}</div></td>
      <td class="mono">${formatPeso(m.unitCost)}</td>
      <td class="mono"><strong>${formatPeso(m.totalCost)}</strong></td>
      <td class="mono">${formatPeso(supplyNetAmount(m))}</td>
      <td class="mono">${formatPeso(supplyVATAmount(m))}</td>
      <td class="mono"><strong>${formatPeso(supplyGrossAmount(m))}</strong></td>
      <td>${m.whoReceived}</td>
      <td>
        <div class="action-btns">
          ${m.type === 'Incoming' ? `<button class="btn btn-outline btn-xs" onclick="toggleSupplyHistory('${m.id}')">${expanded ? 'Hide Usage' : 'Usage'}</button>` : ''}
          <button class="btn btn-outline btn-xs" onclick="event.stopPropagation();editSup('${m.id}')">Edit</button>
          <button class="btn btn-danger btn-xs" onclick="event.stopPropagation();deleteSup('${m.id}')">Delete</button>
        </div>
      </td>
    </tr>${expanded ? supplyHistoryHtml(m) : ''}`;
  },
  emptyHtml: '<tr><td colspan="13"><div class="empty-state"><div class="empty-icon">📋</div><p>No supply movements yet.</p></div></td></tr>',
});
supTable.render();
document.getElementById('btn-load-more-sup')?.addEventListener('click', async () => {
  await loadSuppliesBatch({ append: true });
  supTable.render();
  renderSummary();
});
document.getElementById('sup-load-limit')?.addEventListener('change', () => clampRecordsLoadLimit('sup-load-limit'));
document.getElementById('sup-load-limit')?.addEventListener('blur', () => clampRecordsLoadLimit('sup-load-limit'));
// The supplies batch + KPI aggregates are deferred until the user clicks
// "Generate Report" — each click = paid Firestore reads. The empty table shell
// (supTable.render above) already renders the layout on page open.
EPCReportGate.wire({
  button: 'sup-generate-btn',
  status: 'sup-gen-status',
  load: async () => {
    await loadSuppliesBatch({ append: false });
    supTable.render();
    renderSummary();
    await refreshSuppliesAggregates();
    const e = document.getElementById('sup-empty-state');
    if (e) e.style.display = 'none';
  }
});

initSidebar('e-sales');

const ES_PAGE_SIZE = 50;
const ES_BATCH_SIZE = 200;
let esRows = [];
let esPreview = [];
let esPage = 1;
let esSort = { key:'date', dir:'desc' };
let esFilters = { query:'', from:'', to:'' };
let selectedESalesIds = new Set();
let allESalesSelectedAcrossPages = false;
let pendingDeleteIds = [];
let deleting = false;

function escES(value) {
  return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function esMoney(value) {
  return Number(String(value ?? 0).replace(/[₱,\s]/g,'')) || 0;
}
function esDocId(row) {
  if (row._firestoreId) return row._firestoreId;
  return `${String(row.date || '').replace(/\//g,'-')}_Z${row.zCounter || row.id || genId()}`;
}
function cleanESRow(row) {
  const clean = { ...row };
  delete clean.id;
  delete clean._firestoreId;
  return clean;
}
function esSleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function commitESBatch(batch, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { await batch.commit(); return; }
    catch (err) {
      if (attempt === retries) throw err;
      await esSleep(attempt * 1000);
    }
  }
}
function esToast(message, type = 'success') {
  const old = document.getElementById('es-toast');
  if (old) old.remove();
  const toast = document.createElement('div');
  toast.id = 'es-toast';
  toast.className = `es-toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}
function setImportProgress(label, percent, save = false) {
  const prefix = save ? 'esales-save' : 'esales-import';
  document.getElementById(save ? 'esales-save-progress' : 'esales-import-status').style.display = '';
  document.getElementById(`${prefix}-label`).textContent = label;
  document.getElementById(`${prefix}-fill`).style.width = `${percent}%`;
}
function hideImportProgress(save = false) {
  document.getElementById(save ? 'esales-save-progress' : 'esales-import-status').style.display = 'none';
}
async function writeRows(rows, onProgress) {
  const fsdb = getFirestoreDB();
  const total = Math.max(1, Math.ceil(rows.length / ES_BATCH_SIZE));
  for (let start = 0, batchNo = 0; start < rows.length; start += ES_BATCH_SIZE) {
    const batch = fsdb.batch();
    rows.slice(start, start + ES_BATCH_SIZE).forEach(row => {
      batch.set(fsdb.collection('eSalesRecords').doc(esDocId(row)), cleanESRow(row), { merge:true });
    });
    await commitESBatch(batch);
    batchNo++;
    onProgress?.(Math.round(batchNo / total * 100));
    await esSleep(300);
  }
}
async function deleteRows(rows, onProgress) {
  const fsdb = getFirestoreDB();
  const total = Math.max(1, Math.ceil(rows.length / ES_BATCH_SIZE));
  for (let start = 0, batchNo = 0; start < rows.length; start += ES_BATCH_SIZE) {
    const batch = fsdb.batch();
    rows.slice(start, start + ES_BATCH_SIZE).forEach(row => batch.delete(fsdb.collection('eSalesRecords').doc(esDocId(row))));
    await commitESBatch(batch);
    batchNo++;
    onProgress?.(Math.round(batchNo / total * 100));
    await esSleep(300);
  }
}
async function loadESRows() {
  const snap = await getFirestoreDB().collection('eSalesRecords').get();
  esRows = snap.docs.map(doc => ({ id:doc.id, _firestoreId:doc.id, ...doc.data() }));
}
function filteredRows() {
  const query = esFilters.query.toLowerCase().trim();
  const numeric = new Set(['grossSales','netAmount','vatableSales','vatAmount','vatExempt','zeroRated','scDiscount','pwdDiscount']);
  return esRows.filter(row => !esFilters.from || String(row.date || '') >= esFilters.from)
    .filter(row => !esFilters.to || String(row.date || '') <= esFilters.to)
    .filter(row => !query || [row.date,row.begOR,row.endOR,row.zCounter].some(value => String(value || '').toLowerCase().includes(query)))
    .sort((a,b) => {
      const av = numeric.has(esSort.key) ? Number(a[esSort.key] || 0) : String(a[esSort.key] || '').toLowerCase();
      const bv = numeric.has(esSort.key) ? Number(b[esSort.key] || 0) : String(b[esSort.key] || '').toLowerCase();
      const diff = typeof av === 'number' ? av - bv : av.localeCompare(bv);
      return diff * (esSort.dir === 'asc' ? 1 : -1);
    });
}
function visibleRows(rows = filteredRows()) {
  return rows.slice((esPage - 1) * ES_PAGE_SIZE, esPage * ES_PAGE_SIZE);
}
function renderSummary(rows = filteredRows()) {
  const totals = rows.reduce((sum,row) => {
    Object.keys(sum).forEach(key => { sum[key] += Number(row[key] || 0); });
    return sum;
  }, { vatAmount:0,grossSales:0,vatableSales:0,vatExempt:0,zeroRated:0,scDiscount:0,pwdDiscount:0,netAmount:0 });
  const totalNetSales = totals.vatableSales + totals.vatExempt + totals.zeroRated;
  document.getElementById('esales-summary').innerHTML = `
    <section class="esales-summary-group esales-sales-group">
      <div class="esales-summary-title">Sales Reconciliation</div>
      <div class="esales-summary-subtitle">Net sales components are VAT-exclusive.</div>
      <div class="esales-summary-row esales-sub-row">
        <span>VATable Sales</span>
        <strong>${formatPeso(totals.vatableSales)}</strong>
      </div>
      <div class="esales-summary-row esales-sub-row">
        <span>VAT Exempt</span>
        <strong>${formatPeso(totals.vatExempt)}</strong>
      </div>
      <div class="esales-summary-row esales-sub-row">
        <span>Zero Rated</span>
        <strong>${formatPeso(totals.zeroRated)}</strong>
      </div>
      <div class="esales-summary-row esales-subtotal">
        <span>Total Net Sales</span>
        <strong>${formatPeso(totalNetSales)}</strong>
      </div>
      <div class="esales-summary-row esales-plus-row">
        <span>+ VAT Output (12%)</span>
        <strong class="red">${formatPeso(totals.vatAmount)}</strong>
      </div>
      <div class="esales-summary-row esales-total-row">
        <span>Total Gross Sales</span>
        <strong class="green">${formatPeso(totals.grossSales)}</strong>
      </div>
    </section>
    <section class="esales-summary-group esales-discount-group">
      <div class="esales-summary-title">Discounts & Net</div>
      <div class="esales-inline-summary">
        <div>
          <span>SC Discounts</span>
          <strong>${formatPeso(totals.scDiscount)}</strong>
        </div>
        <div>
          <span>PWD Discounts</span>
          <strong>${formatPeso(totals.pwdDiscount)}</strong>
        </div>
        <div>
          <span>Net Amount</span>
          <strong class="blue">${formatPeso(totals.netAmount)}</strong>
        </div>
      </div>
    </section>`;
}
function renderTable(rows = filteredRows()) {
  const shown = visibleRows(rows);
  const pageCount = Math.max(1, Math.ceil(rows.length / ES_PAGE_SIZE));
  if (esPage > pageCount) { esPage = pageCount; return renderTable(); }
  const start = rows.length ? (esPage - 1) * ES_PAGE_SIZE + 1 : 0;
  document.getElementById('esales-page-info').textContent = `Showing ${start}–${Math.min(esPage * ES_PAGE_SIZE, rows.length)} of ${rows.length}${rows.length !== esRows.length ? ` filtered (${esRows.length} total)` : ''}`;
  document.querySelectorAll('[data-sort]').forEach(th => {
    th.querySelector('.sort-icon').textContent = th.dataset.sort === esSort.key ? (esSort.dir === 'asc' ? '↑' : '↓') : '⇅';
  });
  document.getElementById('esales-tbody').innerHTML = shown.length ? shown.map(row => `<tr>
    <td class="es-select-col"><input type="checkbox" class="esales-row-select" value="${escES(row.id)}"></td>
    <td>${formatDate(row.date)}</td><td class="mono">${escES(row.begOR || '—')}</td><td class="mono">${escES(row.endOR || '—')}</td>
    <td class="mono">${formatPeso(row.grossSales)}</td><td class="mono">${formatPeso(row.netAmount)}</td><td class="mono">${formatPeso(row.vatableSales)}</td>
    <td class="mono">${formatPeso(row.vatAmount)}</td><td class="mono">${formatPeso(row.vatExempt)}</td><td class="mono">${formatPeso(row.zeroRated)}</td>
    <td class="mono">${formatPeso(row.scDiscount)}</td><td class="mono">${formatPeso(row.pwdDiscount)}</td><td class="mono">${escES(row.zCounter || '—')}</td>
  </tr>`).join('') : '<tr><td colspan="13"><div class="empty-state"><p>No E-Sales records found.</p></div></td></tr>';
  document.querySelectorAll('.esales-row-select').forEach(box => {
    box.checked = selectedESalesIds.has(box.value);
    box.addEventListener('change', () => toggleOne(box.value, box.checked));
  });
  document.getElementById('esales-pagination').innerHTML = pageCount <= 1 ? '' :
    `<button ${esPage === 1 ? 'disabled' : ''} onclick="changePage(${esPage - 1})">Prev</button><span class="pagination-info">Page ${esPage} / ${pageCount}</span><button ${esPage === pageCount ? 'disabled' : ''} onclick="changePage(${esPage + 1})">Next</button>`;
  syncSelection(shown);
}
function renderAll() {
  const rows = filteredRows();
  renderSummary(rows);
  renderTable(rows);
}
function changePage(page) { esPage = page; renderTable(); }
function syncSelection(shown = visibleRows()) {
  const ids = shown.map(row => row.id);
  const rows = filteredRows();
  const visibleSelected = ids.filter(id => selectedESalesIds.has(id)).length;
  const pageBox = document.getElementById('esales-select-page');
  pageBox.checked = ids.length > 0 && visibleSelected === ids.length;
  pageBox.indeterminate = visibleSelected > 0 && visibleSelected < ids.length;
  document.getElementById('esales-bulk-count').textContent = `${selectedESalesIds.size.toLocaleString()} items selected`;
  document.getElementById('esales-bulk-toolbar').classList.toggle('open', selectedESalesIds.size > 0);
  const canSelectAll = ids.length > 0 && visibleSelected === ids.length && !allESalesSelectedAcrossPages && rows.length > ids.length;
  document.getElementById('esales-select-all-banner').classList.toggle('open', canSelectAll);
  document.getElementById('esales-select-page-message').textContent = `${visibleSelected} items on this page are selected.`;
  document.getElementById('btn-select-all-esales').textContent = `Select all ${rows.length.toLocaleString()} matching items`;
}
function toggleOne(id, checked) {
  if (!checked) allESalesSelectedAcrossPages = false;
  checked ? selectedESalesIds.add(id) : selectedESalesIds.delete(id);
  syncSelection();
}
function clearSelection() { selectedESalesIds.clear(); allESalesSelectedAcrossPages = false; syncSelection(); }
function openDelete(ids) {
  pendingDeleteIds = [...new Set(ids)];
  if (!pendingDeleteIds.length) return;
  document.getElementById('delete-esales-title').textContent = `Delete ${pendingDeleteIds.length.toLocaleString()} E-Sales records?`;
  openModal('modal-delete-esales');
}
function setDeleteBusy(busy, text = 'Delete') {
  deleting = busy;
  ['btn-close-delete-esales','btn-cancel-delete-esales','btn-confirm-delete-esales'].forEach(id => document.getElementById(id).disabled = busy);
  document.getElementById('btn-confirm-delete-esales').innerHTML = text;
}
async function confirmDelete() {
  if (deleting) return;
  const ids = new Set(pendingDeleteIds);
  const rows = esRows.filter(row => ids.has(row.id));
  setDeleteBusy(true, '<span class="tm-spinner"></span>Deleting... 0%');
  try {
    await deleteRows(rows, percent => setDeleteBusy(true, `<span class="tm-spinner"></span>Deleting... ${percent}%`));
    esRows = esRows.filter(row => !ids.has(row.id));
    setDeleteBusy(true, '✓ Deleted!');
    await esSleep(1000);
    closeModal('modal-delete-esales');
    setDeleteBusy(false);
    clearSelection();
    esPage = 1;
    renderAll();
    logAudit('Delete', 'E-Sales',
      `Deleted ${rows.length.toLocaleString()} E-Sales record${rows.length === 1 ? '' : 's'}`);
  } catch (err) {
    console.error('[E-Sales] Delete failed:', err);
    setDeleteBusy(false);
    alert('Could not delete the selected records. Please try again.');
  }
}
function parseDate(value) {
  if (typeof value === 'number' && typeof XLSX !== 'undefined') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2,'0')}-${String(parsed.d).padStart(2,'0')}`;
  }
  const date = new Date(String(value || '').trim());
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function extractRows(rows, sourceFile) {
  let offset = 0;
  for (let i = 17; i < Math.min(rows.length,40); i++) {
    if (parseDate(rows[i]?.[0])) break;
    if (parseDate(rows[i]?.[1])) { offset = 1; break; }
  }
  return rows.slice(17).map(row => {
    const date = parseDate(row?.[offset]);
    if (!date) return null;
    const value = index => esMoney(row[index + offset]);
    return {
      id:genId(), date, begOR:String(row[2+offset]||'').trim(), endOR:String(row[4+offset]||'').trim(),
      netAmount:value(12), scDiscount:value(13), pwdDiscount:value(14), grossSales:value(18),
      vatableSales:value(19), vatAmount:value(20), vatExempt:value(21), zeroRated:value(22),
      zCounter:String(row[25+offset]||'').trim(), sourceFile, importedAt:new Date().toISOString()
    };
  }).filter(Boolean);
}
async function parseFile(file) {
  if (/\.csv$/i.test(file.name)) return new Promise((resolve,reject) => Papa.parse(file, { header:false, skipEmptyLines:false, complete:r=>resolve(extractRows(r.data,file.name)), error:reject }));
  const workbook = XLSX.read(await file.arrayBuffer(), { type:'array', cellDates:false });
  return extractRows(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header:1, raw:true, defval:'', blankrows:true }), file.name);
}
async function handleFile(file) {
  if (!/\.(xls|xlsx|csv)$/i.test(file.name)) return alert('Please upload an XLS, XLSX, or CSV file.');
  setImportProgress('Parsing file... 10%',10);
  try {
    esPreview = await parseFile(file);
    hideImportProgress();
    if (!esPreview.length) return alert('No E-Sales rows found in this file.');
    document.getElementById('esales-preview-meta').textContent = `${esPreview.length.toLocaleString()} records parsed from ${file.name}.`;
    document.getElementById('esales-preview-tbody').innerHTML = esPreview.map(row => `<tr><td>${formatDate(row.date)}</td><td>${escES(row.begOR)}</td><td>${escES(row.endOR)}</td><td>${formatPeso(row.grossSales)}</td><td>${formatPeso(row.netAmount)}</td><td>${formatPeso(row.vatableSales)}</td><td>${formatPeso(row.vatAmount)}</td><td>${formatPeso(row.vatExempt)}</td><td>${formatPeso(row.zeroRated)}</td><td>${formatPeso(row.scDiscount)}</td><td>${formatPeso(row.pwdDiscount)}</td><td>${escES(row.zCounter)}</td></tr>`).join('');
    openModal('modal-esales-import');
  } catch (err) { hideImportProgress(); alert(`Could not parse file: ${err.message}`); }
}

function resetESalesFilterView() {
  allESalesSelectedAcrossPages = false;
  esPage = 1;
  renderAll();
}
document.getElementById('search-esales').addEventListener('input', event => { esFilters.query = event.target.value; resetESalesFilterView(); });
document.getElementById('esales-date-from').addEventListener('change', event => { esFilters.from = event.target.value; resetESalesFilterView(); });
document.getElementById('esales-date-to').addEventListener('change', event => { esFilters.to = event.target.value; resetESalesFilterView(); });
document.getElementById('btn-reset-esales-filter').addEventListener('click', () => { esFilters = { query:'',from:'',to:'' }; document.getElementById('search-esales').value=''; document.getElementById('esales-date-from').value=''; document.getElementById('esales-date-to').value=''; resetESalesFilterView(); });
document.querySelectorAll('[data-sort]').forEach(th => th.addEventListener('click', () => { esSort.dir = esSort.key === th.dataset.sort && esSort.dir === 'asc' ? 'desc' : 'asc'; esSort.key = th.dataset.sort; renderAll(); }));
document.getElementById('esales-select-page').addEventListener('change', event => { allESalesSelectedAcrossPages=false; visibleRows().forEach(row => event.target.checked ? selectedESalesIds.add(row.id) : selectedESalesIds.delete(row.id)); syncSelection(); });
document.getElementById('btn-select-all-esales').addEventListener('click', () => { allESalesSelectedAcrossPages=true; filteredRows().forEach(row => selectedESalesIds.add(row.id)); syncSelection(); });
document.getElementById('btn-deselect-esales').addEventListener('click', clearSelection);
document.getElementById('btn-delete-esales-selected').addEventListener('click', () => openDelete([...selectedESalesIds]));
document.getElementById('btn-clear-all-esales').addEventListener('click', () => openDelete(esRows.map(row => row.id)));
document.getElementById('btn-close-delete-esales').addEventListener('click', () => { if (!deleting) closeModal('modal-delete-esales'); });
document.getElementById('btn-cancel-delete-esales').addEventListener('click', () => { if (!deleting) closeModal('modal-delete-esales'); });
document.getElementById('btn-confirm-delete-esales').addEventListener('click', confirmDelete);
const dropZone = document.getElementById('esales-drop-zone');
dropZone.addEventListener('dragover', event => { event.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', event => { event.preventDefault(); dropZone.classList.remove('dragover'); if (event.dataTransfer.files[0]) handleFile(event.dataTransfer.files[0]); });
dropZone.addEventListener('click', event => { if (!event.target.closest('button')) document.getElementById('esales-file-input').click(); });
document.getElementById('btn-import-esales').addEventListener('click', event => { event.stopPropagation(); document.getElementById('esales-file-input').click(); });
document.getElementById('esales-file-input').addEventListener('change', event => { if (event.target.files[0]) handleFile(event.target.files[0]); event.target.value=''; });
document.getElementById('btn-confirm-esales-import').addEventListener('click', async () => {
  if (!esPreview.length) return;
  const rows = esPreview.map(row => ({ ...row, _firestoreId:esDocId(row) }));
  const fileName = rows[0].sourceFile || 'Imported file';
  setImportProgress('Saving to database... 0%',0,true);
  try {
    await writeRows(rows, percent => setImportProgress(`Saving to database... ${percent}%`,percent,true));
    logAudit('Import', 'E-Sales',
      `Imported '${fileName}' - ${rows.length.toLocaleString()} records`);
    await loadESRows();
    setImportProgress('✓ Import complete!',100,true);
    await esSleep(1000);
    hideImportProgress(true);
    closeModal('modal-esales-import');
    esPreview = [];
    renderAll();
    esToast(`${rows.length.toLocaleString()} E-Sales records imported.`);
  } catch (err) { console.error('[E-Sales] Import failed:',err); hideImportProgress(true); alert('Could not save the E-Sales import. Please try again.'); }
});

async function initESalesPage() {
  try { await loadESRows(); renderAll(); }
  catch (err) { console.error('[E-Sales] Load failed:',err); alert('Could not load E-Sales records. Please refresh the page.'); }
}
initESalesPage();

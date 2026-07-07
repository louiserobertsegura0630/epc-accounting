initSidebar('audit-log');

const AUDIT_PAGE_SIZE = 50;
let auditPage = 1;
let auditInitialized = false;

function auditEsc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function auditEntryKey(row) {
  return [
    row.id || row._firestoreId || '',
    row.timestamp || '',
    row.action || '',
    row.target || '',
    row.details || ''
  ].join('|');
}

function normalizeAuditRows(rows) {
  const seen = new Set();
  return rows
    .filter(Boolean)
    .map(row => ({
      ...row,
      id: String(row.id || row._firestoreId || genId())
    }))
    .filter(row => {
      const key = auditEntryKey(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
}

function cacheAuditRows(rows) {
  _runtimeData[AUDIT_LOG_KEY] = normalizeAuditRows(rows).slice(0, 5000);
}

async function loadAuditLogFromFirebase() {
  const db = getFirestoreDB();
  if (!db) {
    cacheAuditRows([]);
    return;
  }
  try {
    const snap = await db.collection(AUDIT_LOG_KEY).orderBy('timestamp', 'desc').limit(5000).get();
    const remoteRows = snap.docs.map(doc => ({ _firestoreId: doc.id, id: doc.id, ...doc.data() }));
    cacheAuditRows(remoteRows);
  } catch (err) {
    console.error('[Audit Log] Firestore load failed:', err);
    cacheAuditRows([]);
  }
}

function filteredAuditRows() {
  const action = document.getElementById('audit-action').value;
  const from = document.getElementById('audit-from').value;
  const to = document.getElementById('audit-to').value;
  const query = document.getElementById('audit-search').value.toLowerCase().trim();
  return [...DB.get(AUDIT_LOG_KEY)]
    .filter(row => !action || row.action === action)
    .filter(row => !from || String(row.timestamp || '').slice(0, 10) >= from)
    .filter(row => !to || String(row.timestamp || '').slice(0, 10) <= to)
    .filter(row => !query || String(row.details || '').toLowerCase().includes(query))
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
}

function renderAuditPagination(total) {
  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  auditPage = Math.min(auditPage, pages);
  const start = total ? (auditPage - 1) * AUDIT_PAGE_SIZE + 1 : 0;
  const end = Math.min(auditPage * AUDIT_PAGE_SIZE, total);
  document.getElementById('audit-pagination').innerHTML = `
    <div class="pagination-info">Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} entries</div>
    <div class="pagination-controls">
      <button class="page-btn" type="button" onclick="setAuditPage(${auditPage - 1})" ${auditPage <= 1 ? 'disabled' : ''}>‹ Prev</button>
      <span class="pagination-info">Page ${auditPage} / ${pages}</span>
      <button class="page-btn" type="button" onclick="setAuditPage(${auditPage + 1})" ${auditPage >= pages ? 'disabled' : ''}>Next ›</button>
    </div>`;
}

function renderAuditLog() {
  const rows = filteredAuditRows();
  const start = (auditPage - 1) * AUDIT_PAGE_SIZE;
  document.getElementById('audit-tbody').innerHTML = rows.slice(start, start + AUDIT_PAGE_SIZE)
    .map(row => `<tr>
      <td>${auditEsc(new Date(row.timestamp).toLocaleString('en-PH'))}</td>
      <td>${auditEsc(row.user)}</td><td>${auditEsc(row.action)}</td>
      <td>${auditEsc(row.target)}</td><td>${auditEsc(row.details)}</td>
    </tr>`).join('') || '<tr><td colspan="5"><div class="empty-state"><p>No audit entries found.</p></div></td></tr>';
  renderAuditPagination(rows.length);
}

function renderAuditActions() {
  const select = document.getElementById('audit-action');
  const current = select.value;
  const actions = [...new Set(DB.get(AUDIT_LOG_KEY).map(row => row.action).filter(Boolean))].sort();
  select.innerHTML = '<option value="">All Actions</option>' +
    actions.map(action => `<option value="${auditEsc(action)}"${action === current ? ' selected' : ''}>${auditEsc(action)}</option>`).join('');
}

function resetAuditPage() { auditPage = 1; renderAuditLog(); }
function setAuditPage(page) { auditPage = Math.max(1, page); renderAuditLog(); }

async function initAuditLogPage() {
  if (auditInitialized) return;
  auditInitialized = true;
  await loadAuditLogFromFirebase();
  renderAuditActions();
  renderAuditLog();

  ['audit-action', 'audit-from', 'audit-to'].forEach(id =>
    document.getElementById(id).addEventListener('change', resetAuditPage));
  document.getElementById('audit-search').addEventListener('input', resetAuditPage);
  document.getElementById('audit-clear').addEventListener('click', () => {
    ['audit-action', 'audit-from', 'audit-to', 'audit-search'].forEach(id => document.getElementById(id).value = '');
    resetAuditPage();
  });
}

document.addEventListener('epc-auth-ready', initAuditLogPage, { once: true });

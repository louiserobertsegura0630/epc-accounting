
initSidebar('employees');

// ─── Summary ──────────────────────────────────────────────────────────────────
function renderSummary() {
  const emps = DB.get('employees');
  const totalBasic = emps.reduce((s,e) => s + (e.basicSalary||0), 0);
  const totalAllow = emps.reduce((s,e) =>
    s + (e.mealAllowance||0) + (e.transportationAllowance||0) + (e.otherAllowance||0), 0);
  document.getElementById('emp-summary').innerHTML = `
    <div class="summary-card">
      <div class="kpi-label">Total Employees</div>
      <div class="kpi-value">${emps.length}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Total Basic Salary / Mo.</div>
      <div class="kpi-value blue">${formatPeso(totalBasic)}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Total Allowances / Mo.</div>
      <div class="kpi-value green">${formatPeso(totalAllow)}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Est. Gross Payroll / Mo.</div>
      <div class="kpi-value" style="color:var(--primary)">${formatPeso(totalBasic + totalAllow)}</div>
    </div>`;
}

// ─── Table ────────────────────────────────────────────────────────────────────
function renderTable() {
  const emps = DB.get('employees').sort((a,b) => a.name.localeCompare(b.name));
  const tbody = document.getElementById('emp-tbody');
  if (!emps.length) {
    tbody.innerHTML = '<tr><td colspan="10"><div class="empty-state"><div class="empty-icon">👥</div><p>No employees added yet. Click <strong>Add Employee</strong> or upload a CSV to get started.</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = emps.map(e => `
    <tr>
      <td><strong>${e.name}</strong></td>
      <td>${e.department}</td>
      <td>${e.position||'—'}</td>
      <td class="mono">${formatPeso(e.basicSalary)}</td>
      <td class="mono">${e.mealAllowance ? formatPeso(e.mealAllowance) : '—'}</td>
      <td class="mono">${e.transportationAllowance ? formatPeso(e.transportationAllowance) : '—'}</td>
      <td class="mono">${e.otherAllowance ? formatPeso(e.otherAllowance) : '—'}</td>
      <td class="mono">${e.workingDaysPerMonth||26}</td>
      <td><span class="badge ${e.deductAllowanceOnAbsence ? 'badge-blue' : 'badge-gray'}">${e.deductAllowanceOnAbsence ? 'YES' : 'NO'}</span></td>
      <td>
        <div class="action-btns">
          <button class="btn btn-outline btn-xs" onclick="editEmp('${e.id}')">Edit</button>
          <button class="btn btn-danger btn-xs" onclick="deleteEmp('${e.id}')">Delete</button>
        </div>
      </td>
    </tr>`).join('');
}

// ─── Toggle label ─────────────────────────────────────────────────────────────
document.getElementById('emp-deduct-absence').addEventListener('change', function() {
  const lbl = document.getElementById('deduct-status-label');
  if (this.checked) {
    lbl.textContent = 'YES. Allowances are prorated for absences.';
    lbl.className   = 'toggle-status on';
  } else {
    lbl.textContent = 'NO. Allowances are always paid in full.';
    lbl.className   = 'toggle-status off';
  }
});

// ─── Add / Edit ───────────────────────────────────────────────────────────────
function resetForm() {
  document.getElementById('emp-edit-id').value = '';
  document.getElementById('modal-emp-title').textContent = 'Add Employee';
  ['emp-name','emp-dept','emp-position','emp-basic','emp-meal','emp-transp','emp-other'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('emp-wdm').value = 26;
  const cb = document.getElementById('emp-deduct-absence');
  cb.checked = false;
  cb.dispatchEvent(new Event('change'));
}

function saveEmp() {
  const name  = document.getElementById('emp-name').value.trim();
  const dept  = document.getElementById('emp-dept').value.trim();
  const basic = parsePeso(document.getElementById('emp-basic').value);
  const wdm   = parseInt(document.getElementById('emp-wdm').value) || 26;
  if (!name || !dept || !basic) { alert('Please fill Name, Department, and Basic Salary.'); return; }

  const record = {
    name,
    department:              dept,
    position:                document.getElementById('emp-position').value.trim(),
    basicSalary:             basic,
    mealAllowance:           parsePeso(document.getElementById('emp-meal').value),
    transportationAllowance: parsePeso(document.getElementById('emp-transp').value),
    otherAllowance:          parsePeso(document.getElementById('emp-other').value),
    workingDaysPerMonth:     wdm,
    deductAllowanceOnAbsence: document.getElementById('emp-deduct-absence').checked,
  };

  const editId = document.getElementById('emp-edit-id').value;
  if (editId) { DB.update('employees', editId, record); }
  else { record.id = genId(); DB.push('employees', record); }

  closeModal('modal-emp');
  renderTable(); renderSummary();
}

function editEmp(id) {
  const e = DB.get('employees').find(x => x.id === id);
  if (!e) return;
  document.getElementById('emp-edit-id').value     = e.id;
  document.getElementById('modal-emp-title').textContent = 'Edit Employee';
  document.getElementById('emp-name').value        = e.name;
  document.getElementById('emp-dept').value        = e.department;
  document.getElementById('emp-position').value    = e.position||'';
  document.getElementById('emp-basic').value       = formatNum(e.basicSalary||0);
  document.getElementById('emp-meal').value        = formatNum(e.mealAllowance||0);
  document.getElementById('emp-transp').value      = formatNum(e.transportationAllowance||0);
  document.getElementById('emp-other').value       = formatNum(e.otherAllowance||0);
  document.getElementById('emp-wdm').value         = e.workingDaysPerMonth||26;
  const cb = document.getElementById('emp-deduct-absence');
  cb.checked = !!e.deductAllowanceOnAbsence;
  cb.dispatchEvent(new Event('change'));
  openModal('modal-emp');
}

function deleteEmp(id) {
  const e = DB.get('employees').find(x => x.id === id);
  confirmDelete(`Delete employee <strong>${e?.name}</strong>? This cannot be undone.`, () => {
    DB.remove('employees', id); renderTable(); renderSummary();
  });
}

document.getElementById('btn-add-emp').addEventListener('click', () => { resetForm(); openModal('modal-emp'); });
document.getElementById('btn-save-emp').addEventListener('click', saveEmp);
initTableSearch('search-emp', 'emp-tbody');

// ─── CSV Template Download ────────────────────────────────────────────────────
const CSV_COLS = [
  'name','department','position','basic_salary',
  'meal_allowance','transportation_allowance','other_allowance',
  'working_days_per_month','deduct_allowance_on_absence'
];

document.getElementById('btn-dl-template').addEventListener('click', () => {
  const sample = [
    ['Juan dela Cruz','Operations','Staff','15000','2000','1500','0','26','NO'],
    ['Maria Santos','Admin','Clerk','12000','1500','1000','0','26','YES'],
  ];
  const csv  = [CSV_COLS, ...sample].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'employee_template.csv';
  a.click();
});

// ─── CSV Upload ───────────────────────────────────────────────────────────────
let batchRows = [];

document.getElementById('btn-open-csv').addEventListener('click', () => {
  document.getElementById('csv-panel').style.display = '';
  document.getElementById('csv-panel').scrollIntoView({ behavior:'smooth' });
});
document.getElementById('btn-close-csv').addEventListener('click', () => {
  document.getElementById('csv-panel').style.display = 'none';
  clearBatch();
});

const empDrop  = document.getElementById('emp-drop-zone');
const empInput = document.getElementById('emp-file-input');
empDrop.addEventListener('click',     () => empInput.click());
empDrop.addEventListener('dragover',  e => { e.preventDefault(); empDrop.classList.add('dragover'); });
empDrop.addEventListener('dragleave', () => empDrop.classList.remove('dragover'));
empDrop.addEventListener('drop', e => {
  e.preventDefault(); empDrop.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f && f.name.endsWith('.csv')) readCsvFile(f);
  else alert('Please drop a .csv file.');
});
empInput.addEventListener('change', function() {
  if (this.files[0]) readCsvFile(this.files[0]);
  this.value = '';
});

function readCsvFile(file) {
  const reader = new FileReader();
  reader.onload = e => parseAndShowBatch(e.target.result);
  reader.readAsText(file);
}

function parseAndShowBatch(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) { alert('CSV must have a header row and at least one data row.'); return; }
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^"|"$/g,''));
  const idx = {};
  CSV_COLS.forEach(h => { idx[h] = headers.indexOf(h); });

  batchRows = lines.slice(1).map((line, ri) => {
    const cols = line.split(',').map(v => v.trim().replace(/^"|"$/g,''));
    const raw  = idx.deduct_allowance_on_absence >= 0
      ? (cols[idx.deduct_allowance_on_absence]||'').toUpperCase() : '';
    return {
      _ri: ri,
      name:                    idx.name >= 0                    ? cols[idx.name]                     : '',
      department:              idx.department >= 0              ? cols[idx.department]               : '',
      position:                idx.position >= 0               ? cols[idx.position]                : '',
      basicSalary:             idx.basic_salary >= 0            ? parsePeso(cols[idx.basic_salary])  : 0,
      mealAllowance:           idx.meal_allowance >= 0          ? parsePeso(cols[idx.meal_allowance]): 0,
      transportationAllowance: idx.transportation_allowance >= 0 ? parsePeso(cols[idx.transportation_allowance]) : 0,
      otherAllowance:          idx.other_allowance >= 0         ? parsePeso(cols[idx.other_allowance]): 0,
      workingDaysPerMonth:     idx.working_days_per_month >= 0  ? (parseInt(cols[idx.working_days_per_month])||26) : 26,
      deductAllowanceOnAbsence: raw === 'YES',
    };
  }).filter(r => r.name);

  if (!batchRows.length) { alert('No valid rows found. Check that the "name" column is present and filled.'); return; }
  renderBatchTable();
}

const BATCH_COLS = [
  { key:'name',                    label:'Name',              type:'text',   width:140 },
  { key:'department',              label:'Department',        type:'text',   width:120 },
  { key:'position',                label:'Position',          type:'text',   width:110 },
  { key:'basicSalary',             label:'Basic Salary',      type:'number', width:100 },
  { key:'mealAllowance',           label:'Meal Allow.',       type:'number', width:90  },
  { key:'transportationAllowance', label:'Transport Allow.',  type:'number', width:100 },
  { key:'otherAllowance',          label:'Other Allow.',      type:'number', width:90  },
  { key:'workingDaysPerMonth',     label:'Working Days',      type:'number', width:80  },
  { key:'deductAllowanceOnAbsence',label:'Deduct on Absence', type:'yesno',  width:110 },
];

function renderBatchTable() {
  document.getElementById('csv-batch-wrap').style.display = '';
  document.getElementById('csv-batch-count').textContent =
    `${batchRows.length} employee${batchRows.length !== 1 ? 's' : ''} ready to import`;

  const TH_STYLE = 'padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;background:#f8fafc;border-bottom:1px solid var(--card-border);white-space:nowrap';
  document.getElementById('batch-thead').innerHTML =
    '<tr>' + BATCH_COLS.map(c => `<th style="${TH_STYLE}">${c.label}</th>`).join('') + '</tr>';

  document.getElementById('batch-tbody').innerHTML = batchRows.map((row, i) =>
    '<tr>' + BATCH_COLS.map(c => {
      const cellStyle = 'padding:4px 6px';
      const inputBase = `style="padding:4px 7px;font-size:12px;border:1px solid var(--card-border);border-radius:4px;width:${c.width}px"`;
      if (c.type === 'yesno') {
        return `<td style="${cellStyle}"><select ${inputBase} onchange="batchRows[${i}].${c.key} = this.value === 'YES'">
          <option value="NO"  ${!row[c.key] ? 'selected' : ''}>NO</option>
          <option value="YES" ${ row[c.key] ? 'selected' : ''}>YES</option>
        </select></td>`;
      }
      if (c.type === 'number') {
        return `<td style="${cellStyle}"><input type="number" ${inputBase}
          style="padding:4px 7px;font-size:12px;border:1px solid var(--card-border);border-radius:4px;width:${c.width}px;font-family:'Figtree', sans-serif"
          value="${row[c.key]||0}" oninput="batchRows[${i}].${c.key} = +this.value"></td>`;
      }
      return `<td style="${cellStyle}"><input type="text" ${inputBase}
        value="${row[c.key]||''}" oninput="batchRows[${i}].${c.key} = this.value"></td>`;
    }).join('') + '</tr>'
  ).join('');
}

function clearBatch() {
  batchRows = [];
  document.getElementById('csv-batch-wrap').style.display = 'none';
  document.getElementById('emp-file-input').value = '';
}

document.getElementById('btn-clear-batch').addEventListener('click', clearBatch);

document.getElementById('btn-save-batch').addEventListener('click', () => {
  if (!batchRows.length) return;
  let saved = 0;
  batchRows.forEach(row => {
    if (!row.name || !row.department) return;
    DB.push('employees', {
      id:                      genId(),
      name:                    row.name,
      department:              row.department,
      position:                row.position||'',
      basicSalary:             row.basicSalary||0,
      mealAllowance:           row.mealAllowance||0,
      transportationAllowance: row.transportationAllowance||0,
      otherAllowance:          row.otherAllowance||0,
      workingDaysPerMonth:     row.workingDaysPerMonth||26,
      deductAllowanceOnAbsence: !!row.deductAllowanceOnAbsence,
    });
    saved++;
  });
  document.getElementById('csv-panel').style.display = 'none';
  clearBatch();
  renderTable(); renderSummary();
  alert(`${saved} employee${saved !== 1 ? 's' : ''} imported successfully.`);
});

renderSummary();
renderTable();

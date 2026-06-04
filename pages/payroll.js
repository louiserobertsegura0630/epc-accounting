
initSidebar('payroll');

// ─── Pay period dropdowns ────────────────────────────────────────────────────
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const monthSel = document.getElementById('pay-month');
const yearSel  = document.getElementById('pay-year');

MONTHS.forEach((m, i) => {
  const o = document.createElement('option');
  o.value = i + 1; o.textContent = m; monthSel.appendChild(o);
});
const now = new Date();
for (let y = now.getFullYear(); y >= now.getFullYear() - 5; y--) {
  const o = document.createElement('option');
  o.value = y; o.textContent = y; yearSel.appendChild(o);
}
monthSel.value = now.getMonth() + 1;

// ─── Absence state ───────────────────────────────────────────────────────────
const absenceMap = {}; // empId → daysAbsent

function renderAbsenceTable() {
  const emps  = DB.get('employees').sort((a,b) => a.name.localeCompare(b.name));
  const tbody = document.getElementById('absence-tbody');
  const notice = document.getElementById('no-emp-notice');
  const wrap   = document.getElementById('absence-table-wrap');

  if (!emps.length) {
    notice.style.display = '';
    wrap.style.display   = 'none';
    return;
  }
  notice.style.display = 'none';
  wrap.style.display   = '';

  tbody.innerHTML = emps.map(e => {
    const wdm    = e.workingDaysPerMonth || 26;
    const absent = absenceMap[e.id] || 0;
    return `<tr>
      <td><strong>${e.name}</strong></td>
      <td>${e.department}</td>
      <td class="mono">${wdm}</td>
      <td>
        <input type="number" class="form-input" style="width:80px;padding:5px 10px"
          value="${absent}" min="0" max="${wdm}"
          oninput="setAbsence('${e.id}', +this.value, ${wdm}, this)">
      </td>
      <td class="mono" id="present-${e.id}">${wdm - absent}</td>
      <td><span class="badge ${e.deductAllowanceOnAbsence ? 'badge-blue' : 'badge-gray'}">
        ${e.deductAllowanceOnAbsence ? 'YES' : 'NO'}
      </span></td>
    </tr>`;
  }).join('');
}

function setAbsence(id, val, wdm, input) {
  const clamped  = Math.min(wdm, Math.max(0, isNaN(val) ? 0 : val));
  absenceMap[id] = clamped;
  if (input.value != clamped) input.value = clamped;
  document.getElementById('present-' + id).textContent = wdm - clamped;
}

// ─── Payroll computation ─────────────────────────────────────────────────────
function computeEmp(e) {
  const wdm      = e.workingDaysPerMonth || 26;
  const absent   = absenceMap[e.id] || 0;
  const present  = Math.max(0, wdm - absent);
  const basicPaid = (e.basicSalary || 0) * (present / wdm);
  // Allowances: prorated only when flag is ON
  const ratio     = e.deductAllowanceOnAbsence ? (present / wdm) : 1;
  const mealPaid  = (e.mealAllowance             || 0) * ratio;
  const transpPaid= (e.transportationAllowance   || 0) * ratio;
  const otherPaid = (e.otherAllowance            || 0) * ratio;
  const totalAllow = mealPaid + transpPaid + otherPaid;
  return { basicPaid, mealPaid, transpPaid, otherPaid, totalAllow,
           grossPay: basicPaid + totalAllow, present, wdm };
}

document.getElementById('btn-compute').addEventListener('click', () => {
  const emps = DB.get('employees').sort((a,b) => a.name.localeCompare(b.name));
  if (!emps.length) { alert('No employees to compute. Add employees first.'); return; }

  const period = `${MONTHS[parseInt(monthSel.value) - 1]} ${yearSel.value}`;
  document.getElementById('payroll-table-title').textContent = `Payroll Register for ${period}`;
  document.getElementById('print-period').textContent = period;

  let totBasic = 0, totAllow = 0, totGross = 0;

  const rows = emps.map(e => {
    const p = computeEmp(e);
    totBasic += p.basicPaid;
    totAllow += p.totalAllow;
    totGross += p.grossPay;
    return `<tr>
      <td><strong>${e.name}</strong></td>
      <td>${e.department}</td>
      <td class="mono">${p.present} / ${p.wdm}</td>
      <td class="mono">${formatPeso(p.basicPaid)}</td>
      <td class="mono">${formatPeso(p.mealPaid)}</td>
      <td class="mono">${formatPeso(p.transpPaid)}</td>
      <td class="mono">${formatPeso(p.otherPaid)}</td>
      <td class="mono"><strong>${formatPeso(p.totalAllow)}</strong></td>
      <td class="mono" style="color:var(--primary);font-weight:700">${formatPeso(p.grossPay)}</td>
    </tr>`;
  });

  // Totals row
  rows.push(`<tr style="background:#f8fafc">
    <td colspan="3" style="text-align:right;padding:12px 20px;font-size:11.5px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.4px">TOTALS</td>
    <td class="mono" style="font-weight:700">${formatPeso(totBasic)}</td>
    <td colspan="3"></td>
    <td class="mono" style="font-weight:700">${formatPeso(totAllow)}</td>
    <td class="mono" style="color:var(--primary);font-weight:700">${formatPeso(totGross)}</td>
  </tr>`);

  document.getElementById('payroll-tbody').innerHTML = rows.join('');

  document.getElementById('payroll-summary').innerHTML = `
    <div class="summary-card">
      <div class="kpi-label">Employees</div>
      <div class="kpi-value">${emps.length}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Total Basic Paid</div>
      <div class="kpi-value blue">${formatPeso(totBasic)}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Total Allowances</div>
      <div class="kpi-value green">${formatPeso(totAllow)}</div>
    </div>
    <div class="summary-card">
      <div class="kpi-label">Total Gross Pay</div>
      <div class="kpi-value" style="color:var(--primary)">${formatPeso(totGross)}</div>
    </div>`;

  document.getElementById('payroll-results').style.display = '';
  document.getElementById('payroll-results').scrollIntoView({ behavior:'smooth' });
});

renderAbsenceTable();

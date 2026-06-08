initSidebar('tax-monitoring');

const now = new Date();
const SETTINGS_KEY = 'eSalesFilters';
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function loadTaxSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    const tax = saved.taxMonitoring || {};
    return {
      ...saved,
      taxMonitoring:{
        fiscalStartMonth:Number(tax.fiscalStartMonth) || 1,
        periodType:tax.periodType || 'monthly',
        periodValue:tax.periodValue || '',
        customFrom:tax.customFrom || '',
        customTo:tax.customTo || '',
      }
    };
  } catch (error) {
    return {
      taxMonitoring:{
        fiscalStartMonth:1,
        periodType:'monthly',
        periodValue:'',
        customFrom:'',
        customTo:'',
      }
    };
  }
}

let taxSettings = loadTaxSettings();
let generatedTaxRange = null;

function saveTaxSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(taxSettings));
}

function switchTaxTab(tab) {
  document.querySelectorAll('[data-tax-tab]').forEach(button => {
    button.classList.toggle('active', button.dataset.taxTab === tab);
  });
  document.getElementById('tax-vat-panel').style.display = tab === 'vat' ? '' : 'none';
  document.getElementById('tax-ewt-panel').style.display = tab === 'ewt' ? '' : 'none';
  document.getElementById('tax-income-panel').style.display = tab === 'income' ? '' : 'none';
  if (tab === 'vat') renderVAT();
  if (tab === 'ewt') renderEWT();
  if (tab === 'income') renderCIT();
}

function escTax(value) {
  return String(value || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function localISODate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeTaxDate(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) return localISODate(value);

  const text = String(value).trim();
  if (!text) return '';

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slashDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashDate) {
    const month = Number(slashDate[1]);
    const day = Number(slashDate[2]);
    let year = Number(slashDate[3]);
    if (year < 100) year += 2000;
    const parsed = new Date(year, month - 1, day);
    if (!Number.isNaN(parsed.getTime())) return localISODate(parsed);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : localISODate(parsed);
}

function taxDate(row) {
  return normalizeTaxDate(row.date || row.datePurchased || row.dateDelivered || row.importedAt);
}

function rowsInRange(rows, range) {
  return rows.filter(row => {
    const date = taxDate(row);
    return date && date >= range.from && date <= range.to;
  });
}

function excludedDateCount(rows) {
  return rows.filter(row => !taxDate(row)).length;
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
}

function endOfMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0);
}

function activeFiscalStartYear() {
  const startMonthIndex = taxSettings.taxMonitoring.fiscalStartMonth - 1;
  return now.getMonth() >= startMonthIndex ? now.getFullYear() : now.getFullYear() - 1;
}

function fiscalStartDate() {
  return new Date(activeFiscalStartYear(), taxSettings.taxMonitoring.fiscalStartMonth - 1, 1);
}

function fiscalEndDate() {
  const start = fiscalStartDate();
  return new Date(start.getFullYear(), start.getMonth() + 12, 0);
}

function fiscalMonthValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function currentFiscalPeriodValue(type = taxSettings.taxMonitoring.periodType) {
  const start = fiscalStartDate();
  const monthOffset = ((now.getFullYear() - start.getFullYear()) * 12) + now.getMonth() - start.getMonth();
  if (type === 'quarterly') {
    const quarter = Math.min(4, Math.max(1, Math.floor(Math.max(0, monthOffset) / 3) + 1));
    return `Q${quarter}`;
  }
  if (type === 'yearly') return 'yearly';
  const currentMonth = monthOffset >= 0 && monthOffset < 12 ? now : start;
  return fiscalMonthValue(currentMonth);
}

function periodRange() {
  const fiscal = taxSettings.taxMonitoring;
  const start = fiscalStartDate();
  const end = fiscalEndDate();

  if (fiscal.periodType === 'custom') {
    return {
      from:fiscal.customFrom || localISODate(start),
      to:fiscal.customTo || localISODate(end),
      label:'Custom'
    };
  }

  if (fiscal.periodType === 'quarterly') {
    const quarter = Number(String(fiscal.periodValue || currentFiscalPeriodValue('quarterly')).replace('Q', '')) || 1;
    const quarterStart = addMonths(start, (quarter - 1) * 3);
    const quarterEnd = endOfMonth(quarterStart.getFullYear(), quarterStart.getMonth() + 2);
    return {
      from:localISODate(quarterStart),
      to:localISODate(quarterEnd),
      label:`Q${quarter}`
    };
  }

  if (fiscal.periodType === 'yearly') {
    return {
      from:localISODate(start),
      to:localISODate(end),
      label:'Yearly'
    };
  }

  const monthValue = fiscal.periodValue || currentFiscalPeriodValue('monthly');
  const [year, month] = monthValue.split('-').map(Number);
  const monthStart = new Date(year, month - 1, 1);
  return {
    from:localISODate(monthStart),
    to:localISODate(endOfMonth(year, month - 1)),
    label:monthStart.toLocaleDateString('en-PH', { month:'long', year:'numeric' })
  };
}

function activeGeneratedRange() {
  return generatedTaxRange || periodRange();
}

function fyLabel() {
  const start = fiscalStartDate();
  const end = fiscalEndDate();
  const startLabel = start.toLocaleDateString('en-PH', { month:'short', year:'numeric' });
  const endLabel = end.toLocaleDateString('en-PH', { month:'short', year:'numeric' });
  return `FY ${start.getFullYear()} (${startLabel} - ${endLabel})`;
}

function rangeLabel(range) {
  const from = new Date(`${range.from}T00:00:00`);
  const to = new Date(`${range.to}T00:00:00`);
  const fromText = from.toLocaleDateString('en-PH', { month:'short', day:'numeric' });
  const toText = to.toLocaleDateString('en-PH', { month:'short', day:'numeric', year:'numeric' });
  return `${fyLabel()} - ${range.label}: ${fromText} - ${toText}`;
}

function populateFiscalControls() {
  const fiscal = taxSettings.taxMonitoring;
  const startSelect = document.getElementById('tax-fy-start-month');
  startSelect.innerHTML = MONTH_NAMES.map((month, index) =>
    `<option value="${index + 1}"${index + 1 === fiscal.fiscalStartMonth ? ' selected' : ''}>${month}</option>`
  ).join('');
  document.getElementById('tax-period-type').value = fiscal.periodType;
  document.getElementById('tax-custom-from').value = fiscal.customFrom;
  document.getElementById('tax-custom-to').value = fiscal.customTo;
  populatePeriodValues();
}

function populatePeriodValues() {
  const fiscal = taxSettings.taxMonitoring;
  const valueSelect = document.getElementById('tax-period-value');
  const customRange = document.getElementById('tax-custom-range');
  const start = fiscalStartDate();
  const options = [];

  valueSelect.style.display = fiscal.periodType === 'custom' ? 'none' : '';
  customRange.style.display = fiscal.periodType === 'custom' ? 'flex' : 'none';

  if (fiscal.periodType === 'monthly') {
    for (let offset = 0; offset < 12; offset++) {
      const monthDate = addMonths(start, offset);
      const value = fiscalMonthValue(monthDate);
      options.push({
        value,
        label:monthDate.toLocaleDateString('en-PH', { month:'long', year:'numeric' })
      });
    }
    if (!options.some(option => option.value === fiscal.periodValue)) {
      fiscal.periodValue = currentFiscalPeriodValue('monthly');
    }
  } else if (fiscal.periodType === 'quarterly') {
    for (let quarter = 1; quarter <= 4; quarter++) {
      const quarterStart = addMonths(start, (quarter - 1) * 3);
      const quarterEnd = endOfMonth(quarterStart.getFullYear(), quarterStart.getMonth() + 2);
      options.push({
        value:`Q${quarter}`,
        label:`Q${quarter}: ${quarterStart.toLocaleDateString('en-PH', { month:'short' })} - ${quarterEnd.toLocaleDateString('en-PH', { month:'short', year:'numeric' })}`
      });
    }
    if (!options.some(option => option.value === fiscal.periodValue)) {
      fiscal.periodValue = currentFiscalPeriodValue('quarterly');
    }
  } else if (fiscal.periodType === 'yearly') {
    fiscal.periodValue = 'yearly';
    options.push({ value:'yearly', label:fyLabel() });
  }

  valueSelect.innerHTML = options.map(option =>
    `<option value="${option.value}"${option.value === fiscal.periodValue ? ' selected' : ''}>${option.label}</option>`
  ).join('');
  saveTaxSettings();
  updatePeriodHeader();
}

function updatePeriodHeader() {
  const range = periodRange();
  const sources = [
    ...DB.get('eSalesRecords'),
    ...DB.get('purchases'),
    ...DB.get('expenses'),
    ...DB.get('supplies_movements')
  ];
  const excluded = excludedDateCount(sources);
  document.getElementById('tax-period-label').textContent = rangeLabel(range);
  document.getElementById('tax-excluded-note').textContent = excluded
    ? `${excluded} records with no parseable date are excluded from these period totals.`
    : '';
}

function rerenderAllTaxTabs() {
  updatePeriodHeader();
  renderVAT();
  renderEWT();
  renderCIT();
}

function generateTaxPeriod() {
  saveTaxSettings();
  generatedTaxRange = periodRange();
  rerenderAllTaxTabs();
}

function money(row, keys) {
  for (const key of keys) {
    if (row[key] != null && row[key] !== '') return Number(row[key]) || 0;
  }
  return 0;
}

function purchaseSpend(row) {
  return Number(row.netAmount ?? row.total ?? row.amount ?? row.totalCost ?? row.totalAmount ?? 0) || 0;
}

function purchaseNetAmount(row) {
  return Number(row.netAmount ?? row.total ?? row.amount ?? 0) || 0;
}

function purchaseEWTRate(row) {
  return Number(row.ewtRate ?? row.taxRate ?? 0) || 0;
}

function purchaseEWTAmount(row) {
  return Number(row.ewtAmount ?? row.withholdingTax ?? 0) || 0;
}

function inputVATAmount(row) {
  const explicit = money(row, ['inputVAT', 'vatAmount', 'vat']);
  if (explicit) return explicit;
  const gross = Number(row.grossAmount ?? row.totalAmount ?? 0) || 0;
  const net = purchaseSpend(row);
  return gross > net ? gross - net : 0;
}

function supplyFullPurchaseCost(row) {
  if (String(row.type || 'Incoming').toLowerCase() !== 'incoming') return 0;
  const explicit = Number(row.grossAmount ?? row.totalIncomingValue ?? row.purchaseTotalCost);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const originalQty = Number(row.originalQty ?? row.qty ?? 0) || 0;
  const unitCost = Number(row.unitCost ?? row.cost ?? 0) || 0;
  return originalQty * unitCost || Number(row.totalCost ?? row.amount ?? 0) || 0;
}

function vatCreditable(row) {
  return row.inputVATCreditable === true ||
    row.vatCreditable === true ||
    row.isVATCreditable === true ||
    row.inputVATCreditable === 'yes' ||
    row.vatCreditable === 'yes';
}

function vatExplicitlyNonCreditable(row) {
  return row.inputVATCreditable === false ||
    row.vatCreditable === false ||
    row.isVATCreditable === false ||
    row.inputVATCreditable === 'no' ||
    row.vatCreditable === 'no';
}

async function loadTaxESalesRecords() {
  const db = getFirestoreDB();
  if (!db) {
    console.warn('[Tax Monitoring] Firestore is unavailable; E-Sales output VAT will use the current local cache only.');
    return DB.get('eSalesRecords');
  }

  try {
    const snap = await db.collection('eSalesRecords').get();
    const rows = snap.docs.map(doc => ({ id:doc.id, _firestoreId:doc.id, ...doc.data() }));
    DB.set('eSalesRecords', rows);
    return rows;
  } catch (error) {
    console.error('[Tax Monitoring] Could not load E-Sales Records:', error);
    return DB.get('eSalesRecords');
  }
}

function renderVAT() {
  const range = activeGeneratedRange();
  const sales = rowsInRange(DB.get('eSalesRecords'), range);
  const purchases = rowsInRange(DB.get('purchases'), range);
  const expenses = rowsInRange(DB.get('expenses'), range);
  const supplies = rowsInRange(DB.get('supplies_movements'), range);

  const grossSales = sales.reduce((sum, row) => sum + money(row, ['grossSales']), 0);
  const vatExempt = sales.reduce((sum, row) => sum + money(row, ['vatExempt']), 0);
  const zeroRated = sales.reduce((sum, row) => sum + money(row, ['zeroRated']), 0);
  const scPwdDiscounts = sales.reduce((sum, row) =>
    sum + money(row, ['scDiscount']) + money(row, ['pwdDiscount']), 0);
  const netTaxableSales = sales.reduce((sum, row) => sum + money(row, ['vatableSales']), 0);
  const outputVAT = sales.reduce((sum, row) => {
    const explicitVAT = money(row, ['vatAmount']);
    const taxable = money(row, ['vatableSales']);
    return sum + (explicitVAT || taxable * 0.12);
  }, 0);

  const purchaseInputIncluded = purchases
    .filter(row => !vatExplicitlyNonCreditable(row))
    .reduce((sum, row) => sum + inputVATAmount(row), 0);
  const purchaseInputExcluded = purchases
    .filter(vatExplicitlyNonCreditable)
    .reduce((sum, row) => sum + inputVATAmount(row), 0);

  const expenseInputIncluded = expenses
    .filter(vatCreditable)
    .reduce((sum, row) => sum + inputVATAmount(row), 0);
  const expenseInputExcluded = expenses
    .filter(row => inputVATAmount(row) && !vatCreditable(row))
    .reduce((sum, row) => sum + inputVATAmount(row), 0);

  const supplyInputIncluded = supplies
    .filter(row => !vatExplicitlyNonCreditable(row))
    .reduce((sum, row) => sum + inputVATAmount(row), 0);
  const supplyInputExcluded = supplies
    .filter(vatExplicitlyNonCreditable)
    .reduce((sum, row) => sum + inputVATAmount(row), 0);

  const creditableInputVAT = purchaseInputIncluded + expenseInputIncluded + supplyInputIncluded;
  const payable = outputVAT - creditableInputVAT;

  document.getElementById('vat-gross-sales').textContent = formatPeso(grossSales);
  document.getElementById('vat-exempt-sales').textContent = `(${formatPeso(vatExempt)})`;
  document.getElementById('vat-zero-rated-sales').textContent = `(${formatPeso(zeroRated)})`;
  document.getElementById('vat-sc-pwd-discounts').textContent = `(${formatPeso(scPwdDiscounts)})`;
  document.getElementById('vat-net-taxable-sales').textContent = formatPeso(netTaxableSales);
  document.getElementById('vat-output').textContent = formatPeso(outputVAT);
  document.getElementById('vat-input-purchases').textContent = formatPeso(purchaseInputIncluded);
  document.getElementById('vat-input-expenses').textContent = formatPeso(expenseInputIncluded);
  document.getElementById('vat-input-supplies').textContent = formatPeso(supplyInputIncluded);
  document.getElementById('vat-input-total').textContent = formatPeso(creditableInputVAT);
  document.getElementById('vat-payable-formula').textContent =
    `VAT Payable = ${formatPeso(outputVAT)} - ${formatPeso(creditableInputVAT)}`;
  document.getElementById('vat-payable').textContent = formatPeso(payable);

  document.getElementById('vat-input-breakdown-body').innerHTML = `
    <tr>
      <td>Purchases</td>
      <td class="mono">${formatPeso(purchaseInputIncluded)}</td>
      <td class="mono">${formatPeso(purchaseInputExcluded)}</td>
    </tr>
    <tr>
      <td>Expenses</td>
      <td class="mono">${formatPeso(expenseInputIncluded)}</td>
      <td class="mono">${formatPeso(expenseInputExcluded)}</td>
    </tr>
    <tr>
      <td>Supplies</td>
      <td class="mono">${formatPeso(supplyInputIncluded)}</td>
      <td class="mono">${formatPeso(supplyInputExcluded)}</td>
    </tr>`;
}

function renderEWT() {
  const rows = rowsInRange(DB.get('purchases'), activeGeneratedRange())
    .filter(row => purchaseEWTAmount(row) || purchaseEWTRate(row))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  const totalEWT = rows.reduce((sum, row) => sum + purchaseEWTAmount(row), 0);
  const tbody = document.getElementById('ewt-computation-body');

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><p>No purchases with EWT recorded.</p></div></td></tr>';
  } else {
    tbody.innerHTML = rows.map(row => `
      <tr>
        <td>${escTax(formatDate(taxDate(row)))}</td>
        <td>${escTax(row.supplier || row.supplierName || row.vendorName || 'Unknown')}</td>
        <td class="mono">${formatPeso(purchaseNetAmount(row))}</td>
        <td>${purchaseEWTRate(row).toFixed(2).replace(/\.00$/, '')}%</td>
        <td class="mono">${formatPeso(purchaseEWTAmount(row))}</td>
      </tr>
    `).join('');
  }

  document.getElementById('ewt-total-remit').textContent = formatPeso(totalEWT);
}

function rowsInCITPeriod(rows) {
  return rowsInRange(rows, activeGeneratedRange());
}

function taxExpenseIsDeductible(row) {
  return String(row.classification || '').toLowerCase() === 'business' && !(
    row.taxDeductible === false ||
    row.deductible === false ||
    row.taxTreatment === 'Non-deductible' ||
    row.deductibility === 'Non-deductible' ||
    row.taxDeductible === 'no' ||
    row.deductible === 'no'
  );
}

function calculateCIT() {
  const salesRows = rowsInCITPeriod(DB.get('eSalesRecords'));
  const purchases = rowsInCITPeriod(DB.get('purchases'));
  const expenses = rowsInCITPeriod(DB.get('expenses')).filter(taxExpenseIsDeductible);
  const supplies = rowsInCITPeriod(DB.get('supplies_movements'));

  const sales = salesRows.reduce((sum, row) => sum + (Number(row.grossSales) || 0), 0);
  const cogs = purchases.reduce((sum, row) => sum + purchaseSpend(row), 0);
  const expenseAmount = expenses.reduce((sum, row) => sum + (Number(row.amount ?? row.grossAmount ?? row.netAmount) || 0), 0);
  const supplyAmount = supplies.reduce((sum, row) => sum + supplyFullPurchaseCost(row), 0);
  const expensesAndSupplies = expenseAmount + supplyAmount;
  const taxableIncome = sales - cogs - expensesAndSupplies;
  const rate = Number(document.getElementById('cit-tax-rate').value) || 0.20;
  const taxDue = Math.max(0, taxableIncome) * rate;

  return { sales, cogs, expenseAmount, supplyAmount, expensesAndSupplies, taxableIncome, rate, taxDue };
}

function renderCIT() {
  const result = calculateCIT();
  document.getElementById('cit-sales').textContent = formatPeso(result.sales);
  document.getElementById('cit-cogs').textContent = `(${formatPeso(result.cogs)})`;
  document.getElementById('cit-expenses').textContent = `(${formatPeso(result.expensesAndSupplies)})`;
  document.getElementById('cit-taxable').textContent = formatPeso(result.taxableIncome);
  document.getElementById('cit-rate-label').textContent =
    `Income Tax Due = ${formatPeso(Math.max(0, result.taxableIncome))} × ${(result.rate * 100).toFixed(0)}%`;
  document.getElementById('cit-tax-due').textContent = formatPeso(result.taxDue);
}

document.getElementById('tax-fy-start-month').addEventListener('change', function() {
  taxSettings.taxMonitoring.fiscalStartMonth = Number(this.value) || 1;
  taxSettings.taxMonitoring.periodValue = '';
  populatePeriodValues();
});

document.getElementById('tax-period-type').addEventListener('change', function() {
  taxSettings.taxMonitoring.periodType = this.value;
  taxSettings.taxMonitoring.periodValue = '';
  populatePeriodValues();
});

document.getElementById('tax-period-value').addEventListener('change', function() {
  taxSettings.taxMonitoring.periodValue = this.value;
  saveTaxSettings();
  updatePeriodHeader();
});

document.getElementById('tax-custom-from').addEventListener('change', function() {
  taxSettings.taxMonitoring.customFrom = this.value;
  saveTaxSettings();
  updatePeriodHeader();
});

document.getElementById('tax-custom-to').addEventListener('change', function() {
  taxSettings.taxMonitoring.customTo = this.value;
  saveTaxSettings();
  updatePeriodHeader();
});

document.getElementById('tax-generate-btn').addEventListener('click', generateTaxPeriod);
document.getElementById('cit-tax-rate').addEventListener('change', renderCIT);
populateFiscalControls();

async function initTaxMonitoring() {
  await loadTaxESalesRecords();
  generateTaxPeriod();
}

initTaxMonitoring();

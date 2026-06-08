initSidebar('reports');

const REPORT_DATA = {
  sales: [], purchases: [], expenses: [], supplies: [], inventory: [], suppliers: [], esales: [],
  ewtRemittances: [], productMaster: []
};
let activeReportTab = 'income';
const FEATURE_CUSTOM_REPORT = false;
let reportChart = null;
let purchasesBarChart = null;
let reportCategoryChart = null;
let customExportRows = [];
const CUSTOM_SOURCE_CONFIG = {
  sales:    { key:'sales',    measures:[{value:'value',label:'Total Value (₱)'},{value:'units',label:'Units Sold'},{value:'count',label:'Transaction Count'}],    dimensions:[{value:'day',label:'Day'},{value:'week',label:'Week'},{value:'month',label:'Month'},{value:'category',label:'Category'}] },
  esales:   { key:'esales',   measures:[{value:'value',label:'Total Value (₱)'},{value:'units',label:'Units Sold'},{value:'count',label:'Transaction Count'}],    dimensions:[{value:'day',label:'Day'},{value:'week',label:'Week'},{value:'month',label:'Month'},{value:'category',label:'Category'}] },
  purchases:{ key:'purchases',measures:[{value:'value',label:'Total Value (₱)'},{value:'count',label:'Transaction Count'}],                                       dimensions:[{value:'day',label:'Day'},{value:'week',label:'Week'},{value:'month',label:'Month'},{value:'category',label:'Category'},{value:'supplier',label:'Supplier'}] },
  expenses: { key:'expenses', measures:[{value:'value',label:'Total Value (₱)'},{value:'count',label:'Transaction Count'}],                                       dimensions:[{value:'day',label:'Day'},{value:'week',label:'Week'},{value:'month',label:'Month'},{value:'category',label:'Category'}] },
  inventory:{ key:'inventory',measures:[{value:'value',label:'Total Value (₱)'},{value:'units',label:'Units'},{value:'count',label:'Record Count'}],              dimensions:[{value:'day',label:'Day'},{value:'week',label:'Week'},{value:'month',label:'Month'},{value:'category',label:'Category'},{value:'supplier',label:'Supplier'}] },
};
const customState = (() => {
  const d = { source:'sales', measure:'value', groupBy:'month', chartType:'bar', barOrientation:'vertical', pieTopN:8 };
  try { return { ...d, ...JSON.parse(localStorage.getItem('customReportState') || '{}') }; }
  catch(e) { return { ...d }; }
})();
let reportSalesCategory = '';
let reportSalesFlag = '';
let reportPurchaseSupplier = '';
let salesTopN = 5;
let purchasesTopN = 5;
let reportProgressTimer = null;
const inventoryMovementState = {
  highThreshold:75, lowThreshold:25, search:'', flag:'all',
  sortKey:'outgoingPct', sortDir:'desc', page:1, pageSize:50,
  filters:{ itemCode:'', description:'', category:'', supplier:'', unitCost:{min:'',max:''},
    totalIncoming:{min:'',max:''}, incomingValue:{min:'',max:''}, totalOutgoing:{min:'',max:''},
    outgoingValue:{min:'',max:''}, netStock:{min:'',max:''}, outgoingPct:{min:'',max:''} }
};
const rankingTableSort = {
  sales:{ key:'rank', direction:'asc' },
  purchases:{ key:'rank', direction:'asc' }
};
const reportToday = new Date();
const reportCurrentMonth = `${reportToday.getFullYear()}-${String(reportToday.getMonth() + 1).padStart(2, '0')}`;
const taxRanges = {
  vat:{ from:`${reportCurrentMonth}-01`, to:lastDayOfReportMonth(reportToday.getFullYear(), reportToday.getMonth() + 1) },
  ewt:{ from:`${reportCurrentMonth}-01`, to:lastDayOfReportMonth(reportToday.getFullYear(), reportToday.getMonth() + 1) },
};
let taxIncomePeriod = { type:'monthly', value:reportCurrentMonth };
let taxChartInstances = {};
let taxLiabilityState = { vatPayable:0, ewt:0, incomeTaxStillDue:0 };

function normalizeReportDate(value) {
  if (!value) return '';
  if (typeof value.toDate === 'function') value = value.toDate();
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }
  const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    return `${slashMatch[3]}-${slashMatch[1].padStart(2, '0')}-${slashMatch[2].padStart(2, '0')}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function reportDate(row) {
  return normalizeReportDate(row.date || row.dateDelivered || row.datePurchased || row.importedAt || '');
}

function inReportRange(row) {
  const date = reportDate(row);
  const start = document.getElementById('report-start').value;
  const end = document.getElementById('report-end').value;
  return date && (!start || date >= start) && (!end || date <= end);
}

function escReport(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function fetchReportCollection(name, fallbackKey = '') {
  const localRows = fallbackKey ? DB.get(fallbackKey) : [];
  if (name === 'purchases' && localRows.length) return localRows;
  const db = getFirestoreDB();
  if (!db) return localRows;
  const snapshot = await db.collection(name).get();
  const rows = snapshot.docs.map(doc => ({ _firestoreId: doc.id, ...doc.data() }));
  if (!snapshot.empty) return rows;
  return localRows;
}

async function loadReportData() {
  const [sales, purchases, expenses, supplies, inventory, suppliers, esales, ewtRemittances, productMaster] = await Promise.all([
    fetchReportCollection('salesData', 'pos_sales'),
    fetchReportCollection('purchases', 'purchases'),
    fetchReportCollection('expenses', 'expenses'),
    fetchReportCollection('suppliesData', 'supplies_movements'),
    fetchReportCollection('inventoryData', 'inventory_movements'),
    fetchReportCollection('suppliers', 'suppliers'),
    fetchReportCollection('eSalesRecords'),
    fetchReportCollection('ewtRemittances'),
    fetchReportCollection('productMaster'),
  ]);
  Object.assign(REPORT_DATA, { sales, purchases, expenses, supplies, inventory, suppliers, esales, ewtRemittances, productMaster });
}

function setDefaultReportDates() {
  const now = new Date();
  document.getElementById('report-start').value =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  document.getElementById('report-end').value =
    new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
}

async function setReportPreset(preset) {
  const now = new Date();
  let start;
  let end;
  if (preset === 'last-month') {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 0);
  } else if (preset === 'quarter') {
    start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    end = new Date(start.getFullYear(), start.getMonth() + 3, 0);
  } else if (preset === 'year') {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear(), 11, 31);
  } else if (preset === 'custom') {
    document.getElementById('report-start').focus();
    return;
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  }
  document.getElementById('report-start').value = start.toISOString().slice(0, 10);
  document.getElementById('report-end').value = end.toISOString().slice(0, 10);
  await refreshReportData();
}

function setReportTab(tab) {
  if (tab === 'custom' && !FEATURE_CUSTOM_REPORT) return;
  activeReportTab = tab;
  document.querySelectorAll('[data-report-tab]').forEach(button => {
    button.classList.toggle('active', button.dataset.reportTab === tab);
  });
  renderActiveReport();
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

function setReportProgress(value, label = '') {
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  document.getElementById('report-loading-fill').style.width = `${percent}%`;
  document.getElementById('report-loading-percent').textContent = `${percent}%`;
  if (label) document.getElementById('report-loading-label').textContent = label;
}

function waitReportFrame() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function withReportProgress(label, task) {
  const loading = document.getElementById('report-loading');
  const applyButton = document.getElementById('btn-apply-report-range');
  clearInterval(reportProgressTimer);
  loading.classList.add('active');
  applyButton.disabled = true;
  setReportProgress(8, label);
  await waitReportFrame();
  setReportProgress(28);
  reportProgressTimer = setInterval(() => {
    const current = parseInt(document.getElementById('report-loading-percent').textContent, 10) || 0;
    if (current < 88) setReportProgress(current + 6);
  }, 160);

  try {
    const result = await task();
    clearInterval(reportProgressTimer);
    setReportProgress(100, 'Report ready.');
    setTimeout(() => loading.classList.remove('active'), 450);
    return result;
  } catch (error) {
    clearInterval(reportProgressTimer);
    setReportProgress(100, 'Report failed.');
    setTimeout(() => loading.classList.remove('active'), 900);
    throw error;
  } finally {
    applyButton.disabled = false;
  }
}

function renderCards(cards) {
  document.getElementById('report-summary').innerHTML = cards.map(card => `
    <div class="summary-card">
      <div class="kpi-label">${escReport(card.label)}</div>
      <div class="kpi-value ${card.cls || ''}">${card.value}</div>
      ${card.note ? `<div class="kpi-sub">${escReport(card.note)}</div>` : ''}
    </div>`).join('');
}

function renderTable(cardId, title, headers, rows) {
  const secondary = cardId === 'secondary';
  const card = document.getElementById(`report-${cardId}-card`);
  card.style.display = '';
  document.getElementById(`report-${cardId}-title`).textContent = title;
  document.getElementById(`report-${cardId}-head`).innerHTML =
    `<tr>${headers.map(header => `<th>${escReport(header)}</th>`).join('')}</tr>`;
  document.getElementById(`report-${cardId}-body`).innerHTML = rows.length
    ? rows.join('')
    : `<tr><td colspan="${headers.length}"><div class="empty-state"><p>No data for this period.</p></div></td></tr>`;
  if (!secondary) document.getElementById('report-primary-card').style.display = '';
}

function hideSecondaryTable() {
  document.getElementById('report-secondary-card').style.display = 'none';
}

function drawChart(type, labels, data, label, color = '#1a56db', chartOptions = {}) {
  const card = document.getElementById('report-chart-card');
  if (!labels.length || typeof Chart === 'undefined') {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  if (reportChart) {
    if (reportChart === purchasesBarChart) purchasesBarChart = null;
    reportChart.destroy();
  }
  const chartType = type === 'area' ? 'line' : type;
  reportChart = new Chart(document.getElementById('report-chart'), {
    type: chartType,
    data: { labels, datasets: [{ label, data, backgroundColor: color, borderColor: color,
      borderRadius:chartOptions.borderRadius || 0, fill: type === 'area', tension: 0.25 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: chartOptions.indexAxis,
      scales: chartOptions.scales || (chartOptions.forceZero ? { y:{ beginAtZero:true, min:0 } } : undefined),
      plugins: {
        legend: { display: !chartOptions.hideLegend },
        title: chartOptions.title ? { display:true, text:chartOptions.title, font:{ size:13, weight:'500' } } : undefined,
        tooltip: chartOptions.pesoTooltips ? {
          callbacks: {
            label: context => `₱${Number(context.raw || 0).toLocaleString('en-PH', {
              minimumFractionDigits:2, maximumFractionDigits:2
            })}`
          }
        } : undefined
      }
    }
  });
}

function renderCategoryChart(rows, labelFn, valueFn, title) {
  if (typeof Chart === 'undefined') return;
  const colors = ['#3b82f6', '#16a34a', '#d97706', '#dc2626', '#7c3aed',
    '#0891b2', '#db2777', '#65a30d', '#6b7280'];
  const totals = grouped(rows, labelFn, valueFn).sort((a, b) => b[1] - a[1]);
  const chartRows = totals.slice(0, 8);
  const others = totals.slice(8).reduce((total, row) => total + row[1], 0);
  if (others > 0) chartRows.push(['Others', others]);
  if (reportCategoryChart) reportCategoryChart.destroy();
  reportCategoryChart = new Chart(document.getElementById('report-category-chart'), {
    type:'doughnut',
    data:{
      labels:chartRows.map(row => row[0]),
      datasets:[{ data:chartRows.map(row => row[1]), backgroundColor:colors,
        borderWidth:2, borderColor:'#ffffff' }]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{
        legend:{ position:'right', labels:{ font:{ size:11 }, padding:12 } },
        title:{ display:true, text:title, font:{ size:13, weight:'500' } },
        tooltip:{ callbacks:{ label:context => {
          const total = context.dataset.data.reduce((sum, value) => sum + value, 0);
          const percent = total ? (context.parsed / total * 100).toFixed(1) : '0.0';
          const value = `₱${Number(context.parsed || 0).toLocaleString('en-PH', {
            minimumFractionDigits:2, maximumFractionDigits:2
          })}`;
          return ` ${context.label}: ${value} (${percent}%)`;
        } } }
      }
    }
  });
}

function shortenChartLabel(value) {
  const text = String(value);
  return text.length > 20 ? `${text.slice(0, 20)}…` : text;
}

function getRankedChartHeight(n) {
  return (n * 36) + 80;
}

function getPurchasesChartHeight(n) {
  return (n * 36) + 80;
}

function renderTopNChart(rows, title, color, selectedN, type = 'sales') {
  const isPurchases = type === 'purchases';
  const height = isPurchases ? getPurchasesChartHeight(selectedN) : getRankedChartHeight(selectedN);
  const container = document.getElementById(isPurchases ? 'purchases-bar-container' : 'sales-bar-container');
  document.getElementById('report-chart-card').style.height = `${height}px`;
  container.style.height = `${height - 32}px`;
  if (isPurchases && purchasesBarChart) {
    purchasesBarChart.destroy();
    if (reportChart === purchasesBarChart) reportChart = null;
    purchasesBarChart = null;
  }
  drawChart('bar', rows.map(row => shortenChartLabel(row.name)), rows.map(row => row.total),
    title, color, {
      indexAxis:'y', hideLegend:true, pesoTooltips:true, borderRadius:4,
      title,
      scales:{ x:{ beginAtZero:true, ticks:{ callback:value => `₱${(value / 1000000).toFixed(1)}M` } } }
    });
  if (isPurchases) purchasesBarChart = reportChart;
}

function setReportTopN(value) {
  const selected = Number(value) || 5;
  if (activeReportTab === 'sales') salesTopN = selected;
  if (activeReportTab === 'purchases') purchasesTopN = selected;
  renderActiveReport();
}

function renderTopNControl(selected, noun) {
  document.getElementById('report-top-n-control').innerHTML = `
    <span>Show top:</span>
    <select class="form-select" onchange="setReportTopN(this.value)">
      ${[5, 10, 15, 20].map(value => `<option${value === selected ? ' selected' : ''}>${value}</option>`).join('')}
    </select>
    <span>${noun}</span>`;
}

function sortRankingRows(rows, type) {
  const sort = rankingTableSort[type];
  return [...rows].sort((a, b) => {
    const left = a[sort.key];
    const right = b[sort.key];
    const result = typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left ?? '').localeCompare(String(right ?? ''));
    return sort.direction === 'asc' ? result : -result;
  });
}

function setRankingTableSort(type, key) {
  const sort = rankingTableSort[type];
  sort.direction = sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc';
  sort.key = key;
  renderActiveReport();
}

function renderRankingTable(title, type, columns, rows) {
  const sort = rankingTableSort[type];
  renderTable('primary', title, columns.map(column => column.label), sortRankingRows(rows, type).map(row => `
    <tr>${columns.map(column => `<td class="${column.numeric ? 'mono' : ''}">${column.render(row)}</td>`).join('')}</tr>`));
  document.getElementById('report-primary-head').innerHTML = `<tr>${columns.map(column => `
    <th><button class="sortable-report-header" onclick="setRankingTableSort('${type}','${column.key}')">
      ${column.label}${sort.key === column.key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}
    </button></th>`).join('')}</tr>`;
}

function grouped(rows, labelFn, valueFn) {
  const values = new Map();
  rows.forEach(row => {
    const label = labelFn(row);
    values.set(label, (values.get(label) || 0) + valueFn(row));
  });
  return [...values.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

function monthLabel(row) {
  return reportDate(row).slice(0, 7) || 'Unknown';
}

function salesFlag(row) {
  const margin = Number(row.margin) || 0;
  const high = Number(localStorage.getItem('marginHighThreshold') ?? 30);
  if (Number(row.grossProfit) < 0 || margin < 0) return 'Loss';
  if (margin > high) return 'High Margin';
  return 'Normal';
}

function renderIncomeStatement() {
  const sales = REPORT_DATA.sales.filter(inReportRange);
  const expenses = REPORT_DATA.expenses.filter(inReportRange);
  const supplies = REPORT_DATA.supplies.filter(inReportRange);
  const salesCostMethod = window.EPCSalesCost?.getCostMethod?.() || 'latest';
  const costedSales = window.EPCSalesCost?.fullyCostedSales
    ? window.EPCSalesCost.fullyCostedSales(sales, REPORT_DATA.productMaster, salesCostMethod)
    : sales.filter(row => Number(row.totalCost) > 0);
  const revenue = sum(costedSales, 'totalRevenue');
  const cogs = sum(costedSales, 'totalCost');
  const grossProfit = revenue - cogs;
  const operatingExpenses = sum(expenses, 'amount');
  const suppliesExpense = supplies.reduce((total, row) => total + (Number(row.totalCost ?? row.amount) || 0), 0);
  const totalExpenses = operatingExpenses + suppliesExpense;
  const netIncome = grossProfit - totalExpenses;
  const chartData = [
    revenue, cogs, grossProfit, operatingExpenses, suppliesExpense, totalExpenses, netIncome
  ].map(value => Math.abs(value));
  const chartColors = [
    '#16a34a', '#dc2626', '#2563eb', '#dc2626', '#d97706', '#dc2626',
    netIncome >= 0 ? '#16a34a' : '#dc2626'
  ];
  drawChart('bar',
    ['Revenue', 'COGS', 'Gross Profit', 'Op. Expenses', 'Supplies', 'Total Expenses', 'Net Income'],
    chartData,
    'Income Statement',
    chartColors,
    { forceZero:true, hideLegend:true, pesoTooltips:true });
  renderTable('primary', 'Income Statement', ['Line Item', 'Amount'], [
    `<tr class="section-header"><td colspan="2">REVENUE</td></tr>`,
    statementRow('Sales Revenue', revenue),
    `<tr class="statement-rule"><td colspan="2"></td></tr>`,
    `<tr class="section-header"><td colspan="2">COST OF GOODS SOLD</td></tr>`,
    statementRow('COGS', cogs, true),
    `<tr class="statement-rule"><td colspan="2"></td></tr>`,
    statementRow('GROSS PROFIT', grossProfit, false, 'subtotal'),
    `<tr class="statement-spacer"><td colspan="2"></td></tr>`,
    `<tr class="section-header"><td colspan="2">OPERATING EXPENSES</td></tr>`,
    statementRow('General Expenses', operatingExpenses, true),
    statementRow('Supplies Expense', suppliesExpense, true),
    statementRow('Total Operating Expenses', totalExpenses, true, 'subtotal'),
    `<tr class="statement-rule"><td colspan="2"></td></tr>`,
    statementRow('NET INCOME', netIncome, false, 'net-income', true),
  ]);
  hideSecondaryTable();
}

function formatStatementAmount(value, parentheses = false, signedColor = false) {
  const amount = Number(value) || 0;
  const formatted = formatPeso(Math.abs(amount));
  const display = parentheses || amount < 0 ? `(${formatted})` : formatted;
  if (!signedColor) return display;
  return `<span class="${amount < 0 ? 'amount-negative' : 'amount-positive'}">${display}</span>`;
}

function statementRow(label, value, parentheses = false, rowClass = '', signedColor = false) {
  return `<tr class="${rowClass}">
    <td>${label}</td><td class="mono">${formatStatementAmount(value, parentheses, signedColor)}</td>
  </tr>`;
}

function salesFilters(rows) {
  return rows.filter(row => !reportSalesCategory || row.category === reportSalesCategory)
    .filter(row => !reportSalesFlag || salesFlag(row) === reportSalesFlag);
}

function setReportSalesCategory(value) {
  reportSalesCategory = value;
  renderActiveReport();
}

function setReportSalesFlag(value) {
  reportSalesFlag = value;
  renderActiveReport();
}

function setReportPurchaseSupplier(value) {
  reportPurchaseSupplier = value;
  renderActiveReport();
}

function salesProductRanking(rows) {
  const products = new Map();
  rows.forEach(row => {
    const name = row.productName || row.itemCode || 'Unknown';
    const key = `${name}\u0000${row.itemCode || ''}\u0000${row.category || 'Uncategorized'}`;
    const current = products.get(key) || {
      name, itemCode:row.itemCode || '', category:row.category || 'Uncategorized',
      total:0, units:0, profit:0
    };
    const revenue = Number(row.totalRevenue) || 0;
    const grossProfit = Number(row.grossProfit);
    current.total += revenue;
    current.units += Number(row.unitsSold) || 0;
    current.profit += Number.isFinite(grossProfit) ? grossProfit : revenue * (Number(row.margin) || 0) / 100;
    products.set(key, current);
  });
  return [...products.values()].sort((a, b) => b.total - a.total)
    .slice(0, salesTopN).map((row, index) => ({ ...row, rank:index + 1 }));
}

function purchaseSpend(row) {
  return Number(row.netAmount ?? row.total ?? row.amount ?? row.totalCost ?? row.totalAmount ?? 0) || 0;
}

function purchaseGrossAmount(row) {
  const explicit = Number(row.grossAmount ?? row.totalAmount);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return purchaseSpend(row) + purchaseInputVAT(row);
}

function purchaseSupplier(row) {
  return row.supplier || row.supplierName || row.vendorName || 'Unknown';
}

function purchasesSupplierRanking(rows) {
  const suppliers = new Map();
  rows.forEach(row => {
    const name = purchaseSupplier(row);
    const current = suppliers.get(name) || { name, total:0, transactions:0 };
    current.total += purchaseSpend(row);
    current.transactions += 1;
    suppliers.set(name, current);
  });
  return [...suppliers.values()].sort((a, b) => b.total - a.total)
    .slice(0, purchasesTopN).map((row, index) => ({
      ...row, rank:index + 1, average:row.transactions ? row.total / row.transactions : 0
    }));
}

function renderSalesReport() {
  const rows = salesFilters(REPORT_DATA.sales.filter(inReportRange));
  const revenue = sum(rows, 'totalRevenue');
  const units = sum(rows, 'unitsSold');
  const profit = sum(rows, 'grossProfit');
  const flagged = rows.filter(row => salesFlag(row) !== 'Normal');
  const categories = [...new Set(REPORT_DATA.sales.map(row => row.category).filter(Boolean))].sort();
  document.getElementById('report-extra-filters').innerHTML = `
    <select class="form-select" id="report-sales-category" onchange="setReportSalesCategory(this.value)">
      <option value="">All Categories</option>${categories.map(v => `<option${v === reportSalesCategory ? ' selected' : ''}>${escReport(v)}</option>`).join('')}
    </select>
    <select class="form-select" id="report-sales-flag" onchange="setReportSalesFlag(this.value)">
      <option value="">All Flags</option><option${reportSalesFlag === 'Loss' ? ' selected' : ''}>Loss</option><option${reportSalesFlag === 'High Margin' ? ' selected' : ''}>High Margin</option><option${reportSalesFlag === 'Normal' ? ' selected' : ''}>Normal</option>
    </select>`;
  renderCards([
    { label:'Total Revenue', value:formatPeso(revenue), cls:'green' },
    { label:'Total Units Sold', value:units.toLocaleString() },
    { label:'Avg Margin %', value:`${revenue ? (profit / revenue * 100).toFixed(1) : '0.0'}%`, cls:'blue' },
    { label:'Flagged Items', value:flagged.length.toLocaleString(), cls:'red' },
  ]);
  const top = salesProductRanking(rows);
  renderTopNControl(salesTopN, 'products');
  renderTopNChart(top, `Top ${salesTopN} Products by Revenue`, '#3b82f6', salesTopN, 'sales');
  renderCategoryChart(rows, row => row.category || 'Uncategorized',
    row => Number(row.totalRevenue) || 0, 'Revenue by Category');
  renderRankingTable(`Top ${salesTopN} Products by Revenue`, 'sales', [
    { key:'rank', label:'Rank', numeric:true, render:row => row.rank },
    { key:'name', label:'Product Name', render:row => escReport(row.name) },
    { key:'itemCode', label:'Item Code', render:row => escReport(row.itemCode || '—') },
    { key:'category', label:'Category', render:row => escReport(row.category) },
    { key:'total', label:'Total Revenue', numeric:true, render:row => formatPeso(row.total) },
    { key:'units', label:'Units Sold', numeric:true, render:row => row.units.toLocaleString() },
    { key:'margin', label:'Avg Margin %', numeric:true,
      render:row => `${row.total ? (row.profit / row.total * 100).toFixed(1) : '0.0'}%` },
  ], top.map(row => ({ ...row, margin:row.total ? row.profit / row.total * 100 : 0 })));
  renderTable('secondary', 'Flagged Items', ['Date', 'Product', 'Margin', 'Flag'],
    flagged.map(row => `<tr><td>${formatDate(reportDate(row))}</td><td>${escReport(row.productName)}</td><td>${Number(row.margin || 0).toFixed(1)}%</td><td>${salesFlag(row)}</td></tr>`));
}

function renderPurchasesReport() {
  const rows = REPORT_DATA.purchases.filter(inReportRange).filter(row => !reportPurchaseSupplier || purchaseSupplier(row) === reportPurchaseSupplier);
  const suppliers = [...new Set(REPORT_DATA.purchases.map(purchaseSupplier).filter(Boolean))].sort();
  document.getElementById('report-extra-filters').innerHTML = `
    <select class="form-select" id="report-purchase-supplier" onchange="setReportPurchaseSupplier(this.value)">
      <option value="">All Suppliers</option>${suppliers.map(v => `<option${v === reportPurchaseSupplier ? ' selected' : ''}>${escReport(v)}</option>`).join('')}
    </select>`;
  const total = rows.reduce((value, row) => value + purchaseSpend(row), 0);
  const unique = new Set(rows.map(purchaseSupplier).filter(Boolean)).size;
  renderCards([
    { label:'Total Purchases', value:formatPeso(total), cls:'blue' },
    { label:'Total Suppliers', value:unique.toLocaleString() },
    { label:'Avg per Supplier', value:formatPeso(unique ? total / unique : 0) },
  ]);
  const top = purchasesSupplierRanking(rows);
  renderTopNControl(purchasesTopN, 'suppliers');
  renderTopNChart(top, `Top ${purchasesTopN} Suppliers by Total Spend`, '#7c3aed', purchasesTopN, 'purchases');
  renderCategoryChart(rows, row => row.category || purchaseSupplier(row),
    purchaseSpend, 'Purchases by Category');
  renderRankingTable(`Top ${purchasesTopN} Suppliers by Total Spend`, 'purchases', [
    { key:'rank', label:'Rank', numeric:true, render:row => row.rank },
    { key:'name', label:'Supplier', render:row => escReport(row.name) },
    { key:'total', label:'Total Purchases', numeric:true, render:row => formatPeso(row.total) },
    { key:'transactions', label:'No. of Transactions', numeric:true, render:row => row.transactions.toLocaleString() },
    { key:'average', label:'Avg per Transaction', numeric:true, render:row => formatPeso(row.average) },
  ], top);
  hideSecondaryTable();
}

function localReportISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function lastDayOfReportMonth(year, month) {
  return localReportISO(new Date(Number(year), Number(month), 0));
}

function filterTaxRange(rows, range) {
  return rows.filter(row => {
    const date = reportDate(row);
    return date && date >= range.from && date <= range.to;
  });
}

function taxPresetRange(preset) {
  const today = new Date();
  let start;
  let end;
  if (preset === 'last-month') {
    start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    end = new Date(today.getFullYear(), today.getMonth(), 0);
  } else if (preset === 'quarter') {
    start = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1);
    end = new Date(start.getFullYear(), start.getMonth() + 3, 0);
  } else if (preset === 'year') {
    start = new Date(today.getFullYear(), 0, 1);
    end = new Date(today.getFullYear(), 11, 31);
  } else {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
    end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  }
  return { from:localReportISO(start), to:localReportISO(end) };
}

function setTaxRangePreset(section, preset) {
  if (preset === 'custom') {
    document.getElementById(`tax-${section}-from`).focus();
    return;
  }
  taxRanges[section] = taxPresetRange(preset);
  renderTaxSummary();
}

function applyTaxRange(section) {
  withReportProgress('Applying tax range...', async () => {
    taxRanges[section] = {
      from:document.getElementById(`tax-${section}-from`).value,
      to:document.getElementById(`tax-${section}-to`).value
    };
    await waitReportFrame();
    renderTaxSummary();
  });
}

function taxRangeControls(section) {
  const range = taxRanges[section];
  return `${['month','last-month','quarter','year'].map(preset =>
    `<button class="btn btn-outline-gray btn-sm" type="button" onclick="setTaxRangePreset('${section}','${preset}')">${{
      month:'This Month', 'last-month':'Last Month', quarter:'This Quarter', year:'This Year'
    }[preset]}</button>`).join('')}
    <button class="btn btn-outline-gray btn-sm" type="button" onclick="setTaxRangePreset('${section}','custom')">Custom</button>
    <label>From <input class="form-input" type="date" id="tax-${section}-from" value="${range.from}"></label>
    <label>To <input class="form-input" type="date" id="tax-${section}-to" value="${range.to}"></label>
    <button class="btn btn-primary btn-sm" type="button" onclick="applyTaxRange('${section}')">Apply</button>`;
}

function getPeriodDates(periodType, periodValue) {
  if (periodType === 'monthly') {
    const [year, month] = periodValue.split('-');
    return { from:`${periodValue}-01`, to:lastDayOfReportMonth(year, month) };
  }
  if (periodType === 'quarterly') {
    const [year, quarter] = periodValue.split('-Q');
    return {
      from:`${year}-${String((Number(quarter) - 1) * 3 + 1).padStart(2, '0')}-01`,
      to:lastDayOfReportMonth(year, Number(quarter) * 3)
    };
  }
  return { from:`${periodValue}-01-01`, to:`${periodValue}-12-31` };
}

function taxIncomeOptions(type) {
  const currentYear = reportToday.getFullYear();
  const years = Array.from({ length:5 }, (_, index) => currentYear - 2 + index);
  if (type === 'monthly') return years.flatMap(year => Array.from({ length:12 }, (_, month) => {
    const value = `${year}-${String(month + 1).padStart(2, '0')}`;
    return [value, new Date(year, month, 1).toLocaleDateString('en-PH', { month:'long', year:'numeric' })];
  }));
  if (type === 'quarterly') return years.flatMap(year => [1,2,3,4].map(quarter => [`${year}-Q${quarter}`, `Q${quarter} ${year}`]));
  return years.map(year => [String(year), String(year)]);
}

function setTaxIncomePeriodType(value) {
  const year = reportToday.getFullYear();
  taxIncomePeriod.type = value;
  taxIncomePeriod.value = value === 'monthly' ? reportCurrentMonth
    : value === 'quarterly' ? `${year}-Q${Math.floor(reportToday.getMonth() / 3) + 1}` : String(year);
  renderTaxSummary();
}

function applyTaxIncomePeriod() {
  withReportProgress('Applying income tax period...', async () => {
    taxIncomePeriod.value = document.getElementById('tax-income-period-value').value;
    await waitReportFrame();
    renderTaxSummary();
  });
}

function taxCards(targetId, cards) {
  document.getElementById(targetId).innerHTML = cards.map(card => `<div class="summary-card">
    <div class="kpi-label">${card.label}</div><div class="kpi-value ${card.cls || ''}">${card.value}</div>
  </div>`).join('');
}

function replaceTaxChart(key, canvasId, config) {
  if (taxChartInstances[key]) taxChartInstances[key].destroy();
  if (typeof Chart === 'undefined') return;
  taxChartInstances[key] = new Chart(document.getElementById(canvasId), config);
}

function reportMonthsBetween(from, to) {
  const months = [];
  const cursor = new Date(`${from.slice(0, 7)}-01T00:00:00`);
  const last = to.slice(0, 7);
  while (localReportISO(cursor).slice(0, 7) <= last) {
    months.push(localReportISO(cursor).slice(0, 7));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

function reportMonthDisplay(month) {
  return new Date(`${month}-01T00:00:00`).toLocaleDateString('en-PH', { month:'short', year:'numeric' });
}

function purchaseInputVAT(row) {
  const explicit = row.inputVAT ?? row.vatAmount;
  if (explicit != null && explicit !== '') return Number(explicit) || 0;
  const gross = Number(row.grossAmount ?? row.totalAmount ?? 0) || 0;
  const net = purchaseSpend(row);
  return gross > net ? gross - net : 0;
}

function purchaseEWT(row) {
  return Number(row.ewtAmount ?? row.withholdingTax ?? 0) || 0;
}

function purchaseVATNonCreditable(row) {
  return row.inputVATCreditable === false ||
    row.vatCreditable === false ||
    row.isVATCreditable === false ||
    row.inputVATCreditable === 'no' ||
    row.vatCreditable === 'no';
}

function calculateIncomeTax(range) {
  const revenue = sum(filterTaxRange(REPORT_DATA.esales, range), 'grossSales');
  const cogs = filterTaxRange(REPORT_DATA.purchases, range).reduce((total, row) => total + purchaseSpend(row), 0);
  const expenses = sum(filterTaxRange(REPORT_DATA.expenses, range), 'amount');
  const supplies = filterTaxRange(REPORT_DATA.supplies, range).reduce((total, row) => total + (Number(row.totalCost ?? row.amount) || 0), 0);
  const grossProfit = revenue - cogs;
  const taxable = grossProfit - expenses - supplies;
  return { revenue, cogs, expenses, supplies, grossProfit, taxable, due:taxable > 0 ? taxable * .25 : 0 };
}

function renderTaxVATSection() {
  document.getElementById('tax-vat-controls').innerHTML = taxRangeControls('vat');
  const sales = filterTaxRange(REPORT_DATA.esales, taxRanges.vat);
  const purchases = filterTaxRange(REPORT_DATA.purchases, taxRanges.vat);
  const vatOutput = sum(sales, 'vatAmount');
  const vatInput = purchases
    .filter(row => !purchaseVATNonCreditable(row))
    .reduce((total, row) => total + purchaseInputVAT(row), 0);
  const difference = vatOutput - vatInput;
  taxLiabilityState.vatPayable = Math.max(0, difference);
  taxCards('tax-vat-summary', [
    { label:'VAT Output', value:formatPeso(vatOutput), cls:'red' },
    { label:'VAT Input', value:formatPeso(vatInput), cls:'blue' },
    { label:difference < 0 ? 'VAT Creditable' : 'VAT Payable', value:formatPeso(Math.abs(difference)), cls:difference < 0 ? 'green' : 'red' },
  ]);
  replaceTaxChart('vatClassification', 'tax-vat-classification-chart', {
    type:'doughnut', data:{ labels:['VATable Sales','VAT Exempt','Zero Rated'], datasets:[{
      data:[sum(sales,'vatableSales'),sum(sales,'vatExempt'),sum(sales,'zeroRated')],
      backgroundColor:['#3b82f6','#d97706','#16a34a'], borderColor:'#fff', borderWidth:2
    }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{ title:{ display:true,text:'Sales Classification' } } }
  });
  const months = reportMonthsBetween(taxRanges.vat.from, taxRanges.vat.to);
  replaceTaxChart('vatTrend', 'tax-vat-trend-chart', {
    type:'bar', data:{ labels:months.map(reportMonthDisplay), datasets:[{ label:'VAT Output', data:months.map(month => sum(sales.filter(row => reportDate(row).startsWith(month)),'vatAmount')), backgroundColor:'#dc2626' }] },
    options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } }, plugins:{ title:{ display:true,text:'VAT Output Trend by Month' } } }
  });
}

function ewtMonthlyRows() {
  const purchases = filterTaxRange(REPORT_DATA.purchases, taxRanges.ewt);
  return reportMonthsBetween(taxRanges.ewt.from, taxRanges.ewt.to).map(month => {
    const rows = purchases.filter(row => reportDate(row).startsWith(month));
    const totalPurchases = rows.reduce((total, row) => total + purchaseSpend(row), 0);
    const ewt = rows.reduce((total, row) => total + purchaseEWT(row), 0);
    const stored = REPORT_DATA.ewtRemittances.find(row => row._firestoreId === month);
    return { month, totalPurchases, ewt, rate:totalPurchases ? ewt / totalPurchases * 100 : 0, status:stored?.status || 'due' };
  });
}

async function toggleEwtRemittance(month) {
  const row = REPORT_DATA.ewtRemittances.find(item => item._firestoreId === month);
  const status = row?.status === 'remitted' ? 'due' : 'remitted';
  const ewtAmount = ewtMonthlyRows().find(item => item.month === month)?.ewt || 0;
  await getFirestoreDB().collection('ewtRemittances').doc(month).set({ month, ewtAmount, status }, { merge:true });
  if (row) row.status = status; else REPORT_DATA.ewtRemittances.push({ _firestoreId:month, month, ewtAmount, status });
  renderTaxSummary();
}

function renderTaxEWTSection() {
  document.getElementById('tax-ewt-controls').innerHTML = taxRangeControls('ewt');
  const purchases = filterTaxRange(REPORT_DATA.purchases, taxRanges.ewt);
  const months = ewtMonthlyRows();
  const totalPurchases = purchases.reduce((total,row) => total + purchaseSpend(row), 0);
  const ewt = purchases.reduce((total,row) => total + purchaseEWT(row), 0);
  taxLiabilityState.ewt = months.filter(row => row.status !== 'remitted').reduce((total, row) => total + row.ewt, 0);
  taxCards('tax-ewt-summary', [
    { label:'Total EWT Withheld', value:formatPeso(ewt), cls:'red' },
    { label:'Total Suppliers with EWT', value:new Set(purchases.filter(row => purchaseEWT(row)).map(purchaseSupplier)).size.toLocaleString() },
    { label:'Avg EWT Rate %', value:`${totalPurchases ? (ewt / totalPurchases * 100).toFixed(2) : '0.00'}%` },
  ]);
  document.getElementById('tax-ewt-remittance-body').innerHTML = months.map(row => `<tr>
    <td>${escReport(reportMonthDisplay(row.month))}</td><td class="mono">${formatPeso(row.totalPurchases)}</td><td>${row.rate.toFixed(2)}%</td>
    <td class="mono">${formatPeso(row.ewt)}</td><td><button class="tax-remittance-toggle ${row.status}" onclick="toggleEwtRemittance('${row.month}')">${row.status === 'remitted' ? 'Remitted' : 'Due'}</button></td>
  </tr>`).join('');
  replaceTaxChart('ewtMonthly', 'tax-ewt-monthly-chart', {
    type:'bar', data:{ labels:months.map(row => reportMonthDisplay(row.month)), datasets:[{ label:'EWT Withheld', data:months.map(row => row.ewt), backgroundColor:'#d97706' }] },
    options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } }, plugins:{ title:{ display:true,text:'Monthly EWT Withheld' } } }
  });
  const suppliers = taxEwtSupplierSummary(purchases).slice(0, 8);
  replaceTaxChart('ewtSuppliers', 'tax-ewt-suppliers-chart', {
    type:'doughnut', data:{ labels:suppliers.map(row => row.supplier), datasets:[{ data:suppliers.map(row => row.ewt), backgroundColor:['#3b82f6','#16a34a','#d97706','#dc2626','#7c3aed','#0891b2','#db2777','#65a30d'] }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ title:{ display:true,text:'Top Suppliers by EWT' } } }
  });
}

function renderTaxIncomeSection() {
  const options = taxIncomeOptions(taxIncomePeriod.type);
  document.getElementById('tax-income-controls').innerHTML = `
    <label>Period type <select class="form-select" onchange="setTaxIncomePeriodType(this.value)">
      ${['monthly','quarterly','annual'].map(type => `<option value="${type}"${taxIncomePeriod.type === type ? ' selected' : ''}>${type[0].toUpperCase() + type.slice(1)}</option>`).join('')}
    </select></label>
    <label>Period <select class="form-select" id="tax-income-period-value">${options.map(([value,label]) => `<option value="${value}"${taxIncomePeriod.value === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
    <button class="btn btn-primary btn-sm" type="button" onclick="applyTaxIncomePeriod()">Apply</button>`;
  const range = getPeriodDates(taxIncomePeriod.type, taxIncomePeriod.value);
  const result = calculateIncomeTax(range);
  taxLiabilityState.incomeTaxStillDue = result.due;
  taxCards('tax-income-summary', [
    { label:'Income Tax Due', value:formatPeso(result.due), cls:'red' },
    { label:'Tax Still Due', value:formatPeso(result.due), cls:'red' },
  ]);
  document.getElementById('tax-income-computation-body').innerHTML = [
    statementRow('Gross Income (E-Sales)', result.revenue), statementRow('Less: COGS (Purchases)', result.cogs, true),
    '<tr class="statement-rule"><td colspan="2"></td></tr>', statementRow('Gross Profit', result.grossProfit, false, 'subtotal'),
    statementRow('Less: General Expenses', result.expenses, true), statementRow('Less: Supplies Expense', result.supplies, true),
    '<tr class="statement-rule"><td colspan="2"></td></tr>', statementRow('Net Taxable Income', result.taxable, false, 'subtotal', true),
    '<tr><td>× Tax Rate</td><td class="mono">25%</td></tr>', statementRow('Income Tax Due', result.due, false, 'subtotal'),
    '<tr class="statement-rule"><td colspan="2"></td></tr>',
    statementRow('TAX STILL DUE', result.due, false, 'net-income', true)
  ].join('');
  const year = Number(taxIncomePeriod.value.slice(0, 4));
  const trendPeriods = taxIncomePeriod.type === 'quarterly'
    ? [1,2,3,4].map(q => [`Q${q}`, getPeriodDates('quarterly', `${year}-Q${q}`)])
    : Array.from({ length:12 }, (_, month) => {
      const value = `${year}-${String(month + 1).padStart(2,'0')}`;
      return [new Date(year,month,1).toLocaleDateString('en-PH',{month:'short'}), getPeriodDates('monthly',value)];
    });
  replaceTaxChart('incomeTrend', 'tax-income-trend-chart', {
    type:'line', data:{ labels:trendPeriods.map(row => row[0]), datasets:[{ label:'Income Tax Due', data:trendPeriods.map(row => calculateIncomeTax(row[1]).due), borderColor:'#7c3aed', backgroundColor:'#7c3aed', tension:.25 }] },
    options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } }, plugins:{ title:{ display:true,text:`Income Tax Due Trend for ${year}` } } }
  });
}

function renderTaxLiabilitySummary() {
  const total = taxLiabilityState.vatPayable + taxLiabilityState.ewt + taxLiabilityState.incomeTaxStillDue;
  document.getElementById('tax-liability-period-note').textContent =
    `VAT ${taxRanges.vat.from} to ${taxRanges.vat.to} · EWT ${taxRanges.ewt.from} to ${taxRanges.ewt.to} · Income Tax ${taxIncomePeriod.value}`;
  document.getElementById('tax-dedicated-liability-body').innerHTML = `
    <div class="tax-liability-row"><span>VAT Payable</span><strong>${formatPeso(taxLiabilityState.vatPayable)}</strong></div>
    <div class="tax-liability-row"><span>EWT to Remit (current period)</span><strong>${formatPeso(taxLiabilityState.ewt)}</strong></div>
    <div class="tax-liability-row"><span>Income Tax Still Due</span><strong>${formatPeso(taxLiabilityState.incomeTaxStillDue)}</strong></div>
    <div class="tax-liability-row tax-liability-total"><span>TOTAL TAX LIABILITY</span><span>${formatPeso(total)}</span></div>`;
}

function renderTaxSummary() {
  renderTaxVATSection();
  renderTaxEWTSection();
  renderTaxIncomeSection();
  renderTaxLiabilitySummary();
}

function taxEwtSupplierSummary(purchases) {
  const suppliers = new Map();
  purchases.forEach(row => {
    const supplier = purchaseSupplier(row);
    const current = suppliers.get(supplier) || { supplier, ewt:0, gross:0, rates:new Set() };
    current.ewt += purchaseEWT(row);
    current.gross += purchaseGrossAmount(row);
    const rate = Number(row.ewtRate ?? row.taxRate);
    if (Number.isFinite(rate)) current.rates.add(rate);
    suppliers.set(supplier, current);
  });
  return [...suppliers.values()].sort((a, b) => b.ewt - a.ewt).map(row => ({
    ...row, rate:row.rates.size ? [...row.rates].map(rate => `${rate}%`).join(', ') : '—'
  }));
}

function renderInventoryReport() {
  const incoming = REPORT_DATA.inventory.filter(inReportRange)
    .filter(row => String(row.type || 'Incoming').toLowerCase() === 'incoming');
  const value = incoming.reduce((total, row) => total + Number(row.total ?? row.totalCost ?? 0), 0);
  const quantity = incoming.reduce((total, row) => total + Number(row.quantity ?? row.qty ?? 0), 0);
  const unique = new Set(incoming.map(row => row.itemCode).filter(Boolean)).size;
  renderCards([
    { label:'Total Incoming Value', value:formatPeso(value), cls:'green' },
    { label:'Total Items Received', value:quantity.toLocaleString() },
    { label:'Unique Products', value:unique.toLocaleString() },
  ]);
  const outgoing = REPORT_DATA.inventory.filter(inReportRange)
    .filter(row => String(row.type || 'Incoming').toLowerCase() === 'outgoing');
  const totalIncomingUnits = incoming.reduce((total, row) => total + (Number(row.quantity ?? row.qty ?? 0) || 0), 0);
  const totalOutgoingUnits = outgoing.reduce((total, row) => total + (Number(row.quantity ?? row.qty ?? 0) || 0), 0);
  const totalUnits = totalIncomingUnits + totalOutgoingUnits;
  const invCard = document.getElementById('report-chart-card');
  if (totalUnits === 0 || typeof Chart === 'undefined') {
    invCard.style.display = 'none';
  } else {
    invCard.style.display = '';
    if (reportChart) {
      if (reportChart === purchasesBarChart) purchasesBarChart = null;
      reportChart.destroy();
    }
    const inPct = (totalIncomingUnits / totalUnits * 100).toFixed(1);
    const outPct = (totalOutgoingUnits / totalUnits * 100).toFixed(1);
    reportChart = new Chart(document.getElementById('report-chart'), {
      type: 'pie',
      data: {
        labels: [
          `Total Incoming Units: ${totalIncomingUnits.toLocaleString()} (${inPct}%)`,
          `Total Outgoing Units: ${totalOutgoingUnits.toLocaleString()} (${outPct}%)`
        ],
        datasets: [{ data: [totalIncomingUnits, totalOutgoingUnits],
          backgroundColor: ['#16a34a', '#dc2626'], borderColor: '#ffffff', borderWidth: 2 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          title: { display: true, text: 'Total Incoming vs Outgoing Units', font: { size: 13, weight: '500' } },
          legend: { position: 'bottom', labels: { font: { size: 12 }, padding: 16 } },
          tooltip: { callbacks: { label: context => {
            const pct = (context.parsed / totalUnits * 100).toFixed(1);
            return ` ${context.label.split(':')[0]}: ${context.parsed.toLocaleString()} units (${pct}%)`;
          } } }
        }
      }
    });
  }
  renderInventoryMovementTable();
  hideSecondaryTable();
}

function reportInventoryProduct(itemCode) {
  const code = String(itemCode || '').trim();
  return REPORT_DATA.productMaster.find(product =>
    String(product.itemCode || product.code || '').trim() === code);
}

function reportInventoryDescription(itemCode, fallback = '') {
  const product = reportInventoryProduct(itemCode);
  return String(product?.productName || product?.name || fallback || '').trim();
}

function reportInventoryCategory(itemCode) {
  return String(reportInventoryProduct(itemCode)?.category || '').trim() || 'Uncategorized';
}

function inventoryMovementRows() {
  const products = new Map();
  const fullIncomingByCode = new Map();
  REPORT_DATA.inventory.forEach(row => {
    const itemCode = String(row.itemCode || '').trim();
    if (!itemCode || String(row.type || 'Incoming').toLowerCase() === 'outgoing') return;
    fullIncomingByCode.set(itemCode, (fullIncomingByCode.get(itemCode) || 0) + (Number(row.quantity ?? row.qty ?? 0) || 0));
  });
  REPORT_DATA.inventory.filter(inReportRange).forEach(row => {
    const itemCode = String(row.itemCode || '').trim();
    if (!itemCode) return;
    const date = reportDate(row);
    const current = products.get(itemCode) || {
      itemCode, description:reportInventoryDescription(itemCode, row.description || row.itemName || row.productName || ''),
      category:reportInventoryCategory(itemCode), supplier:row.supplier || '',
      unitCost:0, latestCostDate:'', totalIncoming:0, totalOutgoing:0, incomingValue:0, outgoingValue:0
    };
    const qty = Number(row.quantity ?? row.qty ?? 0) || 0;
    const cost = Number(row.unitCost ?? row.cost ?? 0) || 0;
    if (String(row.type || 'Incoming').toLowerCase() === 'outgoing') {
      current.totalOutgoing += qty;
      current.outgoingValue += Number(row.totalCost ?? row.total ?? qty * cost) || 0;
    } else {
      current.totalIncoming += qty;
      current.incomingValue += Number(row.totalCost ?? row.total ?? qty * cost) || 0;
      if (!current.latestCostDate || date >= current.latestCostDate) {
        current.unitCost = cost;
        current.latestCostDate = date;
      }
    }
    products.set(itemCode, current);
  });
  return [...products.values()].map(row => ({
    ...row, netStock:row.totalIncoming - row.totalOutgoing,
    outgoingPct:row.totalIncoming ? row.totalOutgoing / row.totalIncoming * 100 : 0,
    incomingOutsideRange:row.totalIncoming === 0 && row.totalOutgoing > 0 && (fullIncomingByCode.get(row.itemCode) || 0) > 0
  }));
}

function inventoryMovementHistory(itemCode) {
  return REPORT_DATA.inventory
    .filter(row => String(row.itemCode || '').trim() === String(itemCode || '').trim())
    .sort((a, b) => reportDate(b).localeCompare(reportDate(a)));
}

function inventoryRangeDateLabel(value) {
  if (!value) return 'Any date';
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function inventoryHistoryList(rows) {
  return rows.length ? rows.map(row => `
    <div class="inventory-history-row">
      <span>${escReport(inventoryRangeDateLabel(reportDate(row)))}</span>
      <strong>${(Number(row.quantity ?? row.qty ?? 0) || 0).toLocaleString()} units</strong>
    </div>`).join('') : '<div class="inventory-history-empty">No records found.</div>';
}

function openInventoryMovementDetail(itemCode) {
  const row = inventoryMovementRows().find(item => item.itemCode === String(itemCode || '').trim());
  if (!row) return;
  const history = inventoryMovementHistory(row.itemCode);
  const incomingHistory = history.filter(item => String(item.type || 'Incoming').toLowerCase() !== 'outgoing');
  const outgoingHistory = history.filter(item => String(item.type || '').toLowerCase() === 'outgoing');
  const start = inventoryRangeDateLabel(document.getElementById('report-start').value);
  const end = inventoryRangeDateLabel(document.getElementById('report-end').value);
  document.getElementById('inventory-detail-title').textContent =
    `${row.description || row.itemCode}: Inventory Movement`;
  document.getElementById('inventory-detail-body').innerHTML = `
    <div class="inventory-detail-scope">
      <h4>In selected range (${escReport(start)} - ${escReport(end)})</h4>
      <p><strong>Incoming:</strong> ${row.totalIncoming.toLocaleString()} units / <strong>Outgoing:</strong> ${row.totalOutgoing.toLocaleString()} units</p>
      ${row.incomingOutsideRange ? '<div class="inventory-detail-note">ⓘ Incoming stock exists for this item, but it was received outside the selected date range.</div>' : ''}
    </div>
    <div class="inventory-history-section">
      <h4>Full movement history (all dates)</h4>
      <div class="inventory-history-grid">
        <div class="inventory-history-card"><h5>Incoming</h5><div class="inventory-history-list">${inventoryHistoryList(incomingHistory)}</div></div>
        <div class="inventory-history-card"><h5>Outgoing</h5><div class="inventory-history-list">${inventoryHistoryList(outgoingHistory)}</div></div>
      </div>
    </div>`;
  openModal('modal-inventory-movement-detail');
}

function inventoryMovementFlag(outgoingPct) {
  if (outgoingPct >= inventoryMovementState.highThreshold) return 'high';
  if (outgoingPct <= inventoryMovementState.lowThreshold) return 'low';
  return 'normal';
}

function inventoryRangeMatch(value, range) {
  const number = Number(value) || 0;
  return (range.min === '' || number >= Number(range.min)) && (range.max === '' || number <= Number(range.max));
}

function filteredInventoryMovementRows() {
  const state = inventoryMovementState;
  const filters = state.filters;
  const text = value => String(value || '').toLowerCase();
  const query = state.search.trim().toLowerCase();
  return inventoryMovementRows()
    .filter(row => !query || text(row.itemCode).includes(query) || text(row.description).includes(query))
    .filter(row => !filters.itemCode || text(row.itemCode).includes(text(filters.itemCode)))
    .filter(row => !filters.description || text(row.description).includes(text(filters.description)))
    .filter(row => !filters.category || row.category === filters.category)
    .filter(row => !filters.supplier || text(row.supplier).includes(text(filters.supplier)))
    .filter(row => ['unitCost','totalIncoming','incomingValue','totalOutgoing','outgoingValue','netStock','outgoingPct']
      .every(key => inventoryRangeMatch(row[key], filters[key])))
    .filter(row => state.flag === 'all' || inventoryMovementFlag(row.outgoingPct) === state.flag)
    .sort((a,b) => {
      const left = a[state.sortKey], right = b[state.sortKey];
      const result = typeof left === 'number' && typeof right === 'number'
        ? left - right : String(left || '').localeCompare(String(right || ''));
      return result * (state.sortDir === 'asc' ? 1 : -1);
    });
}

function setInventoryMovementState(key, value) {
  inventoryMovementState[key] = value;
  inventoryMovementState.page = 1;
  renderInventoryMovementTable();
}

function setInventoryMovementFilter(key, value, part = '') {
  if (part) inventoryMovementState.filters[key][part] = value;
  else inventoryMovementState.filters[key] = value;
  inventoryMovementState.page = 1;
  renderInventoryMovementTable();
}

function applyInventoryThresholds() {
  inventoryMovementState.highThreshold = Number(document.getElementById('inventory-high-threshold').value) || 75;
  inventoryMovementState.lowThreshold = Number(document.getElementById('inventory-low-threshold').value) || 25;
  inventoryMovementState.page = 1;
  logAudit('Settings', 'Inventory Report Thresholds',
    `Updated outgoing thresholds - high ${inventoryMovementState.highThreshold}%, low ${inventoryMovementState.lowThreshold}%`);
  renderInventoryMovementTable();
}

function sortInventoryMovement(key) {
  inventoryMovementState.sortDir = inventoryMovementState.sortKey === key && inventoryMovementState.sortDir === 'desc' ? 'asc' : 'desc';
  inventoryMovementState.sortKey = key;
  inventoryMovementState.page = 1;
  renderInventoryMovementTable();
}

function goToInventoryMovementPage(page) {
  inventoryMovementState.page = page;
  renderInventoryMovementTable();
}

function inventoryNumberFilter(key) {
  const range = inventoryMovementState.filters[key];
  return `<div class="inventory-num-filter"><input class="form-input" type="number" placeholder="Min" value="${range.min}" onchange="setInventoryMovementFilter('${key}',this.value,'min')"><input class="form-input" type="number" placeholder="Max" value="${range.max}" onchange="setInventoryMovementFilter('${key}',this.value,'max')"></div>`;
}

function syncCustomHorizontalScroll() {
  const topScroll = document.getElementById('custom-horizontal-scroll');
  const topContent = document.getElementById('custom-horizontal-scroll-content');
  const chartScroll = document.getElementById('sales-bar-container');
  const chart = document.getElementById('report-chart');
  if (!topScroll || !topContent || !chartScroll || !chart) return;
  topContent.style.width = `${Math.max(chart.scrollWidth, 1200)}px`;
  topScroll.scrollLeft = chartScroll.scrollLeft;
  topScroll.onscroll = () => {
    if (chartScroll.scrollLeft !== topScroll.scrollLeft) chartScroll.scrollLeft = topScroll.scrollLeft;
  };
  chartScroll.onscroll = () => {
    if (topScroll.scrollLeft !== chartScroll.scrollLeft) topScroll.scrollLeft = chartScroll.scrollLeft;
  };
}

function renderInventoryMovementTable() {
  const state = inventoryMovementState;
  const categories = [...new Set(inventoryMovementRows().map(row => row.category).filter(Boolean))].sort();
  document.getElementById('report-primary-title').textContent = 'Inventory Movement Analysis';
  document.getElementById('inventory-movement-controls').innerHTML = `<div class="inventory-controls-grid inventory-controls-row">
    <label>Date Range <span>${document.getElementById('report-start').value || '—'} to ${document.getElementById('report-end').value || '—'}</span></label>
    <label>High outgoing % <input class="form-input" id="inventory-high-threshold" type="number" value="${state.highThreshold}"></label>
    <label>Low outgoing % <input class="form-input" id="inventory-low-threshold" type="number" value="${state.lowThreshold}"></label>
    <button class="btn btn-primary btn-sm" onclick="applyInventoryThresholds()">Apply Threshold</button>
    <label>Search <input class="form-input inventory-search" placeholder="Search item code or name..." value="${escReport(state.search)}" onchange="setInventoryMovementState('search',this.value)"></label>
    <label>Filter by flag <select class="form-select" onchange="setInventoryMovementState('flag',this.value)">${['all','high','low','normal'].map(value => `<option value="${value}"${state.flag === value ? ' selected' : ''}>${{all:'All',high:'High',low:'Low',normal:'Normal'}[value]}</option>`).join('')}</select></label>
    <label>Sort by <select class="form-select" onchange="setInventoryMovementState('sortKey',this.value)">${[
      ['outgoingPct','Outgoing %'],['incomingValue','Total Incoming (₱)'],['totalIncoming','Incoming Units'],['totalOutgoing','Outgoing Units'],['outgoingValue','Outgoing Value (₱)']
    ].map(([value,label]) => `<option value="${value}"${state.sortKey === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
    <label>Direction <select class="form-select" onchange="setInventoryMovementState('sortDir',this.value)"><option value="desc"${state.sortDir === 'desc' ? ' selected' : ''}>↓ Desc</option><option value="asc"${state.sortDir === 'asc' ? ' selected' : ''}>↑ Asc</option></select></label>
  </div>`;
  const columns = [
    ['itemCode','Item Code'],['description','Description'],['category','Category'],['incomingValue','Total Incoming (₱)'],['totalIncoming','Incoming Units'],
    ['totalOutgoing','Outgoing Units'],['outgoingValue','Outgoing Value (₱)'],['outgoingPct','Outgoing %'],['flag','Flag']
  ];
  document.getElementById('report-primary-head').innerHTML = `<tr>${columns.map(([key,label]) => `<th${key === 'flag' ? '' : ` class="sortable" onclick="sortInventoryMovement('${key}')"`}>${label}${state.sortKey === key ? (state.sortDir === 'asc' ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr>
    <tr class="inventory-filter-row">
      <th><input class="form-input" placeholder="Filter..." value="${escReport(state.filters.itemCode)}" onchange="setInventoryMovementFilter('itemCode',this.value)"></th>
      <th><input class="form-input" placeholder="Filter..." value="${escReport(state.filters.description)}" onchange="setInventoryMovementFilter('description',this.value)"></th>
      <th><select class="form-select" onchange="setInventoryMovementFilter('category',this.value)"><option value="">All</option>${categories.map(category => `<option${state.filters.category === category ? ' selected' : ''}>${escReport(category)}</option>`).join('')}</select></th>
      ${['incomingValue','totalIncoming','totalOutgoing','outgoingValue','outgoingPct'].map(key => `<th>${inventoryNumberFilter(key)}</th>`).join('')}
      <th><select class="form-select" onchange="setInventoryMovementState('flag',this.value)">${['all','high','low','normal'].map(value => `<option value="${value}"${state.flag === value ? ' selected' : ''}>${{all:'All',high:'High',low:'Low',normal:'Normal'}[value]}</option>`).join('')}</select></th>
    </tr>`;
  const rows = filteredInventoryMovementRows();
  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  if (state.page > pages) state.page = pages;
  const visible = rows.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
  document.getElementById('report-primary-body').innerHTML = visible.length ? visible.map(row => {
    const flag = inventoryMovementFlag(row.outgoingPct);
    return `<tr class="inventory-movement-row ${flag === 'high' ? 'inventory-row-high' : flag === 'low' ? 'inventory-row-low' : ''}" data-item-code="${escReport(row.itemCode)}" onclick="openInventoryMovementDetail(this.dataset.itemCode)">
      <td>${escReport(row.itemCode)}</td><td>${escReport(row.description)}${row.incomingOutsideRange ? '<span class="inventory-range-note">ⓘ Incoming exists outside this date range</span>' : ''}</td><td>${escReport(row.category)}</td>
      <td class="mono">${formatPeso(row.incomingValue)}</td><td class="mono">${row.totalIncoming.toLocaleString()}</td>
      <td class="mono">${row.totalOutgoing.toLocaleString()}</td><td class="mono">${formatPeso(row.outgoingValue)}</td>
      <td class="mono">${row.outgoingPct.toFixed(1)}%</td><td>${flag === 'normal' ? '' : `<span class="inventory-flag ${flag}">${flag === 'high' ? '🟡 High' : '🔵 Low'}</span>`}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="9"><div class="empty-state"><p>No inventory products match the selected filters.</p></div></td></tr>';
  const start = rows.length ? (state.page - 1) * state.pageSize + 1 : 0;
  document.getElementById('inventory-movement-pagination')?.remove();
  document.getElementById('report-primary-card').insertAdjacentHTML('beforeend', `<div class="inventory-pagination" id="inventory-movement-pagination">
    <span>Showing ${start}–${Math.min(state.page * state.pageSize, rows.length)} of ${rows.length} products</span>
    <button class="btn btn-outline-gray btn-sm" ${state.page === 1 ? 'disabled' : ''} onclick="goToInventoryMovementPage(${state.page - 1})">Prev</button>
    <span>Page ${state.page} / ${pages}</span>
    <button class="btn btn-outline-gray btn-sm" ${state.page === pages ? 'disabled' : ''} onclick="goToInventoryMovementPage(${state.page + 1})">Next</button>
  </div>`);
}

function customSourceRows() {
  const key = (CUSTOM_SOURCE_CONFIG[customState.source] || CUSTOM_SOURCE_CONFIG.sales).key;
  return (REPORT_DATA[key] || []).filter(inReportRange);
}

function customGroupLabel(row, groupBy) {
  const date = reportDate(row);
  if (groupBy === 'day') return date || 'Unknown';
  if (groupBy === 'week') {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() - d.getDay());
    return d.toISOString().slice(0, 10);
  }
  if (groupBy === 'category') {
    if (row.category) return row.category;
    return (row.itemCode ? reportInventoryCategory(row.itemCode) : '') || 'Uncategorized';
  }
  if (groupBy === 'supplier') return row.supplier || purchaseSupplier(row) || 'Unknown';
  return (date || '').slice(0, 7) || 'Unknown';
}

function customRowValue(source, measure, row) {
  if (measure === 'count') return 1;
  if (measure === 'units') {
    if (source === 'sales') return Number(row.unitsSold) || 0;
    if (source === 'esales') return Number(row.unitsSold ?? row.qty ?? row.quantity) || 0;
    if (source === 'inventory') return Number(row.quantity ?? row.qty) || 0;
    return 1;
  }
  if (source === 'sales') return Number(row.totalRevenue) || 0;
  if (source === 'esales') return Number(row.grossSales ?? row.totalRevenue) || 0;
  if (source === 'purchases') return purchaseSpend(row);
  if (source === 'expenses') return Number(row.amount) || 0;
  return Number(row.total ?? row.totalCost) || 0;
}

function saveCustomState() {
  localStorage.setItem('customReportState', JSON.stringify(customState));
}

function customMeasureLabel() {
  const cfg = CUSTOM_SOURCE_CONFIG[customState.source] || CUSTOM_SOURCE_CONFIG.sales;
  return cfg.measures.find(m => m.value === customState.measure)?.label || 'Total Value (₱)';
}

function renderCustomSourceControls() {
  const cfg = CUSTOM_SOURCE_CONFIG[customState.source] || CUSTOM_SOURCE_CONFIG.sales;
  if (!cfg.measures.find(m => m.value === customState.measure)) customState.measure = 'value';
  if (!cfg.dimensions.find(d => d.value === customState.groupBy)) customState.groupBy = 'month';
  const mel = document.getElementById('custom-measure');
  const gel = document.getElementById('custom-group-by');
  if (mel) mel.innerHTML = cfg.measures.map(m =>
    `<option value="${m.value}"${m.value === customState.measure ? ' selected' : ''}>${m.label}</option>`).join('');
  if (gel) gel.innerHTML = cfg.dimensions.map(d =>
    `<option value="${d.value}"${d.value === customState.groupBy ? ' selected' : ''}>${d.label}</option>`).join('');
}

function renderCustomChartOptions() {
  const { chartType, barOrientation, pieTopN, groupBy } = customState;
  const el = document.getElementById('custom-chart-options');
  if (!el) return;
  if (chartType === 'bar') {
    const axisHint = barOrientation === 'horizontal' ? 'X = Measure · Y = Dimension' : 'X = Dimension · Y = Measure';
    el.innerHTML = `<div class="custom-chart-option-row">
      <label class="custom-option-label">Orientation
        <select class="form-select" id="custom-bar-orientation"
          onchange="customState.barOrientation=this.value;saveCustomState();document.getElementById('custom-axis-hint').textContent=this.value==='horizontal'?'X = Measure · Y = Dimension':'X = Dimension · Y = Measure'">
          <option value="vertical"${barOrientation === 'vertical' ? ' selected' : ''}>Vertical (columns)</option>
          <option value="horizontal"${barOrientation === 'horizontal' ? ' selected' : ''}>Horizontal (bars)</option>
        </select>
      </label>
      <span class="custom-axis-hint" id="custom-axis-hint">${axisHint}</span>
    </div>`;
  } else if (chartType === 'line' || chartType === 'area') {
    const isTime = ['day', 'week', 'month'].includes(groupBy);
    el.innerHTML = `<div class="custom-chart-option-row">
      <span class="custom-axis-hint">X = Dimension · Y = Measure</span>
      ${!isTime ? '<span class="custom-chart-hint">Line charts read best with a time dimension (Day / Week / Month)</span>' : ''}
    </div>`;
  } else if (chartType === 'pie' || chartType === 'doughnut') {
    el.innerHTML = `<div class="custom-chart-option-row">
      <label class="custom-option-label">Show top N slices
        <input class="form-input" id="custom-pie-top-n" type="number" min="2" max="50" value="${pieTopN}"
          onchange="customState.pieTopN=Math.max(2,Number(this.value)||8);saveCustomState()">
      </label>
      <span class="custom-chart-hint">Remaining slices grouped into "Other"</span>
    </div>`;
  } else {
    el.innerHTML = '';
  }
}

function onCustomSourceChange() {
  customState.source = document.getElementById('custom-source').value;
  renderCustomSourceControls();
  renderCustomChartOptions();
  saveCustomState();
}

function onCustomChartTypeChange() {
  customState.chartType = document.getElementById('custom-chart-type').value;
  renderCustomChartOptions();
  saveCustomState();
}

function onCustomDimensionChange() {
  customState.groupBy = document.getElementById('custom-group-by').value;
  if (customState.chartType === 'line' || customState.chartType === 'area') renderCustomChartOptions();
  saveCustomState();
}

function renderCustomReport() {
  document.getElementById('custom-report-controls').style.display = '';
  const sourceEl = document.getElementById('custom-source');
  const chartTypeEl = document.getElementById('custom-chart-type');
  if (sourceEl) sourceEl.value = customState.source;
  if (chartTypeEl) chartTypeEl.value = customState.chartType;
  renderCustomSourceControls();
  renderCustomChartOptions();
  const { source, measure, groupBy, chartType, barOrientation, pieTopN } = customState;
  const values = grouped(customSourceRows(), row => customGroupLabel(row, groupBy),
    row => customRowValue(source, measure, row));
  customExportRows = values.map(([group, value]) => ({ group, value }));
  const measureLabel = customMeasureLabel();
  const isPeso = measure === 'value';
  const total = values.reduce((s, x) => s + x[1], 0);
  renderCards([
    { label:'Groups', value:values.length.toLocaleString() },
    { label:`Total ${measureLabel}`, value:isPeso ? formatPeso(total) : total.toLocaleString(), cls:'blue' },
  ]);
  const card = document.getElementById('report-chart-card');
  if (!values.length || typeof Chart === 'undefined') {
    card.style.display = 'none';
  } else if (chartType === 'pie' || chartType === 'doughnut') {
    const sorted = [...values].sort((a, b) => b[1] - a[1]);
    const slices = sorted.slice(0, pieTopN);
    const otherSum = sorted.slice(pieTopN).reduce((s, x) => s + x[1], 0);
    if (otherSum > 0) slices.push(['Other', otherSum]);
    const pieTotal = slices.reduce((s, x) => s + x[1], 0);
    const palette = ['#3b82f6','#16a34a','#d97706','#dc2626','#7c3aed','#0891b2','#db2777','#65a30d','#6b7280','#f59e0b','#10b981','#ef4444'];
    card.style.display = '';
    if (reportChart) { if (reportChart === purchasesBarChart) purchasesBarChart = null; reportChart.destroy(); }
    reportChart = new Chart(document.getElementById('report-chart'), {
      type: chartType,
      data: {
        labels: slices.map(x => x[0]),
        datasets: [{ data:slices.map(x => x[1]), backgroundColor:palette.slice(0, slices.length), borderColor:'#fff', borderWidth:2 }]
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins: {
          legend:{ position:'right', labels:{ font:{ size:11 }, padding:12 } },
          title:{ display:true, text:`${measureLabel} by ${groupBy}`, font:{ size:13, weight:'500' } },
          tooltip:{ callbacks:{ label: ctx => {
            const pct = pieTotal ? (ctx.parsed / pieTotal * 100).toFixed(1) : '0.0';
            const fmt = isPeso
              ? `₱${ctx.parsed.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}`
              : ctx.parsed.toLocaleString();
            return ` ${ctx.label}: ${fmt} (${pct}%)`;
          } } }
        }
      }
    });
  } else {
    const isHorizontal = chartType === 'bar' && barOrientation === 'horizontal';
    const pesoTick = { callback: v => `₱${(v / 1000).toFixed(0)}k` };
    const scales = isHorizontal
      ? { x:{ beginAtZero:true, ...(isPeso ? { ticks:pesoTick } : {}) } }
      : (isPeso ? { y:{ beginAtZero:true, ticks:pesoTick } } : null);
    drawChart(chartType, values.map(x => x[0]), values.map(x => x[1]), measureLabel, '#2563eb', {
      indexAxis: isHorizontal ? 'y' : undefined,
      hideLegend: false, pesoTooltips: isPeso,
      forceZero: !scales, borderRadius: chartType === 'bar' ? 4 : 0,
      title: `${measureLabel} by ${groupBy}`,
      scales: scales || undefined,
    });
  }
  renderTable('primary', 'Custom Report Data', ['Group', measureLabel],
    values.map(([label, value]) => `<tr><td>${escReport(label)}</td><td class="mono">${isPeso ? formatPeso(value) : value.toLocaleString()}</td></tr>`));
  hideSecondaryTable();
  requestAnimationFrame(syncCustomHorizontalScroll);
}

// ─── Cash Flow Report ─────────────────────────────────────────────────────────
const CF_OVERRIDE_KEY = 'cfBeginOverride';

function cfComputedBeginBalance(from) {
  if (!from) return 0;
  const before = r => { const d = reportDate(r); return d && d < from; };
  const inflow  = REPORT_DATA.sales.filter(before).reduce((s,r) => s+(Number(r.totalRevenue)||0), 0);
  const purOut  = REPORT_DATA.purchases.filter(before).reduce((s,r) => s+purchaseSpend(r), 0);
  const supOut  = REPORT_DATA.supplies.filter(before).reduce((s,r) => s+(Number(r.totalCost??r.amount)||0), 0);
  return inflow - purOut - supOut;
}

function cfEarliestDate(from) {
  if (!from) return null;
  const dates = [
    ...REPORT_DATA.sales.map(r => reportDate(r)),
    ...REPORT_DATA.purchases.map(r => reportDate(r)),
    ...REPORT_DATA.supplies.map(r => reportDate(r)),
  ].filter(d => d && d < from).sort();
  return dates[0] || null;
}

function clearCFOverride() {
  localStorage.removeItem(CF_OVERRIDE_KEY);
  logAudit('Settings', 'Cash Flow', 'Cleared beginning balance override');
  renderCashFlowReport();
}

function saveCFBeginOverride(value) {
  const from = document.getElementById('report-start').value;
  const num = Number(value);
  if (Number.isFinite(num) && Math.abs(num - cfComputedBeginBalance(from)) > 0.005) {
    localStorage.setItem(CF_OVERRIDE_KEY, String(num));
    logAudit('Settings', 'Cash Flow', `Updated beginning balance override to ${formatPeso(num)}`);
  } else {
    localStorage.removeItem(CF_OVERRIDE_KEY);
    logAudit('Settings', 'Cash Flow', 'Reset beginning balance override to computed value');
  }
  renderCashFlowReport();
}

function renderCFBeginSection(from) {
  const section = document.getElementById('cf-begin-section');
  if (!section) return;
  const computed    = cfComputedBeginBalance(from);
  const overrideRaw = localStorage.getItem(CF_OVERRIDE_KEY);
  const hasOverride = overrideRaw !== null;
  const displayVal  = hasOverride ? Number(overrideRaw) : computed;
  const earliest    = cfEarliestDate(from);
  function fmtD(d) {
    if (!d) return '';
    return new Date(`${d}T00:00:00`).toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'});
  }
  const fromDisplay = fmtD(from);
  const dayBefore   = from ? fmtD(new Date(new Date(`${from}T00:00:00`).getTime()-86400000).toISOString().slice(0,10)) : '';
  const coverageHtml = !earliest
    ? `<div class="cf-coverage-note cf-coverage-none">No records before ${escReport(fromDisplay)}. The computed beginning balance is ₱0. Enter a beginning balance manually if cash existed before this date.</div>`
    : `<div class="cf-coverage-note">Beginning balance computed from earliest record (${escReport(fmtD(earliest))}) through ${escReport(dayBefore)}.</div>`;
  const modeTag  = hasOverride
    ? '<span class="cf-mode-tag cf-mode-manual">Manual override</span>'
    : '<span class="cf-mode-tag cf-mode-computed">Computed</span>';
  const resetBtn = hasOverride
    ? '<button class="cf-reset-btn" onclick="clearCFOverride()">Reset to computed</button>'
    : '';
  section.style.display = '';
  section.innerHTML = `
    <div class="cf-begin-row">
      <span class="cf-begin-label">Beginning Balance</span>
      ${modeTag}
      <div class="cf-begin-field">
        <span class="cf-peso-sign">₱</span>
        <input class="form-input cf-begin-input" id="cf-begin-input" type="number" step="0.01"
          value="${displayVal.toFixed(2)}" onchange="saveCFBeginOverride(this.value)">
      </div>
      ${resetBtn}
    </div>
    ${coverageHtml}`;
}

function renderCashFlowReport() {
  const from = document.getElementById('report-start').value;
  renderCFBeginSection(from);
  const salesIn  = REPORT_DATA.sales.filter(inReportRange);
  const purOut   = REPORT_DATA.purchases.filter(inReportRange);
  const supOut   = REPORT_DATA.supplies.filter(inReportRange);
  const months   = [...new Set([
    ...salesIn.map(r => (reportDate(r)||'').slice(0,7)),
    ...purOut.map(r  => (reportDate(r)||'').slice(0,7)),
    ...supOut.map(r  => (reportDate(r)||'').slice(0,7)),
  ])].filter(Boolean).sort();
  const mInflow  = m => salesIn.filter(r=>(reportDate(r)||'').startsWith(m)).reduce((s,r)=>s+(Number(r.totalRevenue)||0),0);
  const mOutflow = m => purOut.filter(r=>(reportDate(r)||'').startsWith(m)).reduce((s,r)=>s+purchaseSpend(r),0)
                      + supOut.filter(r=>(reportDate(r)||'').startsWith(m)).reduce((s,r)=>s+(Number(r.totalCost??r.amount)||0),0);
  const totalInflow  = salesIn.reduce((s,r)=>s+(Number(r.totalRevenue)||0),0);
  const totalOutflow = purOut.reduce((s,r)=>s+purchaseSpend(r),0)
                     + supOut.reduce((s,r)=>s+(Number(r.totalCost??r.amount)||0),0);
  const netCashFlow  = totalInflow - totalOutflow;
  const overrideRaw  = localStorage.getItem(CF_OVERRIDE_KEY);
  const beginBal     = overrideRaw !== null ? Number(overrideRaw) : cfComputedBeginBalance(from);
  const endingBal    = beginBal + netCashFlow;
  renderCards([
    { label:'Total Inflows (Sales)',  value:formatPeso(totalInflow),  cls:'green' },
    { label:'Total Outflows',         value:formatPeso(totalOutflow), cls:'red' },
    { label:'Net Cash Flow',          value:formatPeso(netCashFlow),  cls:netCashFlow>=0?'green':'red' },
    { label:'Ending Balance',         value:formatPeso(endingBal),    cls:endingBal>=0?'green':'red' },
  ]);
  const card = document.getElementById('report-chart-card');
  if (months.length && typeof Chart !== 'undefined') {
    card.style.display = '';
    card.style.height = '280px';
    if (reportChart) { if (reportChart===purchasesBarChart) purchasesBarChart=null; reportChart.destroy(); }
    reportChart = new Chart(document.getElementById('report-chart'), {
      type:'line',
      data:{
        labels: months.map(m=>new Date(`${m}-01T00:00:00`).toLocaleDateString('en-PH',{month:'short',year:'2-digit'})),
        datasets:[
          { label:'Inflows (Sales)', data:months.map(mInflow), borderColor:'#16a34a', backgroundColor:'rgba(22,163,74,0.1)', tension:0.3, fill:true, pointRadius:4, borderWidth:2 },
          { label:'Outflows (Purchases + Supplies)', data:months.map(mOutflow), borderColor:'#dc2626', backgroundColor:'rgba(220,38,38,0.1)', tension:0.3, fill:true, pointRadius:4, borderWidth:2 },
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{
          title:{ display:true, text:'Cash Inflows vs Outflows by Month', font:{size:13,weight:'500'} },
          legend:{ position:'bottom', labels:{font:{size:11},padding:14} },
          tooltip:{ callbacks:{ label:ctx=>` ${ctx.dataset.label}: ₱${ctx.parsed.y.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}` } },
        },
        scales:{ y:{ beginAtZero:true, ticks:{ callback:v=>`₱${(v/1000).toFixed(0)}k` } } },
      }
    });
  } else {
    card.style.display = 'none';
  }
  if (reportCategoryChart) { reportCategoryChart.destroy(); reportCategoryChart=null; }
  document.getElementById('report-category-chart-card').style.display = 'none';
  let runBal = beginBal;
  const tableRows = months.map(m => {
    const inflow=mInflow(m), outflow=mOutflow(m), net=inflow-outflow;
    const openBal=runBal; runBal+=net; const closeBal=runBal;
    const mLbl=new Date(`${m}-01T00:00:00`).toLocaleDateString('en-PH',{month:'long',year:'numeric'});
    return `<tr>
      <td>${escReport(mLbl)}</td>
      <td class="mono" style="color:#16a34a">${formatPeso(inflow)}</td>
      <td class="mono" style="color:#dc2626">${formatPeso(outflow)}</td>
      <td class="mono ${net>=0?'amount-positive':'amount-negative'}">${formatPeso(net)}</td>
      <td class="mono">${formatPeso(openBal)}</td>
      <td class="mono ${closeBal>=0?'amount-positive':'amount-negative'}">${formatPeso(closeBal)}</td>
    </tr>`;
  });
  renderTable('primary','Cash Flow by Period',['Period','Inflows','Outflows','Net Cash Flow','Opening Balance','Closing Balance'],tableRows);
  hideSecondaryTable();
}

const REPORT_META = {
  income:['Income Statement', 'Revenue, COGS, expenses, and net income'],
  sales:['Sales Report', 'Sales performance, product ranking, and margin flags'],
  purchases:['Purchases Report', 'Supplier spending and purchase trends'],
  tax:['Tax Summary', 'VAT and EWT obligations for the selected period'],
  inventory:['Inventory Report', 'Incoming inventory value and product quantities'],
  cashflow:['Cash Flow Report', 'Beginning balance, period inflows, outflows, and running balance'],
  custom:['Custom Report', 'Build a chart from the selected data source'],
};

function renderActiveReport() {
  const rankedBarContainer = document.getElementById('sales-bar-container') ||
    document.getElementById('purchases-bar-container');
  rankedBarContainer.id = activeReportTab === 'purchases' ? 'purchases-bar-container' : 'sales-bar-container';
  document.getElementById('report-output').classList.toggle('income-statement-layout', activeReportTab === 'income');
  document.getElementById('report-output').classList.toggle('ranking-report-layout',
    activeReportTab === 'sales' || activeReportTab === 'purchases');
  document.getElementById('report-output').classList.toggle('tax-report-layout', activeReportTab === 'tax');
  document.getElementById('report-output').classList.toggle('inventory-report-layout', activeReportTab === 'inventory');
  document.getElementById('report-output').classList.toggle('cashflow-report-layout', activeReportTab === 'cashflow');
  document.getElementById('report-output').classList.toggle('custom-report-layout', activeReportTab === 'custom');
  document.querySelector('.report-controls').style.display = activeReportTab === 'tax' ? 'none' : '';
  document.getElementById('report-chart-card').style.height = '';
  rankedBarContainer.style.height = '';
  document.getElementById('report-top-n-control').innerHTML = '';
  document.getElementById('inventory-movement-controls').innerHTML = '';
  document.getElementById('inventory-movement-pagination')?.remove();
  document.getElementById('cf-begin-section').style.display = 'none';
  document.getElementById('report-primary-table').classList.toggle('is-table',
    activeReportTab === 'income' || activeReportTab === 'tax');
  document.getElementById('report-extra-filters').innerHTML = '';
  document.getElementById('custom-report-controls').style.display = activeReportTab === 'custom' && FEATURE_CUSTOM_REPORT ? '' : 'none';
  const [title, subtitle] = REPORT_META[activeReportTab];
  document.getElementById('report-title').textContent = title;
  document.getElementById('report-subtitle').textContent = subtitle;
  if (activeReportTab === 'sales') renderSalesReport();
  else if (activeReportTab === 'purchases') renderPurchasesReport();
  else if (activeReportTab === 'tax') renderTaxSummary();
  else if (activeReportTab === 'inventory') renderInventoryReport();
  else if (activeReportTab === 'cashflow') renderCashFlowReport();
  else if (activeReportTab === 'custom' && FEATURE_CUSTOM_REPORT) renderCustomReport();
  else renderIncomeStatement();
}

function exportChartPNG() {
  const link = document.createElement('a');
  link.download = `palo-grocerette-${activeReportTab}-chart.png`;
  link.href = document.getElementById('report-chart').toDataURL('image/png');
  link.click();
}

function exportCustomCSV() {
  const csv = ['Group,Value', ...customExportRows.map(row => `"${String(row.group).replace(/"/g, '""')}",${row.value}`)].join('\n');
  const link = document.createElement('a');
  link.download = 'palo-grocerette-custom-report.csv';
  link.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
  link.click();
  URL.revokeObjectURL(link.href);
}

async function refreshReportData() {
  await withReportProgress('Loading report data...', async () => {
    try {
      await loadReportData();
    } catch (err) {
      console.error('[Reports] Firestore refresh failed:', err);
      alert('Could not refresh report data. Please check your connection and try again.');
    }
    setReportProgress(86, 'Rendering report...');
    await waitReportFrame();
    renderActiveReport();
  });
}

document.getElementById('btn-apply-report-range').addEventListener('click', refreshReportData);
document.getElementById('btn-build-custom').addEventListener('click', renderCustomReport);
document.getElementById('btn-export-chart').addEventListener('click', exportChartPNG);
document.getElementById('btn-export-custom-csv').addEventListener('click', exportCustomCSV);
async function initReports() {
  setDefaultReportDates();
  if (!FEATURE_CUSTOM_REPORT) {
    const btn = document.getElementById('tab-btn-custom');
    if (btn) {
      btn.insertAdjacentHTML('afterend',
        '<span class="tab-btn tab-btn-locked" title="Contact us to enable Custom Reports">Custom<span class="tab-locked-badge">available on request</span></span>');
      btn.remove();
    }
  }
  try {
    await loadReportData();
  } catch (err) {
    console.error('[Reports] Firestore load failed:', err);
    alert('Could not load report data. Please check your connection and refresh.');
  }
  renderActiveReport();
  const db = getFirestoreDB();
  if (db) {
    db.collection('productMaster').onSnapshot(snapshot => {
      REPORT_DATA.productMaster = snapshot.docs.map(doc => ({ _firestoreId:doc.id, ...doc.data() }));
      if (activeReportTab === 'inventory') renderInventoryReport();
    }, err => console.error('[Reports] Product Master listener failed:', err));
  }
}

initReports();

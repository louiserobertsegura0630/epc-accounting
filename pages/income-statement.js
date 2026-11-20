initSidebar('income-statement');

const now = new Date();
const defaultMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
const periodSel = document.getElementById('period-select');
periodSel.value = defaultMonth;
periodSel.addEventListener('change', () => {
  renderIS();                                            // a month not loaded yet shows zeros until Generate
  window.dispatchEvent(new Event('epc-cost-change'));    // the cost line follows the chosen month
});

// The month's sales come from the salesDaily day docs (EPCDays: one read per
// day, kept in the browser's day store). Expenses come from the saved copy.
let _isDays = {};
let _isPeriod = '';
function isMonthRange(period) {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}
async function loadISData() {
  const period = periodSel.value || defaultMonth;
  const { from, to } = isMonthRange(period);
  const [sales, expenses] = await Promise.all([
    EPCDays.docs('salesDaily', from, to),
    EPCSaved.rows('expenses'),
  ]);
  _isDays = sales.days;
  _isPeriod = period;
  DB.set('expenses', expenses);
}
// Revenue, cost of the costed part and what is still awaiting a cost, for the month.
function isSalesTotals(days) {
  let revenue = 0; let cogs = 0; let awaitingItems = 0; let awaitingRevenue = 0;
  Object.keys(days || {}).forEach(date => {
    const d = days[date] || {};
    const products = d.products || {};
    Object.keys(products).forEach(code => {
      const p = products[code] || {};
      revenue += Number(p.revenue) || 0;
      cogs += p.cost != null ? (Number(p.cost) || 0) : (Number(p.unit_cost) || 0) * (Number(p.units) || 0);
    });
    awaitingItems += Number(d.awaitingCostItemCount) || 0;
    awaitingRevenue += Number(d.awaitingCostRevenue) || 0;
  });
  return { revenue, cogs, awaitingItems, awaitingRevenue, hasSales: Object.keys(days || {}).length > 0 };
}

function purchaseNetAmount(row) {
  return Number(row.netAmount ?? row.total ?? row.amount ?? row.totalCost ?? row.totalAmount ?? 0) || 0;
}

function renderIS() {
  const period = periodSel.value || defaultMonth;
  const [year, mo] = period.split('-');
  const monthLabel = new Date(year, mo-1, 1).toLocaleDateString('en-PH', { month:'long', year:'numeric' });

  document.getElementById('is-period').textContent = `For the Month Ending ${monthLabel}`;

  // Only the loaded month can be shown; another month needs Generate again.
  const emptyState = document.getElementById('is-empty-state');
  const doc = document.getElementById('is-doc');
  if (period !== _isPeriod) {
    if (emptyState) { emptyState.style.display = ''; emptyState.innerHTML = `Click <strong>Generate Report</strong> to load ${monthLabel}.`; }
    if (doc) doc.style.display = 'none';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';
  if (doc) doc.style.display = '';
  const tot = isSalesTotals(_isDays);
  const netRevenue    = tot.revenue;
  const cogs          = tot.cogs;
  const gross         = netRevenue - cogs;
  const salesMargin   = cogs > 0 ? ((netRevenue - cogs) / cogs * 100).toFixed(4) + '%' : '0.0000%';

  // Partial data note: products still waiting for a cost (matched on Inventory Tracking).
  const reviewNote = document.getElementById('is-review-note');
  if (tot.awaitingItems > 0) {
    reviewNote.style.display = '';
    reviewNote.innerHTML = `<strong>Partial data: pending cost entry.</strong>
      ${tot.awaitingItems.toLocaleString()} item${tot.awaitingItems !== 1 ? 's' : ''} (${formatPeso(tot.awaitingRevenue)} revenue)
      have no cost yet. COGS and Gross Profit are understated until costs are matched on
      <a href="inventory-tracking.html" style="color:#92400e;font-weight:600;text-decoration:underline">Inventory Tracking</a>.`;
  } else {
    reviewNote.style.display = 'none';
  }

  // Expenses (business only, in selected month)
  const allExp  = DB.get('expenses').filter(e => e.classification==='Business' && e.date?.startsWith(period));
  const totalExp = allExp.reduce((s,e) => s+(e.amount||0), 0);

  // Group by category for line items
  const catMap = {};
  allExp.forEach(e => {
    if (!catMap[e.category]) catMap[e.category] = [];
    catMap[e.category].push(e);
  });

  // Income
  const ibt       = netRevenue - cogs - totalExp;
  const taxable   = Math.max(0, ibt);
  const taxDue    = taxable * 0.25;
  const netIncome = ibt - taxDue;

  // Render
  document.getElementById('is-net-revenue').textContent = formatPeso(netRevenue);
  document.getElementById('is-cogs').textContent        = formatPeso(cogs);
  document.getElementById('is-gross-profit').textContent = formatPeso(gross);
  document.getElementById('is-gross-margin').textContent = salesMargin;
  document.getElementById('is-total-exp').textContent   = formatPeso(totalExp);
  document.getElementById('is-ibt').textContent         = formatPeso(ibt);
  document.getElementById('is-taxable').textContent     = formatPeso(taxable);
  document.getElementById('is-tax-due').textContent     = formatPeso(taxDue);

  const netEl = document.getElementById('is-net-income');
  netEl.textContent = formatPeso(netIncome);
  netEl.className = 'is-amount is-net-income ' + (netIncome >= 0 ? 'is-positive' : 'is-negative');
  document.getElementById('is-net-line').className =
    'is-total-line ' + (netIncome >= 0 ? 'is-positive' : 'is-negative');

  // Expense lines grouped by category
  const linesHTML = Object.entries(catMap).map(([cat, items]) => {
    const catTotal = items.reduce((s,e) => s+(e.amount||0), 0);
    const subLines = items.map(e =>
      `<div class="is-line sub">
        <span class="is-label">${e.name}</span>
        <span class="is-amount">${formatPeso(e.amount)}</span>
      </div>`).join('');
    return `
      <div class="is-line indent" style="margin-top:8px">
        <span class="is-label" style="font-weight:600">${cat}</span>
        <span class="is-amount" style="font-weight:600">${formatPeso(catTotal)}</span>
      </div>
      ${subLines}`;
  }).join('');

  document.getElementById('is-exp-lines').innerHTML = linesHTML ||
    '<div class="is-line indent"><span class="is-label" style="color:#94a3b8">No business expenses recorded for this period.</span><span class="is-amount">—</span></div>';

}

// Data is not loaded on page open — the user must click "Generate Report".
// Each click = paid Firestore reads, so the button guards against double-clicks.
EPCReportGate.wire({
  button: 'is-generate-btn',
  status: 'is-gen-status',
  costLine: 'is-cost-line',
  estimate: () => {
    const { from, to } = isMonthRange(periodSel.value || defaultMonth);
    return [...EPCDays.estimateParts('salesDaily', from, to), { saved: 'expenses' }];
  },
  load: async () => {
    await loadISData();
    renderIS();
    const e = document.getElementById('is-empty-state');
    if (e) e.style.display = 'none';
  }
});

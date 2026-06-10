initSidebar('income-statement');

const now = new Date();
const defaultMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
const periodSel = document.getElementById('period-select');
periodSel.value = defaultMonth;
periodSel.addEventListener('change', renderIS);

let _isSalesRows  = [];
let _isReviewRows = [];

async function loadISData() {
  async function fetchC(name, fallback) {
    const db = getFirestoreDB();
    if (db) {
      try {
        const snap = await db.collection(name).get();
        if (!snap.empty) return snap.docs.map(d => ({ _firestoreId: d.id, ...d.data() }));
      } catch (e) {
        console.warn('[Income Statement] Firestore fetch failed for', name, e);
      }
    }
    return DB.get(fallback) || [];
  }
  [_isSalesRows, _isReviewRows] = await Promise.all([
    fetchC('salesData',       'pos_sales'),
    fetchC('underReviewData', 'pos_review'),
  ]);
}

function purchaseNetAmount(row) {
  return Number(row.netAmount ?? row.total ?? row.amount ?? row.totalCost ?? row.totalAmount ?? 0) || 0;
}

function renderIS() {
  const period = periodSel.value || defaultMonth;
  const [year, mo] = period.split('-');
  const monthLabel = new Date(year, mo-1, 1).toLocaleDateString('en-PH', { month:'long', year:'numeric' });

  document.getElementById('is-period').textContent = `For the Month Ending ${monthLabel}`;

  // POS revenue plus purchase ledger COGS for the selected month.
  const posRows      = _isSalesRows.filter(r => r.date?.startsWith(period));
  const totPos       = getPOSTotals(posRows);

  // Unmatched items in pos_review — contribute revenue only
  const reviewRows    = _isReviewRows.filter(r => r.date?.startsWith(period));
  const totReview     = getPOSTotals(reviewRows);

  const grossRevenue  = totPos.grossRevenue + totReview.grossRevenue;
  const discounts     = totPos.discounts + totReview.discounts;
  const srpwdDiscounts = totPos.srpwdDiscounts + totReview.srpwdDiscounts;
  const netRevenue    = totPos.netRevenue + totReview.netRevenue;
  const cogs          = totPos.cogs;
  const gross         = grossRevenue - cogs;
  const salesMargin   = cogs > 0 ? ((grossRevenue - cogs) / cogs * 100).toFixed(1) + '%' : '0.0%';

  // Partial data note
  const reviewNote = document.getElementById('is-review-note');
  if (reviewRows.length > 0) {
    reviewNote.style.display = '';
    reviewNote.innerHTML = `<strong>Partial data: pending cost entry.</strong>
      ${reviewRows.length} item${reviewRows.length !== 1 ? 's' : ''} (${formatPeso(totReview.netRevenue)} net revenue)
      are awaiting unit costs in
      <a href="pos-import.html" style="color:#92400e;font-weight:600;text-decoration:underline">Sales Under Review</a>.
      COGS and Gross Profit are understated until costs are entered.`;
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
  document.getElementById('is-gross-revenue').textContent = formatPeso(grossRevenue);
  document.getElementById('is-discounts').textContent = formatPeso(-discounts);
  document.getElementById('is-srpwd-discounts').textContent = formatPeso(-srpwdDiscounts);
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

  // If no POS data at all
  if (!posRows.length && !reviewRows.length) {
    document.getElementById('is-gross-revenue').textContent = '₱0.00';
    document.getElementById('is-discounts').textContent = '₱0.00';
    document.getElementById('is-srpwd-discounts').textContent = '₱0.00';
    document.getElementById('is-net-revenue').textContent = '₱0.00';
    document.getElementById('is-cogs').textContent    = '₱0.00';
    document.getElementById('is-gross-profit').textContent = '₱0.00';
  }
}

loadISData().then(renderIS);

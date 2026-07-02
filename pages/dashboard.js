initSidebar('dashboard');

// ─── State ────────────────────────────────────────────────────────────────────
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
})();
let SNAP_DATE = today;

// ─── Data cache (filled by loadDashData from Firestore, fallback localStorage)
const DASH_DATA = {
  pos: [], purchases: [], supplies: [], esales: [],
  inventory: [], expenses: [], productMap: {}
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function snapDateFromRow(r) {
  const raw = r.date || r.dateDelivered || r.datePurchased || r.importedAt || '';
  if (!raw) return '';
  if (typeof raw.toDate === 'function') return raw.toDate().toISOString().slice(0, 10);
  return String(raw).slice(0, 10);
}

function onDay(rows) {
  return rows.filter(r => snapDateFromRow(r) === SNAP_DATE);
}

function snapRow(label, value, opts = {}) {
  const v = Number(value) || 0;
  const neg = v < 0;
  const valCls = neg ? 'snap-neg' : (v > 0 ? 'snap-pos' : 'snap-zero');
  const display = opts.units
    ? (v > 0 ? '+' : '') + Math.round(v).toLocaleString()
    : (neg ? '−' : '') + formatPeso(Math.abs(v));
  const rowCls = ['snap-row',
    opts.sub   ? 'snap-row-sub'   : '',
    opts.total ? 'snap-row-total' : '',
    opts.flag  ? 'snap-row-flag'  : '',
  ].filter(Boolean).join(' ');
  return `<div class="${rowCls}">
    <span class="snap-row-label">${label}</span>
    <span class="snap-row-value ${valCls}">${display}</span>
  </div>`;
}

function actRow(label, count) {
  return `<div class="snap-row">
    <span class="snap-row-label">${label}</span>
    <span class="snap-row-value ${count > 0 ? 'snap-pos' : 'snap-zero'}">${count.toLocaleString()}</span>
  </div>`;
}

// ─── Cheap sales reads from salesDaily rollups ───────────────────────────────
// salesDaily/{YYYY-MM-DD} = { products:{code:{name,units,revenue,cost,profit,unit_cost}},
//   totals:{units,revenue,cost,profit}, awaitingCostItemCount, awaitingCostRevenue }.
// Expand a day-doc into POS-shaped rows so getPOSTotals/onDay/product-perf keep working,
// without ever scanning the raw salesData collection.
const _salesDailyCache = new Map(); // date -> POS-shaped rows[]
function salesDayToRows(date, data) {
  const products = (data && data.products) || {};
  const rows = [];
  Object.keys(products).forEach((code) => {
    const p = products[code] || {};
    const units = Number(p.units) || 0;
    const revenue = Number(p.revenue) || 0;
    rows.push({
      date, itemCode: code, productName: p.name || code,
      unitsSold: units, totalRevenue: revenue, revenue,
      unitCost: Number(p.unit_cost) || 0,
      totalCost: (p.cost != null ? Number(p.cost) : (Number(p.unit_cost) || 0) * units) || 0,
    });
  });
  return rows;
}
async function loadSalesForDate(date) {
  if (_salesDailyCache.has(date)) return _salesDailyCache.get(date);
  const db = typeof getFirestoreDB === 'function' ? getFirestoreDB() : null;
  let rows = [];
  if (db) {
    try {
      const doc = await db.collection('salesDaily').doc(date).get();
      if (doc.exists) rows = salesDayToRows(date, doc.data());
    } catch (e) { console.warn('[Dashboard] salesDaily read failed for', date, e); }
  }
  _salesDailyCache.set(date, rows);
  return rows;
}
// Read a date range of salesDaily docs by document-id (one read per existing day).
async function loadSalesRange(from, to) {
  const db = typeof getFirestoreDB === 'function' ? getFirestoreDB() : null;
  if (!db) return [];
  try {
    const snap = await db.collection('salesDaily')
      .orderBy(firebase.firestore.FieldPath.documentId())
      .startAt(from).endAt(to).get();
    const rows = [];
    snap.forEach((doc) => {
      const r = salesDayToRows(doc.id, doc.data());
      _salesDailyCache.set(doc.id, r);
      rows.push(...r);
    });
    return rows;
  } catch (e) { console.warn('[Dashboard] salesDaily range read failed', from, to, e); return []; }
}

// ─── Firestore loader (mirrors reports.js fetchReportCollection) ──────────────
async function loadDashData() {
  async function fetchC(name, fallback) {
    const db = typeof getFirestoreDB === 'function' ? getFirestoreDB() : null;
    if (db) {
      try {
        const snap = await db.collection(name).get();
        if (!snap.empty) return snap.docs.map(d => ({ _firestoreId: d.id, ...d.data() }));
      } catch(e) {
        console.warn('[Dashboard] Firestore fetch failed for', name, e);
      }
    }
    return DB.get(fallback) || [];
  }

  const [pos, purchases, supplies, esales, inventory, expenses, products] = await Promise.all([
    loadSalesForDate(SNAP_DATE),   // cheap: one salesDaily/{date} read, not a full scan
    fetchC('purchases',     'purchases'),
    fetchC('suppliesData',  'supplies_movements'),
    fetchC('eSalesRecords', 'esales'),
    fetchC('inventoryData', 'inventory_movements'),
    fetchC('expenses',      'expenses'),
    fetchC('productMaster', 'productMaster'),
  ]);

  DASH_DATA.pos       = pos;
  DASH_DATA.purchases = purchases;
  DASH_DATA.supplies  = supplies;
  DASH_DATA.esales    = esales;
  DASH_DATA.inventory = inventory;
  DASH_DATA.expenses  = expenses;

  // Build product name map — also merge localStorage 'products' key as fallback
  const productMap = {};
  [...products, ...(DB.get('products') || [])].forEach(p => {
    const code = String(p.itemCode || p.code || '').trim();
    if (code && !productMap[code]) productMap[code] = p;
  });
  DASH_DATA.productMap = productMap;
}

// ─── Build daily operations summary ──────────────────────────────────────────
function buildDailyOperationsSummary() {
  const d = new Date(`${SNAP_DATE}T00:00:00`);
  document.getElementById('snap-headline').textContent =
    'Daily Operations Summary for ' + d.toLocaleDateString('en-PH', { weekday:'long', month:'long', day:'numeric', year:'numeric' });

  const pos       = onDay(DASH_DATA.pos);
  const purchases = onDay(DASH_DATA.purchases);
  const supplies  = onDay(DASH_DATA.supplies);
  const esales    = onDay(DASH_DATA.esales);
  const inventory = onDay(DASH_DATA.inventory);
  const expenses  = onDay(DASH_DATA.expenses).filter(e => e.classification === 'Business');

  // ── Block 1: Income Summary ────────────────────────────────────────────────
  const tots     = getPOSTotals(pos);
  const sales    = tots.revenue;
  const purchaseNet = purchases.reduce((s, p) => s + (Number(p.netAmount ?? p.total ?? p.amount ?? 0) || 0), 0);
  const cogs     = purchaseNet;
  const gross    = sales - cogs;
  const expTotal = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const netInc   = gross - expTotal;

  document.getElementById('snap-is').innerHTML = [
    snapRow('Sales Revenue', sales),
    snapRow('Cost of Goods Sold', -cogs, { sub:true }),
    snapRow('Gross Profit', gross, { total:true }),
    snapRow('Operating Expenses', -expTotal, { sub:true }),
    snapRow('Net Income', netInc, { total:true }),
  ].join('');

  // ── Block 2: Cash Flow ──────────────────────────────────────────────────────
  const inflows = sales;
  const purOut  = purchases.reduce((s, p) => s + (Number(p.netAmount ?? p.total ?? p.amount ?? 0) || 0), 0);
  const supOut  = supplies.reduce((s, r)  => s + (Number(r.totalCost ?? r.amount) || 0), 0);
  const netCash = inflows - purOut - supOut;

  document.getElementById('snap-cf').innerHTML = [
    snapRow('Sales Collections', inflows),
    snapRow('Purchases', -purOut, { sub:true }),
    snapRow('Supplies', -supOut, { sub:true }),
    snapRow('Net Cash', netCash, { total:true }),
  ].join('');

  // ── Block 3: Tax ────────────────────────────────────────────────────────────
  const vatOutput = esales.reduce((s, e) => s + (Number(e.vat ?? e.vatAmount) || 0), 0);
  const ewtHeld   = purchases.reduce((s, p) => s + (Number(p.ewtAmount) || 0), 0);

  document.getElementById('snap-tax').innerHTML = [
    snapRow('VAT Output (12%) from E-Sales', vatOutput),
    snapRow('EWT Withheld from Purchases', ewtHeld),
  ].join('');

  // ── Block 4: Inventory Movement ─────────────────────────────────────────────
  const invIn  = inventory.filter(r => String(r.type || 'Incoming').toLowerCase() !== 'outgoing')
                           .reduce((s, r) => s + (Number(r.qty ?? r.quantity) || 0), 0);
  const invOut = inventory.filter(r => String(r.type || '').toLowerCase() === 'outgoing')
                           .reduce((s, r) => s + (Number(r.qty ?? r.quantity) || 0), 0);
  const byCode = {};
  inventory.forEach(r => {
    const c = r.itemCode || '?';
    if (!byCode[c]) byCode[c] = { in:0, out:0 };
    if (String(r.type||'').toLowerCase() === 'outgoing') byCode[c].out += Number(r.qty??r.quantity)||0;
    else byCode[c].in += Number(r.qty??r.quantity)||0;
  });
  const flagged = Object.values(byCode).filter(v => v.out > v.in).length;
  const netMov  = invIn - invOut;

  document.getElementById('snap-inv').innerHTML = [
    `<div class="snap-row"><span class="snap-row-label">Units In</span><span class="snap-row-value snap-pos">${invIn.toLocaleString()}</span></div>`,
    `<div class="snap-row"><span class="snap-row-label">Units Out</span><span class="snap-row-value">${invOut.toLocaleString()}</span></div>`,
    `<div class="snap-row snap-row-total"><span class="snap-row-label">Net Movement</span><span class="snap-row-value ${netMov>=0?'snap-pos':'snap-neg'}">${netMov>=0?'+':''}${netMov.toLocaleString()}</span></div>`,
    flagged > 0
      ? `<div class="snap-row snap-row-flag"><span class="snap-row-label">Inventory Exceptions</span><span class="snap-row-value snap-neg">${flagged}</span></div>`
      : `<div class="snap-row"><span class="snap-row-label snap-zero" style="font-size:12px">No inventory exceptions for the selected date</span></div>`,
  ].join('');

  // ── Block 5: Activity ───────────────────────────────────────────────────────
  document.getElementById('snap-act').innerHTML = [
    actRow('Sales Transactions', pos.length),
    actRow('Purchase Records', purchases.length),
    actRow('Supply Entries', supplies.length),
    actRow('Inventory Movements', inventory.length),
  ].join('');
}

// ─── Generate daily report ────────────────────────────────────────────────────
function generateDayReport() {
  const d = new Date(`${SNAP_DATE}T00:00:00`);
  const dateLabel = d.toLocaleDateString('en-PH', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  const now = new Date().toLocaleString('en-PH');
  const fp  = v => `₱${Number(v||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}`;

  const pos       = onDay(DASH_DATA.pos);
  const purchases = onDay(DASH_DATA.purchases);
  const supplies  = onDay(DASH_DATA.supplies);
  const esales    = onDay(DASH_DATA.esales);
  const inventory = onDay(DASH_DATA.inventory);
  const expenses  = onDay(DASH_DATA.expenses).filter(e => e.classification === 'Business');

  const tots      = getPOSTotals(pos);
  const sales     = tots.revenue;
  const purchaseNet = purchases.reduce((s,p) => s+(Number(p.netAmount??p.total??p.amount)||0), 0);
  const cogs      = purchaseNet;
  const gross     = sales - cogs;
  const expTotal  = expenses.reduce((s,e) => s+(Number(e.amount)||0), 0);
  const netInc    = gross - expTotal;
  const purOut    = purchases.reduce((s,p) => s+(Number(p.netAmount??p.total??p.amount)||0), 0);
  const supOut    = supplies.reduce((s,r) => s+(Number(r.totalCost??r.amount)||0), 0);
  const netCash   = sales - purOut - supOut;
  const vatOutput = esales.reduce((s,e) => s+(Number(e.vat??e.vatAmount)||0), 0);
  const ewtHeld   = purchases.reduce((s,p) => s+(Number(p.ewtAmount)||0), 0);
  const invIn     = inventory.filter(r => String(r.type||'Incoming').toLowerCase()!=='outgoing').reduce((s,r)=>s+(Number(r.qty??r.quantity)||0),0);
  const invOut    = inventory.filter(r => String(r.type||'').toLowerCase()==='outgoing').reduce((s,r)=>s+(Number(r.qty??r.quantity)||0),0);
  const netMov    = invIn - invOut;

  const row = (label, value, cls='', sub=false) =>
    `<tr class="${sub?'sub':''}"><td>${label}</td><td class="${cls}">${value}</td></tr>`;
  const tot = (label, value, cls='') =>
    `<tr class="total"><td>${label}</td><td class="${cls}">${value}</td></tr>`;

  const win = window.open('','_blank','width=720,height=900');
  win.document.write(`<!DOCTYPE html><html><head>
<title>Daily Operations Report - ${dateLabel}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Arial,sans-serif;padding:44px;color:#0f172a;font-size:13px;max-width:680px;margin:0 auto}
  h1{font-size:22px;margin:0 0 2px}
  .meta{color:#64748b;font-size:12px;margin:0 0 30px}
  h3{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#64748b;margin:22px 0 6px;padding-bottom:6px;border-bottom:1px solid #e2e8f0}
  table{width:100%;border-collapse:collapse;margin-bottom:4px}
  td{padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:13px}
  td:last-child{text-align:right;font-family:'Courier New',monospace;white-space:nowrap}
  tr.sub td:first-child{padding-left:24px;color:#64748b}
  tr.total td{font-weight:700;border-top:2px solid #cbd5e1;border-bottom:none;padding-top:10px}
  .pos{color:#15803d} .neg{color:#dc2626}
  .footer{margin-top:36px;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:12px}
  @media print{body{padding:24px}}
</style></head><body>
<h1>EPC Commercial Corporation</h1>
<p class="meta">Daily Operations Report &nbsp;·&nbsp; ${dateLabel}<br>Generated: ${now}</p>

<h3>Income Statement</h3>
<table>
  ${row('Sales Revenue', fp(sales), 'pos')}
  ${row('Cost of Goods Sold', fp(cogs), '', true)}
  ${tot('Gross Profit', fp(gross), gross<0?'neg':'pos')}
  ${row('Operating Expenses', fp(expTotal), '', true)}
  ${tot('Net Income', fp(netInc), netInc<0?'neg':'pos')}
</table>

<h3>Cash Flow</h3>
<table>
  ${row('Sales Collections', fp(sales), 'pos')}
  ${row('Purchases', fp(purOut), '', true)}
  ${row('Supplies', fp(supOut), '', true)}
  ${tot('Net Cash', fp(netCash), netCash<0?'neg':'pos')}
</table>

<h3>Tax</h3>
<table>
  ${row('VAT Output (12%) from E-Sales', fp(vatOutput))}
  ${row('EWT Withheld from Purchases', fp(ewtHeld))}
</table>

<h3>Inventory Movement</h3>
<table>
  ${row('Units In', invIn.toLocaleString(), 'pos')}
  ${row('Units Out', invOut.toLocaleString())}
  ${tot('Net Movement', (netMov>=0?'+':'')+netMov.toLocaleString(), netMov<0?'neg':'pos')}
</table>

<h3>Transaction Counts</h3>
<table>
  ${row('Sales Transactions', pos.length.toLocaleString())}
  ${row('Purchase Records', purchases.length.toLocaleString())}
  ${row('Supply Entries', supplies.length.toLocaleString())}
  ${row('Inventory Movements', inventory.length.toLocaleString())}
</table>

<div class="footer">EPC Commercial Corporation Accounting Portal &nbsp;·&nbsp; Daily Operations Report &nbsp;·&nbsp; ${now}</div>
</body></html>`);
  win.document.close();
  win.print();
}

// ─── Date control ─────────────────────────────────────────────────────────────
async function setSnapDate(date) {
  SNAP_DATE = date || today;
  const el = document.getElementById('snap-date');
  if (el) el.value = SNAP_DATE;
  DASH_DATA.pos = await loadSalesForDate(SNAP_DATE);  // one salesDaily/{date} read (cached)
  buildDailyOperationsSummary();
}
function setSnapToday() { setSnapDate(today); }

document.getElementById('snap-date').addEventListener('change', function() {
  setSnapDate(this.value);
});

// ─── Product Performance ──────────────────────────────────────────────────────
const PROD_PERF_KEY = 'productPerfState';
const prodCharts = {};

function prodWindowRange(win, from, to) {
  const n = new Date();
  const p = x => String(x).padStart(2, '0');
  const tod = `${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())}`;
  if (win === 'month')  return { from:`${n.getFullYear()}-${p(n.getMonth()+1)}-01`, to:tod };
  if (win === 'last30') { const d=new Date(n-30*864e5); return { from:`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`, to:tod }; }
  if (win === 'last90') { const d=new Date(n-90*864e5); return { from:`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`, to:tod }; }
  if (win === 'ytd')    return { from:`${n.getFullYear()}-01-01`, to:tod };
  return { from: from || tod, to: to || tod };
}

function prodWindowLabel(win, range) {
  const f = d => {
    if (!d) return 'Not set';
    const [y, m, dy] = d.split('-');
    return new Date(y, m-1, dy).toLocaleDateString('en-PH', { month:'short', day:'numeric', year:'numeric' });
  };
  const names = { month:'Current Month', last30:'Last 30 Days', last90:'Last 90 Days', ytd:'Year to Date', custom:'Custom Range' };
  return `${names[win] || win} (${f(range.from)} to ${f(range.to)})`;
}

function productMetricLabel(measure) {
  return measure === 'pesos' ? 'sales value' : 'units sold';
}

function formatProductMetric(value, measure) {
  const number = Number(value) || 0;
  return measure === 'pesos'
    ? '₱' + number.toLocaleString('en-PH', { minimumFractionDigits:2, maximumFractionDigits:2 })
    : Math.round(number).toLocaleString('en-PH');
}

function makeBarChart(canvasId, items, color, measure) {
  if (prodCharts[canvasId]) { prodCharts[canvasId].destroy(); delete prodCharts[canvasId]; }
  const canvas  = document.getElementById(canvasId);
  const emptyEl = document.getElementById(canvasId.replace('chart', 'empty'));
  if (!canvas) return;
  if (!items.length) {
    canvas.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'flex';
    return;
  }
  canvas.style.display = '';
  if (emptyEl) emptyEl.style.display = 'none';
  const shorten = s => s.length > 22 ? s.slice(0, 20) + '…' : s;
  prodCharts[canvasId] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: items.map(e => shorten(e.name)),
      datasets: [{ data:items.map(e => e.metric), backgroundColor:color, borderRadius:4 }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display:false },
        tooltip: { callbacks: { label: ctx => ` ${formatProductMetric(ctx.parsed.x, measure)}` }}
      },
      scales: {
        x: {
          beginAtZero:true,
          min:0,
          title:{ display:true, text:measure === 'pesos' ? 'Sales Value (₱)' : 'Units Sold' },
          ticks:{
            precision:measure === 'units' ? 0 : undefined,
            font:{size:11},
            callback:value => measure === 'pesos'
              ? '₱' + Number(value).toLocaleString('en-PH')
              : Math.round(Number(value)).toLocaleString('en-PH')
          }
        },
        y: { ticks:{ font:{size:11} } }
      }
    }
  });
}

async function buildProductPerformance() {
  let st = {};
  try { st = JSON.parse(localStorage.getItem(PROD_PERF_KEY) || '{}'); } catch(e) {}
  const win   = st.window || 'month';
  const measure = st.measure === 'pesos' ? 'pesos' : 'units';
  const range = prodWindowRange(win, st.from, st.to);

  const sel = document.getElementById('prod-window-sel');
  if (sel && sel.value !== win) sel.value = win;
  const measureSel = document.getElementById('prod-measure-sel');
  if (measureSel && measureSel.value !== measure) measureSel.value = measure;
  document.getElementById('prod-top-caption').textContent = `Top 5 by ${productMetricLabel(measure)}`;
  document.getElementById('prod-slow-caption').textContent = `Lowest 5 by ${productMetricLabel(measure)}`;
  const cr = document.getElementById('prod-custom-row');
  if (cr) cr.style.display = win === 'custom' ? 'flex' : 'none';
  if (win === 'custom') {
    const fe = document.getElementById('prod-from'); if (fe) fe.value = st.from || '';
    const te = document.getElementById('prod-to');   if (te) te.value = st.to   || '';
  }
  const lbl = document.getElementById('prod-window-label');
  if (lbl) lbl.textContent = `Product Performance: ${prodWindowLabel(win, range)}`;

  const byCode = {};
  const rangeRows = await loadSalesRange(range.from, range.to);  // cheap: docs by id range
  rangeRows.filter(r => {
    const d = snapDateFromRow(r);
    return d >= range.from && d <= range.to;
  }).forEach(r => {
    const code = String(r.itemCode || '').trim();
    if (!code) return;
    if (!byCode[code]) byCode[code] = { units:0, value:0, fallback:r.productName || code };
    byCode[code].units += Number(r.unitsSold)    || 0;
    byCode[code].value += Number(r.totalRevenue) || 0;
  });

  const getName = (code, fb) => {
    const p = DASH_DATA.productMap[code];
    return (p && (p.productName || p.name)) || fb || code;
  };

  const entries = Object.entries(byCode)
    .map(([code, v]) => ({
      code,
      name:getName(code, v.fallback),
      units:v.units,
      value:v.value,
      metric:measure === 'pesos' ? v.value : v.units
    }))
    .filter(entry => entry.metric > 0)
    .sort((a, b) => b.metric - a.metric);

  makeBarChart('prod-top-chart', entries.slice(0, 5), '#16a34a', measure);
  makeBarChart('prod-slow-chart', [...entries].sort((a, b) => a.metric - b.metric).slice(0, 5), '#d97706', measure);
}

function setProdWindow(win) {
  let previous = {};
  try { previous = JSON.parse(localStorage.getItem(PROD_PERF_KEY) || '{}'); } catch(e) {}
  const st = { ...previous, window:win };
  if (win === 'custom') {
    st.from = document.getElementById('prod-from')?.value || '';
    st.to   = document.getElementById('prod-to')?.value   || '';
  }
  localStorage.setItem(PROD_PERF_KEY, JSON.stringify(st));
  buildProductPerformance();
}

function setProdMeasure(measure) {
  let st = {};
  try { st = JSON.parse(localStorage.getItem(PROD_PERF_KEY) || '{}'); } catch(e) {}
  st.measure = measure === 'pesos' ? 'pesos' : 'units';
  localStorage.setItem(PROD_PERF_KEY, JSON.stringify(st));
  buildProductPerformance();
}

function setProdCustomRange() {
  let previous = {};
  try { previous = JSON.parse(localStorage.getItem(PROD_PERF_KEY) || '{}'); } catch(e) {}
  localStorage.setItem(PROD_PERF_KEY, JSON.stringify({
    ...previous,
    window:'custom',
    from: document.getElementById('prod-from')?.value || '',
    to:   document.getElementById('prod-to')?.value   || '',
  }));
  buildProductPerformance();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.getElementById('snap-date').value = today;
loadDashData()
  .then(() => {
    buildDailyOperationsSummary();
    buildProductPerformance();
  })
  .catch(err => {
    console.error('[Dashboard] Data load error:', err);
    buildDailyOperationsSummary();
    buildProductPerformance();
  });

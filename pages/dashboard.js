initSidebar('dashboard');

// ─── State ────────────────────────────────────────────────────────────────────
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const today = isoDate(new Date());
// The dashboard defaults to YESTERDAY: a day's operations (sales, purchases/COGS,
// supplies, expenses, tax, inventory) are reviewed the next day, so "today's"
// snapshot shows the prior day's data. Picking any date still shows that exact
// date's data, and the "Today" button jumps to the real current day.
const defaultSnapDate = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return isoDate(d); })();
let SNAP_DATE = defaultSnapDate;

// ─── Data cache (filled by loadDashData from Firestore, fallback localStorage)
const DASH_DATA = {
  pos: [], purchases: [], supplies: [], esales: [],
  inventory: [], expenses: []
};

// ─── Loading pop-up ───────────────────────────────────────────────────────────
// Several loads can overlap (daily summary + product performance), so count them
// and hide the pop-up only when the last one finishes.
let _loadingCount = 0;
async function withLoadingPopup(message, fn) {
  const overlay = document.getElementById('dash-loading');
  const msg = document.getElementById('dash-loading-msg');
  _loadingCount++;
  if (msg) msg.textContent = message;
  if (overlay) overlay.hidden = false;
  try {
    return await fn();
  } finally {
    _loadingCount = Math.max(0, _loadingCount - 1);
    if (overlay && _loadingCount === 0) overlay.hidden = true;
  }
}

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
// The Sales Pulse (dashboard-sales.js) loads a block of recent days on page open.
// It hands them over here so the rest of the page reuses them instead of reading again.
let _salesCoverage = null; // { from, to }: every date in this range is in the cache
function primeSalesCache(from, to, docsByDate) {
  for (let d = from; d <= to; d = addDaysIso(d, 1)) {
    _salesDailyCache.set(d, docsByDate[d] ? salesDayToRows(d, docsByDate[d]) : []);
  }
  _salesCoverage = { from, to };
}
// Read a date range of salesDaily docs by document-id (one read per existing day).
async function loadSalesRange(from, to) {
  if (_salesCoverage && from >= _salesCoverage.from && to <= _salesCoverage.to) {
    const cached = [];
    for (let d = from; d <= to; d = addDaysIso(d, 1)) cached.push(...(_salesDailyCache.get(d) || []));
    return cached;
  }
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

// Raw inventory rows for the selected day only: one read per row delivered that
// day, instead of the whole inventoryData collection. Kept per day for this page view.
const _inventoryDayCache = new Map(); // date -> rows[]
async function loadInventoryForDate(date) {
  if (_inventoryDayCache.has(date)) return;
  const db = typeof getFirestoreDB === 'function' ? getFirestoreDB() : null;
  if (!db) return;
  try {
    const snap = await db.collection('inventoryData')
      .where('dateDelivered', '>=', date)
      .where('dateDelivered', '<=', `${date}\uf8ff`).get();
    _inventoryDayCache.set(date, snap.docs.map(d => ({ _firestoreId: d.id, ...d.data() })));
  } catch (e) {
    EPCQuota.report(e);
    console.warn('[Dashboard] inventory read failed for', date, e);
  }
  DASH_DATA.inventory = [..._inventoryDayCache.values()].flat();
}

// ─── Firestore loader ─────────────────────────────────────────────────────────
// Purchases, supplies, e-sales and expenses come from the browser's saved copy
// (EPCSaved in app.js), which fetches only records changed since the last load.
async function loadDashData() {
  async function fetchC(name, fallback) {
    try {
      const rows = await EPCSaved.rows(name);
      if (rows.length) return rows;
    } catch(e) {
      EPCQuota.report(e);
      console.warn('[Dashboard] Firestore fetch failed for', name, e);
    }
    return DB.get(fallback) || [];
  }

  _inventoryDayCache.delete(SNAP_DATE);   // Generate shows the day's latest inventory
  const [pos, purchases, supplies, esales, expenses] = await Promise.all([
    loadSalesForDate(SNAP_DATE),   // cheap: one salesDaily/{date} read, not a full scan
    fetchC('purchases',     'purchases'),
    fetchC('suppliesData',  'supplies_movements'),
    fetchC('eSalesRecords', 'esales'),
    fetchC('expenses',      'expenses'),
    loadInventoryForDate(SNAP_DATE),
  ]);

  DASH_DATA.pos       = pos;
  DASH_DATA.purchases = purchases;
  DASH_DATA.supplies  = supplies;
  DASH_DATA.esales    = esales;
  DASH_DATA.expenses  = expenses;
}

// ─── Motion helpers (entrance, count-up, 3D tilt) ────────────────────────────
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const CAN_TILT = !REDUCED_MOTION && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

// Fade/rise cards in one after another. Cards below the fold wait until they
// scroll into view.
const _revealObserver = ('IntersectionObserver' in window && !REDUCED_MOTION)
  ? new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        _revealObserver.unobserve(e.target);
      });
    }, { threshold: 0.12 })
  : null;
function revealIn(root) {
  const els = [...(root || document).querySelectorAll('.reveal')];
  els.forEach((el, i) => {
    if (el.classList.contains('in')) return;
    el.style.setProperty('--d', `${Math.min(i, 8) * 70}ms`);
    if (_revealObserver) _revealObserver.observe(el);
    else el.classList.add('in');
  });
}

// Cards lean toward the mouse (max ~6°) with a soft light that follows it.
function initTilt(root) {
  if (!CAN_TILT) return;
  (root || document).querySelectorAll('.tilt').forEach((el) => {
    if (el.dataset.tiltReady) return;
    el.dataset.tiltReady = '1';
    el.addEventListener('pointermove', (ev) => {
      const r = el.getBoundingClientRect();
      const x = (ev.clientX - r.left) / r.width;
      const y = (ev.clientY - r.top) / r.height;
      el.classList.add('is-tilting');
      el.style.setProperty('--ry', `${((x - 0.5) * 8).toFixed(2)}deg`);
      el.style.setProperty('--rx', `${((0.5 - y) * 6).toFixed(2)}deg`);
      el.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
      el.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
    });
    el.addEventListener('pointerleave', () => {
      el.classList.remove('is-tilting');
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
    });
  });
}

// Numbers roll up from 0 to their value.
const fmtPesoSigned = (v) => (v < 0 ? '−' : '') + formatPeso(Math.abs(v));
function animateCount(el, to, fmt = fmtPesoSigned, ms = 1000) {
  if (!el) return;
  const target = Number(to) || 0;
  if (REDUCED_MOTION) { el.textContent = fmt(target); return; }
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(target * eased);
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = fmt(target);
  };
  requestAnimationFrame(step);
}

// ─── Per-day figures ─────────────────────────────────────────────────────────
function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
function onDate(rows, date) {
  return rows.filter(r => snapDateFromRow(r) === date);
}
// Everything the dashboard shows for one day. Same formulas as the daily
// summary blocks, so the cards, charts and blocks always agree.
function computeDay(date) {
  const pos       = date === SNAP_DATE ? DASH_DATA.pos : (_salesDailyCache.get(date) || []);
  const purchases = onDate(DASH_DATA.purchases, date);
  const supplies  = onDate(DASH_DATA.supplies, date);
  const esales    = onDate(DASH_DATA.esales, date);
  const inventory = onDate(DASH_DATA.inventory, date);
  const expenses  = onDate(DASH_DATA.expenses, date).filter(e => e.classification === 'Business');
  const tots      = getPOSTotals(pos);
  const sales     = tots.revenue;
  // COGS = cost of the goods actually SOLD that day (from the salesDaily rollup's
  // per-item cost), matched to revenue — NOT the day's purchases spend. Purchases
  // are a cash outflow shown in Cash Flow, not cost of goods sold.
  const cogs      = tots.cogs;
  const gross     = sales - cogs;
  const expTotal  = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const netInc    = gross - expTotal;
  const purOut    = purchases.reduce((s, p) => s + (Number(p.netAmount ?? p.total ?? p.amount ?? 0) || 0), 0);
  const supOut    = supplies.reduce((s, r)  => s + (Number(r.totalCost ?? r.amount) || 0), 0);
  const netCash   = sales - purOut - supOut;
  return { date, pos, purchases, supplies, esales, inventory, expenses,
           sales, cogs, gross, expTotal, netInc, purOut, supOut, netCash };
}

// The 7 days ending on the selected day (for sparklines and the sales chart).
// Sales come from salesDaily: at most 7 cheap reads, cached per day.
function weekDates() {
  return Array.from({ length: 7 }, (_, i) => addDaysIso(SNAP_DATE, i - 6));
}
async function loadWeekSales() {
  const days = weekDates();
  const missing = days.filter(d => !_salesDailyCache.has(d));
  if (!missing.length) return;
  await loadSalesRange(missing[0], missing[missing.length - 1]);
  days.forEach(d => { if (!_salesDailyCache.has(d)) _salesDailyCache.set(d, []); });
}

// ─── Icons (inline, no extra downloads) ──────────────────────────────────────
const DASH_ICONS = {
  sales:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
  profit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/></svg>',
  income: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .9-3 2.2 0 3.3 6 1.6 6 4.6 0 1.3-1.3 2.2-3 2.2-1.4 0-2.6-.6-3-1.6"/><path d="M12 6v2M12 16v2"/></svg>',
  cash:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></svg>',
};

// ─── Greeting ────────────────────────────────────────────────────────────────
function renderGreeting(tries = 0) {
  const el = document.getElementById('dash-greet');
  if (!el) return;
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  let first = '';
  try { first = String((getCurrentUser() || {}).firstName || '').trim(); } catch (e) { /* not signed in yet */ }
  el.textContent = first ? `${part}, ${first}!` : `${part}!`;
  // The signed-in user's profile loads a moment after the page; try again.
  if (!first && tries < 20) setTimeout(() => renderGreeting(tries + 1), 500);
}

// ─── KPI cards ───────────────────────────────────────────────────────────────
function renderKpis(week) {
  const today = week[week.length - 1];
  const prev  = week[week.length - 2];
  const cards = [
    { key:'sales',   label:'Sales Revenue', cls:'kpi-lime', icon:DASH_ICONS.sales,  href:'sales.html',            title:'Open sales' },
    { key:'gross',   label:'Gross Profit',  cls:'kpi-teal', icon:DASH_ICONS.profit, href:'income-statement.html', title:'Open income statement' },
    { key:'netInc',  label:'Net Income',    cls:'kpi-pink', icon:DASH_ICONS.income, href:'income-statement.html', title:'Open income statement' },
    { key:'netCash', label:'Net Cash',      cls:'kpi-lav',  icon:DASH_ICONS.cash,   href:'reports.html',          title:'Open cash flow report' },
  ];
  const grid = document.getElementById('kpi-grid');
  grid.innerHTML = cards.map((c) => {
    const series = week.map(d => d[c.key]);
    const max = Math.max(...series.map(v => Math.abs(v)), 1);
    const now = today[c.key];
    const was = prev[c.key];
    let delta = '<span>Nothing recorded the day before</span>';
    if (was !== 0) {
      const pct = ((now - was) / Math.abs(was)) * 100;
      const up = pct >= 0;
      delta = `<span class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%</span> vs day before`;
    }
    const bars = series.map((v, i) => {
      const h = Math.max(8, Math.round((Math.abs(v) / max) * 100));
      const cls = [i === series.length - 1 ? 'now' : '', v < 0 ? 'neg' : ''].join(' ').trim();
      return `<i class="${cls}" style="--h:${h}%;--bd:${300 + i * 60}ms" title="${week[i].date}: ${fmtPesoSigned(v)}"></i>`;
    }).join('');
    return `<article class="kpi ${c.cls} tilt reveal">
      <div class="kpi-top">
        <span class="kpi-icon">${c.icon}</span>
        <a class="kpi-more" href="${c.href}" title="${c.title}" aria-label="${c.title}">→</a>
      </div>
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-body">
        <div>
          <div class="kpi-value" data-kpi="${c.key}">${fmtPesoSigned(0)}</div>
          <div class="kpi-delta">${delta}</div>
        </div>
        <div class="kpi-spark" aria-hidden="true">${bars}</div>
      </div>
    </article>`;
  }).join('');
  cards.forEach(c => animateCount(grid.querySelector(`[data-kpi="${c.key}"]`), today[c.key]));
}

// ─── Donut: where each peso of sales went ────────────────────────────────────
let moneyDonut = null;
function renderDonut(day) {
  const canvas = document.getElementById('money-donut');
  const legend = document.getElementById('donut-legend');
  if (!canvas || !legend || typeof Chart === 'undefined') return;
  animateCount(document.getElementById('donut-total'), day.sales);

  const kept = Math.max(0, day.netInc);
  const parts = [
    { label:'Cost of Goods Sold', value:day.cogs,     color:'#f6b9c0', edge:'#e0697a' },
    { label:'Operating Expenses', value:day.expTotal, color:'#c3c4f6', edge:'#6f72e0' },
    { label:'Profit Kept',        value:kept,         color:'#9fdccd', edge:'#3fae96' },
  ];
  const total = parts.reduce((s, p) => s + p.value, 0);
  legend.innerHTML = parts.map(p => `<li>
      <span class="sw" style="background:linear-gradient(135deg,${p.color},${p.edge})"></span>
      <span class="nm">${p.label}</span>
      <span class="pc">${total ? Math.round((p.value / total) * 100) : 0}%</span>
      <span class="am">${formatPeso(p.value)}</span>
    </li>`).join('') +
    (day.netInc < 0 ? `<li class="donut-note">Loss for the day: ${fmtPesoSigned(day.netInc)}</li>` : '');

  if (moneyDonut) { moneyDonut.destroy(); moneyDonut = null; }
  const ctx = canvas.getContext('2d');
  const grad = (c1, c2) => {
    const g = ctx.createLinearGradient(0, 0, 210, 210);
    g.addColorStop(0, c1); g.addColorStop(1, c2); return g;
  };
  moneyDonut = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: total ? parts.map(p => p.label) : ['No sales recorded'],
      datasets: [{
        data: total ? parts.map(p => p.value) : [1],
        backgroundColor: total ? parts.map(p => grad(p.color, p.edge)) : ['#e5e9f0'],
        borderColor: '#fff', borderWidth: 3, borderRadius: 10, spacing: 2, hoverOffset: 10,
      }],
    },
    options: {
      cutout: '64%', responsive: true, maintainAspectRatio: false,
      animation: REDUCED_MOTION ? false : { animateRotate: true, animateScale: true, duration: 1100, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: !!total, callbacks: { label: c => ` ${c.label}: ${formatPeso(c.parsed)}` } },
      },
    },
  });
}

// ─── 3D pill chart: sales for the last 7 days ────────────────────────────────
const PILL_COLORS = [
  ['#f9d3a8', '#e39a4c'], ['#f6b9c0', '#e0697a'], ['#c3c4f6', '#6f72e0'],
  ['#9fdccd', '#3fae96'], ['#f9d3a8', '#e39a4c'], ['#f6b9c0', '#e0697a'],
];
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= v);
}
function shortPeso(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return '₱' + (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return '₱' + (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
  return '₱' + Math.round(v);
}
function renderPillChart(week) {
  const box = document.getElementById('sales-pillchart');
  if (!box) return;
  const max = niceMax(Math.max(...week.map(d => d.sales), 0));
  const ticks = [1, 0.75, 0.5, 0.25, 0].map(f => shortPeso(max * f));
  const cols = week.map((d, i) => {
    const isNow = i === week.length - 1;
    const [c, c2] = isNow ? ['#d6efa0', '#9fcf4a'] : PILL_COLORS[i % PILL_COLORS.length];
    const h = Math.max(0, Math.round((d.sales / max) * 100));
    const dt = new Date(`${d.date}T00:00:00`);
    const day = dt.toLocaleDateString('en-PH', { weekday: 'short' });
    const full = dt.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
    return `<div class="pill-col${isNow ? ' now' : ''}">
      <div class="pill-track">
        <div class="pill-fill-wrap" style="--h:${h}%;--bd:${i * 90}ms;--pc:${c};--pc2:${c2}">
          <div class="pill-fill"></div>
          <span class="pill-dot"></span>
          <div class="pill-tip">${full}<b>${formatPeso(d.sales)}</b></div>
        </div>
      </div>
      <span class="pill-day">${isNow ? 'Selected' : day}</span>
    </div>`;
  }).join('');
  box.classList.remove('grow');
  box.innerHTML = `<div class="pill-axis">${ticks.map(t => `<span>${t}</span>`).join('')}</div>
    <div class="pill-cols">${cols}</div>`;
  // Two frames later, let the bars grow (CSS transition on height).
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('grow')));
}

// ─── Build daily operations summary ──────────────────────────────────────────
function buildDailyOperationsSummary() {
  const d = new Date(`${SNAP_DATE}T00:00:00`);
  const longDate = d.toLocaleDateString('en-PH', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  document.getElementById('snap-headline').textContent =
    `Daily Operations Summary for ${longDate}. All figures are for this day only.`;
  const chip = document.getElementById('dash-day-chip');
  if (chip) chip.textContent = d.toLocaleDateString('en-PH', { month:'short', day:'numeric', year:'numeric' });

  const week = weekDates().map(computeDay);
  const day = week[week.length - 1];
  const { pos, purchases, supplies, esales, inventory, sales, cogs, gross, expTotal, netInc, purOut, supOut, netCash } = day;

  // ── Cards and charts ───────────────────────────────────────────────────────
  renderKpis(week);
  renderDonut(day);
  renderPillChart(week);

  // ── Block 1: Income Summary ────────────────────────────────────────────────
  document.getElementById('snap-is').innerHTML = [
    snapRow('Sales Revenue', sales),
    snapRow('Cost of Goods Sold', -cogs, { sub:true }),
    snapRow('Gross Profit', gross, { total:true }),
    snapRow('Operating Expenses', -expTotal, { sub:true }),
    snapRow('Net Income', netInc, { total:true }),
  ].join('');

  // ── Block 2: Cash Flow ──────────────────────────────────────────────────────
  document.getElementById('snap-cf').innerHTML = [
    snapRow('Sales Collections', sales),
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

  const blocks = document.getElementById('snap-blocks');
  revealIn(blocks);
  initTilt(blocks);

  // "Ask about this report": share the loaded day (and its 7-day trend) with
  // the assistant. Built from data already loaded; no extra reads.
  if (window.EPCChatContext) {
    EPCChatContext.set(`Dashboard, ${longDate}`, () => {
      const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
      const products = {};
      (day.pos || []).forEach((r) => {
        const code = String(r.itemCode || r.productName || '?');
        const p = products[code] || (products[code] = { itemCode: code, name: r.productName || code, revenue: 0, units: 0, cost: 0 });
        p.revenue += Number(r.totalRevenue) || 0; p.units += Number(r.unitsSold) || 0; p.cost += Number(r.totalCost) || 0;
      });
      const list = Object.values(products);
      const row = (p) => [p.itemCode, p.name, r2(p.revenue), Math.round(p.units), r2(p.revenue - p.cost)];
      return {
        report: 'Dashboard (one day)', date: SNAP_DATE, currency: 'PHP',
        selectedDay: {
          salesRevenue: r2(day.sales), costOfGoodsSold: r2(day.cogs), grossProfit: r2(day.gross),
          businessExpenses: r2(day.expTotal), netIncome: r2(day.netInc),
          purchases: r2(day.purOut), supplies: r2(day.supOut), netCash: r2(day.netCash),
          vatOutputFromESales: r2(vatOutput), ewtWithheld: r2(ewtHeld),
          inventoryUnitsIn: Math.round(invIn), inventoryUnitsOut: Math.round(invOut),
          counts: { salesLines: pos.length, purchases: purchases.length, supplyEntries: supplies.length, inventoryMovements: inventory.length },
        },
        last7Days: { columns: ['date', 'salesRevenue', 'grossProfit', 'netIncome', 'netCash'],
          rows: week.map((w) => [w.date, r2(w.sales), r2(w.gross), r2(w.netInc), r2(w.netCash)]) },
        topProductsToday: { columns: ['itemCode', 'name', 'revenue', 'units', 'grossProfit'],
          rows: list.sort((a, b) => b.revenue - a.revenue).slice(0, 15).map(row) },
        slowestProductsToday: { columns: ['itemCode', 'name', 'revenue', 'units', 'grossProfit'],
          rows: list.sort((a, b) => a.revenue - b.revenue).slice(0, 10).map(row) },
      };
    });
  }
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
  body{font-family:Arial,sans-serif;padding:44px;color:#0f172a;font-size:0.875rem;max-width:680px;margin:0 auto}
  h1{font-size:22px;margin:0 0 2px}
  .meta{color:#64748b;font-size:12px;margin:0 0 30px}
  h3{font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#64748b;margin:22px 0 6px;padding-bottom:6px;border-bottom:1px solid #e2e8f0}
  table{width:100%;border-collapse:collapse;margin-bottom:4px}
  td{padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:0.875rem}
  td:last-child{text-align:right;font-family:'Courier New',monospace;white-space:nowrap}
  tr.sub td:first-child{padding-left:24px;color:#64748b}
  tr.total td{font-weight:700;border-top:2px solid #cbd5e1;border-bottom:none;padding-top:10px}
  .pos{color:#15803d} .neg{color:#dc2626}
  .footer{margin-top:36px;font-size:0.75rem;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:12px}
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
// True once the user picked a day (Today, Yesterday or the date box): the Sales
// Pulse then leaves the date alone instead of jumping to the newest import.
let snapTouched = false;
window.EPC_SNAP_TOUCHED = () => snapTouched;
// The line above the greeting names the day under review, not the calendar day.
function paintSnapDateLine() {
  const el = document.getElementById('dash-today');
  if (!el) return;
  const d = new Date(`${SNAP_DATE}T00:00:00`);
  const tag = SNAP_DATE === today ? ' · today' : SNAP_DATE === defaultSnapDate ? ' · yesterday' : '';
  el.textContent = `${d.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}${tag}`;
}
async function setSnapDate(date) {
  SNAP_DATE = date || today;
  const el = document.getElementById('snap-date');
  if (el) el.value = SNAP_DATE;
  paintSnapDateLine();
  // Before the first Generate, just remember the date; the button loads it.
  if (!dailyGate || !dailyGate.hasLoaded()) return;
  await withLoadingPopup('Loading daily summary…', async () => {
    DASH_DATA.pos = await loadSalesForDate(SNAP_DATE);  // one salesDaily/{date} read (cached)
    await loadWeekSales();                               // up to 6 more, for the 7-day charts
    await loadInventoryForDate(SNAP_DATE);               // that day's inventory rows (cached)
    buildDailyOperationsSummary();
  });
}
function setSnapToday() { snapTouched = true; setSnapDate(today); }
function setSnapYesterday() { snapTouched = true; setSnapDate(defaultSnapDate); }

document.getElementById('snap-date').addEventListener('change', function() {
  snapTouched = true;
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
      datasets: [{
        data: items.map(e => e.metric),
        // Shaded, rounded bars (lighter top edge, darker bottom) for a 3D feel.
        backgroundColor: (ctx) => {
          const area = ctx.chart.chartArea;
          if (!area) return color;
          const g = ctx.chart.ctx.createLinearGradient(area.left, 0, area.right, 0);
          g.addColorStop(0, color + 'aa');
          g.addColorStop(1, color);
          return g;
        },
        borderRadius: 999, borderSkipped: false, barPercentage: 0.7, categoryPercentage: 0.8,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: REDUCED_MOTION ? false : {
        duration: 900, easing: 'easeOutQuart',
        delay: (ctx) => (ctx.type === 'data' && ctx.mode === 'default' ? ctx.dataIndex * 110 : 0),
      },
      plugins: {
        legend: { display:false },
        tooltip: { callbacks: { label: ctx => ` ${formatProductMetric(ctx.parsed.x, measure)}` }}
      },
      scales: {
        x: {
          beginAtZero:true,
          min:0,
          title:{ display:true, text:measure === 'pesos' ? 'Sales Value (₱)' : 'Units Sold', color:'#64748b' },
          grid:{ color:'rgba(13,59,53,.06)' }, border:{ display:false },
          ticks:{
            precision:measure === 'units' ? 0 : undefined,
            font:{size:13},
            callback:value => measure === 'pesos'
              ? '₱' + Number(value).toLocaleString('en-PH')
              : Math.round(Number(value)).toLocaleString('en-PH')
          }
        },
        y: { ticks:{ font:{size:13, weight:'500'}, color:'#0d3b35' }, grid:{ display:false }, border:{ display:false } }
      }
    }
  });
}

// Read the saved choices and update the dropdowns and labels (no data reads).
function syncProdControls() {
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
  return { win, measure, range };
}

async function buildProductPerformance() {
  const { measure, range } = syncProdControls();
  const byCode = {};
  const rangeRows = await loadSalesRange(range.from, range.to);  // cheap: docs by id range
  rangeRows.filter(r => {
    const d = snapDateFromRow(r);
    return d >= range.from && d <= range.to;
  }).forEach(r => {
    const code = String(r.itemCode || '').trim();
    if (!code) return;
    if (!byCode[code]) byCode[code] = { units:0, value:0, name:r.productName || code };   // sales days carry the names
    byCode[code].units += Number(r.unitsSold)    || 0;
    byCode[code].value += Number(r.totalRevenue) || 0;
  });

  const entries = Object.entries(byCode)
    .map(([code, v]) => ({
      code,
      name:v.name,
      units:v.units,
      value:v.value,
      metric:measure === 'pesos' ? v.value : v.units
    }))
    .filter(entry => entry.metric > 0)
    .sort((a, b) => b.metric - a.metric);

  makeBarChart('prod-top-chart', entries.slice(0, 5), '#3fae96', measure);
  makeBarChart('prod-slow-chart', [...entries].sort((a, b) => a.metric - b.metric).slice(0, 5), '#e39a4c', measure);
}

function setProdWindow(win) {
  setTimeout(() => window.dispatchEvent(new Event('epc-cost-change')), 0);
  let previous = {};
  try { previous = JSON.parse(localStorage.getItem(PROD_PERF_KEY) || '{}'); } catch(e) {}
  const st = { ...previous, window:win };
  if (win === 'custom') {
    st.from = document.getElementById('prod-from')?.value || '';
    st.to   = document.getElementById('prod-to')?.value   || '';
  }
  localStorage.setItem(PROD_PERF_KEY, JSON.stringify(st));
  refreshProdIfLoaded();
}

function setProdMeasure(measure) {
  let st = {};
  try { st = JSON.parse(localStorage.getItem(PROD_PERF_KEY) || '{}'); } catch(e) {}
  st.measure = measure === 'pesos' ? 'pesos' : 'units';
  localStorage.setItem(PROD_PERF_KEY, JSON.stringify(st));
  refreshProdIfLoaded();
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
  refreshProdIfLoaded();
}

// Changing a dropdown never reads data by itself before the first Generate
// (each read costs money). After that, it refreshes the charts right away.
function refreshProdIfLoaded() {
  if (prodGate && prodGate.hasLoaded()) prodGate.run();
  else syncProdControls();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.getElementById('snap-date').value = defaultSnapDate;
paintSnapDateLine();

// Data is not loaded on page open — the user must click "Generate Report".
// Each click = paid Firestore reads, so the buttons guard against double-clicks.
// The page has two separate buttons:
//   • top (date bar)            → Daily Operations Summary for the picked day
//   • Product Performance card  → best/slowest products for the picked range
let dailyGate = null;
let prodGate = null;

dailyGate = EPCReportGate.wire({
  button: 'dash-generate-btn',
  popup: false,   // this page shows its own loader
  status: 'dash-gen-status',
  costLine: 'dash-cost-line',
  // One sales day, the day's inventory rows and the saved copies of the rest.
  estimate: () => [
    { fixed: 1, label: 'salesDaily', note: 'the chosen day' },
    { fixed: 1, label: 'inventoryData', note: 'the chosen day' },
    { saved: 'purchases' }, { saved: 'suppliesData' }, { saved: 'eSalesRecords' }, { saved: 'expenses' },
  ],
  refreshLabel: 'Generate Report',
  load: () => withLoadingPopup('Loading daily summary…', async () => {
    try {
      await loadDashData();
      await loadWeekSales();
    } catch (err) {
      console.error('[Dashboard] Data load error:', err);
    }
    const empty = document.getElementById('dash-empty-state');
    if (empty) empty.style.display = 'none';
    const blocks = document.getElementById('snap-blocks');
    if (blocks) blocks.style.display = '';
    // Show the section first so the charts can measure their size.
    buildDailyOperationsSummary();
  })
});

prodGate = EPCReportGate.wire({
  button: 'prod-generate-btn',
  popup: false,   // this page shows its own loader
  status: 'prod-gen-status',
  costLine: 'prod-cost-line',
  estimate: () => {
    let st = {};
    try { st = JSON.parse(localStorage.getItem(PROD_PERF_KEY) || '{}'); } catch (e) {}
    const range = prodWindowRange(st.window || 'month', st.from, st.to);
    // Days the Sales Pulse already handed over cost nothing.
    const have = EPCReads.daysBetween(range.from, range.to).filter(d => _salesDailyCache.has(d)).length;
    const all = EPCReads.daysBetween(range.from, range.to).length;
    return all - have > 0
      ? [{ fixed: all - have, label: 'salesDaily', note: `${all - have} day${all - have === 1 ? '' : 's'} not loaded yet` }]
      : [{ fixed: 0, label: 'salesDaily', note: 'already loaded' }];
  },
  refreshLabel: 'Generate Report',
  load: () => withLoadingPopup('Loading product performance…', async () => {
    // Show the grid first so Chart.js can measure the canvas size.
    const grid = document.getElementById('prod-charts-grid');
    if (grid) grid.style.display = '';
    const empty = document.getElementById('prod-empty-state');
    if (empty) empty.style.display = 'none';
    await buildProductPerformance();
  })
});

syncProdControls();
renderGreeting();
revealIn(document);
initTilt(document);

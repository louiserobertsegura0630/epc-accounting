// ─── Sales analysis (Reports → Sales → "Sales analysis") ──────────────────────
// KPIs, sales trend, day-of-week pattern, categories, ABC classes, biggest
// movers and a per-product offtake table.
//
// Cost: nothing of its own. Everything is worked out from the sales days that
// Generate Report already loaded (REPORT_DATA.sales) plus the same number of
// days just before (salesPrevious, loaded by reports.js on Generate) for the
// "vs before" comparisons.
// Unlike the Overview, sales WITHOUT a cost are counted here (offtake and
// sales totals need every product); profit and margin use only the part that
// has a cost, and the "Sales with a cost" card says how big that part is.
// Every figure has an "i" with its definition: an element with class
// "info-def" right after a label (initInfoTips in app.js turns it into the icon).
// Loaded after reports.js and shares its helpers (escReport, formatPeso, …).
(function initSalesAnalysis() {
  const root = document.getElementById('sales-analysis');
  if (!root) return;

  const PAGE_SIZE = 25;
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const C = { revenue: '#2a9d8a', avg: '#0d3b35', prev: '#94a3b8', grid: 'rgba(13,59,53,.06)', ink: '#0d3b35', muted: '#5b706b' };
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const state = { search: '', abc: '', sortKey: 'revenue', sortDir: 'desc', page: 1 };
  const charts = {};
  let model = null;

  // ── Definitions shown by the "i" icons ──────────────────────────────────────
  const DEF = {
    sales: 'All sales in pesos for the dates chosen. Every product counts, with or without a cost.',
    units: 'How many pieces were sold in the dates chosen.',
    ads: 'Average daily sales (ADS): total sales divided by the number of days that had sales.',
    offtake: 'Offtake: how many pieces leave the shelf per day. Units sold divided by the number of days that had sales.',
    asp: 'Average selling price: total sales divided by units sold. What one piece sold for, on average.',
    profit: 'Gross profit: sales minus the cost of the goods sold. Only products that have a cost are counted.',
    margin: 'Gross margin: gross profit as a share of sales. Out of every ₱100 sold, how many pesos are profit. Only products that have a cost are counted.',
    markup: 'Markup: gross profit as a share of cost. How much was added on top of the cost. Only products that have a cost are counted.',
    products: 'How many different products had at least one sale. New = sold now but not in the days before. Stopped = sold in the days before but not now.',
    perProduct: 'Total sales divided by the number of products sold.',
    top10: 'The share of total sales that comes from the 10 best-selling products. A high number means sales depend on a few products.',
    days: 'Days in the chosen dates that had at least one sale. A missing day can be a closed day, or a sales file that was not uploaded.',
    bestDay: 'The single day with the highest sales in the dates chosen.',
    coverage: 'The share of sales that comes from products with a known cost. Profit, margin and markup are worked out from this part only.',
    trend: 'Sales for each day. The dashed line is the 7-day average, which smooths out busy and quiet days. The grey line is the same number of days just before, for comparison.',
    weekday: 'Average sales for each day of the week, counting only days that had sales.',
    categories: 'Sales grouped by product category. Share = that category’s part of total sales. Margin counts only products with a cost.',
    abc: 'ABC analysis sorts products from best seller to weakest. A = the products that bring in the first 80% of sales. B = the next 15%. C = the last 5%. A products need the most attention on stock.',
    gains: 'Products whose sales in pesos grew the most against the same number of days just before.',
    drops: 'Products whose sales in pesos fell the most against the same number of days just before. ₱0 now means the product stopped selling.',
    table: 'One row per product sold in the dates chosen, with its item code and category under the name. Click a column name to sort. Export CSV saves every row and more columns.',
    colOfftake: 'Offtake per day: units sold divided by the number of days the store had sales.',
    colDays: 'On how many of the selling days this product was sold. A low number means it sells only now and then.',
    colShare: 'This product’s part of total sales.',
    colAbc: 'A = the products that bring in the first 80% of sales, B = the next 15%, C = the last 5%.',
    colAsp: 'Average selling price: sales divided by units.',
    colMargin: 'Gross margin: profit as a share of sales. Blank when the product has no cost yet.',
    colChange: 'Change in sales against the same number of days just before. New = no sales in the days before.',
  };

  // ── Small helpers ───────────────────────────────────────────────────────────
  const esc = (t) => escReport(t);
  const dObj = (iso) => new Date(`${iso}T00:00:00`);
  const shift = (iso, n) => { const d = dObj(iso); d.setDate(d.getDate() + n); return localReportIsoDate(d); };
  const fmtDay = (iso, opts) => dObj(iso).toLocaleDateString('en-PH', opts);
  const shortDay = (iso) => fmtDay(iso, { month: 'short', day: 'numeric' });
  const longDay = (iso) => fmtDay(iso, { weekday: 'short', month: 'short', day: 'numeric' });
  const rangeText = (from, to) => `${shortDay(from)} – ${fmtDay(to, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const daysBetween = (from, to) => Math.round((dObj(to) - dObj(from)) / 86400000) + 1;
  const num = (v, dp = 0) => Number(v || 0).toLocaleString('en-PH', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const pct = (v, dp = 1) => `${Number(v || 0).toFixed(dp)}%`;
  const shortPeso = (v) => (Math.abs(v) >= 1e6 ? `₱${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e4 ? `₱${(v / 1e3).toFixed(0)}k`
    : Math.abs(v) >= 1e3 ? `₱${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k` : `₱${Math.round(v)}`);
  const change = (now, before) => (before ? ((now - before) / Math.abs(before)) * 100 : null);
  const def = (key) => `<span class="info-def">${esc(DEF[key])}</span>`;

  // ── Analyse ─────────────────────────────────────────────────────────────────
  // One plain row per product per day. Cost uses the same sources, in the same
  // order, as the Overview (item cost, then the sales day, then Product Master),
  // but a row without a cost is kept, with cost 0.
  function plainRows(source, withCost) {
    const method = localStorage.getItem('costMethod') === 'average' ? 'average' : 'latest';
    const costs = withCost ? reportInventoryUnitCostMap() : {};
    const products = withCost ? reportProductMap() : {};
    const rows = [];
    source.forEach((row) => {
      if (reportSalesCategory && row.category !== reportSalesCategory) return;
      const units = Number(row.unitsSold) || 0;
      const revenue = Number(row.totalRevenue) || 0;
      if (!units && !revenue) return;
      const code = String(row.itemCode || row.code || '').trim();
      let cost = 0;
      if (withCost) {
        const unitCost = Number(costs[code] || costs[code.toUpperCase()]) || Number(row.unitCost) ||
          reportProductCost(products[code] || products[code.toUpperCase()], method);
        cost = unitCost > 0 ? unitCost * units : 0;
      }
      rows.push({ date: row.date, code, name: row.productName || code || 'Unknown', category: row.category || 'Uncategorized', units, revenue, cost });
    });
    return rows;
  }
  function byProduct(rows) {
    const map = new Map();
    rows.forEach((r) => {
      const key = r.code || r.name;
      const p = map.get(key) || { key, code: r.code, name: r.name, category: r.category, units: 0, revenue: 0, cost: 0, costed: 0, days: new Set() };
      p.units += r.units; p.revenue += r.revenue; p.days.add(r.date);
      if (r.cost > 0) { p.cost += r.cost; p.costed += r.revenue; }
      map.set(key, p);
    });
    return map;
  }

  function buildModel() {
    const startInput = (document.getElementById('report-start') || {}).value || '';
    const endInput = (document.getElementById('report-end') || {}).value || '';
    const rows = plainRows(REPORT_DATA.sales.filter(inReportRange), true);
    if (!rows.length) return null;

    // The period: a range that is still running (This Month) ends at the latest day with sales.
    const byDate = {};
    rows.forEach((r) => { const d = byDate[r.date] || (byDate[r.date] = { revenue: 0, units: 0 }); d.revenue += r.revenue; d.units += r.units; });
    const saleDates = Object.keys(byDate).sort();
    const today = localReportIsoDate(new Date());
    const start = startInput || saleDates[0];
    const end = endInput && endInput < today ? endInput : saleDates[saleDates.length - 1];
    const calendar = []; for (let d = start; d <= end; d = shift(d, 1)) calendar.push(d);
    const sellingDays = saleDates.length;

    // The same number of days just before, if Generate Report loaded them for these dates.
    const prevStart = shift(start, -calendar.length);
    const prevEnd = shift(start, -1);
    const hasPrev = !!startInput && salesPrevious.key === `${startInput}|${endInput}`;
    const prevRows = hasPrev ? plainRows(salesPrevious.rows, false).filter((r) => r.date >= prevStart && r.date <= prevEnd) : [];
    const prevByDate = {};
    prevRows.forEach((r) => { prevByDate[r.date] = (prevByDate[r.date] || 0) + r.revenue; });
    const prevProducts = byProduct(prevRows);
    const prev = {
      has: hasPrev, any: prevRows.length > 0, start: prevStart, end: prevEnd,
      revenue: prevRows.reduce((s, r) => s + r.revenue, 0),
      units: prevRows.reduce((s, r) => s + r.units, 0),
      sellingDays: Object.keys(prevByDate).length,
      products: prevProducts.size,
    };

    // Totals
    const t = { revenue: 0, units: 0, cost: 0, costed: 0 };
    rows.forEach((r) => { t.revenue += r.revenue; t.units += r.units; if (r.cost > 0) { t.cost += r.cost; t.costed += r.revenue; } });
    t.profit = t.costed - t.cost;

    // Products, ranked by sales, with share, running share and ABC class
    const products = [...byProduct(rows).values()].sort((a, b) => b.revenue - a.revenue);
    let running = 0;
    products.forEach((p, i) => {
      const before = t.revenue > 0 ? (running / t.revenue) * 100 : 100;
      running += p.revenue;
      const was = prevProducts.get(p.key);
      p.rank = i + 1;
      p.share = t.revenue > 0 ? (p.revenue / t.revenue) * 100 : 0;
      p.cum = t.revenue > 0 ? (running / t.revenue) * 100 : 0;
      p.abc = p.revenue > 0 && before < 80 ? 'A' : p.revenue > 0 && before < 95 ? 'B' : 'C';
      p.offtake = sellingDays ? p.units / sellingDays : 0;
      p.daysSold = p.days.size;
      p.asp = p.units ? p.revenue / p.units : 0;
      p.margin = p.costed > 0 ? ((p.costed - p.cost) / p.costed) * 100 : null;
      p.prevRevenue = was ? was.revenue : 0;
      p.isNew = prev.any && !was;
      p.change = prev.any ? change(p.revenue, p.prevRevenue) : null;
    });
    const soldNow = new Set(products.map((p) => p.key));
    const stopped = [...prevProducts.values()].filter((p) => !soldNow.has(p.key));

    // ABC classes
    const abc = ['A', 'B', 'C'].map((cls) => {
      const list = products.filter((p) => p.abc === cls);
      const revenue = list.reduce((s, p) => s + p.revenue, 0);
      return { cls, count: list.length, countShare: products.length ? (list.length / products.length) * 100 : 0, revenue, share: t.revenue > 0 ? (revenue / t.revenue) * 100 : 0 };
    });

    // Categories
    const catMap = new Map();
    products.forEach((p) => {
      const c = catMap.get(p.category) || { name: p.category, revenue: 0, units: 0, cost: 0, costed: 0, products: 0, prevRevenue: 0 };
      c.revenue += p.revenue; c.units += p.units; c.cost += p.cost; c.costed += p.costed; c.products += 1;
      catMap.set(p.category, c);
    });
    prevProducts.forEach((p) => { const c = catMap.get(p.category); if (c) c.prevRevenue += p.revenue; });
    const categories = [...catMap.values()].sort((a, b) => b.revenue - a.revenue).map((c) => ({
      ...c,
      share: t.revenue > 0 ? (c.revenue / t.revenue) * 100 : 0,
      margin: c.costed > 0 ? ((c.costed - c.cost) / c.costed) * 100 : null,
      change: prev.any ? change(c.revenue, c.prevRevenue) : null,
    }));

    // Movers: biggest peso change against the days before (a stopped product counts as ₱0 now)
    const moves = products.map((p) => ({ name: p.name, code: p.code, before: p.prevRevenue, now: p.revenue }))
      .concat(stopped.map((p) => ({ name: p.name, code: p.code, before: p.revenue, now: 0 })))
      .map((m) => ({ ...m, diff: m.now - m.before, change: change(m.now, m.before) }));
    const gains = prev.any ? moves.filter((m) => m.diff > 0).sort((a, b) => b.diff - a.diff).slice(0, 10) : [];
    const drops = prev.any ? moves.filter((m) => m.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 10) : [];

    // Day of the week (Monday first), averaged over days that had sales
    const wdSum = Array(7).fill(0); const wdCount = Array(7).fill(0);
    saleDates.forEach((d) => { const i = (dObj(d).getDay() + 6) % 7; wdSum[i] += byDate[d].revenue; wdCount[i] += 1; });
    const wdAvg = wdSum.map((s, i) => (wdCount[i] ? s / wdCount[i] : 0));
    const bestWd = wdAvg.indexOf(Math.max(...wdAvg));

    const bestDay = saleDates.reduce((a, d) => (byDate[d].revenue > byDate[a].revenue ? d : a), saleDates[0]);
    const worstDay = saleDates.reduce((a, d) => (byDate[d].revenue < byDate[a].revenue ? d : a), saleDates[0]);
    const top10 = products.slice(0, 10).reduce((s, p) => s + p.revenue, 0);

    return {
      start, end, calendar, saleDates, sellingDays, byDate, prev, prevByDate, t, products, abc, categories, gains, drops,
      missing: calendar.filter((d) => !byDate[d]),
      newCount: products.filter((p) => p.isNew).length, stoppedCount: stopped.length,
      weekday: { avg: wdAvg, best: bestWd },
      bestDay, worstDay,
      top10Share: t.revenue > 0 ? (top10 / t.revenue) * 100 : 0,
      kpi: {
        ads: sellingDays ? t.revenue / sellingDays : 0,
        offtake: sellingDays ? t.units / sellingDays : 0,
        asp: t.units ? t.revenue / t.units : 0,
        margin: t.costed > 0 ? (t.profit / t.costed) * 100 : null,
        markup: t.cost > 0 ? (t.profit / t.cost) * 100 : null,
        coverage: t.revenue > 0 ? (t.costed / t.revenue) * 100 : 0,
        perProduct: products.length ? t.revenue / products.length : 0,
        prevAds: prev.sellingDays ? prev.revenue / prev.sellingDays : 0,
        prevOfftake: prev.sellingDays ? prev.units / prev.sellingDays : 0,
      },
    };
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  const beforeWords = (m) => `the ${m.calendar.length} day${m.calendar.length === 1 ? '' : 's'} before`;
  // "▲ 4.2% vs the 17 days before", or why there is nothing to compare.
  function deltaLine(m, now, before) {
    if (!m.prev.has) return '<span class="sa-flat">Click Generate Report to compare with the days before</span>';
    const c = m.prev.any ? change(now, before) : null;
    if (c == null) return `<span class="sa-flat">No sales in ${esc(beforeWords(m))} to compare</span>`;
    return `<span class="${c >= 0 ? 'sa-up' : 'sa-down'}"><b>${c >= 0 ? '▲' : '▼'} ${pct(Math.abs(c))}</b></span> vs ${esc(beforeWords(m))}`;
  }
  function changeCell(c, isNew) {
    if (isNew) return '<span class="sa-chip">New</span>';
    if (c == null) return '<span class="sa-flat">—</span>';
    return `<span class="${c >= 0 ? 'sa-up' : 'sa-down'}">${c >= 0 ? '▲' : '▼'} ${pct(Math.abs(c))}</span>`;
  }
  const card = (label, key, value, sub = '') => `<div class="summary-card sa-kpi">
      <div class="kpi-label">${esc(label)}</div>${def(key)}
      <div class="kpi-value">${value}</div>
      ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    </div>`;
  const head = (title, key, extra = '') => `<div class="sa-hd"><h3>${esc(title)}</h3>${def(key)}${extra}</div>`;
  const nameCell = (name, sub) => `<td class="sa-name">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ''}</td>`;
  const noCompare = (m) => `<div class="empty-state"><p>${m.prev.has ? `No sales in ${esc(beforeWords(m))} to compare.` : 'Click Generate Report to compare with the days before.'}</p></div>`;

  function kpiCards(m) {
    const k = m.kpi; const t = m.t;
    const costNote = k.coverage >= 99.5 ? '' : t.costed > 0 ? `Based on the ${pct(k.coverage, 0)} of sales that have a cost` : 'No product has a cost yet';
    const missing = m.missing.length
      ? `No sales on ${m.missing.slice(0, 3).map(shortDay).join(', ')}${m.missing.length > 3 ? ` and ${m.missing.length - 3} more` : ''}`
      : 'Every day has sales';
    const classA = m.abc[0];
    return [
      card('Sales', 'sales', formatPeso(t.revenue), deltaLine(m, t.revenue, m.prev.revenue)),
      card('Units sold', 'units', num(t.units), deltaLine(m, t.units, m.prev.units)),
      card('Average daily sales', 'ads', formatPeso(k.ads), deltaLine(m, k.ads, k.prevAds)),
      card('Offtake per day', 'offtake', `${num(k.offtake, 1)} units`, deltaLine(m, k.offtake, k.prevOfftake)),
      card('Average selling price', 'asp', formatPeso(k.asp), 'Per unit sold'),
      card('Gross profit', 'profit', t.costed > 0 ? formatPeso(t.profit) : '—', esc(costNote)),
      card('Gross margin', 'margin', k.margin == null ? '—' : pct(k.margin), esc(costNote)),
      card('Markup', 'markup', k.markup == null ? '—' : pct(k.markup), esc(costNote)),
      card('Products sold', 'products', num(m.products.length),
        m.prev.any ? `${num(m.newCount)} new · ${num(m.stoppedCount)} stopped vs ${esc(beforeWords(m))}` : ''),
      card('Sales per product', 'perProduct', formatPeso(k.perProduct), 'Average per product sold'),
      card('Top 10 share of sales', 'top10', pct(m.top10Share),
        `${num(classA.count)} product${classA.count === 1 ? '' : 's'} bring in 80% of sales`),
      card('Selling days', 'days', `${num(m.sellingDays)} of ${num(m.calendar.length)}`, esc(missing)),
      card('Best day', 'bestDay', formatPeso(m.byDate[m.bestDay].revenue),
        `${esc(longDay(m.bestDay))}${m.sellingDays > 1 ? ` · weakest ${esc(longDay(m.worstDay))}, ${formatPeso(m.byDate[m.worstDay].revenue)}` : ''}`),
      card('Sales with a cost', 'coverage', pct(k.coverage), 'Used for profit, margin and markup'),
    ].join('');
  }

  function categoryTable(m) {
    return `<div class="table-scroll"><table class="sa-table">
      <thead><tr><th>Category</th><th class="num">Sales</th><th class="num">Share</th><th class="num">Units</th><th class="num">Margin</th><th class="num">vs before</th></tr></thead>
      <tbody>${m.categories.map((c) => `<tr>
        ${nameCell(c.name, `${num(c.products)} product${c.products === 1 ? '' : 's'}`)}<td class="num">${formatPeso(c.revenue)}</td><td class="num">${pct(c.share)}</td>
        <td class="num">${num(c.units)}</td>
        <td class="num">${c.margin == null ? '<span class="sa-flat">—</span>' : pct(c.margin)}</td><td class="num">${changeCell(c.change, false)}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }
  function abcTable(m) {
    const meaning = { A: 'First 80%', B: 'Next 15%', C: 'Last 5%' };   // of sales; the "i" explains
    return `<div class="table-scroll"><table class="sa-table">
      <thead><tr><th>Class</th><th class="num">Products</th><th class="num">Sales</th></tr></thead>
      <tbody>${m.abc.map((a) => `<tr>
        <td class="sa-abc-cell"><span class="sa-abc sa-abc-${a.cls.toLowerCase()}">${a.cls}</span> ${meaning[a.cls]}</td>
        <td class="num">${num(a.count)}<small>${pct(a.countShare)} of products</small></td>
        <td class="num">${formatPeso(a.revenue)}<small>${pct(a.share)} of sales</small></td>
      </tr>`).join('')}</tbody></table></div>`;
  }
  function moversTable(m, list, emptyText) {
    if (!m.prev.any) return noCompare(m);
    if (!list.length) return `<div class="empty-state"><p>${esc(emptyText)}</p></div>`;
    return `<div class="table-scroll"><table class="sa-table sa-movers">
      <thead><tr><th>Product</th><th class="num">Before</th><th class="num">Now</th><th class="num">Change</th></tr></thead>
      <tbody>${list.map((x) => `<tr>
        ${nameCell(x.name, x.code)}<td class="num">${formatPeso(x.before)}</td><td class="num">${formatPeso(x.now)}</td>
        <td class="num"><span class="${x.diff >= 0 ? 'sa-up' : 'sa-down'}">${x.diff >= 0 ? '+' : '−'}${formatPeso(Math.abs(x.diff))}</span><small>${changeCell(x.change, x.before === 0)}</small></td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  // ── Product offtake table ───────────────────────────────────────────────────
  const COLUMNS = [
    { key: 'rank', label: '#', num: true },
    { key: 'name', label: 'Product' },
    { key: 'units', label: 'Units', num: true },
    { key: 'offtake', label: 'Offtake / day', num: true, def: 'colOfftake' },
    { key: 'daysSold', label: 'Days sold', num: true, def: 'colDays' },
    { key: 'revenue', label: 'Sales', num: true },
    { key: 'share', label: 'Share', num: true, def: 'colShare' },
    { key: 'abc', label: 'ABC', def: 'colAbc' },
    { key: 'asp', label: 'Avg price', num: true, def: 'colAsp' },
    { key: 'margin', label: 'Margin', num: true, def: 'colMargin' },
    { key: 'change', label: 'vs before', num: true, def: 'colChange' },
  ];
  function tableRows(m) {
    const q = state.search.trim().toLowerCase();
    const list = m.products
      .filter((p) => !state.abc || p.abc === state.abc)
      .filter((p) => !q || `${p.name} ${p.code} ${p.category}`.toLowerCase().includes(q));
    const k = state.sortKey; const dir = state.sortDir === 'asc' ? 1 : -1;
    const text = k === 'name' || k === 'abc';
    return list.sort((a, b) => {
      if (text) return String(a[k]).localeCompare(String(b[k])) * dir || a.rank - b.rank;
      if (a[k] == null || b[k] == null) return (a[k] == null) - (b[k] == null) || a.rank - b.rank;   // blanks last
      return (a[k] - b[k]) * dir || a.rank - b.rank;
    });
  }
  function renderTable() {
    const m = model; const box = document.getElementById('sa-table-box');
    if (!m || !box) return;
    const list = tableRows(m);
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    state.page = Math.min(Math.max(1, state.page), pages);
    const from = (state.page - 1) * PAGE_SIZE;
    const arrow = (key) => (state.sortKey === key ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : '');
    box.innerHTML = `<div class="table-scroll"><table class="sa-table sa-offtake">
      <thead><tr>${COLUMNS.map((c) => `<th class="${c.num ? 'num ' : ''}sa-sort" data-sa-sort="${c.key}" title="Sort by ${esc(c.label)}"><span>${esc(c.label)}${arrow(c.key)}</span>${c.def ? def(c.def) : ''}</th>`).join('')}</tr></thead>
      <tbody>${list.length ? list.slice(from, from + PAGE_SIZE).map((p) => `<tr>
        <td class="num">${p.rank}</td>${nameCell(p.name, [p.code, p.category].filter(Boolean).join(' · '))}
        <td class="num">${num(p.units)}</td><td class="num">${num(p.offtake, 2)}</td><td class="num">${num(p.daysSold)} / ${num(m.sellingDays)}</td>
        <td class="num">${formatPeso(p.revenue)}</td><td class="num">${pct(p.share, 2)}</td>
        <td><span class="sa-abc sa-abc-${p.abc.toLowerCase()}">${p.abc}</span></td><td class="num">${formatPeso(p.asp)}</td>
        <td class="num">${p.margin == null ? '<span class="sa-flat">—</span>' : pct(p.margin)}</td><td class="num">${changeCell(p.change, p.isNew)}</td>
      </tr>`).join('') : `<tr><td colspan="${COLUMNS.length}"><div class="empty-state"><p>No products match.</p></div></td></tr>`}</tbody></table></div>
      <div class="inventory-pagination">
        <span>Showing ${list.length ? from + 1 : 0}–${Math.min(from + PAGE_SIZE, list.length)} of ${num(list.length)} products</span>
        <button class="btn btn-outline-gray btn-sm" type="button" data-sa-page="${state.page - 1}" ${state.page === 1 ? 'disabled' : ''}>Prev</button>
        <span>Page ${state.page} / ${pages}</span>
        <button class="btn btn-outline-gray btn-sm" type="button" data-sa-page="${state.page + 1}" ${state.page === pages ? 'disabled' : ''}>Next</button>
      </div>`;
  }
  function exportCsv() {
    const m = model; if (!m) return;
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Rank', 'Product', 'Item code', 'Category', 'Units', 'Offtake per day', 'Days sold', 'Selling days', 'Sales', 'Share %', 'Running share %', 'ABC', 'Average price', 'Margin %', 'Sales in the days before', 'Change %'].map(cell).join(',')];
    tableRows(m).forEach((p) => lines.push([
      p.rank, p.name, p.code, p.category, p.units, p.offtake.toFixed(2), p.daysSold, m.sellingDays, p.revenue.toFixed(2), p.share.toFixed(2), p.cum.toFixed(2), p.abc,
      p.asp.toFixed(2), p.margin == null ? '' : p.margin.toFixed(2), m.prev.any ? p.prevRevenue.toFixed(2) : '', p.isNew ? 'New' : p.change == null ? '' : p.change.toFixed(2),
    ].map(cell).join(',')));
    const link = document.createElement('a');
    link.download = `epc-sales-offtake-${m.start}-to-${m.end}.csv`;
    link.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }));   // BOM so Excel reads ₱ and ñ correctly
    link.click();
    URL.revokeObjectURL(link.href);
  }

  // ── Charts ──────────────────────────────────────────────────────────────────
  function destroyCharts() { Object.keys(charts).forEach((k) => { charts[k].destroy(); delete charts[k]; }); }
  const baseOpts = () => ({
    responsive: true, maintainAspectRatio: false,
    animation: REDUCED ? false : { duration: 700, easing: 'easeOutQuart' },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom', align: 'start', labels: { usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 16, color: C.ink, font: { family: 'Figtree', size: 13 } } },
      tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y == null ? 'no sales' : formatPeso(ctx.parsed.y)}` } },
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: C.muted, font: { size: 12 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
      y: { beginAtZero: true, grid: { color: C.grid }, border: { display: false }, ticks: { color: C.muted, font: { size: 12 }, callback: (v) => shortPeso(Number(v)) } },
    },
  });
  function drawCharts(m) {
    destroyCharts();
    if (typeof Chart === 'undefined') return;
    const revenue = m.calendar.map((d) => (m.byDate[d] ? m.byDate[d].revenue : null));
    // 7-day average over the days that had sales
    const avg7 = m.calendar.map((d) => {
      let sum = 0; let n = 0;
      for (let i = 0; i < 7; i++) { const day = m.byDate[shift(d, -i)]; if (day) { sum += day.revenue; n += 1; } }
      return n ? sum / n : null;
    });
    const datasets = [
      { __epcPastel: true, type: 'line', label: '7-day average', data: avg7, borderColor: C.avg, backgroundColor: C.avg, borderWidth: 2, borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 4, tension: 0.35, spanGaps: true, order: 1 },
      { type: 'bar', label: 'Sales', data: revenue, backgroundColor: C.revenue, borderRadius: 4, barPercentage: 0.72, categoryPercentage: 0.9, order: 3 },
    ];
    if (m.prev.any) {
      datasets.splice(1, 0, { __epcPastel: true, type: 'line', label: `The ${m.calendar.length} days before`, data: m.calendar.map((d, i) => m.prevByDate[shift(m.prev.start, i)] ?? null),
        borderColor: C.prev, backgroundColor: C.prev, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.3, spanGaps: true, order: 2 });
    }
    charts.trend = new Chart(document.getElementById('sa-trend'), {
      data: { labels: m.calendar.map(shortDay), datasets },
      options: baseOpts(),
    });

    const wdOpts = baseOpts();
    wdOpts.plugins.legend.display = false;
    wdOpts.plugins.tooltip.callbacks.label = (ctx) => ` Average sales: ${formatPeso(ctx.parsed.y)}`;
    charts.weekday = new Chart(document.getElementById('sa-weekday'), {
      type: 'bar',
      data: { labels: WEEKDAYS, datasets: [{ __epcPastel: true, label: 'Average sales', data: m.weekday.avg,
        backgroundColor: m.weekday.avg.map((v, i) => (i === m.weekday.best && v > 0 ? C.avg : C.revenue)), borderRadius: 6, barPercentage: 0.7 }] },
      options: wdOpts,
    });
  }

  function render() {
    model = buildModel();
    destroyCharts();
    if (!model) {
      root.innerHTML = '<div class="card"><div class="empty-state"><p>No sales in these dates.</p></div></div>';
      return;
    }
    const m = model;
    state.page = 1;
    const compare = !m.prev.has ? '' : m.prev.any ? ` · compared with ${esc(rangeText(m.prev.start, m.prev.end))}` : ` · no sales in ${esc(rangeText(m.prev.start, m.prev.end))} to compare`;
    root.innerHTML = `
      <p class="sa-period"><b>${esc(rangeText(m.start, m.end))}</b> · ${num(m.calendar.length)} day${m.calendar.length === 1 ? '' : 's'}${compare}${reportSalesCategory ? ` · ${esc(reportSalesCategory)} only` : ''}</p>
      <div class="summary-row sa-kpis">${kpiCards(m)}</div>
      <div class="sa-grid sa-grid-7-5">
        <section class="card">${head('Sales trend', 'trend')}<div class="sa-chart"><canvas id="sa-trend" role="img" aria-label="Sales for each day with a 7-day average"></canvas></div></section>
        <section class="card">${head('Day of the week', 'weekday')}<div class="sa-chart"><canvas id="sa-weekday" role="img" aria-label="Average sales by day of the week"></canvas></div></section>
      </div>
      <div class="sa-grid sa-grid-7-5">
        <section class="card">${head('Categories', 'categories')}${categoryTable(m)}</section>
        <section class="card">${head('ABC classes', 'abc')}${abcTable(m)}</section>
      </div>
      <div class="sa-grid sa-grid-2">
        <section class="card">${head('Biggest gains', 'gains')}${moversTable(m, m.gains, 'No product sold more than before.')}</section>
        <section class="card">${head('Biggest drops', 'drops')}${moversTable(m, m.drops, 'No product sold less than before.')}</section>
      </div>
      <section class="card">
        ${head('Product offtake', 'table', `<div class="sa-tools">
          <input type="search" class="search-input" id="sa-search" placeholder="Search product, code or category" value="${esc(state.search)}" aria-label="Search products">
          <select class="form-select" id="sa-abc" aria-label="ABC class">
            <option value="">All classes</option>${['A', 'B', 'C'].map((c) => `<option value="${c}"${state.abc === c ? ' selected' : ''}>Class ${c}</option>`).join('')}
          </select>
          <button class="btn btn-outline-gray btn-sm" type="button" id="sa-export">Export CSV</button>
        </div>`)}
        <div id="sa-table-box"></div>
      </section>`;
    renderTable();
    drawCharts(m);
  }

  // ── Table controls (one listener each, on the section) ─────────────────────
  root.addEventListener('click', (e) => {
    if (e.target.closest('.info-tip')) return;
    if (e.target.closest('#sa-export')) { exportCsv(); return; }
    const page = e.target.closest('[data-sa-page]');
    if (page) { state.page = Number(page.dataset.saPage); renderTable(); return; }
    const sort = e.target.closest('[data-sa-sort]');
    if (sort) {
      const key = sort.dataset.saSort;
      const text = key === 'name' || key === 'abc' || key === 'rank';
      if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortKey = key; state.sortDir = text ? 'asc' : 'desc'; }
      state.page = 1;
      renderTable();
    }
  });
  root.addEventListener('input', (e) => {
    if (e.target.id === 'sa-search') { state.search = e.target.value; state.page = 1; renderTable(); }
  });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'sa-abc') { state.abc = e.target.value; state.page = 1; renderTable(); }
  });

  window.renderSalesAnalysis = render;
})();

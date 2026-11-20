// ─── Sales Pulse ──────────────────────────────────────────────────────────────
// Loads on page open (no Generate click) and analyses the latest sales imports:
// latest day, 30-day trend, month so far, weekday pattern, top products,
// movers, margin watch and missing days.
//
// Cost: the first open on a browser reads one salesDaily day-doc per day in the
// last 92 days and keeps them in IndexedDB. After that the saved copy is shown
// and only changes are fetched: at most every 10 minutes it asks for day-docs
// whose lastUpdated is newer than the saved copy (imports and cost matching both
// stamp it) and counts the days to catch deletions. With no new upload that is
// 2 reads. The days are handed to dashboard.js (primeSalesCache) so Product
// Performance and the daily summary reuse them instead of reading again.
// Loaded after dashboard.js and shares its helpers (isoDate, addDaysIso, …).
(function initSalesPulse() {
  const root = document.getElementById('sales-pulse');
  const body = document.getElementById('sp-body');
  if (!root || !body) return;

  const DAYS_BACK = 92;
  const CACHE_DB = 'epc-cache';
  const CACHE_STORE = 'kv';
  const CACHE_KEY = 'salesPulse';
  const CACHE_VERSION = 2;
  const CHECK_MS = 10 * 60 * 1000; // how often to look for new uploads
  const THIN_MARGIN = 5; // percent
  const C = { revenue: '#2a9d8a', profit: '#6f72e0', avg: '#0d3b35', prev: '#94a3b8', grid: 'rgba(13,59,53,.06)', ink: '#0d3b35', muted: '#5b706b' };
  const charts = {};

  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const dObj = (iso) => new Date(`${iso}T00:00:00`);
  const fmtDay = (iso, opts) => dObj(iso).toLocaleDateString('en-PH', opts);
  const shortDay = (iso) => fmtDay(iso, { weekday: 'short', month: 'short', day: 'numeric' });
  const peso0 = (v) => (v < 0 ? '−' : '') + '₱' + Math.round(Math.abs(v)).toLocaleString('en-PH');
  const units0 = (v) => Math.round(v).toLocaleString('en-PH');
  const pctText = (v) => `${Math.abs(v).toFixed(Math.abs(v) >= 100 ? 0 : 1)}%`;
  const change = (now, before) => (before ? ((now - before) / Math.abs(before)) * 100 : null);
  const marginOf = (revenue, cost) => (revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0);

  // ── Load ────────────────────────────────────────────────────────────────────
  // One saved pack per browser, in IndexedDB (day-docs are too big for localStorage).
  function cacheStore(mode, action) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(CACHE_DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(CACHE_STORE);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const idb = open.result;
        const tx = idb.transaction(CACHE_STORE, mode);
        const req = action(tx.objectStore(CACHE_STORE));
        tx.oncomplete = () => { idb.close(); resolve(req.result); };
        tx.onerror = tx.onabort = () => { idb.close(); reject(tx.error); };
      };
    });
  }
  async function readCache(uid) {
    try {
      const pack = await cacheStore('readonly', (store) => store.get(CACHE_KEY));
      if (pack && pack.v === CACHE_VERSION && pack.uid === uid && pack.days) return pack;
    } catch (e) { /* storage off or blocked */ }
    return null;
  }
  async function writeCache(pack) {
    try { await cacheStore('readwrite', (store) => store.put(pack, CACHE_KEY)); } catch (e) { /* storage off: just skip */ }
  }
  function whenSignedIn() {
    return new Promise((resolve, reject) => {
      const auth = typeof getFirebaseAuth === 'function' ? getFirebaseAuth() : null;
      if (!auth) { reject(new Error('Sign-in is not available.')); return; }
      const off = auth.onAuthStateChanged((user) => { if (user) { off(); resolve(user); } });
    });
  }
  // pack = { v, uid, from, to, at, checkedAt, stamp:{s,n}, names:{code:name},
  //          days:{date:[[code, units, revenue, cost], …]} }
  // stamp is the newest lastUpdated seen, kept exactly so the next check asks
  // only for day-docs changed after it.
  function addDay(pack, doc) {
    const data = doc.data() || {};
    const products = data.products || {};
    pack.days[doc.id] = Object.keys(products).map((code) => {
      const p = products[code] || {};
      const units = Number(p.units) || 0;
      const cost = (p.cost != null ? Number(p.cost) : (Number(p.unit_cost) || 0) * units) || 0;
      pack.names[code] = p.name || code;
      return [code, units, r2(p.revenue), r2(cost)];
    });
    noteStamp(pack, data.lastUpdated);
  }
  function noteStamp(pack, ts) {
    if (!ts || typeof ts.seconds !== 'number') return;
    const cur = pack.stamp;
    if (!cur || ts.seconds > cur.s || (ts.seconds === cur.s && ts.nanoseconds > cur.n)) pack.stamp = { s: ts.seconds, n: ts.nanoseconds || 0 };
  }
  const windowQuery = (db, from) => db.collection('salesDaily').orderBy(firebase.firestore.FieldPath.documentId()).startAt(from).endAt(today);
  async function fetchPack(uid) {
    const db = typeof getFirestoreDB === 'function' ? getFirestoreDB() : null;
    if (!db) throw new Error('The database is not available.');
    const from = addDaysIso(today, -DAYS_BACK);
    const pack = { v: CACHE_VERSION, uid, from, to: today, at: Date.now(), checkedAt: Date.now(), stamp: null, names: {}, days: {} };
    (await windowQuery(db, from).get()).forEach((doc) => addDay(pack, doc));
    // No stamps at all (old records): start from five minutes ago to allow for clock differences.
    if (!pack.stamp) pack.stamp = { s: Math.floor(Date.now() / 1000) - 300, n: 0 };
    await writeCache(pack);
    return pack;
  }
  // Bring a saved pack up to date. Returns { pack, changed }.
  async function syncPack(pack) {
    const db = typeof getFirestoreDB === 'function' ? getFirestoreDB() : null;
    if (!db || !pack.stamp) return { pack: await fetchPack(pack.uid), changed: true };
    const from = addDaysIso(today, -DAYS_BACK);
    let changed = pack.to !== today;             // a new day moves the window
    Object.keys(pack.days).forEach((d) => { if (d < from) delete pack.days[d]; });
    // 1) Day-docs written since the saved copy (new uploads, re-uploads, cost matching).
    const since = new firebase.firestore.Timestamp(pack.stamp.s, pack.stamp.n);
    (await db.collection('salesDaily').where('lastUpdated', '>', since).get()).forEach((doc) => {
      if (doc.id >= from && doc.id <= today) { addDay(pack, doc); changed = true; } else noteStamp(pack, (doc.data() || {}).lastUpdated);
    });
    // 2) Deleted uploads leave no trace, so compare the number of days (1 read).
    //    firestoreCount (app.js): this SDK build has no query.count(). null = could not count.
    const idPath = firebase.firestore.FieldPath.documentId();
    const counted = await firestoreCount(
      db.collection('salesDaily').where(idPath, '>=', from).where(idPath, '<=', today), 'sales pulse day count');
    if (counted != null && counted !== Object.keys(pack.days).length) return { pack: await fetchPack(pack.uid), changed: true };
    pack.from = from; pack.to = today; pack.checkedAt = Date.now();
    if (changed) pack.at = Date.now();
    await writeCache(pack);
    return { pack, changed };
  }
  // Give the loaded days to dashboard.js in the shape its own reader expects.
  function shareWithDashboard(pack) {
    if (typeof primeSalesCache !== 'function') return;
    const docs = {};
    Object.keys(pack.days).forEach((date) => {
      const products = {};
      pack.days[date].forEach(([code, units, revenue, cost]) => {
        products[code] = { name: pack.names[code] || code, units, revenue, cost, unit_cost: units ? cost / units : 0 };
      });
      docs[date] = { products };
    });
    primeSalesCache(pack.from, pack.to, docs);
  }

  // ── Analyse ─────────────────────────────────────────────────────────────────
  function buildModel(pack) {
    const totals = {}; // date -> { units, revenue, cost, profit }
    Object.keys(pack.days).forEach((date) => {
      // Profit counts only products that have a cost, so a day whose costs are
      // not matched yet shows "no costs" instead of a false 100% margin.
      let units = 0; let revenue = 0; let cost = 0; let costed = 0;
      pack.days[date].forEach(([, u, r, c]) => { units += u; revenue += r; if (c > 0) { cost += c; costed += r; } });
      if (revenue > 0 || units > 0) totals[date] = { units, revenue, cost, costed, profit: costed - cost };
    });
    const dates = Object.keys(totals).sort();
    if (!dates.length) return null;
    const latest = dates[dates.length - 1];
    const rangeDates = (from, to) => { const out = []; for (let d = from; d <= to; d = addDaysIso(d, 1)) out.push(d); return out; };
    const sumRange = (from, to, key = 'revenue') => rangeDates(from, to).reduce((s, d) => s + (totals[d] ? totals[d][key] : 0), 0);
    const productsIn = (from, to) => {
      const map = {};
      rangeDates(from, to).forEach((d) => (pack.days[d] || []).forEach(([code, u, r, c]) => {
        const p = map[code] || (map[code] = { code, name: pack.names[code] || code, units: 0, revenue: 0, cost: 0 });
        p.units += u; p.revenue += r; p.cost += c;
      }));
      return map;
    };

    // 1. Latest day, vs the previous day with sales and vs the same weekday last week
    const prevDate = dates.length > 1 ? dates[dates.length - 2] : null;
    const weekAgoDate = addDaysIso(latest, -7);
    const headline = {
      date: latest, day: totals[latest],
      prevDate, prev: prevDate ? totals[prevDate] : null,
      weekAgoDate, weekAgo: totals[weekAgoDate] || null,
    };

    // 2. 30-day trend with a 7-day average (averaged over the days that have sales)
    const trendDates = rangeDates(addDaysIso(latest, -29), latest);
    const trend = {
      dates: trendDates,
      revenue: trendDates.map((d) => (totals[d] ? r2(totals[d].revenue) : null)),
      profit: trendDates.map((d) => (totals[d] && totals[d].costed > 0 ? r2(totals[d].profit) : null)),
      avg7: trendDates.map((d) => {
        const win = rangeDates(addDaysIso(d, -6), d).filter((x) => totals[x]);
        return win.length ? r2(win.reduce((s, x) => s + totals[x].revenue, 0) / win.length) : null;
      }),
    };

    // 3. Month so far vs the same point last month, with a straight-line projection
    const ld = dObj(latest);
    const dom = ld.getDate();
    const monthStart = isoDate(new Date(ld.getFullYear(), ld.getMonth(), 1));
    const daysInMonth = new Date(ld.getFullYear(), ld.getMonth() + 1, 0).getDate();
    const prevStartObj = new Date(ld.getFullYear(), ld.getMonth() - 1, 1);
    const prevStart = isoDate(prevStartObj);
    const daysInPrev = new Date(prevStartObj.getFullYear(), prevStartObj.getMonth() + 1, 0).getDate();
    const prevSameEnd = addDaysIso(prevStart, Math.min(dom, daysInPrev) - 1);
    const prevEnd = addDaysIso(prevStart, daysInPrev - 1);
    const cumulative = (start, count) => { let run = 0; return rangeDates(start, addDaysIso(start, count - 1)).map((d) => { run += totals[d] ? totals[d].revenue : 0; return r2(run); }); };
    const mtd = sumRange(monthStart, latest);
    const month = {
      label: fmtDay(latest, { month: 'long', year: 'numeric' }),
      prevLabel: prevStartObj.toLocaleDateString('en-PH', { month: 'long' }),
      dom, daysInMonth, mtd,
      mtdProfit: sumRange(monthStart, latest, 'profit'),
      prevSame: sumRange(prevStart, prevSameEnd),
      prevFull: sumRange(prevStart, prevEnd),
      prevComplete: prevStart >= pack.from,
      projection: (mtd / dom) * daysInMonth,
      thisCum: cumulative(monthStart, dom),
      prevCum: cumulative(prevStart, daysInPrev),
    };

    // 4. Average sales by weekday over the last 8 weeks
    const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const buckets = weekdayNames.map(() => ({ sum: 0, n: 0 }));
    rangeDates(addDaysIso(latest, -55), latest).forEach((d) => {
      if (!totals[d]) return;
      const b = buckets[(dObj(d).getDay() + 6) % 7];
      b.sum += totals[d].revenue; b.n += 1;
    });
    const weekday = { labels: weekdayNames, avg: buckets.map((b) => (b.n ? r2(b.sum / b.n) : 0)), counts: buckets.map((b) => b.n) };
    weekday.best = weekday.avg.indexOf(Math.max(...weekday.avg));
    weekday.worst = weekday.avg.reduce((bi, v, i) => (buckets[i].n && (bi < 0 || v < weekday.avg[bi]) ? i : bi), -1);

    // 5 + 8. Top products and concentration, last 30 days
    const from30 = addDaysIso(latest, -29);
    const list30 = Object.values(productsIn(from30, latest)).filter((p) => p.revenue > 0).sort((a, b) => b.revenue - a.revenue);
    const total30 = list30.reduce((s, p) => s + p.revenue, 0);
    const top10 = list30.slice(0, 10).map((p) => ({ ...p, share: total30 ? (p.revenue / total30) * 100 : 0, margin: p.cost > 0 ? marginOf(p.revenue, p.cost) : null }));
    const top = { list: top10, total: total30, count: list30.length, share: top10.reduce((s, p) => s + p.share, 0) };

    // 6. Margin watch, last 30 days
    const withMargin = list30.map((p) => ({ ...p, margin: marginOf(p.revenue, p.cost), profit: p.revenue - p.cost }));
    const noCost = withMargin.filter((p) => p.cost <= 0);
    const loss = withMargin.filter((p) => p.cost > 0 && p.profit < 0).sort((a, b) => a.profit - b.profit);
    const thin = withMargin.filter((p) => p.cost > 0 && p.profit >= 0 && p.margin < THIN_MARGIN);
    const watch = {
      loss, thin, noCost,
      noCostRevenue: noCost.reduce((s, p) => s + p.revenue, 0),
      lossTotal: loss.reduce((s, p) => s + p.profit, 0),
    };

    // 7. Movers: last 7 days vs the 7 days before
    const now7 = productsIn(addDaysIso(latest, -6), latest);
    const old7 = productsIn(addDaysIso(latest, -13), addDaysIso(latest, -7));
    const moves = [...new Set([...Object.keys(now7), ...Object.keys(old7)])].map((code) => {
      const a = now7[code] ? now7[code].revenue : 0;
      const b = old7[code] ? old7[code].revenue : 0;
      return { code, name: pack.names[code] || code, now: a, before: b, delta: a - b };
    });
    const movers = {
      hasBefore: Object.keys(old7).length > 0,
      up: moves.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 5),
      down: moves.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5),
    };

    // 9. Days with no import in the last 30 days, and the gap up to today
    const gaps = {
      dates: trendDates.map((d) => ({ date: d, has: !!totals[d] })),
      missing: trendDates.filter((d) => !totals[d] && d >= dates[0]),
      sinceLatest: Math.max(0, Math.round((dObj(today) - dObj(latest)) / 864e5)),
    };

    return { latest, headline, trend, month, weekday, top, watch, movers, gaps, from30 };
  }

  // Lines and the weekday bars set __epcPastel so the shared chart theme (app.js)
  // keeps their exact colours: the average must stay dark and the best day stand out.
  // ── Render helpers ──────────────────────────────────────────────────────────
  function deltaLine(now, before, label, isRate, missing = 'No sales on') {
    if (now == null) return '';
    if (before == null) return `<span class="sp-delta sp-flat">${missing} ${esc(label)}</span>`;
    const diff = isRate ? now - before : change(now, before);
    if (diff == null) return `<span class="sp-delta sp-flat">${missing} ${esc(label)}</span>`;
    const cls = Math.abs(diff) < 0.05 ? 'sp-flat' : diff > 0 ? 'sp-up' : 'sp-down';
    const arrow = cls === 'sp-flat' ? '•' : diff > 0 ? '▲' : '▼';
    const amount = isRate ? `${Math.abs(diff).toFixed(1)} pts` : pctText(diff);
    return `<span class="sp-delta ${cls}"><b>${arrow} ${amount}</b> vs ${esc(label)}</span>`;
  }
  function tile(label, id, value, fmt, deltas) {
    return `<div class="sp-tile">
      <span class="sp-tile-label">${label}</span>
      <strong class="sp-tile-value" id="${id}" ${value == null ? '' : `data-value="${value}" data-fmt="${fmt}"`}>—</strong>
      ${deltas.join('')}
    </div>`;
  }
  function productRow(p, right, sub) {
    return `<li class="sp-row">
      <span class="sp-row-name" title="${esc(p.name)}">${esc(p.name)}<small>${esc(sub)}</small></span>
      <span class="sp-row-val">${right}</span>
    </li>`;
  }
  const emptyRow = (text) => `<li class="sp-row sp-row-empty">${esc(text)}</li>`;
  function destroyCharts() { Object.keys(charts).forEach((k) => { charts[k].destroy(); delete charts[k]; }); }
  const baseOpts = () => ({
    responsive: true, maintainAspectRatio: false,
    animation: REDUCED_MOTION ? false : { duration: 900, easing: 'easeOutQuart' },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom', align: 'start', labels: { usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 16, color: C.ink, font: { family: 'Figtree', size: 13 } } },
      tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y == null ? 'no sales' : formatPeso(ctx.parsed.y)}` } },
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: C.muted, font: { size: 12 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
      y: { beginAtZero: true, grid: { color: C.grid }, border: { display: false }, ticks: { color: C.muted, font: { size: 12 }, callback: (v) => shortPeso(Number(v)) } },
    },
  });

  // ── Render ──────────────────────────────────────────────────────────────────
  function render(m) {
    const h = m.headline; const d = h.day;
    const prevLabel = h.prevDate ? shortDay(h.prevDate) : 'the day before';
    const weekLabel = `last ${fmtDay(h.weekAgoDate, { weekday: 'long' })}`;
    // Profit and margin cover only the sales that have a cost recorded.
    const hasCost = (t) => !!t && t.costed > 0;
    const profitOf = (t) => (hasCost(t) ? t.profit : null);
    const marginBefore = (t) => (hasCost(t) ? marginOf(t.costed, t.cost) : null);
    const dayProfit = profitOf(d);
    const dayMargin = marginBefore(d);
    const coverage = d.revenue ? (d.costed / d.revenue) * 100 : 0;
    const costNote = !hasCost(d) ? '<span class="sp-delta sp-flat">No costs matched for this day yet</span>'
      : coverage < 99.5 ? `<span class="sp-delta sp-flat">Based on the ${coverage.toFixed(0)}% of sales that have a cost</span>` : '';
    const NO_COST = 'No costs on';
    const mo = m.month;
    const moChange = change(mo.mtd, mo.prevSame);
    const best = m.weekday.best; const worst = m.weekday.worst;

    body.innerHTML = `
      <div class="sp-tiles">
        ${tile('Sales revenue', 'sp-v-rev', d.revenue, 'peso', [deltaLine(d.revenue, h.prev && h.prev.revenue, prevLabel), deltaLine(d.revenue, h.weekAgo && h.weekAgo.revenue, weekLabel)])}
        ${tile('Gross profit', 'sp-v-profit', dayProfit, 'peso', [deltaLine(dayProfit, profitOf(h.prev), prevLabel, false, NO_COST), deltaLine(dayProfit, profitOf(h.weekAgo), weekLabel, false, NO_COST), costNote])}
        ${tile('Profit margin', 'sp-v-margin', dayMargin, 'pct', [deltaLine(dayMargin, marginBefore(h.prev), prevLabel, true, NO_COST), deltaLine(dayMargin, marginBefore(h.weekAgo), weekLabel, true, NO_COST), costNote])}
        ${tile('Units sold', 'sp-v-units', d.units, 'units', [deltaLine(d.units, h.prev && h.prev.units, prevLabel), deltaLine(d.units, h.weekAgo && h.weekAgo.units, weekLabel)])}
      </div>

      <div class="sp-grid sp-grid-7-5">
        <article class="sp-card">
          <header class="sp-card-hd"><h3>Sales trend</h3><p>Last 30 days, ending ${esc(shortDay(m.latest))}.</p></header>
          <div class="sp-chart"><canvas id="sp-trend" role="img" aria-label="Daily sales revenue and gross profit for the last 30 days, with a 7-day average"></canvas></div>
        </article>
        <article class="sp-card">
          <header class="sp-card-hd"><h3>${esc(mo.label)} so far</h3><p>Day 1 to ${mo.dom}, against the same days in ${esc(mo.prevLabel)}.</p></header>
          <div class="sp-month">
            <div><span class="sp-mini-label">Sales this month</span><strong>${peso0(mo.mtd)}</strong>
              ${moChange == null ? `<span class="sp-delta sp-flat">No ${esc(mo.prevLabel)} sales to compare</span>`
                : `<span class="sp-delta ${moChange >= 0 ? 'sp-up' : 'sp-down'}"><b>${moChange >= 0 ? '▲' : '▼'} ${pctText(moChange)}</b> vs ${peso0(mo.prevSame)}</span>`}
            </div>
            <div><span class="sp-mini-label">On pace for</span><strong>${peso0(mo.projection)}</strong>
              <span class="sp-delta sp-flat">${mo.prevComplete && mo.prevFull ? `${esc(mo.prevLabel)} ended at ${peso0(mo.prevFull)}` : 'Straight-line estimate'}</span>
            </div>
          </div>
          <div class="sp-chart sp-chart-sm"><canvas id="sp-month" role="img" aria-label="Running sales total this month against last month"></canvas></div>
        </article>
      </div>

      <div class="sp-grid sp-grid-5-7">
        <article class="sp-card">
          <header class="sp-card-hd"><h3>Best day of the week</h3>
            <p>${m.weekday.avg[best] ? `<b>${m.weekday.labels[best]}</b> sells the most on average${worst >= 0 && worst !== best ? `, <b>${m.weekday.labels[worst]}</b> the least` : ''}. Last 8 weeks.` : 'Average sales per weekday, last 8 weeks.'}</p></header>
          <div class="sp-chart"><canvas id="sp-weekday" role="img" aria-label="Average sales revenue by day of the week"></canvas></div>
        </article>
        <article class="sp-card">
          <header class="sp-card-hd"><h3>Top 10 products</h3><p>Last 30 days by sales. ${units0(m.top.count)} products sold in all.</p></header>
          <div class="sp-conc">
            <strong>${m.top.share.toFixed(0)}%</strong>
            <span>of sales came from the top 10 products</span>
            <div class="sp-meter" role="img" aria-label="Top 10 products make up ${m.top.share.toFixed(0)} percent of sales"><i style="width:${Math.min(100, m.top.share).toFixed(1)}%"></i></div>
          </div>
          <ol class="sp-list sp-list-2col">
            ${m.top.list.map((p, i) => `<li class="sp-row">
              <span class="sp-rank">${i + 1}</span>
              <span class="sp-row-name" title="${esc(p.name)}">${esc(p.name)}<small>${p.share.toFixed(1)}% of sales${p.margin == null ? ' · no cost yet' : ` · ${p.margin.toFixed(0)}% margin`}</small></span>
              <span class="sp-row-val">${peso0(p.revenue)}</span></li>`).join('') || emptyRow('No products sold in this period.')}
          </ol>
        </article>
      </div>

      <div class="sp-grid sp-grid-7-5">
        <article class="sp-card">
          <header class="sp-card-hd"><h3>Movers</h3><p>Sales in the last 7 days against the 7 days before.</p></header>
          <div class="sp-two">
            <div><h4 class="sp-up">▲ Rising</h4><ul class="sp-list">
              ${m.movers.up.map((p) => productRow(p, `<b class="sp-up">+${peso0(p.delta)}</b>`, p.before ? `${peso0(p.before)} → ${peso0(p.now)}` : `New this week · ${peso0(p.now)}`)).join('') || emptyRow(m.movers.hasBefore ? 'Nothing rose this week.' : 'Needs two weeks of sales.')}
            </ul></div>
            <div><h4 class="sp-down">▼ Falling</h4><ul class="sp-list">
              ${m.movers.down.map((p) => productRow(p, `<b class="sp-down">${peso0(p.delta)}</b>`, p.now ? `${peso0(p.before)} → ${peso0(p.now)}` : `No sales this week · was ${peso0(p.before)}`)).join('') || emptyRow(m.movers.hasBefore ? 'Nothing fell this week.' : 'Needs two weeks of sales.')}
            </ul></div>
          </div>
        </article>
        <article class="sp-card">
          <header class="sp-card-hd"><h3>Margin watch</h3><p>Last 30 days.</p></header>
          <div class="sp-watch">
            <div class="sp-watch-stat"><strong>${m.watch.loss.length}</strong><span>sold at a loss${m.watch.loss.length ? ` (${peso0(m.watch.lossTotal)})` : ''}</span></div>
            <div class="sp-watch-stat"><strong>${m.watch.thin.length}</strong><span>under ${THIN_MARGIN}% margin</span></div>
            <div class="sp-watch-stat"><strong>${m.watch.noCost.length}</strong><span>with no cost yet</span></div>
          </div>
          <ul class="sp-list">
            ${m.watch.loss.slice(0, 4).map((p) => productRow(p, `<b class="sp-down">${peso0(p.profit)}</b>`, `Sold ${peso0(p.revenue)} · cost ${peso0(p.cost)}`)).join('')}
            ${m.watch.loss.length ? '' : m.watch.thin.slice(0, 4).map((p) => productRow(p, `<b>${p.margin.toFixed(1)}%</b>`, `Sold ${peso0(p.revenue)} · profit ${peso0(p.profit)}`)).join('')}
            ${m.watch.loss.length || m.watch.thin.length ? '' : emptyRow('No products sold at a loss or thin margin.')}
          </ul>
          ${m.watch.noCost.length ? `<p class="sp-note">${m.watch.noCost.length} product${m.watch.noCost.length === 1 ? '' : 's'} (${peso0(m.watch.noCostRevenue)} of sales) have no cost recorded yet, so they are left out of profit and margin until inventory costs are matched.</p>` : ''}
        </article>
      </div>

      <article class="sp-card">
        <header class="sp-card-hd"><h3>Import calendar</h3>
          <p>${m.gaps.missing.length ? `<b>${m.gaps.missing.length} day${m.gaps.missing.length === 1 ? '' : 's'} with no sales import</b> in the last 30 days: ${m.gaps.missing.slice(-8).map((x) => esc(fmtDay(x, { month: 'short', day: 'numeric' }))).join(', ')}${m.gaps.missing.length > 8 ? ', and earlier' : ''}.` : 'Every one of the last 30 days has a sales import.'}
          ${m.gaps.sinceLatest > 1 ? ` The latest import is ${m.gaps.sinceLatest} days old.` : ''}</p></header>
        <div class="sp-cal" role="img" aria-label="Which of the last 30 days have a sales import">
          ${m.gaps.dates.map((x) => `<span class="sp-cal-day ${x.has ? 'has' : 'none'}" title="${esc(shortDay(x.date))}: ${x.has ? 'imported' : 'no import'}"><i>${x.has ? '' : '×'}</i><small>${dObj(x.date).getDate()}</small></span>`).join('')}
        </div>
        <div class="sp-cal-key"><span><i class="has"></i>Imported</span><span><i class="none">×</i>No import</span></div>
      </article>`;

    // Numbers roll up (same helper as the daily cards).
    const fmts = { peso: fmtPesoSigned, units: units0, pct: (v) => `${v.toFixed(1)}%` };
    body.querySelectorAll('.sp-tile-value[data-value]').forEach((el) => animateCount(el, Number(el.dataset.value), fmts[el.dataset.fmt]));

    destroyCharts();
    const dayLabels = m.trend.dates.map((x) => fmtDay(x, { month: 'short', day: 'numeric' }));
    charts.trend = new Chart(document.getElementById('sp-trend'), {
      data: {
        labels: dayLabels,
        datasets: [
          { __epcPastel: true, type: 'line', label: '7-day average', data: m.trend.avg7, borderColor: C.avg, backgroundColor: C.avg, borderWidth: 2, borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 4, tension: 0.35, spanGaps: true, order: 1 },
          { __epcPastel: true, type: 'line', label: 'Gross profit', data: m.trend.profit, borderColor: C.profit, backgroundColor: C.profit, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.3, spanGaps: true, order: 2 },
          { type: 'bar', label: 'Sales revenue', data: m.trend.revenue, backgroundColor: C.revenue, borderRadius: 4, barPercentage: 0.72, categoryPercentage: 0.9, order: 3 },
        ],
      },
      options: baseOpts(),
    });

    const monthOpts = baseOpts();
    monthOpts.scales.x.ticks.maxTicksLimit = 6;
    monthOpts.plugins.tooltip.callbacks.title = (items) => `Day ${items[0].label}`;
    charts.month = new Chart(document.getElementById('sp-month'), {
      type: 'line',
      data: {
        labels: mo.prevCum.length >= mo.thisCum.length ? mo.prevCum.map((_, i) => i + 1) : mo.thisCum.map((_, i) => i + 1),
        datasets: [
          { __epcPastel: true, label: mo.label, data: mo.thisCum, borderColor: C.revenue, backgroundColor: C.revenue, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4, tension: 0.2 },
          { __epcPastel: true, label: mo.prevLabel, data: mo.prevCum, borderColor: C.prev, backgroundColor: C.prev, borderWidth: 2, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 4, tension: 0.2 },
        ],
      },
      options: monthOpts,
    });

    const wdOpts = baseOpts();
    wdOpts.plugins.legend.display = false;
    wdOpts.plugins.tooltip.callbacks.label = (ctx) => ` Average: ${formatPeso(ctx.parsed.y)} (${m.weekday.counts[ctx.dataIndex]} day${m.weekday.counts[ctx.dataIndex] === 1 ? '' : 's'})`;
    charts.weekday = new Chart(document.getElementById('sp-weekday'), {
      type: 'bar',
      data: { labels: m.weekday.labels, datasets: [{ __epcPastel: true, borderRadius: 8, label: 'Average sales', data: m.weekday.avg, backgroundColor: m.weekday.avg.map((_, i) => (i === best ? C.revenue : '#a8d8cf')), borderRadius: 4, barPercentage: 0.62 }] },
      options: wdOpts,
    });

    document.getElementById('sp-asof').textContent = `Sales data as of ${fmtDay(m.latest, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`;
  }

  function showState(kind, title, text) {
    destroyCharts();
    body.innerHTML = kind === 'loading'
      ? `<div class="sp-state"><div class="dash-loader" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><strong>${esc(title)}</strong><span>${esc(text)}</span></div>`
      : `<div class="sp-state"><strong>${esc(title)}</strong><span>${text}</span>${kind === 'error' ? '<button type="button" class="dash-preset sp-retry">Try again</button>' : ''}</div>`;
    const retry = body.querySelector('.sp-retry');
    if (retry) retry.addEventListener('click', () => load(true));
  }

  // "Ask about this report": share the analysis with the assistant (no extra reads).
  function shareWithAssistant(m) {
    if (!window.EPCChatContext) return;
    EPCChatContext.set(`Sales pulse, as of ${shortDay(m.latest)}`, () => ({
      report: 'Dashboard sales pulse', currency: 'PHP', latestSalesDay: m.latest,
      latestDay: m.headline.day, previousSalesDay: { date: m.headline.prevDate, ...m.headline.prev },
      sameWeekdayLastWeek: m.headline.weekAgo ? { date: m.headline.weekAgoDate, ...m.headline.weekAgo } : null,
      last30Days: m.trend.dates.map((date, i) => ({ date, revenue: m.trend.revenue[i], profit: m.trend.profit[i] })),
      monthSoFar: { month: m.month.label, daysElapsed: m.month.dom, sales: r2(m.month.mtd), profit: r2(m.month.mtdProfit), samePointLastMonth: r2(m.month.prevSame), lastMonthTotal: r2(m.month.prevFull), straightLineProjection: r2(m.month.projection) },
      averageSalesByWeekday: m.weekday.labels.map((label, i) => ({ day: label, average: m.weekday.avg[i], daysCounted: m.weekday.counts[i] })),
      top10ProductsLast30Days: m.top.list.map((p) => ({ itemCode: p.code, name: p.name, revenue: r2(p.revenue), units: Math.round(p.units), sharePct: r2(p.share) })),
      top10SharePct: r2(m.top.share), productsSold: m.top.count,
      risingLast7Days: m.movers.up, fallingLast7Days: m.movers.down,
      soldAtALoss: m.watch.loss.slice(0, 20).map((p) => ({ itemCode: p.code, name: p.name, revenue: r2(p.revenue), cost: r2(p.cost) })),
      thinMarginCount: m.watch.thin.length, productsWithNoCost: m.watch.noCost.length,
      daysWithNoImport: m.gaps.missing,
    }));
  }

  let shownOnce = false;
  function showPack(pack) {
    shareWithDashboard(pack);
    const model = buildModel(pack);
    if (!model) {
      showState('empty', 'No sales imports yet', `Nothing was imported in the last ${DAYS_BACK} days. <a href="pos-import.html">Import a sales file</a> to see it here.`);
      document.getElementById('sp-asof').textContent = 'No recent sales data';
      return;
    }
    render(model);
    shareWithAssistant(model);
    if (shownOnce) return;
    shownOnce = true;
    // Open the rest of the page on the latest import too.
    const dateInput = document.getElementById('snap-date');
    const touched = typeof window.EPC_SNAP_TOUCHED === 'function' && window.EPC_SNAP_TOUCHED();
    if (dateInput && !touched && dateInput.value === defaultSnapDate && typeof setSnapDate === 'function') setSnapDate(model.latest);
    if (typeof prodGate !== 'undefined' && prodGate && !prodGate.hasLoaded()) prodGate.run();
  }
  const clock = (ms) => new Date(ms).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  function setStatus(text) { const el = document.getElementById('sp-updated'); if (el) el.textContent = text; }

  let loading = false;
  async function load(force) {
    if (loading) return;            // guard against double-clicks (paid reads)
    loading = true;
    const refresh = document.getElementById('sp-refresh');
    if (refresh) refresh.disabled = true;
    try {
      const user = await whenSignedIn();
      let pack = force ? null : await readCache(user.uid);
      if (pack) {
        showPack(pack);                           // saved copy first: no reads
        if (pack.to !== today || Date.now() - pack.checkedAt > CHECK_MS) {
          setStatus('Checking for new uploads…');
          const result = await syncPack(pack);
          pack = result.pack;
          if (result.changed) showPack(pack);
        }
      } else {
        showState('loading', 'Loading the latest sales…', 'The first load on this browser takes a little longer.');
        pack = await fetchPack(user.uid);
        showPack(pack);
      }
      setStatus(`Up to date · checked ${clock(pack.checkedAt)}`);
    } catch (err) {
      console.error('[Sales Pulse] load failed:', err);
      const quota = window.EPCQuota && EPCQuota.report(err);
      if (shownOnce && !force) setStatus(quota ? 'Daily read limit reached · showing the saved copy' : 'Could not check for new uploads');
      else if (quota) showState('error', 'Daily read limit reached', esc(`Sales can load again at ${EPCQuota.resetText()}.`));
      else showState('error', 'Could not load the latest sales', 'Check your connection, then try again.');
    } finally {
      loading = false;
      if (refresh) refresh.disabled = false;
    }
  }

  const refreshBtn = document.getElementById('sp-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => load(true));
  load(false);
})();

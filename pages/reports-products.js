initSidebar('reports');

let fpAll = [];                                  // full ranking (all products)
let fpState = { n: 5, metric: 'revenue' };
let fpChart = null;

function loadFullProductData() {
  try { return JSON.parse(localStorage.getItem('salesFullReport') || 'null'); }
  catch (e) { return null; }
}

function escFp(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fpMetricLabel() { return fpState.metric === 'units' ? 'Units Sold' : 'Revenue'; }

function fpDateLabel() {
  const data = loadFullProductData() || {};
  const fmt = d => {
    if (!d) return '—';
    const [y, m, day] = d.split('-');
    return new Date(y, m - 1, day).toLocaleDateString('en-PH', { month:'short', day:'numeric', year:'numeric' });
  };
  return `${fmt(data.from)} – ${fmt(data.to)}`;
}

// Re-rank the full list by the chosen metric and slice to N.
function fpRankedRows() {
  const metricVal = r => fpState.metric === 'units' ? (Number(r.units) || 0) : (Number(r.total) || 0);
  return [...fpAll].sort((a, b) => metricVal(b) - metricVal(a))
    .slice(0, Math.max(1, fpState.n))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function shortenFpLabel(value) {
  const text = String(value);
  return text.length > 28 ? `${text.slice(0, 26)}…` : text;
}

function renderFullProductChart(rows) {
  const isUnits = fpState.metric === 'units';
  const wrap = document.getElementById('fp-chart-wrap');
  const height = Math.max(420, rows.length * 26 + 80);
  wrap.style.height = `${height}px`;
  wrap.style.minWidth = '600px';
  if (fpChart) fpChart.destroy();
  fpChart = new Chart(document.getElementById('fp-chart'), {
    type: 'bar',
    data: {
      labels: rows.map(r => shortenFpLabel(r.name)),
      datasets: [{ label: fpMetricLabel(), data: rows.map(r => isUnits ? r.units : r.total), backgroundColor: '#3b82f6', borderRadius: 4 }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: true, text: `Top ${rows.length} Products by ${fpMetricLabel()}`, font: { size: 14, weight: '600' } },
        tooltip: { callbacks: { label: ctx => isUnits
          ? ` ${Number(ctx.raw).toLocaleString()} units`
          : ` ₱${Number(ctx.raw).toLocaleString('en-PH', { minimumFractionDigits:2, maximumFractionDigits:2 })}` } }
      },
      scales: { x: { beginAtZero: true, ticks: { callback: v => isUnits ? Number(v).toLocaleString() : `₱${(v / 1000000).toFixed(1)}M` } } }
    }
  });
}

const FP_COLUMNS = [
  { label:'Rank',          render: r => r.rank },
  { label:'Product Name',  render: r => escFp(r.name) },
  { label:'Item Code',     render: r => escFp(r.itemCode || '—') },
  { label:'Category',      render: r => escFp(r.category) },
  { label:'Total Revenue', render: r => formatPeso(r.total) },
  { label:'Units Sold',    render: r => Number(r.units).toLocaleString() },
  { label:'Avg Margin %',  render: r => `${r.total ? (r.profit / r.total * 100).toFixed(1) : '0.0'}%` },
];

function renderFullProductList(rows) {
  document.getElementById('fp-head').innerHTML = `<tr>${FP_COLUMNS.map(c => `<th>${c.label}</th>`).join('')}</tr>`;
  document.getElementById('fp-body').innerHTML = rows.map(row =>
    `<tr>${FP_COLUMNS.map(c => `<td class="mono">${c.render(row)}</td>`).join('')}</tr>`).join('');
}

function renderFullProduct() {
  const rows = fpRankedRows();
  document.getElementById('fp-title').textContent = `Top ${rows.length} Products by ${fpMetricLabel()}`;
  document.getElementById('fp-subtitle').textContent = `Period: ${fpDateLabel()}`;
  document.getElementById('fp-topn').value = fpState.n;
  document.getElementById('fp-metric-revenue').classList.toggle('on', fpState.metric === 'revenue');
  document.getElementById('fp-metric-units').classList.toggle('on', fpState.metric === 'units');
  renderFullProductChart(rows);
  renderFullProductList(rows);
}

function setFullProductN(value) {
  fpState.n = Math.min(fpAll.length, Math.max(1, Math.round(Number(value) || 1)));
  renderFullProduct();
}
function setFullProductMetric(metric) {
  fpState.metric = metric === 'units' ? 'units' : 'revenue';
  renderFullProduct();
}

function setFullProductTab(tab) {
  document.querySelectorAll('[data-fp-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.fpTab === tab));
  document.getElementById('fp-chart-card').style.display = tab === 'chart' ? '' : 'none';
  document.getElementById('fp-list-card').style.display = tab === 'list' ? '' : 'none';
}

function exportFullProductReport() {
  const rows = fpRankedRows();
  const title = `Top ${rows.length} Products by ${fpMetricLabel()}`;
  let body = `<h1>${wordEsc(title)}</h1><p class="meta">Period: ${wordEsc(fpDateLabel())}</p>`;
  body += `<h3>${wordEsc(title)}</h3>`;
  body += serializeTableToWord(document.getElementById('fp-table'));
  printReportPDF(title, body);
}

function exportFullProductExcel() {
  const rows = fpRankedRows();
  const title = `Top ${rows.length} Products by ${fpMetricLabel()}`;
  downloadExcel(title, `<p><b>${wordEsc(title)}</b></p>${serializeTableToExcel(document.getElementById('fp-table'))}`);
}

function initFullProductReport() {
  const data = loadFullProductData();
  if (!data || !Array.isArray(data.rows) || !data.rows.length) {
    document.getElementById('fp-chart-card').style.display = 'none';
    document.getElementById('fp-list-card').style.display = 'none';
    document.getElementById('fp-controls').style.display = 'none';
    document.querySelector('.report-tabs').style.display = 'none';
    document.getElementById('fp-export').style.display = 'none';
    document.getElementById('fp-export-excel').style.display = 'none';
    document.getElementById('fp-empty').style.display = '';
    return;
  }
  fpAll = data.rows;
  fpState.metric = data.metric === 'units' ? 'units' : 'revenue';
  fpState.n = Math.min(fpAll.length, Math.max(1, Number(data.topN) || 5));
  renderFullProduct();
  setFullProductTab('chart');
}

initFullProductReport();

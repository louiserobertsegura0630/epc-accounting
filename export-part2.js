// PART 2 — build 3 daily per-item-code Excel files. Local only, no Firestore.
// Shared columns:
//   date | item_code | product_name | units_sold | unit_selling_price | revenue |
//   unit_cost | cogs | gross_profit | cost_effective_date | status | cost_basis
const fs = require('fs');
const readline = require('readline');
const XLSX = require('xlsx');

const OUT_DIR = './exports';
const HEADERS = ['date','item_code','product_name','units_sold','unit_selling_price','revenue',
                 'unit_cost','cogs','gross_profit','cost_effective_date','status','cost_basis'];

function stream(file, onRow) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (line) => { if (!line.trim()) return; let r; try { r = JSON.parse(line); } catch { return; } onRow(r); });
    rl.on('close', resolve);
  });
}
const r2 = (n) => Math.round(n * 100) / 100;

function writeXlsx(file, rows) {
  const aoa = [HEADERS, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = HEADERS.map((h) => ({ wch: Math.max(10, h.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Daily');
  XLSX.writeFile(wb, file);
}

// Split rows (already sorted by date) into one .xlsx per month under OUT_DIR/<base>/.
// Row[0] is the date column (YYYY-MM-DD). Returns [{month, file, rows}].
function writeByMonth(base, rows) {
  const dir = `${OUT_DIR}/${base}`;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const byMonth = new Map();
  for (const r of rows) {
    const m = String(r[0] || '0000-00').slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }
  const out = [];
  for (const m of [...byMonth.keys()].sort()) {
    const file = `${dir}/${base}_${m}.xlsx`;
    writeXlsx(file, byMonth.get(m));
    out.push({ month: m, file, rows: byMonth.get(m).length });
  }
  return out;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Inventory: itemCode -> sorted [{d, cost}]; name (latest delivery).
  const inv = new Map(), nameByCode = new Map(), latest = new Map();
  await stream('./backup/inventoryData.jsonl', (r) => {
    if (!r.itemCode) return;
    const cost = Number(r.unitCost); const d = r.dateDelivered || '';
    if (Number.isFinite(cost)) { if (!inv.has(r.itemCode)) inv.set(r.itemCode, []); inv.get(r.itemCode).push({ d, cost }); }
    if (!latest.has(r.itemCode) || d >= latest.get(r.itemCode)) { latest.set(r.itemCode, d); nameByCode.set(r.itemCode, r.description || ''); }
  });
  for (const arr of inv.values()) arr.sort((a, b) => a.d.localeCompare(b.d));

  // latest cost with d <= saleDate
  function costOnOrBefore(code, saleDate) {
    const arr = inv.get(code); if (!arr) return null;
    let picked = null; for (const e of arr) { if (e.d <= saleDate) picked = e; else break; }
    return picked; // {d,cost} or null
  }
  function earliestCost(code) { const arr = inv.get(code); return arr && arr.length ? arr[0] : null; }

  // ---- Aggregate a collection to one row per (date+code) ----
  async function rollup(file) {
    const m = new Map(); // date|code -> {date,code,name,units,revenue}
    await stream(file, (r) => {
      const date = r.date || ''; const code = r.itemCode || '';
      const k = date + '|' + code;
      let a = m.get(k);
      if (!a) { a = { date, code, name: nameByCode.get(code) || r.productName || '', units: 0, revenue: 0 }; m.set(k, a); }
      a.units += Number(r.unitsSold) || 0;
      a.revenue += Number(r.totalRevenue) || 0;
    });
    return m;
  }

  // ===== FILE 1: sales_approved (recompute cost from inventory on/before sale date) =====
  const sales = await rollup('./backup/salesData.jsonl');
  const f1 = []; let f1NoCost = 0;
  for (const a of sales.values()) {
    const usp = a.units ? r2(a.revenue / a.units) : '';
    const c = costOnOrBefore(a.code, a.date);
    if (c) {
      const cogs = r2(c.cost * a.units);
      f1.push([a.date, a.code, a.name, a.units, usp, r2(a.revenue),
               r2(c.cost), cogs, r2(a.revenue - cogs), c.d, 'approved', 'inventory_at_sale_date']);
    } else {
      f1NoCost++;
      f1.push([a.date, a.code, a.name, a.units, usp, r2(a.revenue),
               '', '', '', '', 'approved', 'no_inventory_on_or_before']);
    }
  }
  f1.sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));

  // ===== underReviewData -> 3-way bucketing =====
  const ur = await rollup('./backup/underReviewData.jsonl');
  const f2 = [], f3 = []; let costableAtSale = 0;
  for (const a of ur.values()) {
    const usp = a.units ? r2(a.revenue / a.units) : '';
    const hasInv = inv.has(a.code);
    if (!hasInv) {
      // File 2: no cost at all
      f2.push([a.date, a.code, a.name, a.units, usp, r2(a.revenue),
               '', '', '', '', 'under_review', 'none']);
      continue;
    }
    const onBefore = costOnOrBefore(a.code, a.date);
    if (onBefore) { costableAtSale++; continue; } // fits none of the 3 buckets -> report only
    // has inventory but only AFTER the sale date -> File 3
    const e = earliestCost(a.code);
    const cogs = r2(e.cost * a.units);
    f3.push([a.date, a.code, a.name, a.units, usp, r2(a.revenue),
             r2(e.cost), cogs, r2(a.revenue - cogs), e.d, 'under_review', 'cost_dated_after_sale']);
  }
  f2.sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));
  f3.sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));

  const m1 = writeByMonth('sales_approved', f1);
  const m2 = writeByMonth('underreview_no_cost', f2);
  const m3 = writeByMonth('underreview_cost_after_sale', f3);

  const prev = (rows) => rows.slice(0, 5).map((r) => '   ' + r.join(' | ')).join('\n');
  const p = (n) => n.toLocaleString('en-US');
  const list = (arr) => arr.map((f) => `     ${f.month}: ${p(f.rows)} rows  (${(fs.statSync(f.file).size/1024/1024).toFixed(2)} MB)`).join('\n');
  console.log('===== PART 2 — daily per-item-code Excel files, split PER MONTH (./exports/) =====\n');
  console.log('columns: ' + HEADERS.join(' | ') + '\n');
  console.log(`FILE 1  exports/sales_approved/           ${p(f1.length)} rows total`);
  console.log(`        (${p(f1NoCost)} had NO inventory on/before sale -> cost blank, flagged no_inventory_on_or_before)`);
  console.log(list(m1)); console.log('   preview:'); console.log(prev(f1));
  console.log(`\nFILE 2  exports/underreview_no_cost/      ${p(f2.length)} rows total`);
  console.log(list(m2)); console.log('   preview:'); console.log(prev(f2));
  console.log(`\nFILE 3  exports/underreview_cost_after_sale/ ${p(f3.length)} rows total`);
  console.log(list(m3)); console.log('   preview:'); console.log(prev(f3));
  console.log(`\nunderReviewData rows fitting NONE of the 3 buckets (costable at sale date): ${p(costableAtSale)} (date+code groups) — reported only, not exported.`);
})();

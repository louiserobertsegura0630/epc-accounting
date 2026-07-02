// Suggested costs for underReview sales, matched by itemCode ONLY (dates ignored).
// For each itemCode we offer TWO suggestions the user can choose between:
//   latestCost = unitCost of the most recent dateDelivered
//   avgCost    = mean unitCost across all inventory records for that item
// These are SUGGESTIONS — the sale stays under review until the user accepts one.
//
// Outputs (backup/):
//   suggested-costs-by-item.csv       one row per itemCode with both costs + awaiting totals
//   underreview-line-items-suggested.csv   one row per underReview sale, both costs + profit
//   needs-inventory-upload.csv        itemCodes with sales but NO inventory record
const fs = require('fs');
const readline = require('readline');

function stream(file, onRow) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let r; try { r = JSON.parse(line); } catch { return; }
      onRow(r);
    });
    rl.on('close', resolve);
  });
}
const q = (v) => `"${String(v).replace(/"/g, '""')}"`;

(async () => {
  // 1) Inventory: itemCode -> {records:[{d,cost}], ...}
  const inv = new Map();
  await stream('./backup/inventoryData.jsonl', (r) => {
    const code = r.itemCode; const cost = Number(r.unitCost);
    if (!code || !Number.isFinite(cost)) return;
    if (!inv.has(code)) inv.set(code, []);
    inv.get(code).push({ d: r.dateDelivered || '', cost });
  });
  // Compute latest + avg per item.
  const cost = new Map(); // itemCode -> {latest, avg, n}
  for (const [code, recs] of inv) {
    recs.sort((a, b) => a.d.localeCompare(b.d));
    const latest = recs[recs.length - 1].cost;
    const avg = recs.reduce((s, e) => s + e.cost, 0) / recs.length;
    cost.set(code, { latest, avg, n: recs.length });
  }
  console.log(`Inventory: ${cost.size} distinct itemCodes with cost.`);

  // 2) Line-item file + per-item awaiting aggregates + unmatched aggregates.
  const perItem = new Map();   // matched itemCode -> {name, units, revenue}
  const unmatched = new Map(); // itemCode with no inventory -> {name, units, revenue}
  let matched = 0, noMatch = 0;

  const liOut = fs.createWriteStream('./backup/underreview-line-items-suggested.csv');
  liOut.write('docId,documentNo,date,itemCode,productName,unitsSold,totalRevenue,' +
              'latestUnitCost,latestProfit,avgUnitCost,avgProfit,invRecords\n');

  await stream('./backup/underReviewData.jsonl', (r) => {
    const code = r.itemCode || '(no-code)';
    const units = Number(r.unitsSold) || 0;
    const revenue = Number(r.totalRevenue) || 0;
    const c = cost.get(code);
    if (!c) {
      noMatch++;
      const u = unmatched.get(code) || { name: r.productName || '', units: 0, revenue: 0 };
      u.units += units; u.revenue += revenue; unmatched.set(code, u);
      return;
    }
    matched++;
    const a = perItem.get(code) || { name: r.productName || '', units: 0, revenue: 0 };
    a.units += units; a.revenue += revenue; perItem.set(code, a);
    const latestProfit = (revenue - c.latest * units).toFixed(2);
    const avgProfit = (revenue - c.avg * units).toFixed(2);
    liOut.write([r.__id__, q(r.documentNo || ''), r.date || '', code, q(r.productName || ''),
                 units, revenue.toFixed(2),
                 c.latest.toFixed(2), latestProfit, c.avg.toFixed(2), avgProfit, c.n].join(',') + '\n');
  });
  await new Promise((res) => liOut.end(res));
  console.log(`Line-items: matched=${matched} noMatch=${noMatch}`);

  // 3) Per-item suggested-cost table (matched items).
  const itemRows = [...perItem.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
  const siOut = fs.createWriteStream('./backup/suggested-costs-by-item.csv');
  siOut.write('itemCode,productName,invRecords,latestUnitCost,avgUnitCost,unitsAwaiting,revenueAwaiting\n');
  for (const [code, a] of itemRows) {
    const c = cost.get(code);
    siOut.write([code, q(a.name), c.n, c.latest.toFixed(2), c.avg.toFixed(2),
                 a.units, a.revenue.toFixed(2)].join(',') + '\n');
  }
  await new Promise((res) => siOut.end(res));

  // 4) Needs-inventory list (unmatched itemCodes), ranked by revenue awaiting.
  const unRows = [...unmatched.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
  const nOut = fs.createWriteStream('./backup/needs-inventory-upload.csv');
  nOut.write('itemCode,productName,unitsAwaiting,revenueAwaiting\n');
  for (const [code, a] of unRows) {
    nOut.write([code, q(a.name), a.units, a.revenue.toFixed(2)].join(',') + '\n');
  }
  await new Promise((res) => nOut.end(res));

  const mb = (f) => (fs.statSync(f).size / 1024 / 1024).toFixed(2) + ' MB';
  console.log(`\nsuggested-costs-by-item.csv: ${itemRows.length} items, ${mb('./backup/suggested-costs-by-item.csv')}`);
  console.log(`underreview-line-items-suggested.csv: ${matched} rows, ${mb('./backup/underreview-line-items-suggested.csv')}`);
  console.log(`needs-inventory-upload.csv: ${unRows.length} items, ${mb('./backup/needs-inventory-upload.csv')}`);
})();

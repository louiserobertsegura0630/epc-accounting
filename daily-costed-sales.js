// Report B: daily costed sales per product.
// - salesData: already resolved; uses its stored unitCost/totalCost/grossProfit.
// - underReviewData: costed here by joining inventoryData on itemCode using
//   "latest cost" = most recent dateDelivered <= sale date. No prior delivery -> blank
//   (flag no-cost-before-date). No inventory record at all -> blank (flag no-inventory-match).
// Output: backup/costed-sales-by-product-day.csv
//   date,itemCode,productName,unitsSold,totalRevenue,totalCost,grossProfit,costStatus
// Streams line-by-line; memory ~ (#distinct date x item) + inventory index.
const fs = require('fs');
const readline = require('readline');

const OUT = './backup/costed-sales-by-product-day.csv';

function stream(file, onRow) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let r;
      try { r = JSON.parse(line); } catch { return; }
      onRow(r);
    });
    rl.on('close', resolve);
  });
}

// key: "date itemCode" -> aggregate
const totals = new Map();
function bucket(date, itemCode, productName) {
  const key = date + ' ' + itemCode;
  let a = totals.get(key);
  if (!a) {
    a = { date, itemCode, productName: productName || '', units: 0, revenue: 0,
          cost: 0, costMissing: false, noMatch: false };
    totals.set(key, a);
  }
  return a;
}

(async () => {
  // 1) Build inventory cost index: itemCode -> [{d, cost}] sorted by date asc.
  const inv = new Map();
  await stream('./backup/inventoryData.jsonl', (r) => {
    const code = r.itemCode; const cost = Number(r.unitCost);
    if (!code || !Number.isFinite(cost)) return;
    const d = r.dateDelivered || '';
    if (!inv.has(code)) inv.set(code, []);
    inv.get(code).push({ d, cost });
  });
  for (const arr of inv.values()) arr.sort((a, b) => a.d.localeCompare(b.d));
  console.log(`Inventory index: ${inv.size} distinct itemCodes.`);

  // latest cost with d <= saleDate; null if none precedes.
  function latestCost(code, saleDate) {
    const arr = inv.get(code);
    if (!arr) return { cost: null, status: 'no-inventory-match' };
    let picked = null;
    for (const e of arr) { if (e.d <= saleDate) picked = e; else break; }
    if (picked == null) return { cost: null, status: 'no-cost-before-date' };
    return { cost: picked.cost, status: 'costed' };
  }

  // 2) salesData — already costed; use stored totals.
  await stream('./backup/salesData.jsonl', (r) => {
    const a = bucket(r.date || '(no-date)', r.itemCode || '(no-code)', r.productName);
    const units = Number(r.unitsSold) || 0;
    a.units += units;
    a.revenue += Number(r.totalRevenue) || 0;
    a.cost += Number(r.totalCost) || 0; // resolved rows carry their own cost
  });
  console.log('salesData aggregated.');

  // 3) underReviewData — cost via inventory join.
  let urCosted = 0, urNoDate = 0, urNoMatch = 0;
  await stream('./backup/underReviewData.jsonl', (r) => {
    const date = r.date || '(no-date)';
    const a = bucket(date, r.itemCode || '(no-code)', r.productName);
    const units = Number(r.unitsSold) || 0;
    a.units += units;
    a.revenue += Number(r.totalRevenue) || 0;
    const { cost, status } = latestCost(r.itemCode, date);
    if (status === 'costed') { a.cost += cost * units; urCosted++; }
    else if (status === 'no-cost-before-date') { a.costMissing = true; urNoDate++; }
    else { a.noMatch = true; urNoMatch++; }
  });
  console.log(`underReviewData costed=${urCosted} noCostBeforeDate=${urNoDate} noInventoryMatch=${urNoMatch}`);

  // 4) Emit. costStatus: costed | partial-no-cost-before-date | partial-no-inventory-match
  const rows = [...totals.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.itemCode.localeCompare(b.itemCode)
  );
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const out = fs.createWriteStream(OUT);
  out.write('date,itemCode,productName,unitsSold,totalRevenue,totalCost,grossProfit,costStatus\n');
  for (const r of rows) {
    let status = 'costed';
    if (r.noMatch) status = 'partial-no-inventory-match';
    else if (r.costMissing) status = 'partial-no-cost-before-date';
    // Blank cost/profit when any part of this bucket is uncosted.
    const uncosted = r.noMatch || r.costMissing;
    const costCell = uncosted ? '' : r.cost.toFixed(2);
    const profitCell = uncosted ? '' : (r.revenue - r.cost).toFixed(2);
    out.write([r.date, r.itemCode, q(r.productName), r.units, r.revenue.toFixed(2),
               costCell, profitCell, status].join(',') + '\n');
  }
  out.end(() => {
    console.log(`Wrote ${rows.length} rows to ${OUT}`);
    console.log(`File size: ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`);
  });
})();

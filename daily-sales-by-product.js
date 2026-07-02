// Report A: daily units sold + revenue per product, across one or more collections.
// Usage: node daily-sales-by-product.js <out.csv> <in1.jsonl> [in2.jsonl ...]
// Runs locally off the existing backup — no Firebase, no writes, no cost.
const fs = require('fs');
const readline = require('readline');

const OUT = process.argv[2] || './backup/sales-by-product-day.csv';
const INPUTS = process.argv.slice(3);
if (!INPUTS.length) INPUTS.push('./backup/salesData.jsonl');

const totals = new Map(); // key: "date itemCode" -> {date,itemCode,productName,units,revenue}
let read = 0, skipped = 0;

function aggregate(file) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let r;
      try { r = JSON.parse(line); } catch { skipped++; return; }
      read++;
      const date = r.date || '(no-date)';
      const itemCode = r.itemCode || '(no-code)';
      const key = date + ' ' + itemCode;
      let agg = totals.get(key);
      if (!agg) {
        agg = { date, itemCode, productName: r.productName || '', units: 0, revenue: 0 };
        totals.set(key, agg);
      }
      agg.units += Number(r.unitsSold) || 0;
      agg.revenue += Number(r.totalRevenue) || 0;
    });
    rl.on('close', resolve);
  });
}

(async () => {
  for (const f of INPUTS) { console.log(`Reading ${f} ...`); await aggregate(f); }

  const rows = [...totals.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.itemCode.localeCompare(b.itemCode)
  );
  const csvField = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const out = fs.createWriteStream(OUT);
  out.write('date,itemCode,productName,unitsSold,totalRevenue\n');
  for (const r of rows) {
    out.write([r.date, r.itemCode, csvField(r.productName), r.units, r.revenue.toFixed(2)].join(',') + '\n');
  }
  out.end(() => {
    console.log(`Read ${read} rows (${skipped} unparseable).`);
    console.log(`Wrote ${rows.length} (date x product) rows to ${OUT}`);
    console.log(`File size: ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`);
  });
})();

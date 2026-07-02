// Local-only feasibility/cost analysis for per-day, per-item-code rollups.
// Reads ONLY ./backup/*.jsonl. No Firestore, nothing billed.
const fs = require('fs');
const readline = require('readline');

function stream(file, onRow) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (line) => { if (!line.trim()) return; let r; try { r = JSON.parse(line); } catch { return; } onRow(r); });
    rl.on('close', resolve);
  });
}
const median = (arr) => { const s = [...arr].sort((a,b)=>a-b); const m = s.length>>1; return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };

(async () => {
  // Name lookup from inventoryData (productMaster not in backup). Latest delivery wins.
  const nameByCode = new Map();
  const latestDateByCode = new Map();
  await stream('./backup/inventoryData.jsonl', (r) => {
    if (!r.itemCode) return;
    const d = r.dateDelivered || '';
    if (!latestDateByCode.has(r.itemCode) || d >= latestDateByCode.get(r.itemCode)) {
      latestDateByCode.set(r.itemCode, d);
      nameByCode.set(r.itemCode, r.description || r.productName || '');
    }
  });

  // Per-day rollup: day -> Map(code -> {name, units, revenue})
  const days = new Map();
  const allCodes = new Set();
  let total = 0, minDate = null, maxDate = null, unmatched = 0;
  const unmatchedCodes = new Set();

  await stream('./backup/salesData.jsonl', (r) => {
    total++;
    const date = r.date || '(no-date)';
    const code = r.itemCode || '(no-code)';
    allCodes.add(code);
    if (date !== '(no-date)') { if (!minDate || date < minDate) minDate = date; if (!maxDate || date > maxDate) maxDate = date; }
    if (!nameByCode.has(code)) { unmatched++; unmatchedCodes.add(code); }
    let day = days.get(date);
    if (!day) { day = new Map(); days.set(date, day); }
    let p = day.get(code);
    if (!p) { p = { name: nameByCode.get(code) || (r.productName || ''), units: 0, revenue: 0 }; day.set(code, p); }
    p.units += Number(r.unitsSold) || 0;
    p.revenue += Number(r.totalRevenue) || 0;
  });

  const codesPerDay = [...days.values()].map((m) => m.size);
  const avg = codesPerDay.reduce((a,b)=>a+b,0) / codesPerDay.length;
  const max = Math.max(...codesPerDay);
  // busiest day
  let busiestDate = null, busiestMap = null;
  for (const [d, m] of days) if (m.size === max) { busiestDate = d; busiestMap = m; break; }

  // Build actual rollup doc for busiest day
  const products = {};
  let tUnits = 0, tRevenue = 0;
  for (const [code, p] of busiestMap) {
    products[code] = { name: p.name, units: p.units, revenue: Math.round(p.revenue * 100) / 100 };
    tUnits += p.units; tRevenue += p.revenue;
  }
  const doc = { products, totals: { units: tUnits, revenue: Math.round(tRevenue * 100) / 100 } };
  const docBytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');

  const p = (n) => n.toLocaleString('en-US');
  console.log('===== PER-DAY / PER-ITEM ROLLUP FEASIBILITY (salesData, local only) =====\n');
  console.log(`1. Total sales records:            ${p(total)}`);
  console.log(`2. Date range:                     ${minDate}  ->  ${maxDate}`);
  console.log(`3. Distinct days with sales:       ${p(days.size)}`);
  console.log(`4. Distinct item codes overall:    ${p(allCodes.size)}`);
  console.log(`5. Distinct codes PER DAY -> avg: ${avg.toFixed(1)}  median: ${median(codesPerDay)}  max: ${max}`);
  console.log(`\n6. Busiest day = ${busiestDate} (${max} distinct codes)`);
  console.log(`   Rollup doc size: ${(docBytes/1024).toFixed(1)} KB  (${p(docBytes)} bytes)`);
  console.log(`   Firestore limit: 1024 KB (1,048,576 bytes) -> ${docBytes < 1048576 ? 'SAFE, under limit' : 'OVER LIMIT'} (${(docBytes/1048576*100).toFixed(1)}% of max)`);

  console.log(`\n7. READS to display reports (1 read per day-doc):`);
  console.log(`   1 day:   1 read`);
  console.log(`   ~30 days (month):  30 reads`);
  console.log(`   ~365 days (year):  365 reads`);
  console.log(`   all ${days.size} historical days: ${p(days.size)} reads`);
  console.log(`   Free tier = 50,000 reads/day -> all cases FAR under.`);

  console.log(`\n8. WRITES to backfill (1 doc per day of data):`);
  console.log(`   Total writes = ${p(days.size)} (one per distinct day).`);
  console.log(`   Free tier = 20,000 writes/day -> ${days.size < 20000 ? 'fits in a SINGLE day, no chunking needed' : 'NEEDS chunking across days'}.`);

  console.log(`\n9. DATA QUALITY — salesData records with NO name match in inventoryData:`);
  console.log(`   Unmatched records: ${p(unmatched)} of ${p(total)} (${(unmatched/total*100).toFixed(1)}%)`);
  console.log(`   Distinct unmatched item codes: ${p(unmatchedCodes.size)} of ${p(allCodes.size)}`);
  console.log(`   (productMaster.jsonl not in backup — names sourced from inventoryData only.)`);
})();

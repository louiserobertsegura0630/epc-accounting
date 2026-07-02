// Export inventoryData.jsonl as-is to Excel, one file per month (by dateDelivered).
// Local only, no Firestore. Output -> exports/inventory/inventory_<YYYY-MM>.xlsx
const fs = require('fs');
const readline = require('readline');
const XLSX = require('xlsx');

const OUT_DIR = './exports/inventory';
const HEADERS = ['date_delivered','item_code','description','supplier','uom','qty',
                 'unit_cost','total_cost','category','document_no'];

function stream(file, onRow) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (line) => { if (!line.trim()) return; let r; try { r = JSON.parse(line); } catch { return; } onRow(r); });
    rl.on('close', resolve);
  });
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = [];
  await stream('./backup/inventoryData.jsonl', (r) => {
    rows.push([
      r.dateDelivered || '', r.itemCode || '', r.description || '', r.supplier || '',
      r.uom || '', Number(r.qty) || 0,
      Number(r.unitCost) || '', Number(r.totalCost) || '',
      r.category || '', String(r.documentNo || '').replace(/\n/g, ' '),
    ]);
  });
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));

  const byMonth = new Map();
  for (const r of rows) {
    const m = String(r[0] || '0000-00').slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }

  const p = (n) => n.toLocaleString('en-US');
  console.log('===== inventoryData -> Excel per month (exports/inventory/) =====\n');
  console.log('columns: ' + HEADERS.join(' | ') + '\n');
  for (const m of [...byMonth.keys()].sort()) {
    const mr = byMonth.get(m);
    const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...mr]);
    ws['!cols'] = HEADERS.map((h) => ({ wch: Math.max(10, h.length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Inventory');
    const file = `${OUT_DIR}/inventory_${m}.xlsx`;
    XLSX.writeFile(wb, file);
    console.log(`  inventory_${m}.xlsx  ${p(mr.length)} rows  (${(fs.statSync(file).size/1024).toFixed(0)} KB)`);
  }
  console.log(`\nTotal: ${p(rows.length)} delivery records.`);
  console.log('preview:');
  rows.slice(0, 5).forEach((r) => console.log('   ' + r.join(' | ')));
})();

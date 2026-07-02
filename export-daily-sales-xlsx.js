// Local-only export: roll up backup/salesData.jsonl into daily per-product-code totals,
// write ONE .xlsx per month, using headers the EPC POS importer recognizes.
// No Firestore. Output -> backup/upload/<YYYY-MM>.xlsx
//
// Importer-recognized headers (from pages/pos-import-firestore.js POS_COL_ALIASES):
//   Date | Item Code | Product Name | Quantity | Total
// A per-row Date column is included so multi-day files are accepted.
const fs = require('fs');
const readline = require('readline');
const XLSX = require('xlsx');

const OUT_DIR = './backup/upload';

function stream(file, onRow) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (line) => { if (!line.trim()) return; let r; try { r = JSON.parse(line); } catch { return; } onRow(r); });
    rl.on('close', resolve);
  });
}

(async () => {
  // Name lookup from inventoryData (latest delivery wins); fall back to sale's own productName.
  const nameByCode = new Map(), latest = new Map();
  await stream('./backup/inventoryData.jsonl', (r) => {
    if (!r.itemCode) return;
    const d = r.dateDelivered || '';
    if (!latest.has(r.itemCode) || d >= latest.get(r.itemCode)) {
      latest.set(r.itemCode, d);
      nameByCode.set(r.itemCode, r.description || r.productName || '');
    }
  });

  // Roll up: "date|code" -> {date, code, name, qty, total}
  const roll = new Map();
  await stream('./backup/salesData.jsonl', (r) => {
    const date = r.date || '';
    const code = r.itemCode || '';
    const key = date + '|' + code;
    let a = roll.get(key);
    if (!a) { a = { date, code, name: nameByCode.get(code) || r.productName || '', qty: 0, total: 0 }; roll.set(key, a); }
    a.qty += Number(r.unitsSold) || 0;
    a.total += Number(r.totalRevenue) || 0;
  });

  // Group rows by month (YYYY-MM), sorted by date then code.
  const byMonth = new Map();
  for (const a of roll.values()) {
    const month = (a.date || '0000-00').slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(a);
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const HEADERS = ['Date', 'Item Code', 'Product Name', 'Quantity', 'Total'];
  const months = [...byMonth.keys()].sort();
  let grandRows = 0;

  console.log('Writing monthly upload files to ' + OUT_DIR + ' ...\n');
  for (const month of months) {
    const rows = byMonth.get(month).sort((x, y) => x.date.localeCompare(y.date) || x.code.localeCompare(y.code));
    const aoa = [HEADERS];
    for (const a of rows) {
      aoa.push([a.date, a.code, a.name, a.qty, Math.round(a.total * 100) / 100]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 40 }, { wch: 10 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sales');
    const file = `${OUT_DIR}/${month}.xlsx`;
    XLSX.writeFile(wb, file);
    grandRows += rows.length;
    const kb = (fs.statSync(file).size / 1024).toFixed(0);
    console.log(`  ${month}.xlsx  ${rows.length.toLocaleString()} rows   ${kb} KB`);
  }

  console.log(`\nDone. ${months.length} monthly files, ${grandRows.toLocaleString()} total rolled-up rows.`);
  console.log(`Columns: ${HEADERS.join(' | ')}  (headers match the EPC POS importer aliases).`);
})();

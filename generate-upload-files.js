// Generate upload-ready files in the UPLOADER's template column format, split per month.
// Local only, no Firestore.
//   Sales (salesData + underReviewData) -> exports/upload_sales/sales_<YYYY-MM>.xlsx
//     columns: date | item_code | product_name | units_sold | unit_selling_price
//   Inventory -> exports/upload_inventory/inventory_<YYYY-MM>.xlsx
//     columns: date_delivered | item_code | description | unit_cost | qty | uom | supplier | category | document_no
const fs = require('fs');
const readline = require('readline');
const XLSX = require('xlsx');

function stream(file, onRow) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (line) => { if (!line.trim()) return; let r; try { r = JSON.parse(line); } catch { return; } onRow(r); });
    rl.on('close', resolve);
  });
}
const r2 = (n) => Math.round(n * 100) / 100;
const p = (n) => n.toLocaleString('en-US');

// bucketFn: (row) -> bucket key string (e.g. month '2026-01' or week '2026-W03')
function writeBuckets(dir, base, headers, rows, dateIdx, bucketFn) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  rows.sort((a, b) => String(a[dateIdx]).localeCompare(String(b[dateIdx])) || String(a[1]).localeCompare(String(b[1])));
  const buckets = new Map();
  for (const r of rows) {
    const k = bucketFn(r);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const out = [];
  for (const k of [...buckets.keys()].sort()) {
    const mr = buckets.get(k);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...mr]);
    ws['!cols'] = headers.map((h) => ({ wch: Math.max(12, h.length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Upload');
    const file = `${dir}/${base}_${k}.xlsx`;
    XLSX.writeFile(wb, file);
    out.push({ month: k, file, rows: mr.length });
  }
  return out;
}

const byMonthKey = (dateIdx) => (r) => String(r[dateIdx] || '0000-00').slice(0, 7);
// ISO week key like "2026-W03" (Mon-based). Includes date range in a sortable form.
function isoWeekKey(dateIdx) {
  return (r) => {
    const s = String(r[dateIdx] || '');
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '0000-W00';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const day = d.getUTCDay() || 7;               // Mon=1..Sun=7
    d.setUTCDate(d.getUTCDate() + 4 - day);        // shift to Thursday of this week
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  };
}

(async () => {
  // Names from inventory (latest delivery wins), fall back to record's own productName.
  const nameByCode = new Map(), latest = new Map();
  await stream('./backup/inventoryData.jsonl', (r) => {
    if (!r.itemCode) return;
    const d = r.dateDelivered || '';
    if (!latest.has(r.itemCode) || d >= latest.get(r.itemCode)) { latest.set(r.itemCode, d); nameByCode.set(r.itemCode, r.description || ''); }
  });

  // ---- SALES: combine salesData + underReviewData, roll up to one row per date+code ----
  const roll = new Map(); // date|code -> {date, code, name, units, revenue}
  async function addSales(file) {
    await stream(file, (r) => {
      const date = r.date || '', code = r.itemCode || '';
      const k = date + '|' + code;
      let a = roll.get(k);
      if (!a) { a = { date, code, name: nameByCode.get(code) || r.productName || '', units: 0, revenue: 0 }; roll.set(k, a); }
      a.units += Number(r.unitsSold) || 0;
      a.revenue += Number(r.totalRevenue) || 0;
    });
  }
  await addSales('./backup/salesData.jsonl');
  await addSales('./backup/underReviewData.jsonl');

  const salesHeaders = ['date', 'item_code', 'product_name', 'units_sold', 'unit_selling_price'];
  const salesRows = [];
  for (const a of roll.values()) {
    const usp = a.units ? r2(a.revenue / a.units) : 0; // weighted avg unit selling price
    salesRows.push([a.date, a.code, a.name, a.units, usp]);
  }
  const sMonths = writeBuckets('./exports/upload_sales', 'sales', salesHeaders, salesRows, 0, isoWeekKey(0));

  // ---- INVENTORY: as-is delivery lines (uploader computes total_cost) ----
  const invHeaders = ['date_delivered', 'item_code', 'description', 'unit_cost', 'qty', 'uom', 'supplier', 'category', 'document_no'];
  const invRows = [];
  await stream('./backup/inventoryData.jsonl', (r) => {
    invRows.push([
      r.dateDelivered || '', r.itemCode || '', r.description || '',
      Number(r.unitCost) || 0, Number(r.qty) || 0, r.uom || '',
      r.supplier || '', r.category || 'Uncategorized', String(r.documentNo || '').replace(/\n/g, ' '),
    ]);
  });
  const iMonths = writeBuckets('./exports/upload_inventory', 'inventory', invHeaders, invRows, 0, byMonthKey(0));

  const list = (arr) => arr.map((f) => `     ${f.month}: ${p(f.rows)} rows  (${(fs.statSync(f.file).size / 1024 / 1024).toFixed(2)} MB)`).join('\n');
  console.log('===== Upload-ready files (uploader template format) =====\n');
  console.log('SALES  exports/upload_sales/ (per WEEK)  columns: ' + salesHeaders.join(' | '));
  console.log(`  total ${p(salesRows.length)} daily rows (salesData + underReviewData combined), ${sMonths.length} weekly files`);
  console.log(list(sMonths));
  console.log('\nINVENTORY  exports/upload_inventory/   columns: ' + invHeaders.join(' | '));
  console.log(`  total ${p(invRows.length)} delivery rows`);
  console.log(list(iMonths));
  console.log('\nPreview (sales, first 3):');
  salesRows.slice(0, 3).forEach((r) => console.log('   ' + r.join(' | ')));
  console.log('Preview (inventory, first 3):');
  invRows.slice(0, 3).forEach((r) => console.log('   ' + r.join(' | ')));
})();

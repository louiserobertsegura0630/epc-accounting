// Generate blank upload templates -> /exports/. Local only, no Firestore.
// sales_template.xlsx     : date | item_code | product_name | units_sold | unit_selling_price
// inventory_template.xlsx : date_delivered | item_code | description | unit_cost | qty | uom | supplier | category | document_no
const fs = require('fs');
const XLSX = require('xlsx');

const OUT_DIR = './exports';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function build(file, headers, examples, instructions) {
  const wb = XLSX.utils.book_new();
  const main = XLSX.utils.aoa_to_sheet([headers, ...examples]);
  main['!cols'] = headers.map((h) => ({ wch: Math.max(14, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, main, 'Template');
  const instr = XLSX.utils.aoa_to_sheet([['Column', 'Required?', 'Notes'], ...instructions]);
  instr['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, instr, 'Instructions');
  XLSX.writeFile(wb, `${OUT_DIR}/${file}`);
  console.log(`  ${file}`);
}

build('sales_template.xlsx',
  ['date', 'item_code', 'product_name', 'units_sold', 'unit_selling_price'],
  [
    ['2026-01-15', '4800088250290', 'CHAMPION HOTDOG MINI 250g', 3, 33.92],
    ['2026-01-15', '4807770270291', 'LUCKYME PANCIT CANTON CHILIMANSI 60g', 2, 11.47],
  ],
  [
    ['date', 'Required', 'Sale date. Format YYYY-MM-DD (e.g. 2026-01-15).'],
    ['item_code', 'Required', 'Product barcode / item code as text (keep leading zeros).'],
    ['product_name', 'Optional', 'Product name. If blank, the system fills it from inventory.'],
    ['units_sold', 'Required', 'Quantity sold that day. Plain number, no commas.'],
    ['unit_selling_price', 'Required', 'Selling price per unit. Plain number, no currency symbol.'],
    ['', '', 'The system computes revenue, cost, and status — do NOT add those columns.'],
    ['', '', 'One row per item code per day (roll up multiple sales of the same item/day).'],
  ]);

build('inventory_template.xlsx',
  ['date_delivered', 'item_code', 'description', 'unit_cost', 'qty', 'uom', 'supplier', 'category', 'document_no'],
  [
    ['2026-01-20', '4800086040886', 'SELECTA VERY ROCKY ROAD 750ml', 135.45, 3, 'PC', 'VISMIN ADVENT TRADERS INC.', 'Frozen', 'RR00003799'],
    ['2026-01-09', '4806502169841', 'FEMME POCKET HANKIES 2PLY 15sX6', 19.64, 126, 'PCS', 'SANITARY CARE PRODUCTS ASIA, INC', 'Household', 'RR00003577'],
  ],
  [
    ['date_delivered', 'Required', 'Delivery/receiving date. Format YYYY-MM-DD.'],
    ['item_code', 'Required', 'Product barcode / item code as text (keep leading zeros).'],
    ['description', 'Required', 'Product description / name.'],
    ['unit_cost', 'Required', 'Cost per unit. Plain number, no currency symbol.'],
    ['qty', 'Optional', 'Quantity received. Plain number.'],
    ['uom', 'Optional', 'Unit of measure (PC, PCS, BOX, etc.).'],
    ['supplier', 'Optional', 'Supplier name.'],
    ['category', 'Optional', 'Product category.'],
    ['document_no', 'Optional', 'Receiving/reference document number.'],
    ['', '', 'The system computes total_cost (= qty x unit_cost) — do NOT add that column.'],
  ]);

console.log('Templates written to ' + OUT_DIR);

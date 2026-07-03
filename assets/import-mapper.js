/* ==========================================================================
 * import-mapper.js — reusable QBO-style "upload then map columns" dialog.
 * Used by BOTH sales and inventory uploads. Config-driven: pass a field-set +
 * a target config, and the same code renders parse -> header toggle -> column
 * mapping -> validation preview -> chunked Firestore import.
 *
 * Depends on (loaded by the host page, in this order):
 *   assets/vendor/xlsx.full.min.js  (SheetJS, global XLSX)   — .xlsx parsing
 *   PapaParse (global Papa)                                   — .csv parsing
 *   firebase compat SDKs + assets/app.js (getFirestoreDB)    — Firestore writes
 *
 * Public API:
 *   EPCImport.openImportDialog({ fieldSet: 'sales'|'inventory', onDone })
 *   EPCImport.FIELD_SETS   (the field definitions, exposed for reference)
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ---- Field definitions (config-driven core) -------------------------- */
  // type: 'date' | 'number' | 'text'
  const FIELD_SETS = {
    sales: [
      { name: 'date',               label: 'Date',               required: true,  type: 'date' },
      { name: 'item_code',          label: 'Item Code',          required: true,  type: 'text' },
      { name: 'product_name',       label: 'Product Name',       required: false, type: 'text' },
      { name: 'units_sold',         label: 'Units Sold',         required: true,  type: 'number' },
      { name: 'unit_selling_price', label: 'Unit Selling Price', required: true,  type: 'number' },
    ],
    inventory: [
      { name: 'date_delivered', label: 'Date Delivered', required: true,  type: 'date' },
      { name: 'item_code',      label: 'Item Code',      required: true,  type: 'text' },
      { name: 'description',    label: 'Description',    required: true,  type: 'text' },
      { name: 'unit_cost',      label: 'Unit Cost',      required: true,  type: 'number' },
      { name: 'qty',            label: 'Quantity',       required: false, type: 'number' },
      { name: 'uom',            label: 'UOM',            required: false, type: 'text' },
      { name: 'supplier',       label: 'Supplier',       required: false, type: 'text' },
      { name: 'category',       label: 'Category',       required: false, type: 'text' },
      { name: 'document_no',    label: 'Document No',    required: false, type: 'text' },
    ],
    // MIS inventory import (replaces the position-based worker). Required per the page:
    // item_code, description, qty. date_delivered/unit_cost/total_cost/category/supplier optional.
    inventory_mis: [
      { name: 'item_code',      label: 'Item Code',      required: true,  type: 'text' },
      { name: 'description',    label: 'Description',    required: true,  type: 'text' },
      { name: 'qty',            label: 'Quantity',       required: true,  type: 'number' },
      { name: 'unit_cost',      label: 'Unit Cost',      required: true,  type: 'number' },
      // total_cost is ALWAYS auto-computed as qty × unit_cost — never mapped from a column.
      { name: 'category',       label: 'Category',       required: false, type: 'text' },
      { name: 'supplier',       label: 'Supplier',       required: false, type: 'text' },
      { name: 'date_delivered', label: 'Date Delivered', required: false, type: 'date' },
      { name: 'document_no',    label: 'Document No',    required: false, type: 'text' },
    ],
  };

  // Fuzzy-match vocabulary per system field (reuses the POS importer's aliases).
  const ALIASES = {
    date:               ['date', 'transaction date', 'sale date', 'trans date'],
    date_delivered:     ['date delivered', 'delivery date', 'date', 'received date', 'received', 'delivered'],
    item_code:          ['item code', 'material code', 'mat code', 'product code', 'sku', 'code', 'barcode', 'bar code'],
    product_name:       ['product name', 'item name', 'description', 'name', 'item'],
    description:        ['description', 'product name', 'item name', 'name', 'item', 'desc'],
    units_sold:         ['units sold', 'unit sold', 'quantity', 'qty', 'sold', 'units'],
    qty:                ['quantity', 'qty', 'units', 'count'],
    unit_selling_price: ['unit selling price', 'selling price', 'price', 'srp', 'unit price', 'amount', 'sales price'],
    unit_cost:          ['unit cost', 'cost', 'cost price', 'buying price', 'unit price'],
    total_cost:         ['total cost', 'total', 'amount', 'total amount', 'ext cost', 'extended cost'],
    uom:                ['uom', 'unit', 'unit of measure', 'unit measure'],
    supplier:           ['supplier', 'vendor', 'supplier name'],
    category:           ['category', 'class', 'cat'],
    document_no:        ['document no', 'doc no', 'document number', 'reference', 'ref', 'rr no', 'invoice no'],
  };

  // Firestore target config per field-set. Sales uses cost-map routing.
  const TARGETS = {
    inventory: {
      collection: 'inventoryData',
      toDoc(row) {
        const qty = num(row.qty);
        const unitCost = num(row.unit_cost);
        return {
          itemCode:     String(row.item_code || '').trim(),
          description:  String(row.description || '').trim(),
          unitCost:     unitCost,
          qty:          qty,
          totalCost:    Math.round(qty * unitCost * 100) / 100, // system-computed
          uom:          String(row.uom || '').trim(),
          supplier:     String(row.supplier || '').trim(),
          category:     String(row.category || '').trim() || 'Uncategorized',
          documentNo:   String(row.document_no || '').trim(),
          dateDelivered: normDate(row.date_delivered),
          type:         'Incoming',
          notes:        'Imported via upload mapper',
          importedAt:   new Date().toISOString(),
        };
      },
    },
    sales: { collection: null /* routed at import: salesData | underReviewData */ },
  };

  /* ---- Small utilities -------------------------------------------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach((c) => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  }
  const normKey = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/,/g, '').trim()); return Number.isFinite(n) ? n : NaN; };

  // Parse a date-ish value to YYYY-MM-DD, or '' if unparseable. Handles Excel serials & strings.
  function normDate(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number' && global.XLSX && XLSX.SSF) {
      const d = XLSX.SSF.parse_date_code(v);
      if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    }
    const s = String(v).trim();
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return '';
  }

  /* ---- Encoding-safe text sanitize -------------------------------------
   * Files can carry non-UTF-8 bytes (e.g. "°" in "30 DEGREES FROZEN"). We
   * sanitize each cell so a stray char never drops a row or garbles data:
   *  - strip the UTF-8 replacement char (�) that appears on bad decode
   *  - drop control chars except tab/newline
   *  - collapse odd whitespace, trim
   * We do NOT reject or skip rows for encoding reasons. */
  function sanitizeCell(v) {
    if (v == null) return '';
    if (typeof v !== 'string') return v; // keep numbers/dates as-is
    return v
      .replace(/�/g, '')                       // bad-decode marker
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') // control chars (keep \t \n)
      .replace(/\s+/g, ' ')
      .trim();
  }
  function sanitizeGrid(grid) {
    return grid.map((row) => row.map(sanitizeCell));
  }
  // Decode raw bytes leniently: try UTF-8; if it produced replacement chars,
  // fall back to Windows-1252 (Latin-1 superset) so "°" etc. survive.
  function decodeBytes(buf) {
    const bytes = new Uint8Array(buf);
    let text = '';
    try { text = new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch (e) { text = ''; }
    if (text.indexOf('�') !== -1) {
      try { text = new TextDecoder('windows-1252', { fatal: false }).decode(bytes); }
      catch (e) { /* keep utf-8 result */ }
    }
    return text;
  }

  /* ---- Step 1: parse file into a raw grid (no header assumption) -------- */
  function parseFile(file) {
    return new Promise((resolve, reject) => {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (ext === 'csv') {
        if (typeof global.Papa === 'undefined') return reject(new Error('PapaParse not loaded.'));
        // Read bytes ourselves + lenient decode, so non-UTF-8 chars don't garble.
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const text = decodeBytes(e.target.result);
            const res = Papa.parse(text, { skipEmptyLines: true });
            resolve(sanitizeGrid(res.data.map((r) => r.map((c) => (c == null ? '' : c)))));
          } catch (err) { reject(err); }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
      } else if (ext === 'xlsx' || ext === 'xls') {
        if (typeof global.XLSX === 'undefined') return reject(new Error('SheetJS (XLSX) not loaded.'));
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            resolve(sanitizeGrid(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })));
          } catch (err) { reject(err); }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
      } else {
        reject(new Error('Unsupported file type: .' + ext + ' (use .csv or .xlsx)'));
      }
    });
  }

  /* ---- Step 2/3: headers + auto-guess mapping -------------------------- */
  function deriveColumns(grid, hasHeader) {
    const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
    let labels, dataRows;
    if (hasHeader && grid.length) {
      labels = [];
      for (let i = 0; i < width; i++) labels.push(String(grid[0][i] || '').trim() || `Column ${i + 1}`);
      dataRows = grid.slice(1);
    } else {
      labels = [];
      for (let i = 0; i < width; i++) labels.push(`Column ${i + 1}`);
      dataRows = grid.slice();
    }
    return { labels, dataRows, width };
  }

  function autoGuess(labels, fieldDefs) {
    const map = {};                 // fieldName -> colIndex | null
    const used = new Set();
    const norm = labels.map(normKey);
    for (const f of fieldDefs) {
      const cands = [normKey(f.name), normKey(f.label), ...(ALIASES[f.name] || []).map(normKey)];
      let hit = -1;
      // tier 1: exact normalized equality
      for (let i = 0; i < norm.length && hit < 0; i++) if (!used.has(i) && cands.includes(norm[i])) hit = i;
      // tier 2: substring either direction
      if (hit < 0) for (let i = 0; i < norm.length && hit < 0; i++) {
        if (used.has(i) || !norm[i]) continue;
        if (cands.some((c) => c && (norm[i].includes(c) || c.includes(norm[i])))) hit = i;
      }
      map[f.name] = hit >= 0 ? hit : null;
      if (hit >= 0) used.add(hit);
    }
    return map;
  }

  /* ---- Step 4: validation ---------------------------------------------- */
  function validateRow(rowObj, fieldDefs) {
    const problems = [];
    for (const f of fieldDefs) {
      const raw = rowObj[f.name];
      const blank = raw == null || String(raw).trim() === '';
      if (blank) { if (f.required) problems.push({ field: f.name, kind: 'required-blank' }); continue; }
      if (f.type === 'number' && !Number.isFinite(num(raw))) problems.push({ field: f.name, kind: f.required ? 'bad-number' : 'bad-number-opt', required: f.required });
      if (f.type === 'date' && !normDate(raw)) problems.push({ field: f.name, kind: f.required ? 'bad-date' : 'bad-date-opt', required: f.required });
    }
    return problems;
  }
  const isBlocking = (p) => p.kind === 'required-blank' || p.kind === 'bad-number' || p.kind === 'bad-date';

  /* ---- Step 5: import (chunked batches) -------------------------------- */
  async function importInventory(rows, onProgress) {
    const db = global.getFirestoreDB();
    const target = TARGETS.inventory;
    let inserted = 0;
    for (let start = 0; start < rows.length; start += 400) {
      const chunk = rows.slice(start, start + 400);
      const batch = db.batch();                     // fresh batch each commit
      chunk.forEach((r) => batch.set(db.collection(target.collection).doc(), target.toDoc(r)));
      await batch.commit();
      inserted += chunk.length;
      onProgress(inserted, rows.length);
    }
    return { inserted, salesData: 0, underReviewData: 0 };
  }

  // COST-BLIND sales import → per-day rollups (salesDaily). Never writes raw sale
  // rows; never reads itemCost. Every item_code is "awaiting cost" at upload —
  // the inventory importer later fills cost/profit and shrinks these counts.
  async function importSales(rows, onProgress) {
    const db = global.getFirestoreDB();
    const FVT = global.firebase && global.firebase.firestore && global.firebase.firestore.FieldValue;
    const serverTs = () => (FVT ? FVT.serverTimestamp() : new Date().toISOString());

    // 1) Consolidate in memory: date -> { products: Map(code -> {name,units,revenue}) }.
    const byDate = new Map();
    rows.forEach((r) => {
      const code = String(r.item_code || '').trim();
      const date = normDate(r.date);
      if (!code || !date) return;
      const units = num(r.units_sold) || 0;
      const price = num(r.unit_selling_price) || 0;
      const revenue = Math.round(units * price * 100) / 100;
      if (!byDate.has(date)) byDate.set(date, new Map());
      const day = byDate.get(date);
      let p = day.get(code);
      if (!p) { p = { name: String(r.product_name || '').trim(), units: 0, revenue: 0 }; day.set(code, p); }
      p.units += units;
      p.revenue = Math.round((p.revenue + revenue) * 100) / 100;
      if (!p.name && r.product_name) p.name = String(r.product_name).trim();
    });

    // 2) Build one salesDaily doc per date. awaitingCost = ALL items (cost-blind).
    const writes = [];
    let productDays = 0, awaitingItemsTotal = 0, awaitingRevenueTotal = 0;
    byDate.forEach((day, date) => {
      const products = {};
      let tUnits = 0, tRevenue = 0, awItems = 0, awRevenue = 0;
      day.forEach((p, code) => {
        products[code] = { name: p.name || '', units: p.units, revenue: p.revenue };
        tUnits += p.units; tRevenue += p.revenue;
        awItems++; awRevenue += p.revenue;      // cost-blind: every item awaits cost
        productDays++;
      });
      tRevenue = Math.round(tRevenue * 100) / 100;
      awRevenue = Math.round(awRevenue * 100) / 100;
      awaitingItemsTotal += awItems; awaitingRevenueTotal += awRevenue;
      writes.push({ date, data: {
        products, totals: { units: tUnits, revenue: tRevenue },
        awaitingCostItemCount: awItems, awaitingCostRevenue: awRevenue,
        lastUpdated: serverTs(),
      } });
    });

    // 3) Write salesDaily with set() (idempotent REPLACE), chunked 400/batch.
    let written = 0;
    for (let s = 0; s < writes.length; s += 400) {
      const chunk = writes.slice(s, s + 400);
      const batch = db.batch();
      chunk.forEach((w) => batch.set(db.collection('salesDaily').doc(w.date), w.data));
      await batch.commit();
      written += chunk.length;
      onProgress(written, writes.length, `Saving daily sales ${written}/${writes.length}…`);
    }

    const dates = [...byDate.keys()].sort();
    return {
      inserted: productDays, productDays, dates: dates.length,
      awaitingItems: awaitingItemsTotal, awaitingRevenue: Math.round(awaitingRevenueTotal * 100) / 100,
      summary: `${rows.length.toLocaleString()} rows → ${productDays.toLocaleString()} product-days across ${dates.length} date(s). ${awaitingItemsTotal.toLocaleString()} items (₱${Math.round(awaitingRevenueTotal).toLocaleString()} revenue) awaiting cost.`,
    };
  }

  // Load inventory cost history: itemCode -> sorted [{d, cost}].
  async function loadInventoryCostMap(db) {
    const map = new Map();
    const snap = await db.collection('inventoryData').get();
    snap.forEach((doc) => {
      const r = doc.data();
      const code = String(r.itemCode || '').trim();
      const cost = Number(r.unitCost);
      if (!code || !Number.isFinite(cost)) return;
      if (!map.has(code)) map.set(code, []);
      map.get(code).push({ d: r.dateDelivered || '', cost });
    });
    for (const arr of map.values()) arr.sort((a, b) => String(a.d).localeCompare(String(b.d)));
    return map;
  }
  function costForDate(map, code, saleDate) {
    const arr = map.get(code);
    if (!arr || !arr.length) return null;
    let picked = null;
    for (const e of arr) { if (e.d <= saleDate) picked = e.cost; else break; }
    return picked; // number | null
  }

  /* ---- Upload tracking + duplicate blocking ---------------------------- */
  // distinct YYYY-MM-DD dates present in the mapped rows for this field-set.
  function datesInRows(rows, fieldSetName) {
    const key = fieldSetName === 'inventory' ? 'date_delivered' : 'date';
    const set = new Set();
    rows.forEach((r) => { const d = normDate(r[key]); if (d) set.add(d); });
    return [...set].sort();
  }

  // Returns { conflicts:[{date, fileName}] } for dates already uploaded for this type.
  async function findDateConflicts(db, type, fileDates) {
    const wanted = new Set(fileDates);
    const snap = await db.collection('uploads').where('type', '==', type).get();
    const conflicts = [];
    snap.forEach((doc) => {
      const u = doc.data();
      (u.dates || []).forEach((d) => { if (wanted.has(d)) conflicts.push({ date: d, fileName: u.fileName || '(unnamed)' }); });
    });
    return conflicts;
  }

  // Does any prior upload of this type have exactly this fileName? Returns the
  // first match's {fileName, date} (earliest covered date) or null.
  async function findSameFilenameUpload(db, type, fileName) {
    const name = String(fileName || '').trim();
    if (!name) return null;
    const snap = await db.collection('uploads').where('type', '==', type).get();
    let match = null;
    snap.forEach((doc) => {
      const u = doc.data();
      if (String(u.fileName || '').trim() === name && !match) {
        const ds = (u.dates || []).slice().sort();
        match = { fileName: name, date: ds[0] || (u.uploadedAt || '').slice(0, 10) };
      }
    });
    return match;
  }

  // Consolidate incoming rows into per-date item maps, matching how the importer
  // stores them. type 'sales' -> {units, revenue}; 'inventory' -> {qty, total_cost}.
  function consolidateIncoming(rows, type) {
    const byDate = new Map();   // date -> Map(code -> {a,b})
    rows.forEach((r) => {
      const code = String((type === 'sales' ? r.item_code : r.item_code) || '').trim();
      const date = normDate(type === 'sales' ? r.date : r.date_delivered);
      if (!code || !date) return;
      if (!byDate.has(date)) byDate.set(date, new Map());
      const day = byDate.get(date);
      let it = day.get(code);
      if (!it) { it = { a: 0, b: 0 }; day.set(code, it); }
      if (type === 'sales') {
        const units = num(r.units_sold) || 0;
        const price = num(r.unit_selling_price) || 0;
        it.a += units;
        it.b = Math.round((it.b + units * price) * 100) / 100;   // revenue
      } else {
        const qty = num(r.qty) || 0;
        const uc = num(r.unit_cost) || 0;
        it.a += qty;
        it.b = Math.round((it.b + qty * uc) * 100) / 100;        // total_cost
      }
    });
    return byDate;
  }

  // Compare the incoming consolidated data for one date against the STORED rollup
  // doc for that date. Returns { exact:boolean, diffCount:number }.
  // type 'sales' reads salesDaily.products {units, revenue};
  // 'inventory' reads inventoryDaily.items {qty, total_cost}.
  async function compareDateToStored(db, type, date, incomingDayMap) {
    const coll = type === 'sales' ? 'salesDaily' : 'inventoryDaily';
    let stored = {};
    try {
      const doc = await db.collection(coll).doc(date).get();
      if (doc.exists) {
        const data = doc.data() || {};
        stored = (type === 'sales' ? data.products : data.items) || {};
      }
    } catch (e) { return { exact: false, diffCount: null }; }

    const eq = (x, y) => Math.abs((Number(x) || 0) - (Number(y) || 0)) < 0.005;
    const codes = new Set([...Object.keys(stored), ...[...incomingDayMap.keys()]]);
    let diffCount = 0;
    codes.forEach((code) => {
      const s = stored[code];
      const inc = incomingDayMap.get(code);
      if (!s || !inc) { diffCount++; return; }
      const sa = type === 'sales' ? s.units : s.qty;
      const sb = type === 'sales' ? s.revenue : s.total_cost;
      if (!eq(sa, inc.a) || !eq(sb, inc.b)) diffCount++;
    });
    return { exact: diffCount === 0, diffCount };
  }

  // Build a smart, per-date message comparing incoming vs stored for conflicting
  // dates. Returns an array of { date, fileName, exact, diffCount, text }.
  async function smartConflictMessages(db, type, rows, conflicts) {
    const incoming = consolidateIncoming(rows, type);
    const byDate = {};
    conflicts.forEach((c) => { if (!byDate[c.date]) byDate[c.date] = c.fileName; });
    const out = [];
    for (const date of Object.keys(byDate).sort()) {
      const fileName = byDate[date];
      const dayMap = incoming.get(date) || new Map();
      const cmp = await compareDateToStored(db, type, date, dayMap);
      let text;
      if (cmp.diffCount == null) {
        text = `${date} — already uploaded in ${fileName}.`;
      } else if (cmp.exact) {
        text = `${date} — exact duplicate of ${fileName}. No action needed.`;
      } else {
        text = `${date} — already has data from ${fileName}, but this file differs (${cmp.diffCount} item(s) different). If this is a correction: delete the existing upload for this date, then re-upload.`;
      }
      out.push({ date, fileName, exact: cmp.exact, diffCount: cmp.diffCount, text });
    }
    return out;
  }

  function currentUserName() {
    try { if (typeof global.currentUserFullName === 'function') return global.currentUserFullName() || 'Unknown'; } catch (e) {}
    try { if (typeof global.getCurrentUser === 'function') return global.getCurrentUser().username || 'Unknown'; } catch (e) {}
    return 'Unknown';
  }

  async function recordUpload(db, type, dates, fileName, rowCount, productDays) {
    await db.collection('uploads').add({
      type, dates, fileName: fileName || '', rowCount, productDays,
      uploadedBy: currentUserName(), uploadedAt: new Date().toISOString(),
    });
  }

  // Delete rollup docs for the given dates + type (chunked), then return count removed.
  async function deleteDocsForDates(db, type, dates) {
    const dateSet = new Set(dates);
    let removed = 0;
    // Rollup docs are keyed BY date (doc id = date): delete them directly.
    if (type === 'inventory') {
      const rollupCols = ['inventoryDaily', 'dailyPurchases'];
      for (const d of dateSet) {
        for (const col of rollupCols) {
          try { await db.collection(col).doc(d).delete(); removed++; } catch (e) { /* may not exist */ }
        }
      }
    }
    if (type === 'sales') {
      // Sales is rollup-only: delete the salesDaily day-doc (keyed by date).
      for (const d of dateSet) {
        try { await db.collection('salesDaily').doc(d).delete(); removed++; } catch (e) { /* may not exist */ }
      }
    }
    // Legacy raw rows (inventory still writes them) keyed by content-hash id:
    // query by date field and delete in pages. Sales no longer writes raw rows.
    const queryCols = type === 'inventory' ? [['inventoryData', 'dateDelivered']] : [];
    for (const [col, field] of queryCols) {
      for (const d of dateSet) {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const snap = await db.collection(col).where(field, '==', d).limit(400).get();
          if (snap.empty) break;
          const batch = db.batch();
          snap.docs.forEach((doc) => batch.delete(doc.ref));
          await batch.commit();
          removed += snap.size;
          if (snap.size < 400) break;
        }
      }
    }
    return removed;
  }

  /* ---- Dialog / flow orchestration ------------------------------------- */
  function openImportDialog(opts) {
    const fieldSetName = opts && opts.fieldSet;
    const fieldDefs = (opts && opts.fields) || FIELD_SETS[fieldSetName];
    if (!fieldDefs) throw new Error('Unknown fieldSet: ' + fieldSetName);
    const onDone = (opts && opts.onDone) || function () {};
    // Custom importer(rows, onProgress) -> {inserted, ...}. Overrides the built-in writer.
    const customImporter = opts && opts.importer;
    // MIS import dedups by content hash itself, so skip the date-based duplicate block.
    const skipDuplicateCheck = !!(opts && opts.skipDuplicateCheck);
    const dialogTitle = (opts && opts.title) || ('Import ' + String(fieldSetName || 'Data'));

    const state = { grid: null, hasHeader: true, cols: null, mapping: {}, file: null };

    // ----- build modal shell (reuses existing .modal-* classes) -----
    const body = el('div', { class: 'modal-body', id: 'imp-body' });
    const footer = el('div', { class: 'modal-footer', id: 'imp-footer' });
    const card = el('div', { class: 'modal-card modal-lg' }, [
      el('div', { class: 'modal-header' }, [
        el('span', { class: 'modal-title', text: dialogTitle }),
        el('button', { class: 'modal-close', onclick: close }, ['✕']),
      ]),
      body, footer,
    ]);
    const overlay = el('div', { class: 'modal-overlay open', id: 'imp-overlay' }, [card]);
    overlay.style.display = 'flex';
    document.body.appendChild(overlay);
    function close() { overlay.remove(); }

    // ----- step: pick file -----
    function renderPick() {
      body.innerHTML = ''; footer.innerHTML = '';
      const input = el('input', { type: 'file', accept: '.csv,.xlsx,.xls', class: 'imp-file' });
      body.append(
        el('p', { class: 'imp-note', text: 'Choose a .csv or .xlsx file. You will map its columns next.' }),
        input,
        el('div', { class: 'imp-error', id: 'imp-pick-err' })
      );
      input.addEventListener('change', async () => {
        if (!input.files.length) return;
        state.file = input.files[0];
        try {
          state.grid = await parseFile(state.file);
          if (!state.grid.length) throw new Error('File appears empty.');
          renderMapping();
        } catch (e) { $('#imp-pick-err').textContent = 'Could not read file: ' + e.message; }
      });
    }

    // ----- step: header toggle + column mapping + preview -----
    function renderMapping() {
      state.cols = deriveColumns(state.grid, state.hasHeader);
      if (!Object.keys(state.mapping).length || state._reguess) {
        state.mapping = autoGuess(state.cols.labels, fieldDefs);
        state._reguess = false;
      }
      body.innerHTML = ''; footer.innerHTML = '';

      // header checkbox
      const chk = el('input', { type: 'checkbox' });
      chk.checked = state.hasHeader;
      chk.addEventListener('change', () => { state.hasHeader = chk.checked; state._reguess = true; renderMapping(); });
      body.append(el('label', { class: 'imp-check' }, [chk, el('span', { text: ' First row contains column headers' })]));

      // mapping table
      const mapWrap = el('div', { class: 'imp-map' });
      fieldDefs.forEach((f) => {
        const sel = el('select', { class: 'imp-select', 'data-field': f.name });
        sel.appendChild(el('option', { value: '' }, [f.required ? '— choose column —' : '— skip —']));
        state.cols.labels.forEach((lab, i) => {
          const o = el('option', { value: String(i) }, [lab]);
          if (state.mapping[f.name] === i) o.selected = true;
          sel.appendChild(o);
        });
        sel.addEventListener('change', () => {
          state.mapping[f.name] = sel.value === '' ? null : Number(sel.value);
          renderPreview();
        });
        mapWrap.append(
          el('div', { class: 'imp-map-row' }, [
            el('div', { class: 'imp-map-field' }, [
              el('span', { text: f.label }),
              f.required ? el('span', { class: 'imp-req', text: ' *' }) : el('span', { class: 'imp-opt', text: ' (optional)' }),
            ]),
            sel,
          ])
        );
      });
      body.append(el('h4', { class: 'imp-h', text: 'Map your columns' }), mapWrap);
      body.append(el('div', { class: 'imp-preview', id: 'imp-preview' }));

      const next = el('button', { class: 'btn btn-primary', id: 'imp-next' }, ['Continue to Import']);
      next.addEventListener('click', doImport);
      footer.append(el('button', { class: 'btn', onclick: renderPick }, ['Back']), next);
      renderPreview();
    }

    // build mapped row objects from current mapping
    function mappedRows() {
      return state.cols.dataRows
        .filter((r) => r.some((c) => String(c).trim() !== ''))
        .map((r) => {
          const o = {};
          fieldDefs.forEach((f) => { const i = state.mapping[f.name]; o[f.name] = i == null ? '' : r[i]; });
          return o;
        });
    }

    function renderPreview() {
      const rows = mappedRows();
      let valid = 0, problem = 0, blocking = 0;
      rows.forEach((o) => {
        const ps = validateRow(o, fieldDefs);
        if (!ps.length) valid++; else { problem++; if (ps.some(isBlocking)) blocking++; }
      });
      const host = $('#imp-preview'); host.innerHTML = '';
      host.append(el('h4', { class: 'imp-h', text: 'Preview (first 10 rows as mapped)' }));

      const table = el('table', { class: 'imp-table' });
      const thead = el('tr', {}, fieldDefs.map((f) => el('th', { text: f.label })));
      table.append(el('thead', {}, [thead]));
      const tb = el('tbody');
      rows.slice(0, 10).forEach((o) => {
        const ps = validateRow(o, fieldDefs);
        const badFields = new Set(ps.map((p) => p.field));
        tb.append(el('tr', {}, fieldDefs.map((f) =>
          el('td', { class: badFields.has(f.name) ? 'imp-bad' : '' }, [String(o[f.name] == null ? '' : o[f.name])])
        )));
      });
      table.append(tb);
      host.append(table);

      host.append(el('div', { class: 'imp-counts' }, [
        el('span', { class: 'imp-ok', text: `✓ ${valid} valid` }),
        el('span', { class: 'imp-warn', text: `  ⚠ ${problem} with problems` }),
        blocking ? el('span', { class: 'imp-block', text: `  ✕ ${blocking} blocked (required-field errors)` }) : el('span', { text: '' }),
      ]));

      const unmappedReq = fieldDefs.filter((f) => f.required && state.mapping[f.name] == null).map((f) => f.label);
      const next = $('#imp-next');
      if (next) {
        const blockedByReq = unmappedReq.length > 0 || blocking > 0;
        next.disabled = blockedByReq || valid === 0;
        next.textContent = unmappedReq.length ? `Map required: ${unmappedReq.join(', ')}`
          : blocking ? `Fix ${blocking} blocked row(s) to import`
          : `Import ${valid} valid row(s)`;
      }
    }

    // ----- step: import (with duplicate-date block BEFORE any write) -----
    async function doImport() {
      const rows = mappedRows().filter((o) => !validateRow(o, fieldDefs).some(isBlocking));
      const fileDates = datesInRows(rows, fieldSetName);
      const productDays = rows.length; // one row per (date x item_code)
      body.innerHTML = ''; footer.innerHTML = '';
      const status = el('div', { class: 'imp-status', text: 'Checking for duplicate dates…' });
      const bar = el('div', { class: 'imp-bar' }, [el('div', { class: 'imp-bar-fill', id: 'imp-bar-fill' })]);
      body.append(el('h4', { class: 'imp-h', text: 'Importing' }), bar, status);
      const onProgress = (done, total, msg) => {
        const pct = total ? Math.round((done / total) * 100) : 0;
        $('#imp-bar-fill').style.width = pct + '%';
        status.textContent = msg ? msg : `${done.toLocaleString()} / ${total.toLocaleString()} written (${pct}%)`;
      };

      const db = global.getFirestoreDB();
      try {
        // --- DUPLICATE BLOCK: reject the WHOLE file if any date already uploaded (same type) ---
        const conflicts = skipDuplicateCheck ? [] : await findDateConflicts(db, fieldSetName, fileDates);
        if (conflicts.length) {
          status.textContent = 'Comparing against existing data…';
          // Smart per-date comparison: exact duplicate vs differing correction.
          const msgs = await smartConflictMessages(db, fieldSetName, rows, conflicts);
          const allExact = msgs.length && msgs.every((m) => m.exact);
          body.innerHTML = '';
          body.append(
            el('div', { class: allExact ? 'imp-note' : 'imp-error' }, [
              el('strong', { text: allExact
                ? `This file's data is already uploaded — nothing to do.`
                : `Blocked — ${msgs.length} date(s) already have a ${fieldSetName} upload.` }),
            ]),
            el('p', { class: 'imp-note', text: allExact
              ? 'Every conflicting date matches what is already stored. No import was performed.'
              : 'Nothing was imported. Delete the conflicting upload(s) below to free these dates, or upload a file without them.' }),
            el('ul', { class: 'imp-conflicts' }, msgs.map((m) => el('li', { text: m.text }))),
          );
          footer.innerHTML = '';
          footer.append(el('button', { class: 'btn', onclick: renderMapping }, ['Back']));
          return;
        }

        // --- FILENAME WARNING (soft): same-named file already uploaded (any dates)? ---
        if (!skipDuplicateCheck) {
          const fname = state.file && state.file.name;
          const sameName = await findSameFilenameUpload(db, fieldSetName, fname);
          if (sameName) {
            const proceed = global.confirm(
              `A file named "${sameName.fileName}" was already uploaded on ${sameName.date}.\n\nContinue anyway?`);
            if (!proceed) { status.textContent = ''; renderMapping(); return; }
          }
        }

        // --- No conflicts: import ---
        const res = customImporter
          ? await customImporter(rows, onProgress)
          : fieldSetName === 'sales'
            ? await importSales(rows, onProgress)
            : await importInventory(rows, onProgress);

        // --- Record the upload ONLY after all batches succeeded (built-in flows only) ---
        if (!customImporter) {
          status.textContent = 'Recording upload…';
          // rowCount = file rows; productDays = distinct (date x item) from the importer.
          await recordUpload(db, fieldSetName, fileDates, state.file && state.file.name, rows.length, (res.productDays != null ? res.productDays : productDays));
        }

        status.textContent = 'Done.';
        const summary = res.summary || `Inserted ${(res.inserted || 0).toLocaleString()} row(s) across ${fileDates.length} date(s).`;
        body.append(el('p', { class: 'imp-ok', text: summary }));
        footer.append(el('button', { class: 'btn btn-primary', onclick: () => { close(); onDone(res); } }, ['Close']));
      } catch (e) {
        status.textContent = '';
        if (e.isDuplicateBlock) {
          // Custom importer (inventory) raised a duplicate-date block. Render the
          // smart message as bullet lines — no "import failed", nothing was written.
          const raw = String(e.message || '');
          const parts = raw.split('\n• ');
          const head = parts.shift();
          const allExact = /already uploaded — nothing to do/.test(head);
          body.innerHTML = '';
          body.append(el('div', { class: allExact ? 'imp-note' : 'imp-error' }, [el('strong', { text: head })]));
          if (parts.length) body.append(el('ul', { class: 'imp-conflicts' }, parts.map((t) => el('li', { text: t }))));
        } else {
          body.append(
            el('p', { class: 'imp-error', text: 'Import failed: ' + e.message }),
            el('p', { class: 'imp-note', text: 'If some rows were written before the error, no upload record was saved. Use the uploaded-data list to Delete/Replace the affected date(s) before retrying.' })
          );
        }
        footer.append(el('button', { class: 'btn', onclick: renderMapping }, ['Back']));
      }
    }

    // If a file was handed in (drag-drop / external picker), skip the pick step.
    async function startWithFile(file) {
      state.file = file;
      try {
        state.grid = await parseFile(state.file);
        if (!state.grid.length) throw new Error('File appears empty.');
        renderMapping();
      } catch (e) {
        renderPick();
        const err = $('#imp-pick-err'); if (err) err.textContent = 'Could not read file: ' + e.message;
      }
    }
    if (opts && opts.initialFile) startWithFile(opts.initialFile);
    else renderPick();
    return { close };
  }

  /* ---- Uploaded-data list + delete/replace ----------------------------- */
  // Render the list of uploads into a container element. sortKey: 'date'|'uploadedAt'|'type'.
  async function renderUploadsList(container, opts) {
    opts = opts || {};
    const sortKey = opts.sortKey || 'date';
    const dir = opts.dir === 'desc' ? -1 : 1;
    const host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host) return;
    host.innerHTML = '<p class="imp-note">Loading uploads…</p>';
    const db = global.getFirestoreDB();
    let uploads = [];
    try {
      const snap = await db.collection('uploads').get();
      snap.forEach((doc) => uploads.push(Object.assign({ id: doc.id }, doc.data())));
    } catch (e) { host.innerHTML = '<p class="imp-error">Could not load uploads: ' + e.message + '</p>'; return; }

    const firstDate = (u) => (u.dates && u.dates.length ? u.dates.slice().sort()[0] : '');
    uploads.sort((a, b) => {
      let av, bv;
      if (sortKey === 'date') { av = firstDate(a); bv = firstDate(b); }
      else if (sortKey === 'type') { av = a.type || ''; bv = b.type || ''; }
      else { av = a.uploadedAt || ''; bv = b.uploadedAt || ''; }
      return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
    });

    host.innerHTML = '';
    if (!uploads.length) { host.append(el('p', { class: 'imp-note', text: 'No uploads yet.' })); return; }

    // Paginate: 5 uploads per page. Current page is remembered per host + sort.
    const PAGE_SIZE = 5;
    const totalPages = Math.max(1, Math.ceil(uploads.length / PAGE_SIZE));
    let page = Number(host.dataset.uploadsPage) || 1;
    if (page > totalPages) page = totalPages;
    if (page < 1) page = 1;
    host.dataset.uploadsPage = String(page);
    const start = (page - 1) * PAGE_SIZE;
    const pageUploads = uploads.slice(start, start + PAGE_SIZE);

    const table = el('table', { class: 'imp-table imp-uploads' });
    const head = ['Date(s)', 'Type', 'File', 'Rows', 'Product-Days', 'Uploaded By', 'Uploaded At', ''];
    table.append(el('thead', {}, [el('tr', {}, head.map((h) => el('th', { text: h })))]));
    const tb = el('tbody');
    pageUploads.forEach((u) => {
      const ds = (u.dates || []).slice().sort();
      const dateLabel = ds.length <= 3 ? ds.join(', ') : `${ds[0]} … ${ds[ds.length - 1]} (${ds.length} days)`;
      const del = el('button', { class: 'btn btn-sm imp-del', text: 'Delete/Replace' });
      del.addEventListener('click', () => confirmDelete(u, () => renderUploadsList(host, opts)));
      tb.append(el('tr', {}, [
        el('td', { text: dateLabel }),
        el('td', { text: u.type || '' }),
        el('td', { text: u.fileName || '' }),
        el('td', { text: String(u.rowCount == null ? '' : u.rowCount) }),
        el('td', { text: String(u.productDays == null ? '' : u.productDays) }),
        el('td', { text: u.uploadedBy || '' }),
        el('td', { text: (u.uploadedAt || '').replace('T', ' ').slice(0, 19) }),
        el('td', {}, [del]),
      ]));
    });
    table.append(tb);
    host.append(table);

    // Pager (only when more than one page).
    if (totalPages > 1) {
      const goTo = (p) => { host.dataset.uploadsPage = String(p); renderUploadsList(host, opts); };
      const prev = el('button', { class: 'btn btn-sm', text: '‹ Prev' });
      prev.disabled = page <= 1;
      prev.addEventListener('click', () => goTo(page - 1));
      const next = el('button', { class: 'btn btn-sm', text: 'Next ›' });
      next.disabled = page >= totalPages;
      next.addEventListener('click', () => goTo(page + 1));
      const info = el('span', { class: 'imp-note', text:
        `Page ${page} of ${totalPages} — ${uploads.length.toLocaleString()} upload(s)` });
      host.append(el('div', { class: 'imp-uploads-pager' }, [prev, info, next]));
    }
  }

  function confirmDelete(upload, onDone) {
    const ds = (upload.dates || []).slice().sort();
    const body = el('div', { class: 'modal-body' });
    const footer = el('div', { class: 'modal-footer' });
    const card = el('div', { class: 'modal-card' }, [
      el('div', { class: 'modal-header' }, [
        el('span', { class: 'modal-title', text: 'Delete / Replace upload' }),
        el('button', { class: 'modal-close', onclick: close }, ['✕']),
      ]),
      body, footer,
    ]);
    const overlay = el('div', { class: 'modal-overlay open' }, [card]);
    overlay.style.display = 'flex';
    document.body.appendChild(overlay);
    function close() { overlay.remove(); }

    body.append(
      el('p', { text: `This removes the upload record and ALL ${upload.type} data for the following date(s):` }),
      el('p', { class: 'imp-warn', text: ds.join(', ') }),
      el('p', { class: 'imp-note', text: `Collections affected: ${upload.type === 'inventory' ? 'inventoryData' : 'salesData + underReviewData'}. This frees the date(s) to be re-uploaded. This cannot be undone.` }),
      el('div', { class: 'imp-status', id: 'imp-del-status' })
    );
    const go = el('button', { class: 'btn btn-primary', text: 'Delete' });
    const cancel = el('button', { class: 'btn', onclick: close }, ['Cancel']);
    go.addEventListener('click', async () => {
      go.disabled = true; cancel.disabled = true;
      const st = document.getElementById('imp-del-status');
      try {
        const db = global.getFirestoreDB();
        st.textContent = 'Deleting data for date(s)…';
        const removed = await deleteDocsForDates(db, upload.type, ds);
        st.textContent = 'Removing upload record…';
        await db.collection('uploads').doc(upload.id).delete();
        st.textContent = '';
        body.append(el('p', { class: 'imp-ok', text: `Deleted ${removed.toLocaleString()} doc(s). Date(s) freed for re-upload.` }));
        footer.innerHTML = '';
        footer.append(el('button', { class: 'btn btn-primary', onclick: () => { close(); if (onDone) onDone(); } }, ['Close']));
      } catch (e) {
        st.textContent = '';
        body.append(el('p', { class: 'imp-error', text: 'Delete failed: ' + e.message }));
        go.disabled = false; cancel.disabled = false;
      }
    });
    footer.append(cancel, go);
  }

  global.EPCImport = {
    openImportDialog, renderUploadsList, FIELD_SETS,
    // Shared duplicate-handling helpers (reused by the inventory page's own block).
    findDateConflicts, findSameFilenameUpload, smartConflictMessages,
    _internals: { autoGuess, normDate, validateRow, deriveColumns, datesInRows },
  };
})(window);

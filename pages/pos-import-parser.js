// ─── Row validation helpers ───────────────────────────────────────────────────
function normalizeHeaderText(v) {
  return String(v ?? '').replace(/^﻿/, '').trim().toLowerCase()
    .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}
function isPOSHeaderLabel(v) { return POS_HEADER_LABELS.has(normalizeHeaderText(v)); }

function looksLikePOSHeaderRow(values, qty = 0, total = 0) {
  const nonEmpty = values.map(v => String(v ?? '').trim()).filter(Boolean);
  if (!nonEmpty.length) return true;
  const lc = nonEmpty.filter(isPOSHeaderLabel).length;
  return lc >= 2 || (lc >= 1 && qty === 0 && total === 0);
}

function isValidPOSImportRow({ barcode = '', itemName = '', quantity = 0, total = 0, values = [] }) {
  if (!String(barcode).trim() && !String(itemName).trim()) return false;
  if (!String(itemName).trim() || isPOSHeaderLabel(itemName)) return false;
  if (String(barcode).trim() && isPOSHeaderLabel(barcode)) return false;
  if (looksLikePOSHeaderRow(values, quantity, total)) return false;
  return true;
}

function processFile(file) {
  if (!requireSalesEditAccess()) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['csv','xls','xlsx'].includes(ext)) { alert('Please upload a CSV, XLS, or XLSX file.'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    if (ext === 'csv') parseCSV(e.target.result, file.name);
    else               parseXLS(e.target.result, file.name);
  };
  if (ext === 'csv') reader.readAsText(file);
  else               reader.readAsArrayBuffer(file);
}

// ─── CSV utilities ────────────────────────────────────────────────────────────
function parseCSVRow(line) {
  const cells = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      cells.push(cur.trim()); cur = '';
    } else { cur += c; }
  }
  cells.push(cur.trim());
  return cells;
}

function csvToRawRows(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"') {
      if (inQ && next === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (c === ',' && !inQ) {
      row.push(cur.trim());
      cur = '';
    } else if ((c === '\n' || c === '\r') && !inQ) {
      if (c === '\r' && next === '\n') i++;
      row.push(cur.trim());
      cur = '';
      if (row.some(v => v.trim())) rows.push(row);
      row = [];
    } else {
      cur += c;
    }
  }

  row.push(cur.trim());
  if (row.some(v => v.trim())) {
    rows.push(row);
  }
  return rows;
}

// ─── Auto-detection ───────────────────────────────────────────────────────────
function detectPOSHeaderRow(rawRows) {
  for (let i = 0; i < Math.min(25, rawRows.length); i++) {
    const normed  = rawRows[i].map(v => normalizeHeaderText(v));
    const hasCode = normed.some(v =>
      POS_COL_ALIASES.itemCode.includes(v) || POS_COL_ALIASES.barcode.includes(v));
    const hasName = normed.some(v => POS_COL_ALIASES.itemName.includes(v));
    if (hasCode && hasName) return i;
  }
  return -1;
}

function detectHeaderRow(rawRows) {
  return detectPOSHeaderRow(rawRows);
}

function extractCols(headerRow) {
  const cols = {};
  headerRow.forEach((v, i) => {
    const n = normalizeHeaderText(v);
    for (const [field, aliases] of Object.entries(POS_COL_ALIASES)) {
      if (aliases.includes(n) && !(field in cols)) cols[field] = i;
    }
  });
  return cols;
}

// ─── Date Detection ───────────────────────────────────────────────────────────
function validateAndDetectDates(rawRows, headerIdx) {
  detectedMode = ''; detectedSingleDate = '';
  detectedRangeStart = detectedRangeEnd = '';
  detectedDateColIdx = -1; detectedDateColName = '';

  const rangeRe  = /(\d{1,2}\/\d{1,2}\/\d{4})\s+to\s+(\d{1,2}\/\d{1,2}\/\d{4})/i;
  const singleRe = /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/;
  const mdyRe    = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

  const headerText = rawRows.slice(0, headerIdx).map(r => r.join(' ')).join(' ');
  const rangeMatch = headerText.match(rangeRe);

  if (rangeMatch) {
    const d1 = new Date(rangeMatch[1]), d2 = new Date(rangeMatch[2]);
    if (!isNaN(d1) && !isNaN(d2)) {
      detectedRangeStart = d1.toISOString().slice(0, 10);
      detectedRangeEnd   = d2.toISOString().slice(0, 10);
    }
    const dataStart  = headerIdx + 1;
    const sampleData = rawRows.slice(dataStart, Math.min(dataStart + 8, rawRows.length));
    let colIdx = -1, colName = '';
    if (sampleData.length) {
      const numCols = sampleData.reduce((m, r) => Math.max(m, r.length), 0);
      for (let c = 0; c < numCols; c++) {
        const hits = sampleData.filter(r => mdyRe.test(String(r[c] || '').trim())).length;
        if (hits >= Math.min(2, sampleData.length)) {
          colIdx  = c;
          const hdrRow = rawRows[headerIdx];
          colName = hdrRow ? (String(hdrRow[c] || '').trim() || `Column ${c + 1}`) : `Column ${c + 1}`;
          break;
        }
      }
    }
    if (colIdx === -1) {
      return { valid: false,
        error: 'This file covers a date range but has no per-item date column. Please export a daily report.' };
    }
    detectedMode = 'range'; detectedDateColIdx = colIdx; detectedDateColName = colName;
    return { valid: true };
  }

  const singleMatch = headerText.match(singleRe);
  if (singleMatch) {
    const d = new Date(singleMatch[1]);
    if (!isNaN(d)) {
      detectedMode = 'single'; detectedSingleDate = d.toISOString().slice(0, 10);
      return { valid: true };
    }
  }

  detectedMode = 'single'; detectedSingleDate = todayISO();
  return { valid: true };
}

// ─── Detailed Sales Report format detection ───────────────────────────────────
const DETAILED_SALES_DATA_START_ROW = 16;
const DETAILED_SALES_COLS = Object.freeze({
  date: 6,
  itemCode: 8,
  itemName: 12,
  quantity: 16,
  srpwdDiscount: 22,
  discount: 24,
  sellingPrice: 26,
  totalRevenue: 35,
});

function findDetailedSalesReportHeader(rawRows) {
  for (let i = 0; i < Math.min(30, rawRows.length); i++) {
    const normalized = rawRows[i].map(v => normalizeHeaderText(v).replace(/\./g, ''));
    const hasBarcode = normalized.includes('barcode');
    const hasItemName = normalized.includes('itemname') || normalized.includes('item name');
    const hasQty = normalized.includes('qty') || normalized.includes('quantity');
    const hasTotalAmount = normalized.includes('total amt') || normalized.includes('total amount');
    if (hasBarcode && hasItemName && hasQty && hasTotalAmount) return i;
  }
  return -1;
}

// Returns true if rawRows look like a "DETAILED SALES REPORT" export.
function isDetailedSalesReportFormat(rawRows) {
  return findDetailedSalesReportHeader(rawRows) !== -1 ||
    rawRows.slice(0, 10).some(row => row.some(cell => normalizeHeaderText(cell).includes('detailed sales report')));
}

// ─── Detailed Sales Report parser (fixed column indices) ─────────────────────
// Cost and Total Cost are intentionally NOT read from the file; Product Master
// remains the source of truth for costing.
function parseDetailedSalesReport(rawRows, filename) {
  if (!requireSalesEditAccess()) return;
  xlsData = [];
  if (rawRows.length <= DETAILED_SALES_DATA_START_ROW) {
    alert('No data rows found. Verify this is a valid Detailed Sales Report file.');
    return;
  }
  const cols = DETAILED_SALES_COLS;
  let lastSeenDate = todayISO();

  function parseDateCol(v) {
    if (v === '' || v === null || v === undefined) return null;
    if (typeof v === 'number') {
      const d = XLSX.SSF.parse_date_code(v);
      if (d) {
        const mm = String(d.m).padStart(2, '0');
        const dd = String(d.d).padStart(2, '0');
        return `${d.y}-${mm}-${dd}`;
      }
    }
    const s = String(v).trim();
    if (!s) return null;
    const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdy) {
      return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
    }
    const d = new Date(s);
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
    return null;
  }

  for (let i = DETAILED_SALES_DATA_START_ROW; i < rawRows.length; i++) {
    const row = rawRows[i];

    const dateVal = parseDateCol(row[cols.date]);
    if (dateVal) lastSeenDate = dateVal;

    const itemName = String(row[cols.itemName] ?? '').trim();
    if (!itemName) continue;

    const itemCode   = String(row[cols.itemCode] ?? '').trim();
    const quantity   = parsePeso(row[cols.quantity]);
    const srpwdDisc  = parsePeso(row[cols.srpwdDiscount]);
    const regDisc    = parsePeso(row[cols.discount]);
    const sellingPrice = parsePeso(row[cols.sellingPrice]);
    const netTotal   = parsePeso(row[cols.totalRevenue]);
    const discount   = srpwdDisc + regDisc;

    if (!itemCode || quantity <= 0 || netTotal <= 0) continue;

    xlsData.push({
      itemCode,
      productName:  itemName,
      unitsSold:    quantity,
      sellingPrice,
      totalRevenue: netTotal,
      dateSold:     lastSeenDate,
      srpUnit:      sellingPrice,
      discount,
      srpwdDiscount: srpwdDisc,
    });
  }

  // Sanity-check: echo parsed records before Firestore writes (no cost fields).
  console.log('[DSR Import] First 5 parsed records:',
    xlsData.slice(0, 5).map(r => ({
      itemName: r.productName,
      qty: r.unitsSold,
      sellingPrice: r.sellingPrice,
      discount: r.discount,
      totalRevenue: r.totalRevenue
    }))
  );
  console.log('[DSR Import] Verification rows:',
    xlsData
      .filter(r => [
        'REBISCO SANDWICH FAMILY BUNCH 20`SX10',
        'SURF BAR CHERRY BLOSSOM',
      ].some(name => normalizeHeaderText(r.productName).includes(normalizeHeaderText(name))))
      .map(r => ({
        itemName: r.productName,
        qty: r.unitsSold,
        sellingPrice: r.sellingPrice,
        srpwdDiscount: r.srpwdDiscount,
        discount: r.discount,
        totalRevenue: r.totalRevenue,
      }))
  );

  if (!xlsData.length) {
    alert('No data rows found. Verify this is a valid Detailed Sales Report file.');
    return;
  }

  // Reuse detected-mode state: treat as single-date mode (dates are per-row).
  detectedMode       = 'range';
  detectedRangeStart = xlsData[0]?.dateSold || todayISO();
  detectedRangeEnd   = xlsData[xlsData.length - 1]?.dateSold || todayISO();
  detectedSingleDate = '';
  detectedDateColIdx = -1;

  autoImportXLS(filename).catch(err => {
    console.error('[DSR Import] Fatal error:', err);
    document.getElementById('import-status').style.display = 'none';
    dropZone.classList.remove('is-import-disabled');
    fileInput.disabled = false;
    setCostMethodInputsDisabled(false);
    xlsData = [];
    showImportMessage('error', 'Import failed. Please check your connection and try again.');
  });
}

// ─── File parsers → processPOSFile ───────────────────────────────────────────
function parseXLS(buffer, filename) {
  if (typeof XLSX === 'undefined') { alert('SheetJS failed to load. Please refresh.'); return; }
  try {
    const wb      = XLSX.read(buffer, { type: 'array' });
    const ws      = wb.Sheets[wb.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true });
    if (isDetailedSalesReportFormat(rawRows)) {
      parseDetailedSalesReport(rawRows, filename);
    } else {
      processPOSFile(rawRows, filename, 9);
    }
  } catch (err) { alert('Error reading file: ' + err.message); }
}

function parseCSV(text, filename) {
  try {
    const rawRows = csvToRawRows(text);
    if (isDetailedSalesReportFormat(rawRows)) {
      parseDetailedSalesReport(rawRows, filename);
    } else {
      processPOSFile(rawRows, filename);
    }
  } catch (err) { alert('Error reading CSV: ' + err.message); }
}

function processPOSFile(rawRows, filename, fixedHeaderIdx = null) {
  if (!requireSalesEditAccess()) return;
  if (!rawRows.length) { alert('File appears empty.'); return; }

  const headerIdx = fixedHeaderIdx ?? detectHeaderRow(rawRows);
  if (fixedHeaderIdx !== null && !rawRows[headerIdx]) {
    alert('Cannot find XLS column headers on row 10. Verify this is a valid POS export file.');
    return;
  }
  if (headerIdx === -1) {
    alert('Cannot find column headers.\n\nExpected a row with "Material Code"/"Barcode" and "Item Name".\nVerify this is a valid POS export file.');
    return;
  }

  const dateCheck = validateAndDetectDates(rawRows, headerIdx);
  if (!dateCheck.valid) { alert(dateCheck.error); return; }

  const cols = extractCols(rawRows[headerIdx]);
  const hasIdentifier = cols.itemCode !== undefined || cols.barcode !== undefined;
  const missing = ['itemName','quantity','total'].filter(f => cols[f] === undefined);
  if (!hasIdentifier || missing.length) {
    alert('Required columns not found: ' +
      [...(!hasIdentifier ? ['Material Code / Barcode'] : []), ...missing].join(', ') +
      '\n\nDetected headers: ' + rawRows[headerIdx].filter(Boolean).join(', '));
    return;
  }

  xlsData = [];
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const row      = rawRows[i];
    const itemCode = String(row[cols.itemCode] ?? '').trim()
                  || String(row[cols.barcode]  ?? '').trim();
    const itemName = String(row[cols.itemName] ?? '').trim();
    const quantity = parsePeso(row[cols.quantity]);
    const total    = parsePeso(row[cols.total]);

    if (!itemCode && !itemName) continue;
    if (!isValidPOSImportRow({ barcode: itemCode, itemName, quantity, total, values: row })) continue;

    let dateSold = detectedSingleDate || todayISO();
    if (detectedMode === 'range' && detectedDateColIdx >= 0) {
      const raw = String(row[detectedDateColIdx] ?? '').trim();
      const d   = new Date(raw);
      dateSold  = !isNaN(d) ? d.toISOString().slice(0, 10) : (detectedRangeStart || todayISO());
    }

    xlsData.push({
      itemCode,
      productName:  itemName,
      unitsSold:    quantity,
      totalRevenue: total,
      dateSold
    });
  }

  if (!xlsData.length) {
    alert('No data rows found after the header. Verify the file is a valid POS export.');
    return;
  }

  // Kick off the async Firestore import — fire-and-forget with error handler
  autoImportXLS(filename).catch(err => {
    console.error('[POS Import] Fatal error:', err);
    document.getElementById('import-status').style.display = 'none';
    dropZone.classList.remove('is-import-disabled');
    fileInput.disabled = false;
    setCostMethodInputsDisabled(false);
    xlsData = [];
    showImportMessage('error', 'Import failed. Please check your connection and try again.');
  });
}

// ─── Auto Import (async, Firestore-backed) ────────────────────────────────────
async function autoImportXLS(filename) {
  if (!requireSalesEditAccess()) return;
  const statusEl = document.getElementById('import-status');
  const fillEl   = document.getElementById('progress-fill');
  const labelEl  = document.getElementById('import-status-label');
  statusEl.style.display = '';
  fillEl.style.width     = '0%';
  labelEl.textContent    = 'Loading...';
  dropZone.classList.add('is-import-disabled');
  fileInput.disabled = true;
  setCostMethodInputsDisabled(true);

  // 1. Fetch Product Master once, keyed by itemCode field value (not doc ID)
  const [pmSnap, inventoryCostMap] = await Promise.all([
    db.collection('productMaster').get(),
    loadInventoryUnitCostMap(),
  ]);
  const productMap = {};
  pmSnap.forEach(doc => {
    const d    = doc.data();
    const code = String(d.itemCode || '').trim();
    if (code) productMap[code] = { ...d, _docId: doc.id };
  });
  labelEl.textContent = 'Processing rows…';

  // 2. Split rows into matched (→ salesData) and unmatched (→ underReviewData)
  const importedAt  = new Date().toISOString();
  const imported    = [];   // matched
  const toReview    = [];   // unmatched

  for (const r of xlsData) {
    const codeKey = String(r.itemCode || '').trim();
    const prod    = productMap[codeKey];

    if (prod) {
      const unitCost     = inventoryUnitCostForCode(inventoryCostMap, codeKey) || productCostForMethod(prod);
      const unitsSold    = r.unitsSold    || 0;
      const totalCost    = unitCost * unitsSold;
      const totalRevenue = r.totalRevenue || 0;
      const sellingPrice = Number(r.sellingPrice ?? r.srpUnit) || (unitsSold > 0 ? totalRevenue / unitsSold : 0);
      const grossProfit  = salesGrossProfitAmount({ ...r, unitsSold, unitCost, totalCost, sellingPrice, totalRevenue });
      const margin       = salesMarginPercent(grossProfit, { ...r, unitsSold, unitCost, totalCost, sellingPrice, totalRevenue });
      imported.push({
        date:         r.dateSold,
        itemCode:     r.itemCode,
        productName:  prod.productName || r.productName,
        category:     prod.category   || 'Uncategorized',
        unitsSold, unitCost, totalCost, sellingPrice, totalRevenue, grossProfit, margin,
        ...(r.srpUnit    !== undefined && { srpUnit:   r.srpUnit }),
        ...(r.discount   !== undefined && { discount:  r.discount }),
        ...(r.srpwdDiscount !== undefined && { srpwdDiscount: r.srpwdDiscount }),
        importedAt,   filename,
        costMethod,
        dateMode:     detectedMode,
        dateRangeStart: detectedRangeStart,
        dateRangeEnd:   detectedRangeEnd
      });
    } else {
      const unitsSold    = r.unitsSold    || 0;
      const totalRevenue = r.totalRevenue || 0;
      const sellingPrice = Number(r.sellingPrice ?? r.srpUnit) || (unitsSold > 0 ? totalRevenue / unitsSold : 0);
      toReview.push({
        date:        r.dateSold,
        itemCode:    r.itemCode,
        productName: r.productName,
        category:    'Uncategorized',
        unitsSold, sellingPrice, totalRevenue,
        ...(r.srpUnit    !== undefined && { srpUnit:   r.srpUnit }),
        ...(r.discount   !== undefined && { discount:  r.discount }),
        ...(r.srpwdDiscount !== undefined && { srpwdDiscount: r.srpwdDiscount }),
        importedAt, filename
      });
    }
  }

  const importMeta = {
    dateMode: detectedMode,
    singleDate: detectedSingleDate,
    dateRangeStart: detectedRangeStart,
    dateRangeEnd: detectedRangeEnd
  };
  xlsData = [];
  detectedMode = detectedSingleDate = detectedRangeStart = detectedRangeEnd = detectedDateColName = '';
  detectedDateColIdx = -1;

  // 3. Batch write with progress
  const totalToWrite = imported.length + toReview.length;
  let written = 0;

  function onBatch(batchSize) {
    written += batchSize;
    const pct = totalToWrite > 0 ? Math.round(written / totalToWrite * 100) : 100;
    fillEl.style.width  = pct + '%';
    labelEl.textContent = `Saving to database... ${pct}%`;
  }

  const savedImported = imported.length > 0
    ? await saveSalesDataBatch(imported, onBatch) : [];
  const savedReview   = toReview.length  > 0
    ? await saveUnderReviewBatch(toReview, onBatch) : [];

  // 4. Write import history entry
  const grandTotal = [...imported, ...toReview].reduce((s, r) => s + (r.totalRevenue || 0), 0);
  const historyDoc = {
    date:           importedAt,
    filename,
    count:          imported.length,
    reviewCount:    toReview.length,
    ...importMeta,
    costMethod,
    grandTotal
  };
  await addToImportHistory(historyDoc);

  // 5. Update local cache
  _salesData.unshift(...savedImported);
  _reviewData.push(...savedReview);

  // 6. Completion UI
  fillEl.style.width  = '100%';
  labelEl.textContent = 'Import complete! ✓';

  renderAll();

  setTimeout(() => {
    statusEl.style.display = 'none';
    dropZone.classList.remove('is-import-disabled');
    fileInput.disabled = false;
    setCostMethodInputsDisabled(false);
    applySalesPagePermissions();

    const reviewNote = savedReview.length > 0
      ? ` &nbsp;<strong>${savedReview.length} item${savedReview.length !== 1 ? 's' : ''}</strong> require unit cost review. Enter unit costs in <strong>Under Review</strong>.`
      : '';
    showImportMessage('success',
      `✅ <strong>${savedImported.length.toLocaleString()} records imported.</strong>${reviewNote}` +
      (savedImported.length > 0
        ? ` &nbsp;Total: <strong>${formatPeso(savedImported.reduce((s, r) => s + (r.totalRevenue || 0), 0))}</strong>`
        : ''));

    if (savedReview.length > 0) switchTab('review');
  }, 1500);
}

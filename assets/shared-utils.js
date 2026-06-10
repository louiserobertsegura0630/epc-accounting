// ─── shared-utils.js ─────────────────────────────────────────────────────────
// Cross-page utilities shared between POS Import, Product Master, Inventory Tracking, and Reports.
// Requires app.js (getFirestoreDB) to be loaded first.

window.EPCSalesCost = window.EPCSalesCost || (() => {
  function normalizeCode(value) {
    return String(value ?? '').trim().toUpperCase();
  }

  function getCostMethod() {
    return localStorage.getItem('costMethod') === 'average' ? 'average' : 'latest';
  }

  function productMap(products = []) {
    const map = {};
    products.forEach(product => {
      const rawCode = String(product.itemCode ?? product.code ?? '').trim();
      if (!rawCode) return;
      map[rawCode] = product;
      map[normalizeCode(rawCode)] = product;
    });
    return map;
  }

  function productUnitCost(product, method = getCostMethod()) {
    if (!product) return 0;
    const latest = Number(product.latestCost ?? product.unitCost ?? product.cost) || 0;
    const average = Number(product.averageCost) || 0;
    return method === 'average' ? (average || latest) : (latest || average);
  }

  function computeCostedSale(row, products = [], method = getCostMethod()) {
    const unitsSold = Number(row.unitsSold ?? row.qty ?? row.quantity) || 0;
    const totalRevenue = Number(row.totalRevenue ?? row.revenue ?? row.totalSales ?? row.total) || 0;
    const sellingPrice = Number(row.sellingPrice ?? row.srpUnit ?? row.srp) || (unitsSold > 0 ? totalRevenue / unitsSold : 0);
    if (!unitsSold || !totalRevenue) return null;

    const productsByCode = Array.isArray(products) ? productMap(products) : products;
    const code = String(row.itemCode || '').trim();
    const product = productsByCode[code] || productsByCode[normalizeCode(code)];
    const unitCost = product ? productUnitCost(product, method) : (Number(row.unitCost) || 0);
    const storedCost = Number(row.totalCost ?? row.cogs ?? row.costOfGoodsSold) || 0;
    const totalCost = unitCost > 0 ? unitCost * unitsSold : storedCost;
    if (!(totalCost > 0)) return null;

    const grossProfit = (sellingPrice * unitsSold) - totalCost;
    const margin = unitCost > 0 ? Number(((sellingPrice - unitCost) / unitCost * 100).toFixed(1)) : 0;
    return { ...row, unitCost, totalCost, totalRevenue, sellingPrice, grossProfit, margin, costMethod: method };
  }

  function fullyCostedSales(rows = [], products = [], method = getCostMethod()) {
    const productsByCode = productMap(products);
    return rows.map(row => computeCostedSale(row, productsByCode, method)).filter(Boolean);
  }

  return { getCostMethod, productUnitCost, computeCostedSale, fullyCostedSales };
})();

// Re-match all Under Review items against the current Product Master.
// Any item whose itemCode now exists in productMaster is moved to salesData
// and removed from underReviewData, in batches of 200 with 200ms delays.
// Returns { moved: number }.
async function rematchUnderReview() {
  const _sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const db = getFirestoreDB();
  if (!db) return { moved: 0 };

  // 1 — Fetch all Under Review items
  const urSnap = await db.collection('underReviewData').get();
  if (urSnap.empty) return { moved: 0 };

  // 2 — Fetch Product Master into a map keyed by itemCode field value
  const pmSnap = await db.collection('productMaster').get();
  const pmMap  = {};
  pmSnap.forEach(doc => {
    const d    = doc.data();
    const code = String(d.itemCode || '').trim();
    if (code) pmMap[code] = d;
  });

  // 3 — Find Under Review items that now have a matching PM record
  const toMove = [];
  urSnap.forEach(doc => {
    const item = doc.data();
    const code = String(item.itemCode || '').trim();
    const pm   = pmMap[code];
    if (pm) toMove.push({ docId: doc.id, item, pm });
  });

  if (toMove.length === 0) return { moved: 0 };

  // 4 — Cost method from user preference (set on POS page)
  const costMethod = localStorage.getItem('costMethod') || 'latest';

  // 5 — Batch-move matched items to salesData, delete from underReviewData
  const BATCH_SIZE = 200;
  for (let i = 0; i < toMove.length; i += BATCH_SIZE) {
    const chunk = toMove.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    chunk.forEach(({ docId, item, pm }) => {
      const unitCost = costMethod === 'average'
        ? (Number(pm.averageCost) || Number(pm.latestCost)  || 0)
        : (Number(pm.latestCost)  || Number(pm.averageCost) || 0);
      const unitsSold    = Number(item.unitsSold)    || 0;
      const totalRevenue = Number(item.totalRevenue) || 0;
      const sellingPrice = Number(item.sellingPrice ?? item.srpUnit ?? item.srp) || (unitsSold > 0 ? totalRevenue / unitsSold : 0);
      const totalCost    = unitCost * unitsSold;
      const grossProfit  = (sellingPrice * unitsSold) - totalCost;
      const margin       = unitCost > 0
        ? Number(((sellingPrice - unitCost) / unitCost * 100).toFixed(1)) : 0;

      const salesRef = db.collection('salesData').doc();
      batch.set(salesRef, {
        ...item,
        unitCost,
        totalCost,
        grossProfit,
        margin,
        category:   pm.category || item.category || 'Uncategorized',
        costMethod,
        resolvedAt: new Date().toISOString()
      });
      batch.delete(db.collection('underReviewData').doc(docId));
    });
    await batch.commit();
    await _sleep(200);
  }

  // 6 — If we're on the Sales page, reload caches and re-render
  if (typeof loadSalesData === 'function' && typeof _salesData !== 'undefined') {
    try {
      _salesData  = await loadSalesData();
      _reviewData = await loadUnderReview();
      if (typeof renderAll === 'function') renderAll();
    } catch (err) {
      console.error('[rematchUnderReview] POS UI refresh failed:', err);
    }
  }

  return { moved: toMove.length };
}

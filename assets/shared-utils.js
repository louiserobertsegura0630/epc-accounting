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

    const grossProfit = sellingPrice - unitCost;
    const margin = unitCost > 0 ? Number(((sellingPrice - unitCost) / unitCost * 100).toFixed(4)) : 0;
    return { ...row, unitCost, totalCost, totalRevenue, sellingPrice, grossProfit, margin, costMethod: method };
  }

  function fullyCostedSales(rows = [], products = [], method = getCostMethod()) {
    const productsByCode = productMap(products);
    return rows.map(row => computeCostedSale(row, productsByCode, method)).filter(Boolean);
  }

  return { getCostMethod, productUnitCost, computeCostedSale, fullyCostedSales };
})();

// Re-match Under Review items against the current Product Master.
// Any item whose itemCode now exists in productMaster is moved to salesData
// and removed from underReviewData. The scan is cursor-paginated so very large
// ranges do not time out, and each page uses fresh batched writes.
// Returns { processed: number, moved: number, total: number|null }.
async function rematchUnderReview(options = {}) {
  const _sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const db = getFirestoreDB();
  if (!db) return { processed: 0, moved: 0, total: 0 };

  const pageSize = options.pageSize || 500;
  const maxRetries = options.maxRetries ?? 2;
  const start = options.start || '';
  const end = options.end || '';
  const hasRange = Boolean(start && end);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const isTransientFirestoreError = err => {
    const code = String(err?.code || '').toLowerCase();
    const msg = String(err?.message || err || '').toLowerCase();
    return code.includes('deadline-exceeded') ||
      code.includes('unavailable') ||
      msg.includes('timed out') ||
      msg.includes('temporarily unavailable') ||
      msg.includes('deadline exceeded') ||
      msg.includes('unavailable');
  };
  const indexUrlFrom = err => typeof firestoreIndexUrlFromError === 'function'
    ? firestoreIndexUrlFromError(err)
    : '';
  const withPageRetry = async (label, fn) => {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err) {
        const indexUrl = indexUrlFrom(err);
        if (indexUrl) {
          alert(`Firestore needs an index for this re-match. Open this link to create it:\n\n${indexUrl}`);
          throw err;
        }
        if (!isTransientFirestoreError(err) || attempt >= maxRetries) throw err;
        attempt += 1;
        console.warn(`[rematchUnderReview] ${label} failed, retrying ${attempt}/${maxRetries}:`, err);
        await _sleep(500 * attempt);
      }
    }
  };

  // 1. Fetch Product Master into a map keyed by itemCode field value.
  const pmSnap = await db.collection('productMaster').get();
  const pmMap  = {};
  pmSnap.forEach(doc => {
    const d    = doc.data();
    const code = String(d.itemCode || '').trim();
    if (!code) return;
    const entry = { ...d, _id: doc.id };
    pmMap[code] = entry;
    pmMap[code.toUpperCase()] = entry;
  });

  // 2. Count denominator once, before matched docs start moving out.
  let total = Number.isFinite(Number(options.total)) ? Number(options.total) : null;
  if (total == null && hasRange) {
    let countQuery = db.collection('underReviewData')
      .where('date', '>=', start)
      .where('date', '<=', end);
    try {
      if (typeof firestoreCount === 'function') {
        total = await firestoreCount(countQuery, 'underReviewData re-match count');
      } else if (typeof countQuery.count === 'function') {
        const countSnap = await countQuery.count().get();
        total = Number(countSnap.data().count) || 0;
      }
    } catch (err) {
      const indexUrl = indexUrlFrom(err);
      if (indexUrl) {
        alert(`Firestore needs an index for this re-match count. Open this link to create it:\n\n${indexUrl}`);
      }
      throw err;
    }
  }

  if (onProgress) onProgress({ processed: 0, total, moved: 0 });

  // 3. Page through Under Review and move matches.
  const costMethod = localStorage.getItem('costMethod') || 'latest';
  let cursor = null;
  let processed = 0;
  let moved = 0;
  let matched = 0;

  while (true) {
    const snap = await withPageRetry('page read', async () => {
      let q = db.collection('underReviewData');
      if (hasRange) {
        q = q.where('date', '>=', start).where('date', '<=', end).orderBy('date');
      } else {
        q = q.orderBy('date');
      }
      q = q.limit(pageSize);
      if (cursor) q = q.startAfter(cursor);
      return q.get();
    });
    const pageDocs = snap.docs;
    if (!pageDocs.length) break;

    const toMove = [];
    pageDocs.forEach(doc => {
      const item = doc.data();
      const code = String(item.itemCode || '').trim();
      const pm   = pmMap[code] || pmMap[code.toUpperCase()];
      if (pm) toMove.push({ docId: doc.id, item, pm });
    });

    if (toMove.length > 0) {
      await withPageRetry('page write', async () => {
        let batch = db.batch();
        let opsInBatch = 0;

        for (const { docId, item, pm } of toMove) {
          if (opsInBatch >= 400) {
            await batch.commit();
            batch = db.batch(); // Fresh batch after every commit; committed batches cannot be reused.
            opsInBatch = 0;
          }
          const unitCost = costMethod === 'average'
            ? (Number(pm.averageCost) || Number(pm.latestCost)  || 0)
            : (Number(pm.latestCost)  || Number(pm.averageCost) || 0);
          const unitsSold    = Number(item.unitsSold)    || 0;
          const totalRevenue = Number(item.totalRevenue) || 0;
          const sellingPrice = Number(item.sellingPrice ?? item.srpUnit ?? item.srp) || (unitsSold > 0 ? totalRevenue / unitsSold : 0);
          const totalCost    = unitCost * unitsSold;
          const grossProfit  = sellingPrice - unitCost;
          const margin       = unitCost > 0
            ? Number(((sellingPrice - unitCost) / unitCost * 100).toFixed(4)) : 0;

          batch.set(db.collection('salesData').doc(docId), {
            ...item,
            unitCost,
            totalCost,
            grossProfit,
            margin,
            category:   pm.category || item.category || 'Uncategorized',
            costMethod,
            resolvedAt: new Date().toISOString()
          }, { merge: true });
          opsInBatch += 1;
          batch.delete(db.collection('underReviewData').doc(docId));
          opsInBatch += 1;
        }

        if (opsInBatch > 0) await batch.commit();
      });
      matched += toMove.length;
      moved += toMove.length;
    }

    processed += pageDocs.length;
    if (onProgress) onProgress({ processed, total, matched, moved });
    cursor = pageDocs[pageDocs.length - 1];
    if (pageDocs.length < pageSize) break;
    await _sleep(150);
  }

  return { processed, matched, moved, total };
}

// ─── shared-utils.js ─────────────────────────────────────────────────────────
// Cross-page utilities shared between POS Import, Product Master, and Inventory Tracking.
// Requires app.js (getFirestoreDB) to be loaded first.

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
      const totalCost    = unitCost * unitsSold;
      const grossProfit  = totalRevenue - totalCost;
      const margin       = totalRevenue > 0
        ? Number(((grossProfit / totalRevenue) * 100).toFixed(1)) : 0;

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

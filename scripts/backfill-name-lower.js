#!/usr/bin/env node

/*
 * One-time backfill for prefix search.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node scripts/backfill-name-lower.js
 *
 * This reads salesData and underReviewData and writes nameLower when missing or stale.
 */

const admin = require('firebase-admin');

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || 'palo-grocerette-accounting';
const COLLECTIONS = ['salesData', 'underReviewData'];
const PAGE_SIZE = 400;

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

function nameLowerFor(row) {
  return String(row?.productName || '').toLowerCase().trim();
}

async function backfillCollection(collectionName) {
  let lastDoc = null;
  let scanned = 0;
  let updated = 0;

  while (true) {
    let query = db.collection(collectionName)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);

    const snap = await query.get();
    if (snap.empty) break;

    const batch = db.batch();
    let pending = 0;

    snap.docs.forEach(doc => {
      scanned += 1;
      const data = doc.data();
      const nameLower = nameLowerFor(data);
      if (!nameLower || data.nameLower === nameLower) return;
      batch.update(doc.ref, { nameLower });
      pending += 1;
    });

    if (pending) {
      await batch.commit();
      updated += pending;
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    console.log(`[${collectionName}] scanned ${scanned.toLocaleString()}, updated ${updated.toLocaleString()}`);
  }

  console.log(`[${collectionName}] done. Scanned ${scanned.toLocaleString()}, updated ${updated.toLocaleString()}.`);
}

async function main() {
  for (const collectionName of COLLECTIONS) {
    await backfillCollection(collectionName);
  }
}

main().catch(err => {
  console.error('[backfill-name-lower] failed:', err);
  process.exitCode = 1;
});

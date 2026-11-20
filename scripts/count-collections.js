#!/usr/bin/env node
// Counts the records in each collection the website estimates reads for, so the
// FALLBACK figures in assets/reads.js can be refreshed. Admin SDK, read-only.
// Costs about 1 read per 1,000 records counted, so run it after the daily reset
// (about 4 PM Philippine time) on a day the free allowance is not used up.
//
//   node scripts/count-collections.js
//
// Uses serviceAccountKey-new.json (project inventory-system-1fb4d) from the
// project root. Never commit that key.
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const keyFile = process.env.EPC_SERVICE_ACCOUNT || path.join(__dirname, '..', 'serviceAccountKey-new.json');
initializeApp({ credential: cert(require(keyFile)) });
const db = getFirestore();

const COLLECTIONS = [
  'productMaster', 'inventoryData', 'itemCost', 'purchases', 'expenses', 'suppliesData',
  'eSalesRecords', 'suppliers', 'expenseAccounts', 'salesDaily', 'inventoryDaily',
];

(async () => {
  const out = {};
  for (const name of COLLECTIONS) {
    const snap = await db.collection(name).count().get();
    out[name] = snap.data().count;
    console.log(`${name.padEnd(16)} ${String(out[name]).padStart(8)}`);
  }
  const first = await db.collection('salesDaily').orderBy('__name__').limit(1).get();
  console.log(`\nfirst sales day: ${first.empty ? '(none)' : first.docs[0].id}`);
  console.log('\nFALLBACK for assets/reads.js:');
  console.log(JSON.stringify({
    productMaster: out.productMaster, inventoryData: out.inventoryData, itemCost: out.itemCost,
    purchases: out.purchases, expenses: out.expenses, suppliesData: out.suppliesData,
    eSalesRecords: out.eSalesRecords, suppliers: out.suppliers, expenseAccounts: out.expenseAccounts,
  }, null, 2));
})().catch((err) => { console.error(err.message || err); process.exit(1); });

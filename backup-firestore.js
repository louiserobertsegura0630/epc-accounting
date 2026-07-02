const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldPath } = require('firebase-admin/firestore');

const serviceAccount = require('./serviceAccountKey.json');
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const RUN1 = ['inventoryData', 'salesData', 'users'];
const RUN2 = ['underReviewData'];

const BACKUP_DIR = path.join(__dirname, 'backup');
const BATCH_SIZE = 1000;

// STEP 1: cheap count() aggregation for every collection.
async function printCounts() {
  console.log('=== Document counts (count() aggregation) ===');
  for (const name of [...RUN1, ...RUN2]) {
    try {
      const snap = await db.collection(name).count().get();
      console.log(`  ${name}: ${snap.data().count} docs`);
    } catch (err) {
      console.log(`  ${name}: COUNT FAILED — ${err.message}`);
    }
  }
}

// STEP 2: full paginated backup of one collection to JSONL.
async function backupCollection(name, progressEvery = 1) {
  const file = path.join(BACKUP_DIR, `${name}.jsonl`);
  fs.writeFileSync(file, ''); // truncate/create
  let total = 0;
  let batchNum = 0;
  let last = null;

  while (true) {
    let q = db.collection(name).orderBy(FieldPath.documentId()).limit(BATCH_SIZE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;

    const lines = snap.docs
      .map((d) => JSON.stringify({ __id__: d.id, ...d.data() }) + '\n')
      .join('');
    fs.appendFileSync(file, lines);

    total += snap.size;
    batchNum += 1;
    last = snap.docs[snap.docs.length - 1].id;

    const done = snap.size < BATCH_SIZE;
    if (batchNum % progressEvery === 0 || done) {
      console.log(`${name}: ${total} docs saved so far`);
    }

    if (done) break;
  }
  return total;
}

async function runBackup(collections, progressEvery = 1) {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const counts = {};
  const failures = [];

  for (const name of collections) {
    try {
      counts[name] = await backupCollection(name, progressEvery);
    } catch (err) {
      console.error(`FAILED backing up ${name}: ${err.message}`);
      failures.push({ name, error: err.message });
    }
  }

  console.log('\n=== Backup summary ===');
  console.log('Collection'.padEnd(20), 'Docs'.padStart(12), '  File size');
  for (const name of collections) {
    const file = path.join(BACKUP_DIR, `${name}.jsonl`);
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    const docs = counts[name] !== undefined ? counts[name] : 'FAILED';
    console.log(name.padEnd(20), String(docs).padStart(12), '  ' + fmtSize(size));
  }

  if (failures.length) {
    console.log('\n=== Failures ===');
    failures.forEach((f) => console.log(`  ${f.name}: ${f.error}`));
  } else {
    console.log('\nNo failures.');
  }
}

function fmtSize(bytes) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(2)} ${u[i]}`;
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--run1') {
    await runBackup(RUN1, 1);
  } else if (mode === '--run2') {
    await runBackup(RUN2, 10);
  } else {
    await printCounts();
    console.log('\nRun with --run1 (inventoryData, salesData, users) or --run2 (underReviewData).');
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

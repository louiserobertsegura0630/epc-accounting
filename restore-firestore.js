// Restore backup/*.jsonl into the NEW Firebase project.
// SAFETY:
//  - Authenticates ONLY with ./serviceAccountKey-new.json (NOT the original key).
//  - Prints the target project_id and requires you to type "yes" before any write.
//  - Batched writes of 500 (Firestore limit), original __id__ preserved.
//  - Resumable: skips docs already present, so a restart never double-charges writes.
//
// Usage: node restore-firestore.js            (restores ALL collections below)
//        node restore-firestore.js salesData  (restore one collection)
const fs = require('fs');
const readline = require('readline');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const KEY = './serviceAccountKey-new.json';
const BACKUP_DIR = './backup';
const BATCH = 500;
const ALL = ['inventoryData', 'salesData', 'users', 'underReviewData'];

if (!fs.existsSync(KEY)) {
  console.error(`Missing ${KEY}. Download the NEW project's service account key and save it there.`);
  process.exit(1);
}
const svc = require(KEY);

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
  });
}

// Read one JSONL file as an async generator of {id, data}.
async function* docsOf(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const { __id__, ...data } = r;
    yield { id: __id__, data };
  }
}

async function restoreCollection(db, name) {
  const file = `${BACKUP_DIR}/${name}.jsonl`;
  if (!fs.existsSync(file)) { console.log(`  skip ${name}: no backup file`); return { name, written: 0, skipped: 0 }; }
  const col = db.collection(name);
  let written = 0, skipped = 0, buffer = [];

  async function flush() {
    if (!buffer.length) return;
    // Resumable: check existence for this buffer, only write the missing ones.
    const refs = buffer.map((d) => col.doc(d.id));
    const snaps = await db.getAll(...refs);
    const batch = db.batch();
    let inBatch = 0;
    snaps.forEach((snap, i) => {
      if (snap.exists) { skipped++; return; }
      batch.set(col.doc(buffer[i].id), buffer[i].data);
      inBatch++;
    });
    if (inBatch) await batch.commit();
    written += inBatch;
    buffer = [];
    console.log(`  ${name}: ${written} written, ${skipped} already present`);
  }

  for await (const doc of docsOf(file)) {
    buffer.push(doc);
    if (buffer.length >= BATCH) await flush();
  }
  await flush();
  console.log(`  DONE ${name}: ${written} written, ${skipped} skipped`);
  return { name, written, skipped };
}

(async () => {
  initializeApp({ credential: cert(svc) });
  const db = getFirestore();

  const only = process.argv[2];
  const collections = only ? [only] : ALL;

  console.log('=== Firestore RESTORE ===');
  console.log(`Target project: ${svc.project_id}`);
  console.log(`Collections:    ${collections.join(', ')}`);
  console.log('This WRITES data and may incur Firestore write costs (~$1.80 / million docs).');
  const a = await confirm(`Type "yes" to proceed writing to "${svc.project_id}": `);
  if (a !== 'yes') { console.log('Aborted. No writes performed.'); process.exit(0); }

  const results = [];
  for (const name of collections) {
    try { results.push(await restoreCollection(db, name)); }
    catch (err) { console.error(`FAILED ${name}: ${err.message}`); results.push({ name, error: err.message }); }
  }

  console.log('\n=== Restore summary ===');
  for (const r of results) {
    if (r.error) console.log(`  ${r.name}: FAILED — ${r.error}`);
    else console.log(`  ${r.name}: ${r.written} written, ${r.skipped} already present`);
  }
  process.exit(0);
})().catch((e) => { console.error('Fatal:', e); process.exit(1); });

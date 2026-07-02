// Create the 3 login accounts in the NEW project with the SAME UIDs as the existing
// user profile docs, so login -> role mapping stays intact. Sets a temp password.
// Idempotent: if a UID already exists, updates its email/password instead of failing.
// Auth: serviceAccountKey-new.json (new project). No data collections touched.
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const AUTH_DOMAIN = '@palogrocerette.local'; // matches EPC_AUTH_DOMAIN in assets/app.js
const TEMP_PASSWORD = process.argv[2] || 'ChangeMe123!';

initializeApp({ credential: cert(require('./serviceAccountKey-new.json')) });
const auth = getAuth();
const db = getFirestore();

(async () => {
  console.log('Project:', require('./serviceAccountKey-new.json').project_id);
  console.log('Temp password for all accounts:', TEMP_PASSWORD, '\n');

  const snap = await db.collection('users').get();
  const users = [];
  snap.forEach((d) => { const u = d.data(); users.push({ uid: d.id, username: u.username, role: u.role }); });

  for (const u of users) {
    const email = `${u.username}${AUTH_DOMAIN}`;
    try {
      await auth.createUser({ uid: u.uid, email, password: TEMP_PASSWORD, emailVerified: true });
      console.log(`  CREATED  ${u.username} (${u.role})  ${email}  uid=${u.uid}`);
    } catch (e) {
      if (e.code === 'auth/uid-already-exists' || e.code === 'auth/email-already-exists') {
        await auth.updateUser(u.uid, { email, password: TEMP_PASSWORD });
        console.log(`  UPDATED  ${u.username} (${u.role})  ${email}  uid=${u.uid}`);
      } else {
        console.log(`  FAILED   ${u.username}: ${e.message}`);
      }
    }
  }
  console.log('\nDone. Enable Email/Password sign-in in the new project console if not already on.');
})().catch((e) => { console.error('Fatal:', e); process.exit(1); });

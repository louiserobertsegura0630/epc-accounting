// Create (or update) the "supervisor" login with the "accountant" role.
// Does BOTH steps: (1) the Auth account and (2) the users/{uid} Firestore doc
// that actually grants the role. Idempotent — safe to re-run.
// Usage: node create-supervisor.js [password]
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const AUTH_DOMAIN = '@palogrocerette.local'; // matches EPC_AUTH_DOMAIN in assets/app.js
const USERNAME = 'supervisor';
const ROLE = 'accountant';
const PASSWORD = process.argv[2] || 'Supervisor123!';
const EMAIL = `${USERNAME}${AUTH_DOMAIN}`;

initializeApp({ credential: cert(require('./serviceAccountKey-new.json')) });
const auth = getAuth();
const db = getFirestore();

(async () => {
  console.log('Project:', require('./serviceAccountKey-new.json').project_id);
  console.log(`Username: ${USERNAME}   Password: ${PASSWORD}   Role: ${ROLE}\n`);

  // 1) Auth account — create, or update password/email if it already exists.
  let uid;
  try {
    const rec = await auth.createUser({ email: EMAIL, password: PASSWORD, emailVerified: true });
    uid = rec.uid;
    console.log(`  CREATED  auth account  ${EMAIL}  uid=${uid}`);
  } catch (e) {
    if (e.code === 'auth/email-already-exists') {
      const rec = await auth.getUserByEmail(EMAIL);
      uid = rec.uid;
      await auth.updateUser(uid, { password: PASSWORD });
      console.log(`  UPDATED  auth account (reset password)  ${EMAIL}  uid=${uid}`);
    } else {
      throw e;
    }
  }

  // 2) Firestore role doc — this is what grants "accountant" permissions.
  await db.collection('users').doc(uid).set(
    { username: USERNAME, role: ROLE },
    { merge: true }
  );
  console.log(`  SET      users/${uid}  { username: "${USERNAME}", role: "${ROLE}" }`);

  console.log('\nDone. Log in with the username (not the full email) and the password above.');
})().catch((e) => { console.error('Fatal:', e); process.exit(1); });

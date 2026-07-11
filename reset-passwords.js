// Reset passwords for the viewer / limited / accountant logins.
// Only touches Auth passwords — roles and Firestore data are untouched.
// Idempotent. Usage: node reset-passwords.js
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const AUTH_DOMAIN = '@palogrocerette.local'; // matches EPC_AUTH_DOMAIN in assets/app.js

// username -> new password
const TARGETS = {
  viewer: 'Viewer123!',
  limited: 'Limited123!',
  accountant: 'Accountant123!',
};

initializeApp({ credential: cert(require('./serviceAccountKey-new.json')) });
const auth = getAuth();

(async () => {
  console.log('Project:', require('./serviceAccountKey-new.json').project_id, '\n');
  for (const [username, password] of Object.entries(TARGETS)) {
    const email = `${username}${AUTH_DOMAIN}`;
    try {
      const rec = await auth.getUserByEmail(email);
      await auth.updateUser(rec.uid, { password });
      console.log(`  RESET   ${username}  ->  ${password}   (${email})`);
    } catch (e) {
      console.log(`  FAILED  ${username}: ${e.message}`);
    }
  }
  console.log('\nDone. Log in with the username (not the email) and the password shown.');
})().catch((e) => { console.error('Fatal:', e); process.exit(1); });

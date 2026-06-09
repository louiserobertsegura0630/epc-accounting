#!/usr/bin/env node

const uid = process.argv[2] || process.env.EPC_LOCAL_ACCOUNTANT_UID;
const username = process.argv[3] || process.env.EPC_LOCAL_ACCOUNTANT_USERNAME || '';

const projectId = process.env.FIREBASE_PROJECT_ID || 'palo-grocerette-accounting';
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';

if (!uid) {
  console.error('Usage: node scripts/seed-local-accountant.js <firebase-auth-uid> [username]');
  console.error('This writes only to the local Firestore emulator at', emulatorHost);
  process.exit(1);
}

const documentPath = `users/${uid}`;
const endpoint = new URL(
  `http://${emulatorHost}/v1/projects/${projectId}/databases/(default)/documents/${documentPath}`
);
[
  'role',
  'username',
  'firstName',
  'middleName',
  'lastName'
].forEach(fieldPath => endpoint.searchParams.append('updateMask.fieldPaths', fieldPath));

const fields = {
  role: { stringValue: 'accountant' },
  username: { stringValue: username },
  firstName: { stringValue: '' },
  middleName: { stringValue: '' },
  lastName: { stringValue: '' }
};

async function main() {
  const response = await fetch(endpoint, {
    method: 'PATCH',
    headers: {
      'Authorization': 'Bearer owner',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  const body = await response.text();

  if (!response.ok) {
    console.error(`Could not seed ${documentPath} in the local emulator.`);
    console.error(body);
    process.exit(1);
  }

  console.log(`Seeded local Firestore emulator document: ${documentPath}`);
  console.log('role: accountant');
}

main().catch(err => {
  console.error('Local emulator seed failed:', err.message);
  process.exit(1);
});

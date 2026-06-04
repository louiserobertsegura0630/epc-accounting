initSidebar('settings');

function loadSettingsForm() {
  const user = getCurrentUser();
  document.getElementById('set-last-name').value   = user.lastName   || '';
  document.getElementById('set-first-name').value  = user.firstName  || '';
  document.getElementById('set-middle-name').value = user.middleName || '';
  document.getElementById('set-role').value        = roleDisplayName(user.role);
  document.getElementById('set-current-password').value = '';
  document.getElementById('set-password').value         = '';
  document.getElementById('set-password-confirm').value = '';
}

async function saveProfile() {
  const current = getCurrentUser();
  if (!current.uid) return;

  const lastName   = document.getElementById('set-last-name').value.trim();
  const firstName  = document.getElementById('set-first-name').value.trim();
  const middleName = document.getElementById('set-middle-name').value.trim();
  const statusEl   = document.getElementById('settings-status');

  try {
    const db = getFirestoreDB();
    if (db) {
      await db.collection('users').doc(current.uid).update({ lastName, firstName, middleName });
    }
    // Reflect update in the in-memory user so sidebar immediately shows new name.
    _currentEPCUser = { ...current, lastName, firstName, middleName };
    logAudit('Settings', 'User Profile', `Updated profile for ${currentUserFullName()}`);
    statusEl.textContent = 'Profile saved.';
    loadSettingsForm();
    rebuildSidebar('settings');
  } catch (err) {
    console.error('[Settings] Profile save failed:', err);
    statusEl.textContent = 'Save failed. Please try again.';
  }
}

async function changePassword() {
  const password  = document.getElementById('set-password').value;
  const confirm   = document.getElementById('set-password-confirm').value;
  const statusEl  = document.getElementById('password-status');
  const hasLetter = /[A-Za-z]/.test(password);
  const hasNumber = /\d/.test(password);

  statusEl.style.color = 'var(--text-secondary)';

  if (!password) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = 'Enter a new password.';
    return;
  }
  if (!hasLetter || !hasNumber) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = 'New password must contain letters and numbers.';
    return;
  }
  if (password !== confirm) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = 'Passwords do not match.';
    return;
  }

  const fbUser = firebase.auth().currentUser;
  if (!fbUser) { statusEl.style.color='var(--danger)'; statusEl.textContent='Not signed in.'; return; }

  try {
    await fbUser.updatePassword(password);
    logAudit('Settings', 'User Credentials', `Changed password for ${currentUserFullName()}`);
    document.getElementById('set-current-password').value = '';
    document.getElementById('set-password').value         = '';
    document.getElementById('set-password-confirm').value = '';
    statusEl.textContent = 'Password changed.';
  } catch (err) {
    statusEl.style.color = 'var(--danger)';
    if (err.code === 'auth/requires-recent-login') {
      statusEl.textContent = 'For security, please log out and log back in before changing your password.';
    } else {
      statusEl.textContent = 'Password change failed. Please try again.';
      console.error('[Settings] Password change error:', err);
    }
  }
}

document.getElementById('btn-save-profile').addEventListener('click', saveProfile);
document.getElementById('btn-change-password').addEventListener('click', changePassword);

// Load form once auth + user profile have been resolved by initSidebar.
document.addEventListener('epc-auth-ready', loadSettingsForm, { once: true });

const auth = firebase.auth();
let authResolved = false;

function clearLoginForm() {
  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('login-error').textContent = '';
}

function showLoginForm() {
  if (!auth.currentUser) clearLoginForm();
  document.body.style.visibility = '';
}

function redirectIfSignedIn(user) {
  if (!user) {
    authResolved = true;
    showLoginForm();
    return;
  }
  sessionStorage.removeItem('epc_signed_out_at');
  location.replace('dashboard.html');
}

auth.onAuthStateChanged(redirectIfSignedIn);

async function loginFromForm() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl  = document.getElementById('login-error');
  const btn      = document.getElementById('btn-login');

  errorEl.textContent = '';

  if (!authResolved && auth.currentUser) {
    location.replace('dashboard.html');
    return;
  }
  if (!username) { errorEl.textContent = 'Please enter your username.'; return; }
  if (!password) { errorEl.textContent = 'Please enter your password.';  return; }

  btn.disabled = true;
  const email = username + EPC_AUTH_DOMAIN;

  try {
    await auth.signInWithEmailAndPassword(email, password);
    sessionStorage.removeItem('epc_signed_out_at');
    location.replace('dashboard.html');
  } catch (err) {
    btn.disabled = false;
    switch (err.code) {
      case 'auth/user-not-found':
      case 'auth/wrong-password':
      case 'auth/invalid-credential':
      case 'auth/invalid-email':
        errorEl.textContent = 'Invalid username or password.';
        break;
      case 'auth/too-many-requests':
        errorEl.textContent = 'Too many failed attempts. Please try again later.';
        break;
      default:
        errorEl.textContent = 'Login failed. Please try again.';
    }
  }
}

document.getElementById('btn-login').addEventListener('click', loginFromForm);

document.getElementById('login-username').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('login-password').focus();
});
document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') loginFromForm();
});

window.addEventListener('pageshow', () => {
  document.body.style.visibility = 'hidden';
  const unsubscribe = auth.onAuthStateChanged(user => {
    unsubscribe();
    redirectIfSignedIn(user);
  });
});

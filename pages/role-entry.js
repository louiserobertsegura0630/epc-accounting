// Role-specific entry points are deprecated.
// Authentication is now handled by Firebase Auth via login.html.
// Role is determined by the users/{uid} document in Firestore, not by the login path.
function initRoleEntry() {
  location.href = 'login.html';
}

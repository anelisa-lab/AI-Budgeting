/**
 * Device-only app settings (Settings screen).
 *
 * The backend has no settings endpoint — only profile + shopping preferences,
 * which live on the Profile screen and ARE saved to the account. Anything here
 * is stored in this browser only, and the Settings screen says so.
 *
 * applyStoredSettings() runs once at start-up (main.jsx) so a saved choice is
 * in force on every screen from the first paint — not only while the Settings
 * screen happens to be open, which is how the first version behaved.
 */

const REDUCED_MOTION_KEY = 'uniwallet.reducedMotion';

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

export function getReducedMotion() {
  return safeGet(REDUCED_MOTION_KEY) === '1';
}

export function setReducedMotion(on) {
  safeSet(REDUCED_MOTION_KEY, on ? '1' : '0');
  document.documentElement.dataset.reducedMotion = on ? 'true' : 'false';
}

export function applyStoredSettings() {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.reducedMotion = getReducedMotion() ? 'true' : 'false';
}

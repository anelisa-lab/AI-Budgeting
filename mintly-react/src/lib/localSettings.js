/**
 * Device-only app settings (Settings screen).
 *
 * The backend has no generic settings endpoint, so these accessibility
 * preferences are stored in this browser only. Profile and shopping
 * preferences remain account-level settings elsewhere in the app.
 */

const REDUCED_MOTION_KEY = 'uniwallet.reducedMotion';
const TEXT_SIZE_KEY = 'uniwallet.textSize';
const CONTRAST_KEY = 'uniwallet.contrast';
const THEME_KEY = 'uniwallet.theme';

const TEXT_SIZES = new Set(['default', 'large', 'extra-large']);
const THEMES = new Set(['system', 'light', 'dark']);
const CONTRAST_MODES = new Set(['default', 'high']);

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
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.reducedMotion = on ? 'true' : 'false';
  }
}

export function getTextSize() {
  const value = safeGet(TEXT_SIZE_KEY);
  return TEXT_SIZES.has(value) ? value : 'default';
}

export function setTextSize(size) {
  const value = TEXT_SIZES.has(size) ? size : 'default';
  safeSet(TEXT_SIZE_KEY, value);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.textSize = value;
  }
}

export function getContrastMode() {
  const value = safeGet(CONTRAST_KEY);
  return CONTRAST_MODES.has(value) ? value : 'default';
}

export function setContrastMode(mode) {
  const value = CONTRAST_MODES.has(mode) ? mode : 'default';
  safeSet(CONTRAST_KEY, value);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.contrast = value;
  }
}

export function getTheme() {
  const value = safeGet(THEME_KEY);
  return THEMES.has(value) ? value : 'system';
}

/** 'system' follows the OS; the resolved light/dark lands on data-theme. */
function resolveTheme(theme) {
  if (theme !== 'system') return theme;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function setTheme(theme) {
  const value = THEMES.has(theme) ? theme : 'system';
  safeSet(THEME_KEY, value);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolveTheme(value);
  }
}

export function applyStoredSettings() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.reducedMotion = getReducedMotion() ? 'true' : 'false';
  root.dataset.textSize = getTextSize();
  root.dataset.contrast = getContrastMode();
  root.dataset.theme = resolveTheme(getTheme());
  try { root.lang = localStorage.getItem('uniwallet.language') || 'en'; } catch { /* keep default */ }
  // While set to 'system', follow the OS when it flips.
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getTheme() === 'system') root.dataset.theme = resolveTheme('system');
    });
  } catch { /* matchMedia unavailable */ }
}

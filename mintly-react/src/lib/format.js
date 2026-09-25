/**
 * Formatting helpers. Member 7.
 *
 * Money is formatted in ONE place so R1 234,50 never appears as R1234.5 on
 * one screen and R1,234.50 on another.
 */

/** Group a whole-number string into space-separated thousands: 1234 -> "1 234". */
function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** R1 234,50 — South African convention: space thousands, comma decimal. */
export function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'R0,00';
  const [whole, decimals] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}R${groupThousands(whole)},${decimals}`;
}

/** Compact form for tight spaces: R1 235 */
export function moneyShort(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'R0';
  return `${n < 0 ? '-' : ''}R${groupThousands(String(Math.round(Math.abs(n))))}`;
}

export function km(value) {
  if (value === null || value === undefined) return 'Online only';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n < 1 ? `${Math.round(n * 1000)} m` : `${n.toFixed(1)} km`;
}

export function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : (pluralForm || `${singular}s`)}`;
}

/**
 * `new Date('2026-10-13')` is midnight UTC, which is the 12th anywhere west of
 * Greenwich. Date-only strings from the backend are calendar days, so they are
 * read as LOCAL midnight instead.
 */
export function parseDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(value);
}

/** Today's calendar date, YYYY-MM-DD, in the student's own timezone. */
export function todayIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function shortDate(value) {
  const d = parseDate(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}

export function longDate(value) {
  const d = parseDate(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Whole days from today until `value` (negative = in the past). */
export function daysUntil(value) {
  const d = parseDate(value);
  if (Number.isNaN(d.getTime())) return 0;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setHours(0, 0, 0, 0);
  return Math.round((end - start) / 86400000);
}

/** 24 September 2026 — for dates that are not about this budget period. */
export function fullDate(value) {
  const d = parseDate(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
}

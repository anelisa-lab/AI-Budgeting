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

export function shortDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}

export function longDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Whole days from today until `value` (negative = in the past). */
export function daysUntil(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 0;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setHours(0, 0, 0, 0);
  return Math.round((end - start) / 86400000);
}

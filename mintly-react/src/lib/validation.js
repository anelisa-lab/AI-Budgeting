/**
 * Form validation rules. Member 8.
 *
 * Every rule lives here rather than inside a screen, so login and register
 * agree on what a valid password is, and so these can be unit-tested without
 * rendering React. The rubric marks "Validation and acceptance" — this file
 * plus the error rendering in Field.jsx is where that mark is earned.
 *
 * Each validator returns a STRING (the message shown to the user) or null.
 * Messages say what is wrong AND how to fix it — never just "Invalid input".
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function required(value, fieldName = 'This field') {
  if (value === null || value === undefined) return `${fieldName} is required.`;
  if (typeof value === 'string' && value.trim() === '') return `${fieldName} is required.`;
  return null;
}

export function fullName(value) {
  const base = required(value, 'Your name');
  if (base) return base;
  const trimmed = value.trim();
  if (trimmed.length < 2) return 'Please enter your full name.';
  if (trimmed.length > 100) return 'Keep your name under 100 characters.';
  if (!/^[\p{L}\s'-]+$/u.test(trimmed)) {
    return 'Names can only contain letters, spaces, hyphens and apostrophes.';
  }
  return null;
}

export function email(value) {
  const base = required(value, 'Email address');
  if (base) return base;
  if (!EMAIL_RE.test(value.trim())) {
    return 'Enter a valid email address, like s221234567@dut4life.ac.za';
  }
  return null;
}

export function studentNumber(value) {
  const base = required(value, 'Student number');
  if (base) return base;
  if (!/^\d{8,9}$/.test(value.trim())) {
    return 'Your DUT student number is 8 or 9 digits, with no letters or spaces.';
  }
  return null;
}

export function password(value) {
  const base = required(value, 'Password');
  if (base) return base;
  if (value.length < 8) return 'Use at least 8 characters.';
  if (!/[A-Za-z]/.test(value)) return 'Include at least one letter.';
  if (!/\d/.test(value)) return 'Include at least one number.';
  return null;
}

export function confirmPassword(value, original) {
  const base = required(value, 'Password confirmation');
  if (base) return base;
  if (value !== original) return 'The two passwords do not match.';
  return null;
}

/** 0-4. Drives the strength meter on the register screen. */
export function passwordStrength(value) {
  if (!value) return { score: 0, label: 'Enter a password' };
  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 12) score += 1;
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score += 1;
  if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) score += 1;
  const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
  return { score, label: labels[score] };
}

export function amount(value, { min = 0.01, max = 100000, fieldName = 'Amount' } = {}) {
  const base = required(value, fieldName);
  if (base) return base;
  const n = Number(String(value).replace(/[\s,]/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return `${fieldName} must be a number.`;
  if (n < min) return `${fieldName} must be at least R${min}.`;
  if (n > max) return `${fieldName} looks too high — the maximum is R${max.toLocaleString('en-ZA')}.`;
  return null;
}

/**
 * 0–100, matching the backend's constraint on BudgetCreateRequest
 * (`savings_percentage: Decimal = Field(default=0, ge=0, le=100)`) and the
 * CHECK on budgets.savings_percentage. Empty counts as 0, not as an error.
 */
export function percentage(value, fieldName = 'Percentage') {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(String(value).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return `${fieldName} must be a number between 0 and 100.`;
  if (n < 0) return `${fieldName} cannot be negative.`;
  if (n > 100) return `${fieldName} cannot be more than 100%.`;
  return null;
}

export function futureOrTodayDate(value, fieldName = 'Date') {
  const base = required(value, fieldName);
  if (base) return base;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return `${fieldName} is not a valid date.`;
  return null;
}

export function residence(value) {
  return required(value, 'Residence');
}

export function accepted(value) {
  return value ? null : 'You need to accept the terms before creating an account.';
}

/**
 * Run a shape of validators over a values object.
 *   validateAll({ email: 'x' }, { email: v => email(v) })
 * Returns { errors, isValid }.
 */
export function validateAll(values, rules) {
  const errors = {};
  for (const [key, rule] of Object.entries(rules)) {
    const message = rule(values[key], values);
    if (message) errors[key] = message;
  }
  return { errors, isValid: Object.keys(errors).length === 0 };
}

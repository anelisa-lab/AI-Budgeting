/**
 * The ONE category list for the whole frontend.
 *
 * Before Phase 4 the same idea was typed out four times (Search,
 * Dashboard, Profile) and the copies had drifted: the dashboard knew about
 * "Transport" and "Airtime & data", the recommender screen did not, and none
 * of them knew about "Maintenance". Everything now imports from here.
 *
 * TWO LISTS, ONE SYSTEM
 * ---------------------
 *  - CATALOGUE_CATEGORIES are the values stored in `products.category` on the
 *    backend. They are sent as-is to GET /search (?category=) and
 *    POST /recommendations ({ category }), and saved as-is in
 *    preferences.preferred_categories — so the spelling must match the
 *    catalogue exactly.
 *  - SPENDING_CATEGORIES are what a recorded spend can be filed under
 *    (`transactions.category`, free text on the backend). It is the catalogue
 *    list PLUS the costs that are not products in a shop (transport, data,
 *    other). The shared entries use the same value, so "Groceries" on the
 *    dashboard and "Groceries" in Search are the same category.
 *
 * MAINTENANCE (group leader, Phase 4): a first-class category everywhere a
 * category can be chosen. Phase 5 added its products to the catalogue (light
 * bulbs, batteries, duct tape, super glue, padlocks, extension cords — see
 * docs/seed/build_seed.py), so it is no longer flagged as empty.
 */

export const CATALOGUE_CATEGORIES = [
  { value: 'Groceries', label: 'Groceries', icon: '🛒' },
  { value: 'Toiletries', label: 'Toiletries', icon: '🧼' },
  { value: 'Stationery', label: 'Stationery', icon: '📓' },
  { value: 'Electronics', label: 'Electronics', icon: '🔌' },
  { value: 'Homeware', label: 'Homeware', icon: '🏠' },
  { value: 'Maintenance', label: 'Maintenance', icon: '🛠️' },
];

const SPEND_ONLY = [
  { value: 'Transport', label: 'Transport', icon: '🚕' },
  { value: 'Data', label: 'Airtime & data', icon: '📱' },
  { value: 'Other', label: 'Other', icon: '💸' },
];

export const SPENDING_CATEGORIES = [...CATALOGUE_CATEGORIES, ...SPEND_ONLY];

/**
 * Categories the catalogue does not stock yet. Empty since Phase 5; kept so a
 * future category can be added to the app before its products exist, and the
 * screens will say so plainly instead of showing a blank page.
 */
export const CATEGORIES_WITHOUT_LISTINGS = [];

const BY_VALUE = new Map(SPENDING_CATEGORIES.map((c) => [c.value.toLowerCase(), c]));

export function categoryIcon(value) {
  return BY_VALUE.get(String(value || '').toLowerCase())?.icon || '💸';
}

export function categoryLabel(value) {
  return BY_VALUE.get(String(value || '').toLowerCase())?.label || value || 'Other';
}

/**
 * Canonical spelling for a catalogue category, whatever case it was typed or
 * stored in. Unknown values come back unchanged so nothing is silently lost.
 */
export function canonicalCategory(value) {
  const hit = CATALOGUE_CATEGORIES.find(
    (c) => c.value.toLowerCase() === String(value || '').trim().toLowerCase(),
  );
  return hit ? hit.value : String(value || '').trim();
}

export function isWithoutListings(value) {
  return CATEGORIES_WITHOUT_LISTINGS.some(
    (c) => c.toLowerCase() === String(value || '').trim().toLowerCase(),
  );
}


/* ------------------------------------------------------------------ planner */

/**
 * "Plan your priorities" (BudgetEntry): the categories a student can add with
 * one tap. They are NOT limited to these — any name can be typed — and they are
 * not the same list as the catalogue's product categories, because a student
 * budgets for things a shop does not sell (transport, data, emergencies).
 * Mirrors SUGGESTED_CATEGORIES in app/budget_categories.py.
 */
export const PLANNER_SUGGESTIONS = [
  'Groceries', 'Toiletries', 'Transport', 'Airtime & data',
  'Stationery', 'Cleaning supplies', 'Laundry', 'Emergencies',
];

export const MAX_PLANNER_CATEGORIES = 25;
export const MAX_CATEGORY_NAME = 60;

/**
 * Tidy a typed category name the way the backend will (clean_category_name):
 * collapse spaces, and drop a leading = + - @ so it can never run as a
 * spreadsheet formula. Returns '' when nothing usable is left.
 */
export function cleanPlannerName(name) {
  const text = String(name ?? '').split(/\s+/).filter(Boolean).join(' ');
  return text.replace(/^[=+\-@\s]+/, '').trim();
}

/** A message when `name` cannot be added to `existing` (an array of names), else null. */
export function plannerNameError(name, existing = []) {
  const cleaned = cleanPlannerName(name);
  if (!cleaned) return 'Type a category name first.';
  if (cleaned.length > MAX_CATEGORY_NAME) return `Keep it under ${MAX_CATEGORY_NAME} characters.`;
  if (/[*?~]/.test(cleaned)) return 'Category names cannot contain * ? or ~.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(cleaned)) return 'Category names cannot contain control characters.';
  if (existing.some((n) => String(n).toLowerCase() === cleaned.toLowerCase())) {
    return `${cleaned} is already on your list.`;
  }
  if (existing.length >= MAX_PLANNER_CATEGORIES) {
    return `Choose at most ${MAX_PLANNER_CATEGORIES} categories.`;
  }
  return null;
}

/**
 * The "record a spend" category choices: the app's standard list plus the
 * student's own priorities, without duplicates (compared ignoring case).
 * Their priorities come first — they are what they said matters.
 */
export function spendCategoryOptions(plannedNames = []) {
  const out = [];
  const seen = new Set();
  const add = (value, label) => {
    const key = String(value).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ value, label });
  };
  plannedNames.forEach((n) => add(n, categoryLabel(n)));
  SPENDING_CATEGORIES.forEach((c) => add(c.value, c.label));
  return out;
}

/** "week", "two weeks" or "month" — what to call a budget of this length. */
export function periodWord(days) {
  const n = Number(days) || 30;
  if (n <= 7) return 'week';
  if (n <= 16) return 'two weeks';
  return 'month';
}

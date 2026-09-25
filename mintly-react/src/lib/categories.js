/**
 * The ONE category list for the whole frontend.
 *
 * Before Phase 4 the same idea was typed out four times (Search, For you,
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

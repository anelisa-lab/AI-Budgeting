/** Canonical categories used by the product catalogue and recommendations. */
export const CATALOGUE_CATEGORIES = [
  { value: 'Groceries', label: 'Groceries', icon: '🛒' },
  { value: 'Toiletries', label: 'Toiletries', icon: '🧼' },
  { value: 'Stationery', label: 'Stationery', icon: '📓' },
  { value: 'Electronics', label: 'Electronics', icon: '🔌' },
  { value: 'Homeware', label: 'Homeware', icon: '🏠' },
  { value: 'Maintenance', label: 'Maintenance', icon: '🛠️' },
];

const CATEGORIES_WITHOUT_LISTINGS = ['Maintenance'];
const CATEGORY_BY_VALUE = new Map(
  CATALOGUE_CATEGORIES.map((category) => [category.value.toLowerCase(), category]),
);

export function categoryIcon(value) {
  return CATEGORY_BY_VALUE.get(String(value || '').toLowerCase())?.icon || '✨';
}

export function isWithoutListings(value) {
  return CATEGORIES_WITHOUT_LISTINGS.some(
    (category) => category.toLowerCase() === String(value || '').trim().toLowerCase(),
  );
}

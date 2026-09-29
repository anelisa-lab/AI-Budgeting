const STORAGE_KEY = 'uniwallet-budget-plan-history';

export function currentMonth() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(value) {
  const date = new Date(`${value}-01T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
}

export function readBudgetPlanHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveBudgetPlanHistory(history) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

export function upsertBudgetPlan(history, snapshot) {
  return [
    snapshot,
    ...history.filter((item) => item.month !== snapshot.month),
  ].slice(0, 24);
}

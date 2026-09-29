import { useMemo, useState } from 'react';
import { Button, Card } from '../ui/index.js';
import { money } from '../../lib/format.js';
import {
  currentMonth, monthLabel, readBudgetPlanHistory, saveBudgetPlanHistory,
  upsertBudgetPlan,
} from '../../lib/budgetHistory.js';

const STARTER_CATEGORIES = [
  { id: 'groceries', name: 'Groceries', priority: 'must', amount: 0 },
  { id: 'toiletries', name: 'Toiletries', priority: 'must', amount: 0 },
  { id: 'transport', name: 'Transport', priority: 'must', amount: 0 },
  { id: 'phone', name: 'Phone & data', priority: 'must', amount: 0 },
  { id: 'fun', name: 'Fun money', priority: 'want', amount: 0 },
  { id: 'savings', name: 'Leave untouched', priority: 'future', amount: 0 },
];

function freshCategories() {
  return STARTER_CATEGORIES.map((category) => ({ ...category }));
}

function monthFromDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date.slice(0, 7)
    : currentMonth();
}

export default function BudgetPlanSheet({
  spendable = 0,
  savings = 0,
  payoutDate,
  periodDays = 30,
}) {
  const [history, setHistory] = useState(() => readBudgetPlanHistory());
  const [month, setMonth] = useState(() => monthFromDate(payoutDate));
  const [categories, setCategories] = useState(() => freshCategories());
  const [newCategory, setNewCategory] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [saved, setSaved] = useState(false);

  const total = useMemo(
    () => categories.reduce((sum, category) => sum + Math.max(0, Number(category.amount) || 0), 0),
    [categories],
  );
  const remaining = spendable - total;

  function changeMonth(nextMonth) {
    const savedPlan = history.find((item) => item.month === nextMonth);
    setMonth(nextMonth);
    setSaved(Boolean(savedPlan));
    setCategories(savedPlan
      ? savedPlan.categories.map((category) => ({ ...category }))
      : categories.map((category) => ({ ...category, amount: 0 })));
  }

  function updateCategory(id, updates) {
    setCategories((items) => items.map((category) => (
      category.id === id ? { ...category, ...updates } : category
    )));
    setSaved(false);
  }

  function addCategory() {
    const name = newCategory.trim();
    if (!name) return;
    setCategories((items) => [
      ...items,
      { id: `${Date.now()}`, name, priority: 'want', amount: 0 },
    ]);
    setNewCategory('');
    setShowAdd(false);
    setSaved(false);
  }

  function removeCategory(id) {
    setCategories((items) => items.filter((category) => category.id !== id));
    setSaved(false);
  }

  function suggestAmounts() {
    const weights = { must: 0.18, want: 0.1, future: 0.12 };
    setCategories((items) => items.map((category) => ({
      ...category,
      amount: Number((spendable * weights[category.priority]).toFixed(2)),
    })));
    setSaved(false);
  }

  function savePlan() {
    const snapshot = {
      month,
      spendable: Number(spendable.toFixed(2)),
      savings: Number(savings.toFixed(2)),
      periodDays,
      categories: categories.map((category) => ({ ...category })),
      savedAt: new Date().toISOString(),
    };
    const nextHistory = upsertBudgetPlan(history, snapshot);
    saveBudgetPlanHistory(nextHistory);
    setHistory(nextHistory);
    setSaved(true);
  }

  return (
    <Card className="budget-plan-sheet">
      <div className="budget-plan-sheet__header">
        <div>
          <p className="dash-label">Your priorities</p>
          <h2 className="budget-plan-sheet__title">Build this month&apos;s spending map</h2>
          <p className="field__hint">
            This is your editable plan for the money left after savings. It does not replace the active budget saved to your account.
          </p>
        </div>
        <div className="budget-plan-sheet__controls">
          <label className="field__label" htmlFor="budget-plan-month">Plan for</label>
          <input
            id="budget-plan-month"
            className="input"
            type="month"
            value={month}
            onChange={(event) => changeMonth(event.target.value)}
          />
        </div>
      </div>

      <div className="budget-plan-sheet__summary" aria-live="polite">
        <div>
          <span className="dash-sub">Left to spend</span>
          <strong className="num">{money(spendable)}</strong>
        </div>
        <div>
          <span className="dash-sub">Planned</span>
          <strong className="num">{money(total)}</strong>
        </div>
        <div className={remaining < 0 ? 'budget-plan-sheet__over' : ''}>
          <span className="dash-sub">{remaining < 0 ? 'Over by' : 'Still free'}</span>
          <strong className="num">{money(Math.abs(remaining))}</strong>
        </div>
      </div>

      <div className="budget-plan-sheet__toolbar">
        <span className="field__hint" style={{ margin: 0 }}>
          {history.length
            ? `${history.length} saved ${history.length === 1 ? 'month' : 'months'}`
            : 'No saved months yet'}
        </span>
        <Button type="button" variant="quiet" size="sm" onClick={suggestAmounts} disabled={!spendable}>
          Suggest amounts
        </Button>
      </div>

      <div className="budget-plan-sheet__table" role="table" aria-label={`Spending plan for ${monthLabel(month)}`}>
        <div className="budget-plan-sheet__row budget-plan-sheet__row--head" role="row">
          <span>Category</span><span>Priority</span><span>Planned</span><span />
        </div>
        {categories.map((category) => (
          <div className="budget-plan-sheet__row" role="row" key={category.id}>
            <input
              className="input budget-plan-sheet__category"
              aria-label={`${category.name} category`}
              value={category.name}
              onChange={(event) => updateCategory(category.id, { name: event.target.value })}
            />
            <select
              className="select"
              aria-label={`${category.name} priority`}
              value={category.priority}
              onChange={(event) => updateCategory(category.id, { priority: event.target.value })}
            >
              <option value="must">Essential</option>
              <option value="want">Nice to have</option>
              <option value="future">Future</option>
            </select>
            <input
              className="input budget-plan-sheet__amount num"
              aria-label={`${category.name} planned amount`}
              type="number"
              min="0"
              step="0.01"
              value={category.amount || ''}
              onChange={(event) => updateCategory(category.id, { amount: Math.max(0, Number(event.target.value) || 0) })}
            />
            <button type="button" className="budget-plan-sheet__remove" onClick={() => removeCategory(category.id)} aria-label={`Remove ${category.name}`}>
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="budget-plan-sheet__footer">
        {showAdd ? (
          <div className="row">
            <input
              className="input"
              autoFocus
              aria-label="New category name"
              placeholder="e.g. Laundry"
              value={newCategory}
              onChange={(event) => setNewCategory(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && addCategory()}
            />
            <Button type="button" size="sm" onClick={addCategory}>Add</Button>
            <Button type="button" size="sm" variant="quiet" onClick={() => setShowAdd(false)}>Cancel</Button>
          </div>
        ) : (
          <Button type="button" size="sm" variant="quiet" onClick={() => setShowAdd(true)}>
            + Add another category
          </Button>
        )}
        <Button type="button" size="sm" onClick={savePlan}>
          {saved ? 'Saved' : `Save ${monthLabel(month)} plan`}
        </Button>
      </div>

      {history.length > 0 && (
        <div className="budget-plan-sheet__history">
          <p className="dash-label">Saved plan history</p>
          <div className="budget-plan-sheet__history-list">
            {history.map((item) => (
              <button type="button" key={`${item.month}-${item.savedAt}`} onClick={() => changeMonth(item.month)}>
                <span>{monthLabel(item.month)}</span>
                <span className="num">{money(item.spendable)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

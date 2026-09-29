/**
 * Budget dashboard.
 *
 * The screen a student opens every day. It answers three questions in the
 * first screenful: how much is left, how long it has to last, and whether they
 * are spending too fast.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------
 * "Left to spend" is `budget.remaining_amount` as returned by
 * GET /budgets/dashboard — the backend's figure, not a subtraction done here.
 * "Safe to spend" is Member 6's Daily Budget Split, rendered the way
 * docs/BUDGET_SPLIT_CONTRACT.md specifies, and the status banner uses the
 * server's `health.warnings` whenever it has something to warn about.
 * Recording a spend POSTs to /budgets/{id}/transactions and the response
 * carries the recalculated budget AND the server's overspend decision, both of
 * which are used verbatim. See BudgetContext for the full reasoning.
 *
 * Also here: a spend can be dated (yesterday's groceries do not eat into
 * today's allowance) and edited in place; the full history is one click away;
 * "Where it went" shows planned vs spent for the student's priority categories;
 * and when the payout date has passed a banner asks them to start the next cycle.
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert, Badge, Button, Card, EmptyState, Eyebrow, Field, Input, Progress, Select, Skeleton,
} from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useBudget } from '../context/BudgetContext.jsx';
import { useShopping } from '../context/ShoppingContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useLanguage } from '../context/LanguageContext.jsx';
import DailyBudgetSplit from '../components/budget/DailyBudgetSplit.jsx';
import TransactionRow from '../components/budget/TransactionRow.jsx';
import { money, plural, shortDate, todayIso } from '../lib/format.js';
import * as v from '../lib/validation.js';
import { categoryIcon, categoryLabel, spendCategoryOptions } from '../lib/categories.js';

/** Recent spends shown before "Show all". */
const RECENT_COUNT = 10;

/** The one-line read on how the period is going. */
function healthCopy(health, d) {
  switch (health) {
    case 'over':
      return {
        tone: 'danger',
        title: 'You have nothing left this period',
        body: `You have spent ${money(d.spent)} of ${money(d.spendable)}. `
          + 'Use Search to find cheaper alternatives before your next shop.',
      };
    case 'fast':
      return {
        tone: 'warning',
        title: 'Spending faster than planned',
        body: `By day ${d.daysGone} you would normally have spent about ${money(d.onPace)}. `
          + `You are at ${money(d.spent)}. Slowing to ${money(d.dailyAllowance)} a day gets you to the end.`,
      };
    case 'tight':
      return {
        tone: 'warning',
        title: 'It is getting tight',
        body: `${money(d.remaining)} left for ${plural(d.daysLeft, 'day')}. `
          + `That is ${money(d.dailyAllowance)} a day.`,
      };
    default:
      return {
        tone: 'success',
        title: 'On track',
        body: `${money(d.remaining)} left with ${plural(d.daysLeft, 'day')} to go — `
          + `about ${money(d.dailyAllowance)} a day.`,
      };
  }
}

/** GET /budgets/dashboard `health` -> the status banner, when it has a warning. */
const SERVER_HEALTH = {
  caution: { tone: 'warning', title: 'Careful — you are ahead of plan' },
  danger: { tone: 'danger', title: 'Your budget is running low' },
  exhausted: { tone: 'danger', title: 'You have nothing left this period' },
};

function serverStatus(serverHealth) {
  if (!serverHealth || serverHealth.warning_level === 'ok') return null;
  const base = SERVER_HEALTH[serverHealth.warning_level];
  if (!base || serverHealth.warnings.length === 0) return null;
  return { ...base, body: serverHealth.warnings.join(' ') };
}

export default function Dashboard() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const budgetCtx = useBudget();
  const { listCount, listTotal } = useShopping();
  const toast = useToast();
  const navigate = useNavigate();

  const {
    budget, transactions, loading, error, supports, split, serverHealth,
    savings, spendable, spent, remaining, ratio,
    daysLeft, dailyAllowance, health, byCategory, recorded,
    addTransaction, updateTransaction, deleteTransaction,
    categories, cycleEnded, daysOverdue,
  } = budgetCtx;

  /* Priorities first, then the app's standard categories (no duplicates). */
  const categoryOptions = useMemo(
    () => spendCategoryOptions(categories.map((c) => c.name)),
    [categories],
  );
  const today = todayIso();

  async function handleDeleteTransaction(t) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${t.item_name}" (${money(t.amount)})? The money goes back to your budget.`)) return;
    try {
      await deleteTransaction(t.id);
      setOverspend(null);
      toast.info(`Deleted ${t.item_name}.`);
    } catch (err) {
      toast.error(err.message || 'Could not delete that spend.');
    }
  }

  const [form, setForm] = useState({
    description: '', amount: '', category: 'Groceries', isEssential: false,
    transactionDate: todayIso(),
  });
  const [showAll, setShowAll] = useState(false);
  const [filterCategory, setFilterCategory] = useState('all');
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  /** The server's own overspend verdict from the last POST. */
  const [overspend, setOverspend] = useState(null);
  /** "More than today's allowance" — fits the cycle, but not today. */
  const [dailyWarning, setDailyWarning] = useState(null);

  const topCategories = useMemo(
    () => Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 4),
    [byCategory],
  );
  // Planned vs spent for the student's priority categories. Spend is matched
  // ignoring case, the same way the server matches it.
  const plannedRows = useMemo(() => {
    const spentBy = new Map(Object.entries(byCategory).map(([n, amt]) => [n.toLowerCase(), amt]));
    return categories.map((c) => ({
      name: c.name,
      planned: c.planned_amount,
      spent: spentBy.get(c.name.toLowerCase()) || 0,
    }));
  }, [categories, byCategory]);
  const otherRows = useMemo(() => {
    const planned = new Set(categories.map((c) => c.name.toLowerCase()));
    return Object.entries(byCategory)
      .filter(([name]) => !planned.has(name.toLowerCase()))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
  }, [categories, byCategory]);

  // The full history, optionally narrowed to one category.
  const categoryFilterOptions = useMemo(() => {
    const seen = new Map();
    transactions.forEach((t) => {
      const name = t.category || 'Other';
      if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    });
    return [{ value: 'all', label: 'All categories' },
      ...[...seen.entries()].map(([value, name]) => ({ value, label: categoryLabel(name) }))];
  }, [transactions]);
  const filteredTransactions = useMemo(
    () => (filterCategory === 'all'
      ? transactions
      : transactions.filter((t) => (t.category || 'Other').toLowerCase() === filterCategory)),
    [transactions, filterCategory],
  );
  const shownTransactions = showAll ? filteredTransactions : filteredTransactions.slice(0, RECENT_COUNT);

  async function handleSaveTransaction(t, values) {
    await updateTransaction(t.id, values);
    setOverspend(null);
    setDailyWarning(null);
    toast.success(`Updated ${values.description || t.item_name}.`);
  }
  // Bars are a share of everything RECORDED. `spent` is budget-based and is
  // capped once the balance floors at R0, so using it here let a category's
  // bar run past 100% after an overspend.
  const recordedTotal = useMemo(
    () => Object.values(byCategory).reduce((sum, amt) => sum + amt, 0),
    [byCategory],
  );

  const status = serverStatus(serverHealth) || healthCopy(health, budgetCtx);
  const progressTone = health === 'over' ? 'danger' : health === 'good' ? 'brand' : 'warning';

  async function submitTransaction(event) {
    event.preventDefault();
    const rules = {
      description: (value) => v.required(value, 'Description'),
      amount: (value) => v.amount(value, { min: 0.01, max: 20000, fieldName: 'Amount' }),
      // Blank means "today"; a date can go back to the day the budget started.
      transactionDate: (value) => v.dateWithin(value, {
        min: budget?.cycle_start_date, max: todayIso(), fieldName: 'Date',
      }),
    };
    const { errors: found, isValid } = v.validateAll(form, rules);
    setErrors(found);
    if (!isValid) return;

    setSaving(true);
    setOverspend(null);
    setDailyWarning(null);
    try {
      // The backend records the spend even when it takes the student over, so
      // the log stays accurate; it flags the overspend in the response.
      const result = await addTransaction({
        description: form.description,
        amount: Number(String(form.amount).replace(/[^\d.]/g, '')),
        category: form.category,
        isEssential: form.isEssential,
        transactionDate: form.transactionDate,
      });

      setForm({
        description: '', amount: '', category: form.category, isEssential: false,
        transactionDate: todayIso(),
      });

      if (result.overspend_warning) {
        setOverspend(result.warning_message || 'That purchase took you over your remaining budget.');
        toast.error('Spend recorded — it took you over budget.');
      } else if (result.daily_limit_warning) {
        setDailyWarning(result.daily_limit_message);
        toast.success('Spend recorded — over today\'s allowance.');
      } else {
        toast.success('Spend recorded.');
      }
    } catch (err) {
      if (err.fieldErrors) setErrors(err.fieldErrors);
      else toast.error(err.message || 'Could not record that spend.');
    } finally {
      setSaving(false);
    }
  }

  /* ------------------------------------------------------------ loading */

  if (loading && !budget) {
    return (
      <div className="stack">
        <Skeleton height={40} width="280px" />
        <div className="dash-hero">
          <Skeleton height={190} radius="var(--r-xl)" />
          <Skeleton height={190} radius="var(--r-xl)" />
        </div>
        <Skeleton height={220} radius="var(--r-xl)" />
      </div>
    );
  }

  /* ------------------------------------------ could not reach the backend */

  if (error && !budget) {
    return (
      <Card>
        <Alert tone="danger" title="Could not load your budget">{error}</Alert>
        <div style={{ marginTop: 'var(--s-5)' }}>
          <Button onClick={() => budgetCtx.refresh()}>Try again</Button>
        </div>
      </Card>
    );
  }

  /* --------------------------------------------------- no budget set yet */

  if (!budget) {
    return (
      <Card>
        <EmptyState
          icon="🪙"
          title="Set your budget to get started"
          action={<Button size="lg" onClick={() => navigate('/budget')}>Set my budget</Button>}
        >
          UniWallet needs to know what landed and when. Once it does, it will work out a
          safe daily spend and start finding you cheaper places to shop.
        </EmptyState>
      </Card>
    );
  }

  /* --------------------------------------------------------------- main */

  return (
    <div className="stack stack--loose">
      <div>
        <Eyebrow>{t('dash.eyebrow')}</Eyebrow>
        <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>
          {t(greetingKey())}, {user?.name?.split(' ')[0] || 'there'}.
        </h1>
      </div>

      {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}

      {cycleEnded && supports.renewBudget && (
        <Alert tone="warning" title="Your budget period has ended">
          Your payout date was {shortDate(budget.cycle_end_date)}
          {daysOverdue > 0 && ` (${plural(daysOverdue, 'day')} ago)`}. Start your next cycle so
          the daily limit works again — your last budget stays in your history.
          <div style={{ marginTop: 'var(--s-3)' }}>
            <Button size="sm" onClick={() => navigate('/budget')}>Start next cycle</Button>
          </div>
        </Alert>
      )}

      {overspend && (
        <Alert tone="danger" title="That took you over your budget">
          {overspend} It is still recorded, so your spending history stays accurate.
        </Alert>
      )}

      {dailyWarning && (
        <Alert tone="warning" title="That was more than today's allowance">
          {dailyWarning}
        </Alert>
      )}

      {/* Headline numbers */}
      <div className="dash-hero">
        <Card tone="forest">
          <div className="row row--between">
            <p className="dash-label">{t('dash.left')}</p>
            <Badge tone={health === 'over' ? 'danger' : 'accent'}>
              {plural(daysLeft, 'day')} left
            </Badge>
          </div>
          <div className="dash-amount num" style={{ marginTop: 'var(--s-3)' }}>
            {money(remaining)}
          </div>
          <p className="dash-sub dash-sub--on-dark">
            of {money(spendable)} spendable this period
            {savings > 0 && ` · ${money(savings)} put aside`}
          </p>
          <div style={{ marginTop: 'var(--s-5)' }}>
            <Progress
              value={ratio}
              tone={progressTone}
              surface="dark"
              label={`${Math.round(ratio * 100)}% of your budget spent`}
            />
          </div>
          <p className="dash-sub dash-sub--on-dark" style={{ marginTop: 'var(--s-3)' }}>
            {money(spent)} of your budget used
          </p>
        </Card>

        <Card tone="butter">
          <DailyBudgetSplit
            split={split}
            fallbackAllowance={dailyAllowance}
            remaining={remaining}
            daysLeft={daysLeft}
          />
          <div style={{ marginTop: 'var(--s-5)' }}>
            <Button variant="primary" size="sm" block onClick={() => navigate('/search')}>
              {t('dash.shop')}
            </Button>
          </div>
        </Card>
      </div>

      <Alert tone={status.tone} title={status.title}>{status.body}</Alert>

      {/* Secondary stats */}
      <div className="stat-row">
        <div className="stat">
          <div className="stat__value num">{money(recorded)}</div>
          <p className="stat__label">
            Recorded spending{recorded > spendable + 0.005 ? ` · ${money(recorded - spendable)} more than budgeted` : ''}
          </p>
        </div>
        <div className="stat">
          <div className="stat__value num">{transactions.length}</div>
          <p className="stat__label">Recorded purchases</p>
        </div>
        <div className="stat">
          <div className="stat__value num">{money(listTotal)}</div>
          <p className="stat__label">{plural(listCount, 'item')} in your list · shelf prices</p>
        </div>
        <div className="stat">
          <div className="stat__value num">{shortDate(budget.cycle_end_date)}</div>
          <p className="stat__label">{cycleEnded ? 'Payout date (passed)' : 'Next payout'}</p>
        </div>
      </div>

      <div className="dash-hero">
        {/* Record a spend */}
        <Card>
          <h2 className="card__title">Record a spend</h2>
          <p style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)', marginTop: 'var(--s-2)' }}>
            Add what you bought and UniWallet updates everything above.
          </p>
          <form onSubmit={submitTransaction} noValidate className="stack" style={{ marginTop: 'var(--s-5)' }}>
            <Field id="description" label="What did you buy?" error={errors.description} required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id} placeholder="Bread, milk and eggs"
                  value={form.description} invalid={invalid} describedBy={describedBy}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, description: e.target.value }));
                    if (errors.description) setErrors((x) => ({ ...x, description: undefined }));
                  }}
                />
              )}
            </Field>

            <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s-3)' }}>
              <div className="grow">
                <Field id="amount" label="Amount" error={errors.amount} required>
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id} inputMode="decimal" prefix="R" placeholder="85.50"
                      value={form.amount} invalid={invalid} describedBy={describedBy}
                      onChange={(e) => {
                        setForm((f) => ({ ...f, amount: e.target.value.replace(/[^\d.]/g, '') }));
                        if (errors.amount) setErrors((x) => ({ ...x, amount: undefined }));
                      }}
                    />
                  )}
                </Field>
              </div>
              <div className="grow">
                <Field id="category" label="Category">
                  {({ id, describedBy }) => (
                    <Select
                      id={id} options={categoryOptions} value={form.category}
                      describedBy={describedBy}
                      onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                    />
                  )}
                </Field>
              </div>
            </div>

            <Field
              id="transactionDate"
              label="When did you buy it?"
              hint="Today, unless you are catching up — a past date will not eat into today's allowance."
              error={errors.transactionDate}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id} type="date" value={form.transactionDate}
                  min={budget.cycle_start_date} max={today}
                  invalid={invalid} describedBy={describedBy}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, transactionDate: e.target.value }));
                    if (errors.transactionDate) setErrors((x) => ({ ...x, transactionDate: undefined }));
                  }}
                />
              )}
            </Field>

            {/* transactions.is_essential — a real backend field, and the same
                flag GET /search filters on with essential_only. */}
            <label className="checkbox" htmlFor="isEssential">
              <input
                id="isEssential"
                type="checkbox"
                checked={form.isEssential}
                onChange={(e) => setForm((f) => ({ ...f, isEssential: e.target.checked }))}
              />
              <span>This was something I needed, not something I wanted</span>
            </label>

            <Button type="submit" block loading={saving}>
              {saving ? 'Recording…' : 'Add to my spending'}
            </Button>
          </form>
        </Card>

        {/* Where it went — planned vs spent for the student's priorities */}
        <Card>
          <h2 className="card__title">Where it went</h2>
          {plannedRows.length === 0 && topCategories.length === 0 ? (
            <p style={{ color: 'var(--c-muted-light)', fontSize: 'var(--t-sm)', marginTop: 'var(--s-4)' }}>
              Nothing recorded yet. Add your first spend and this fills in.
            </p>
          ) : (
            <div className="stack stack--tight" style={{ marginTop: 'var(--s-5)' }}>
              {plannedRows.map((row) => {
                const hasPlan = row.planned != null && row.planned > 0;
                const ratioSpent = hasPlan ? row.spent / row.planned : (recordedTotal > 0 ? row.spent / recordedTotal : 0);
                const over = hasPlan && row.spent > row.planned + 0.005;
                const tone = over ? 'danger' : hasPlan && ratioSpent >= 0.9 ? 'warning' : 'accent';
                return (
                  <div key={row.name}>
                    <div className="row row--between" style={{ marginBottom: 'var(--s-1)' }}>
                      <span style={{ fontSize: 'var(--t-sm)', fontWeight: 'var(--fw-bold)' }}>
                        <span aria-hidden="true">{categoryIcon(row.name)}</span> {categoryLabel(row.name)}
                      </span>
                      <span className="num" style={{ fontSize: 'var(--t-sm)', fontWeight: 'var(--fw-extra)' }}>
                        {money(row.spent)}{hasPlan && <span style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--c-muted)' }}> of {money(row.planned)}</span>}
                      </span>
                    </div>
                    <Progress
                      value={ratioSpent}
                      tone={tone}
                      label={hasPlan
                        ? `${categoryLabel(row.name)}: ${money(row.spent)} of ${money(row.planned)} planned`
                        : `${categoryLabel(row.name)}: ${money(row.spent)} spent`}
                    />
                    {over && (
                      <p className="field__hint" style={{ margin: 'var(--s-1) 0 0', color: 'var(--c-coral-deep)' }}>
                        {money(row.spent - row.planned)} over what you planned
                      </p>
                    )}
                  </div>
                );
              })}

              {plannedRows.length > 0 && otherRows.length > 0 && (
                <p className="field__hint" style={{ margin: 'var(--s-3) 0 0' }}>Not on your list</p>
              )}
              {(plannedRows.length > 0 ? otherRows : topCategories).map(([cat, amt]) => (
                <div key={cat}>
                  <div className="row row--between" style={{ marginBottom: 'var(--s-1)' }}>
                    <span style={{ fontSize: 'var(--t-sm)', fontWeight: 'var(--fw-bold)' }}>
                      <span aria-hidden="true">{categoryIcon(cat)}</span> {categoryLabel(cat)}
                    </span>
                    <span className="num" style={{ fontSize: 'var(--t-sm)', fontWeight: 'var(--fw-extra)' }}>
                      {money(amt)}
                    </span>
                  </div>
                  <Progress value={recordedTotal > 0 ? amt / recordedTotal : 0} tone="accent" label={`${categoryLabel(cat)}: ${Math.round(recordedTotal > 0 ? (amt / recordedTotal) * 100 : 0)}% of recorded spending`} />
                </div>
              ))}
            </div>
          )}
          {plannedRows.length === 0 && (
            <p style={{ marginTop: 'var(--s-5)', fontSize: 'var(--t-sm)' }}>
              <Link to="/budget" style={{ fontWeight: 'var(--fw-bold)' }}>Plan your priorities</Link>
              {' '}to see each category against what you planned, and get a budget spreadsheet.
            </p>
          )}
        </Card>
      </div>

      {/* Transaction list */}
      <Card>
        <div className="card__head">
          <h2 className="card__title">Recent spending</h2>
          <Link to="/budget" style={{ fontSize: 'var(--t-sm)', fontWeight: 'var(--fw-bold)' }}>
            Edit budget
          </Link>
        </div>

        {transactions.length === 0 ? (
          <EmptyState icon="🧾" title="Nothing recorded yet">
            Every purchase you add here sharpens what UniWallet recommends.
          </EmptyState>
        ) : (
          <div style={{ marginTop: 'var(--s-4)' }}>
            {transactions.length > RECENT_COUNT && categoryFilterOptions.length > 2 && (
              <div style={{ maxWidth: '16rem', marginBottom: 'var(--s-3)' }}>
                <Select
                  id="filterCategory"
                  aria-label="Show spending from"
                  options={categoryFilterOptions}
                  value={filterCategory}
                  onChange={(e) => { setFilterCategory(e.target.value); setShowAll(true); }}
                />
              </div>
            )}

            {shownTransactions.map((t) => (
              <TransactionRow
                key={t.id}
                t={t}
                categoryOptions={categoryOptions}
                minDate={budget.cycle_start_date}
                maxDate={today}
                canEdit={supports.updateTransaction}
                canDelete={supports.deleteTransaction}
                onSave={(values) => handleSaveTransaction(t, values)}
                onDelete={() => handleDeleteTransaction(t)}
              />
            ))}

            {filteredTransactions.length === 0 && (
              <p style={{ color: 'var(--c-muted-light)', fontSize: 'var(--t-sm)' }}>
                Nothing recorded in that category.
              </p>
            )}

            {filteredTransactions.length > RECENT_COUNT && (
              <div className="row row--between" style={{ marginTop: 'var(--s-4)' }}>
                <p style={{ color: 'var(--c-muted-light)', fontSize: 'var(--t-xs)', margin: 0 }}>
                  {showAll
                    ? `Showing all ${filteredTransactions.length}.`
                    : `Showing the ${RECENT_COUNT} most recent of ${filteredTransactions.length}.`}
                </p>
                <Button variant="quiet" size="sm" onClick={() => setShowAll((x) => !x)}>
                  {showAll ? 'Show fewer' : `Show all ${filteredTransactions.length}`}
                </Button>
              </div>
            )}

            {!supports.deleteTransaction && !supports.updateTransaction && (
              <p style={{ color: 'var(--c-muted-light)', fontSize: 'var(--t-xs)', marginTop: 'var(--s-4)' }}>
                Recorded spending can&apos;t be edited or removed yet, so double-check the
                amount before you add it.
              </p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function greetingKey() {
  const h = new Date().getHours();
  if (h < 12) return 'dash.morning';
  if (h < 18) return 'dash.afternoon';
  return 'dash.evening';
}

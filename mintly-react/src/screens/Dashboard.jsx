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
 * GET /budgets/current — the backend's figure, not a subtraction done here.
 * Recording a spend POSTs to /budgets/{id}/transactions and the response
 * carries the recalculated budget AND the server's overspend decision, both of
 * which are used verbatim. See BudgetContext for the full reasoning.
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
import { money, plural, shortDate } from '../lib/format.js';
import * as v from '../lib/validation.js';

/**
 * `transactions.category` is a free-text VARCHAR(100) on the backend, so these
 * are the app's suggested values rather than a constraint the API enforces.
 */
const CATEGORIES = [
  { value: 'Groceries', label: 'Groceries' },
  { value: 'Toiletries', label: 'Toiletries' },
  { value: 'Transport', label: 'Transport' },
  { value: 'Data', label: 'Airtime & data' },
  { value: 'Stationery', label: 'Stationery' },
  { value: 'Other', label: 'Other' },
];

const ICONS = {
  Groceries: '🛒', Toiletries: '🧼', Transport: '🚕',
  Data: '📱', Stationery: '📓', Other: '💸',
};

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

export default function Dashboard() {
  const { user } = useAuth();
  const budgetCtx = useBudget();
  const { listCount, listTotal } = useShopping();
  const toast = useToast();
  const navigate = useNavigate();

  const {
    budget, transactions, loading, error, supports,
    savings, spendable, spent, remaining, ratio,
    daysLeft, dailyAllowance, dailyAllowanceIsFromServer, health, byCategory,
    addTransaction,
  } = budgetCtx;

  const [form, setForm] = useState({
    description: '', amount: '', category: 'Groceries', isEssential: false,
  });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  /** The server's own overspend verdict from the last POST. */
  const [overspend, setOverspend] = useState(null);

  const topCategories = useMemo(
    () => Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 4),
    [byCategory],
  );

  const status = healthCopy(health, budgetCtx);
  const progressTone = health === 'over' ? 'danger' : health === 'good' ? 'brand' : 'warning';

  async function submitTransaction(event) {
    event.preventDefault();
    const rules = {
      description: (value) => v.required(value, 'Description'),
      amount: (value) => v.amount(value, { min: 0.01, max: 20000, fieldName: 'Amount' }),
    };
    const { errors: found, isValid } = v.validateAll(form, rules);
    setErrors(found);
    if (!isValid) return;

    setSaving(true);
    setOverspend(null);
    try {
      // The backend records the spend even when it takes the student over, so
      // the log stays accurate; it flags the overspend in the response.
      const result = await addTransaction({
        description: form.description,
        amount: Number(String(form.amount).replace(/[^\d.]/g, '')),
        category: form.category,
        isEssential: form.isEssential,
      });

      setForm({ description: '', amount: '', category: form.category, isEssential: false });

      if (result.overspend_warning) {
        setOverspend(result.warning_message || 'That purchase took you over your remaining budget.');
        toast.error('Spend recorded — it took you over budget.');
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
          Mintly needs to know what landed and when. Once it does, it will work out a
          safe daily spend and start finding you cheaper places to shop.
        </EmptyState>
      </Card>
    );
  }

  /* --------------------------------------------------------------- main */

  return (
    <div className="stack stack--loose">
      <div>
        <Eyebrow>Your money this period</Eyebrow>
        <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>
          {greeting()}, {user?.name?.split(' ')[0] || 'there'}.
        </h1>
      </div>

      {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}

      {overspend && (
        <Alert tone="danger" title="That took you over your budget">
          {overspend} It is still recorded, so your spending history stays accurate.
        </Alert>
      )}

      {/* Headline numbers */}
      <div className="dash-hero">
        <Card tone="forest">
          <div className="row row--between">
            <p className="dash-label">Left to spend</p>
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
            {money(spent)} spent so far
          </p>
        </Card>

        <Card tone="butter">
          <p className="dash-label">Safe to spend</p>
          <div className="dash-amount num" style={{ marginTop: 'var(--s-3)' }}>
            {money(dailyAllowance)}
          </div>
          <p className="dash-sub dash-sub--on-butter">
            per day, for the rest of the period
          </p>
          {!dailyAllowanceIsFromServer && (
            <p
              className="dash-sub dash-sub--on-butter"
              style={{ fontSize: 'var(--t-xs)', marginTop: 'var(--s-2)' }}
            >
              Worked out in the app for now — remaining ÷ days left. It switches to the
              backend&apos;s Daily Budget Split as soon as that endpoint returns one.
            </p>
          )}
          <div style={{ marginTop: 'var(--s-5)' }}>
            <Button variant="primary" size="sm" block onClick={() => navigate('/search')}>
              Find something cheaper →
            </Button>
          </div>
        </Card>
      </div>

      <Alert tone={status.tone} title={status.title}>{status.body}</Alert>

      {/* Secondary stats */}
      <div className="stat-row">
        <div className="stat">
          <div className="stat__value num">{money(spent)}</div>
          <p className="stat__label">Spent this period</p>
        </div>
        <div className="stat">
          <div className="stat__value num">{transactions.length}</div>
          <p className="stat__label">Recorded purchases</p>
        </div>
        <div className="stat">
          <div className="stat__value num">{money(listTotal)}</div>
          <p className="stat__label">{plural(listCount, 'item')} in your list</p>
        </div>
        <div className="stat">
          <div className="stat__value num">{shortDate(budget.cycle_end_date)}</div>
          <p className="stat__label">Next payout</p>
        </div>
      </div>

      <div className="dash-hero">
        {/* Record a spend */}
        <Card>
          <h2 className="card__title">Record a spend</h2>
          <p style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)', marginTop: 'var(--s-2)' }}>
            Add what you bought and Mintly updates everything above.
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
                      id={id} options={CATEGORIES} value={form.category}
                      describedBy={describedBy}
                      onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                    />
                  )}
                </Field>
              </div>
            </div>

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

        {/* Where it went */}
        <Card>
          <h2 className="card__title">Where it went</h2>
          {topCategories.length === 0 ? (
            <p style={{ color: 'var(--c-muted-light)', fontSize: 'var(--t-sm)', marginTop: 'var(--s-4)' }}>
              Nothing recorded yet. Add your first spend and this fills in.
            </p>
          ) : (
            <div className="stack stack--tight" style={{ marginTop: 'var(--s-5)' }}>
              {topCategories.map(([cat, amt]) => (
                <div key={cat}>
                  <div className="row row--between" style={{ marginBottom: 'var(--s-1)' }}>
                    <span style={{ fontSize: 'var(--t-sm)', fontWeight: 'var(--fw-bold)' }}>
                      <span aria-hidden="true">{ICONS[cat] || '💸'}</span> {cat}
                    </span>
                    <span className="num" style={{ fontSize: 'var(--t-sm)', fontWeight: 'var(--fw-extra)' }}>
                      {money(amt)}
                    </span>
                  </div>
                  <Progress value={spent > 0 ? amt / spent : 0} tone="accent" />
                </div>
              ))}
            </div>
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
            Every purchase you add here sharpens what Mintly recommends.
          </EmptyState>
        ) : (
          <div style={{ marginTop: 'var(--s-4)' }}>
            {transactions.slice(0, 10).map((t) => (
              <div className="txn" key={t.id}>
                <span className="txn__icon" aria-hidden="true">{ICONS[t.category] || '💸'}</span>
                <div className="grow">
                  <p className="txn__name">{t.item_name}</p>
                  <p className="txn__meta">
                    {t.category || 'Uncategorised'} · {shortDate(t.transaction_date)}
                    {t.is_essential && ' · essential'}
                  </p>
                </div>
                <span className="txn__amt num">{money(t.amount)}</span>
              </div>
            ))}
            {transactions.length > 10 && (
              <p style={{ color: 'var(--c-muted-light)', fontSize: 'var(--t-xs)', marginTop: 'var(--s-4)' }}>
                Showing the 10 most recent of {transactions.length}.
              </p>
            )}

            {!supports.deleteTransaction && (
              <p style={{ color: 'var(--c-muted-light)', fontSize: 'var(--t-xs)', marginTop: 'var(--s-4)' }}>
                Recorded spending cannot be removed yet — the backend has no
                <code> DELETE /budgets/&#123;id&#125;/transactions/&#123;txn_id&#125;</code> route.
                It is listed in docs/BACKEND_INTEGRATION.md as a backend dependency.
              </p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

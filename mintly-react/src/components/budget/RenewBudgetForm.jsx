/**
 * "Start your next cycle" — what the student does when the next allowance lands.
 *
 * Before this existed a budget could never leave `active`, so the second
 * month's allowance could not be entered (the backend allows one active budget
 * per user and answered 409). This closes the current budget, keeps it in the
 * history, and opens the next one — optionally carrying over what was not spent
 * and/or last cycle's savings, and keeping the priority categories.
 */

import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Eyebrow, Field, Input, Select } from '../ui/index.js';
import { useBudget } from '../../context/BudgetContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { daysBetween } from '../../api/normalise.js';
import { longDate, money, todayIso } from '../../lib/format.js';
import { previewRenewal } from '../../lib/budgetMath.js';
import { PERIODS, RULES, START_DATE_HINT } from '../../lib/budgetRules.js';
import * as v from '../../lib/validation.js';

export default function RenewBudgetForm({ ended = false }) {
  const { budget, renewBudget, categories } = useBudget();
  const toast = useToast();
  const navigate = useNavigate();
  const formRef = useRef(null);

  const lastLength = String(daysBetween(budget.cycle_start_date, budget.cycle_end_date) || 30);
  const [values, setValues] = useState({
    amount: '',
    payoutDate: todayIso(),
    periodDays: lastLength,
    savingsPercentage: String(budget.savings_percentage ?? 0),
    survivalThreshold: budget.survival_threshold == null ? '' : String(budget.survival_threshold),
  });
  const [carryLeftover, setCarryLeftover] = useState(true);
  const [carrySavings, setCarrySavings] = useState(false);
  const [keepCategories, setKeepCategories] = useState(true);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const leftover = budget.remaining_amount;
  const previousSavings = budget.savings_amount;

  // A carry-over can be the whole new budget, so the allowance may be blank.
  const amountNum = Number(String(values.amount).replace(/[^\d.]/g, '')) || 0;

  const preview = useMemo(() => previewRenewal({
    amount: amountNum,
    savingsPercentage: Number(values.savingsPercentage) || 0,
    periodDays: Number(values.periodDays),
    startDate: values.payoutDate,
    leftover,
    previousSavings,
    carryLeftover,
    carrySavings,
  }, todayIso()), [amountNum, values, leftover, previousSavings, carryLeftover, carrySavings]);

  function change(name, value) {
    setValues((s) => ({ ...s, [name]: value }));
    if (errors[name]) setErrors((e) => ({ ...e, [name]: undefined }));
    if (formError) setFormError(null);
  }

  function blur(name) {
    const message = RULES[name](values[name], { ...values, isEditing: false });
    setErrors((e) => ({ ...e, [name]: message || undefined }));
  }

  const rules = {
    // The allowance may be left blank only when something is carried over.
    amount: (value) => {
      const carrying = (carryLeftover && leftover > 0) || (carrySavings && previousSavings > 0);
      if (String(value ?? '').trim() === '' && carrying) return null;
      return RULES.amount(value);
    },
    payoutDate: (value, all) => RULES.payoutDate(value, { ...all, isEditing: false }),
    periodDays: (value) => v.required(value, 'Budget period'),
    savingsPercentage: RULES.savingsPercentage,
    survivalThreshold: RULES.survivalThreshold,
  };

  async function submit(event) {
    event.preventDefault();
    setFormError(null);
    const { errors: found, isValid } = v.validateAll(values, rules);
    setErrors(found);
    if (!isValid) {
      const first = Object.keys(found)[0];
      formRef.current?.querySelector(`#renew-${first}`)?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await renewBudget({
        amount: amountNum,
        payoutDate: values.payoutDate,
        periodDays: Number(values.periodDays),
        savingsPercentage: Number(values.savingsPercentage) || 0,
        survivalThreshold: values.survivalThreshold,
        carryOverLeftover: carryLeftover,
        carryOverSavings: carrySavings,
        keepCategories,
      });
      toast.success('Next cycle started. Your last budget is saved under Past budgets.');
      navigate('/dashboard');
    } catch (err) {
      if (err.fieldErrors) setErrors(err.fieldErrors);
      else setFormError(err.message || 'Could not start the next cycle. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const periodOptions = PERIODS.some((p) => p.value === String(values.periodDays))
    ? PERIODS
    : [...PERIODS, { value: String(values.periodDays), label: `${values.periodDays} days (last cycle)` }];

  return (
    <Card tone={ended ? 'butter' : 'paper'} id="next-cycle">
      <Eyebrow>{ended ? 'Your budget period has ended' : 'Next cycle'}</Eyebrow>
      <h2 className="card__title" style={{ marginTop: 'var(--s-3)' }}>Start your next cycle</h2>
      <p style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)', marginTop: 'var(--s-2)' }}>
        {ended
          ? `Your last budget ended on ${longDate(budget.cycle_end_date)}. `
          : 'Starting early closes your current budget. '}
        Enter what landed this time — your last budget stays in your history.
      </p>

      <form ref={formRef} onSubmit={submit} noValidate className="stack" style={{ marginTop: 'var(--s-5)' }}>
        {formError && <Alert tone="danger" title="Could not start it">{formError}</Alert>}

        <Field
          id="renew-amount"
          label="How much landed this time?"
          hint={leftover > 0
            ? 'Leave blank to carry over only what is left from last time.'
            : 'The full amount for the new period.'}
          error={errors.amount}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id} inputMode="decimal" prefix="R" placeholder="1715"
              value={values.amount} invalid={invalid} describedBy={describedBy}
              onChange={(e) => change('amount', e.target.value.replace(/[^\d.]/g, ''))}
              onBlur={() => blur('amount')}
            />
          )}
        </Field>

        <Field
          id="renew-payoutDate"
          label="When did it land?"
          hint={START_DATE_HINT}
          error={errors.payoutDate}
          required
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id} type="date" value={values.payoutDate} invalid={invalid} describedBy={describedBy}
              onChange={(e) => change('payoutDate', e.target.value)}
              onBlur={() => blur('payoutDate')}
            />
          )}
        </Field>

        <Field
          id="renew-periodDays"
          label="How long must it last?"
          hint="Sets your next payout date."
          error={errors.periodDays}
          required
        >
          {({ id, describedBy, invalid }) => (
            <Select
              id={id} options={periodOptions} value={values.periodDays}
              invalid={invalid} describedBy={describedBy}
              onChange={(e) => change('periodDays', e.target.value)}
            />
          )}
        </Field>

        <Field
          id="renew-savingsPercentage"
          label="Put some aside first?"
          hint="A percentage of the new allowance (not of anything carried over)."
          error={errors.savingsPercentage}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id} inputMode="numeric" suffix="%" placeholder="0"
              value={values.savingsPercentage} invalid={invalid} describedBy={describedBy}
              onChange={(e) => change('savingsPercentage', e.target.value.replace(/[^\d.]/g, ''))}
              onBlur={() => blur('savingsPercentage')}
            />
          )}
        </Field>

        <Field
          id="renew-survivalThreshold"
          label="Switch to survival mode below"
          hint="Optional. Blank or 0 turns it off."
          error={errors.survivalThreshold}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id} inputMode="decimal" prefix="R" placeholder="e.g. 200"
              value={values.survivalThreshold} invalid={invalid} describedBy={describedBy}
              onChange={(e) => change('survivalThreshold', e.target.value.replace(/[^\d.]/g, ''))}
              onBlur={() => blur('survivalThreshold')}
            />
          )}
        </Field>

        <div className="stack stack--tight">
          <label className="checkbox" htmlFor="renew-carry-leftover">
            <input
              id="renew-carry-leftover" type="checkbox" checked={carryLeftover}
              onChange={(e) => setCarryLeftover(e.target.checked)}
            />
            <span>Carry over what is left from last time ({money(leftover)})</span>
          </label>
          {previousSavings > 0 && (
            <label className="checkbox" htmlFor="renew-carry-savings">
              <input
                id="renew-carry-savings" type="checkbox" checked={carrySavings}
                onChange={(e) => setCarrySavings(e.target.checked)}
              />
              <span>
                Also spend the {money(previousSavings)} I saved last time
                <span className="checkbox__hint field__hint">Otherwise it stays saved.</span>
              </span>
            </label>
          )}
          {categories.length > 0 && (
            <label className="checkbox" htmlFor="renew-keep-categories">
              <input
                id="renew-keep-categories" type="checkbox" checked={keepCategories}
                onChange={(e) => setKeepCategories(e.target.checked)}
              />
              <span>Keep my priority categories ({categories.length})</span>
            </label>
          )}
        </div>

        {(amountNum > 0 || preview.carried > 0) && (
          <Card tone="forest" flat aria-live="polite">
            <p className="dash-label">Your new safe spend</p>
            <div className="row" style={{ gap: 'var(--s-8)', marginTop: 'var(--s-3)' }}>
              <div>
                <div className="dash-amount num">{money(preview.daily)}</div>
                <p className="dash-sub dash-sub--on-dark">a day</p>
              </div>
              <div>
                <div className="dash-amount num" style={{ fontSize: 'var(--t-xl)' }}>{money(preview.weekly)}</div>
                <p className="dash-sub dash-sub--on-dark">a week</p>
              </div>
            </div>
            <p className="dash-sub dash-sub--on-dark" style={{ marginTop: 'var(--s-4)' }}>
              {money(preview.spendable)} spendable over {preview.daysLeft} days
              {preview.carried > 0 && `, including ${money(preview.carried)} carried over`}
              {preview.savings > 0 && `, after putting ${money(preview.savings)} aside`}.
            </p>
          </Card>
        )}

        <Button type="submit" size="lg" loading={submitting}>
          {submitting ? 'Starting…' : 'Start next cycle'}
        </Button>
      </form>
    </Card>
  );
}

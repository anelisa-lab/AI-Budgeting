/**
 * Budget entry screen — "type in your budget".
 *
 * HOW THE FORM MAPS ONTO THE BACKEND
 * ----------------------------------
 * BudgetCreateRequest wants `total_amount`, `cycle_start_date` and
 * `cycle_end_date`. "cycle_end_date" is not a question anyone can answer, so
 * the form keeps asking the two questions a student can answer — what landed,
 * and how long it must last — and api/normalise.js converts:
 *
 *     payoutDate  -> cycle_start_date
 *     periodDays  -> cycle_end_date  (start + N days = the next payout date,
 *                                     which is what the backend README says
 *                                     cycle_end_date means)
 *
 * That conversion lives in ONE function, `budgetToApi`, and its inverse
 * `budgetToFormValues` fills this form when editing, so a saved budget
 * round-trips exactly.
 *
 * Editing is narrower than creating on purpose: PUT /budgets/{id} accepts only
 * total_amount and cycle_end_date (BudgetUpdateRequest), so the start date is
 * read-only once a budget exists rather than being a control that silently
 * does nothing.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Button, Card, Eyebrow, Field, Input, Select,
} from '../components/ui/index.js';
import { useBudget, NSFAS } from '../context/BudgetContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { addDays, budgetToFormValues } from '../api/normalise.js';
import { daysUntil, longDate, money, todayIso } from '../lib/format.js';
import * as v from '../lib/validation.js';

const PERIODS = [
  { value: '30', label: 'One month (30 days)' },
  { value: '14', label: 'Two weeks (14 days)' },
  { value: '7', label: 'One week (7 days)' },
];

const PRESETS = [
  { label: 'NSFAS living allowance', amount: NSFAS.livingAllowanceMonthly, days: 30 },
  { label: 'Living + personal care', amount: NSFAS.livingAllowanceMonthly + NSFAS.personalCareMonthly, days: 30 },
  { label: 'Personal care only', amount: NSFAS.personalCareMonthly, days: 30 },
];

const RULES = {
  amount: (value) => v.amount(value, { min: 1, max: 50000, fieldName: 'Your allowance' }),
  payoutDate: (value, all) => {
    const base = v.futureOrTodayDate(value, 'Payout date');
    if (base) return base;
    // Editing: the start date is fixed server-side, so it is never the problem.
    if (all.isEditing) return null;
    if (daysUntil(value) > 31) {
      return 'That date is more than a month away. Enter the date your allowance landed (or will land).';
    }
    const end = addDays(value, Number(all.periodDays) || 30);
    if (end && daysUntil(end) < 0) {
      return `A ${all.periodDays}-day budget from that date ended on ${longDate(end)}. `
        + 'Enter the date your latest allowance landed.';
    }
    return null;
  },
  periodDays: (value, all) => {
    const base = v.required(value, 'Budget period');
    if (base) return base;
    if (all.isEditing && all.payoutDate) {
      const end = addDays(all.payoutDate, Number(value) || 30);
      if (end && daysUntil(end) < 0) {
        return `That would end the budget on ${longDate(end)}, which has already passed. Choose a longer period.`;
      }
    }
    return null;
  },
  savingsPercentage: (value) => v.percentage(value, 'Savings'),
  survivalThreshold: (value) => (String(value ?? '').trim() === ''
    ? null
    : v.amount(value, { min: 0, max: 50000, fieldName: 'Survival threshold' })),
};

export default function BudgetEntry() {
  const { budget, saveBudget, supports } = useBudget();
  const toast = useToast();
  const navigate = useNavigate();
  const formRef = useRef(null);

  const [values, setValues] = useState({
    amount: '', payoutDate: todayIso(), periodDays: '30', savingsPercentage: '0',
    survivalThreshold: '',
  });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const isEditing = Boolean(budget);

  // Editing an existing budget — prefill from what the backend returned.
  useEffect(() => {
    if (budget) setValues(budgetToFormValues(budget));
  }, [budget]);

  /**
   * The live preview. On a NEW budget this is the honest arithmetic:
   * (allowance − savings) ÷ days. On an existing one the backend already knows
   * what has been spent, so the preview only previews the CHANGE — the
   * dashboard shows the real remaining figure.
   */
  const preview = useMemo(() => {
    const amountNum = Number(String(values.amount).replace(/[^\d.]/g, ''));
    const days = Number(values.periodDays) || 30;
    const savingsPct = Math.min(100, Math.max(0, Number(values.savingsPercentage) || 0));
    if (!Number.isFinite(amountNum) || amountNum <= 0) return null;

    if (budget) {
      // Editing: mirror what PUT /budgets/{id} does server-side — the balance
      // moves by the same amount as the total, and spending already recorded
      // is kept — then spread it over the days left to the (new) payout date.
      // Showing "new total ÷ period" here, as the first version did, disagreed
      // with the dashboard as soon as anything had been spent.
      const delta = amountNum - budget.total_amount;
      const newRemaining = Math.max(0, budget.remaining_amount + delta);
      const end = addDays(budget.cycle_start_date, days);
      // Same day count as the backend's split: today and payout day included.
      const daysLeft = Math.max(1, daysUntil(end) + 1);
      return {
        editing: true,
        remaining: newRemaining,
        daysLeft,
        end,
        daily: newRemaining / daysLeft,
        weekly: (newRemaining / daysLeft) * 7,
      };
    }

    const savings = Number((amountNum * savingsPct / 100).toFixed(2));
    const spendable = amountNum - savings;
    return {
      amount: amountNum,
      savings,
      spendable,
      days,
      daily: spendable / days,
      weekly: spendable / (days / 7),
    };
  }, [values.amount, values.periodDays, values.savingsPercentage, budget]);

  function change(name, value) {
    setValues((s) => ({ ...s, [name]: value }));
    if (errors[name]) setErrors((e) => ({ ...e, [name]: undefined }));
    if (formError) setFormError(null);
  }

  function blur(name) {
    const message = RULES[name](values[name], { ...values, isEditing });
    setErrors((e) => ({ ...e, [name]: message || undefined }));
  }

  function applyPreset(preset) {
    setValues((s) => ({ ...s, amount: String(preset.amount), periodDays: String(preset.days) }));
    setErrors((e) => ({ ...e, amount: undefined }));
  }

  async function submit(event) {
    event.preventDefault();
    setFormError(null);

    const { errors: found, isValid } = v.validateAll({ ...values, isEditing }, RULES);
    setErrors(found);
    if (!isValid) {
      const first = Object.keys(found)[0];
      formRef.current?.querySelector(`#${first}`)?.focus();
      return;
    }

    setSubmitting(true);
    try {
      await saveBudget({
        amount: Number(String(values.amount).replace(/[^\d.]/g, '')),
        payoutDate: values.payoutDate,
        periodDays: Number(values.periodDays),
        savingsPercentage: Number(values.savingsPercentage) || 0,
        survivalThreshold: values.survivalThreshold,
      });
      toast.success(isEditing ? 'Budget updated.' : 'Budget set. Let’s go shopping.');
      navigate('/dashboard');
    } catch (err) {
      // A 422 from Pydantic arrives with the offending field already mapped to
      // this form's field ids — see http.js.
      if (err.fieldErrors) {
        setErrors(err.fieldErrors);
        const first = Object.keys(err.fieldErrors)[0];
        formRef.current?.querySelector(`#${first}`)?.focus();
      } else {
        setFormError(err.message || 'Could not save your budget. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page--narrow" style={{ margin: '0 auto' }}>
      <div className="stack stack--loose">
        <div>
          <Eyebrow>{isEditing ? 'Edit your budget' : 'Step 1 of 2'}</Eyebrow>
          <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>
            {isEditing ? 'Update your budget' : 'What are you working with?'}
          </h1>
          <p style={{ color: 'var(--c-muted)', marginTop: 'var(--s-3)' }}>
            Tell UniWallet what landed and when. It will work out what you can safely
            spend each day so the money lasts to the next payout.
          </p>
        </div>

        <Card>
          <form ref={formRef} onSubmit={submit} noValidate className="stack">
            {formError && <Alert tone="danger" title="Could not save">{formError}</Alert>}

            {!isEditing && (
              <div>
                <p className="field__label" style={{ marginBottom: 'var(--s-2)' }}>
                  Start from a known amount
                </p>
                <div className="chips">
                  {PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      className="chip"
                      aria-pressed={Number(values.amount) === p.amount}
                      onClick={() => applyPreset(p)}
                    >
                      {p.label} <span className="chip__count num">{money(p.amount)}</span>
                    </button>
                  ))}
                </div>
                <p className="field__hint" style={{ marginTop: 'var(--s-2)' }}>
                  2026 NSFAS caps. Change the amount below if yours differs.
                </p>
              </div>
            )}

            <Field
              id="amount"
              label="How much did you receive?"
              hint="The full amount for this period, before you spend any of it."
              error={errors.amount}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  prefix="R"
                  placeholder="1650"
                  value={values.amount}
                  invalid={invalid}
                  describedBy={describedBy}
                  onChange={(e) => change('amount', e.target.value.replace(/[^\d.]/g, ''))}
                  onBlur={() => blur('amount')}
                />
              )}
            </Field>

            <Field
              id="payoutDate"
              label="When did it land?"
              hint={isEditing
                ? 'The start date of a budget cannot be changed once it is set.'
                : 'The day your allowance was paid. The daily figure counts from here.'}
              error={errors.payoutDate}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="date"
                  value={values.payoutDate}
                  invalid={invalid}
                  describedBy={describedBy}
                  disabled={isEditing}
                  onChange={(e) => change('payoutDate', e.target.value)}
                  onBlur={() => blur('payoutDate')}
                />
              )}
            </Field>

            <Field
              id="periodDays"
              label="How long must it last?"
              hint="Sets the date of your next payout, which is what the daily figure counts down to."
              error={errors.periodDays}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Select
                  id={id}
                  options={PERIODS.some((p) => p.value === String(values.periodDays))
                    ? PERIODS
                    // A saved budget can have a length the presets do not offer.
                    : [...PERIODS, { value: String(values.periodDays), label: `${values.periodDays} days (current)` }]}
                  value={values.periodDays}
                  invalid={invalid}
                  describedBy={describedBy}
                  onChange={(e) => change('periodDays', e.target.value)}
                />
              )}
            </Field>

            {/* budgets.savings_percentage — carved out up front by the backend
                so it is never spendable. Only settable at creation, because
                BudgetUpdateRequest does not accept it. */}
            {!isEditing && (
              <Field
                id="savingsPercentage"
                label="Put some aside first?"
                hint="A percentage of your allowance (0–100), taken off the top and kept out of your spendable balance. Leave at 0 to skip."
                error={errors.savingsPercentage}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    suffix="%"
                    placeholder="0"
                    value={values.savingsPercentage}
                    invalid={invalid}
                    describedBy={describedBy}
                    onChange={(e) => change('savingsPercentage', e.target.value.replace(/[^\d.]/g, ''))}
                    onBlur={() => blur('savingsPercentage')}
                  />
                )}
              </Field>
            )}

            {/* budgets.survival_threshold — the deck's "Broke Week Mode". When
                remaining_amount drops to this, the Daily Budget Split switches
                to survival mode and recommendations become essentials only. */}
            <Field
              id="survivalThreshold"
              label="Switch to survival mode below"
              hint={isEditing
                ? 'When what is left drops to this, UniWallet recommends essentials only. Set 0 to turn it off.'
                : 'Optional. When what is left drops to this, UniWallet recommends essentials only.'}
              error={errors.survivalThreshold}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  prefix="R"
                  placeholder="e.g. 200"
                  value={values.survivalThreshold}
                  invalid={invalid}
                  describedBy={describedBy}
                  onChange={(e) => change('survivalThreshold', e.target.value.replace(/[^\d.]/g, ''))}
                  onBlur={() => blur('survivalThreshold')}
                />
              )}
            </Field>

            {/* Live preview — the payoff for filling the form in. */}
            {preview && (
              <Card tone="forest" flat aria-live="polite">
                <p className="dash-label">
                  {isEditing ? 'After this change' : 'Your safe spend'}
                </p>
                <div className="row" style={{ gap: 'var(--s-8)', marginTop: 'var(--s-3)' }}>
                  <div>
                    <div className="dash-amount num">{money(preview.daily)}</div>
                    <p className="dash-sub dash-sub--on-dark">a day</p>
                  </div>
                  <div>
                    <div className="dash-amount num" style={{ fontSize: 'var(--t-xl)' }}>
                      {money(preview.weekly)}
                    </div>
                    <p className="dash-sub dash-sub--on-dark">a week</p>
                  </div>
                </div>
                <p className="dash-sub dash-sub--on-dark" style={{ marginTop: 'var(--s-4)' }}>
                  {preview.editing
                    ? `About ${money(preview.remaining)} left for the ${preview.daysLeft} days to `
                      + `${longDate(preview.end)} — spending you have already recorded is kept. `
                      + 'The dashboard shows the exact figure once you save.'
                    : preview.savings > 0
                      ? `${money(preview.spendable)} spendable after putting ${money(preview.savings)} aside, `
                        + `spread over ${preview.days} days.`
                      : `${money(preview.amount)} spread evenly over ${preview.days} days.`}
                </p>
              </Card>
            )}

            <div className="row" style={{ gap: 'var(--s-3)' }}>
              <Button type="submit" size="lg" loading={submitting} className="grow">
                {submitting ? 'Saving…' : isEditing ? 'Save changes' : 'Set my budget'}
              </Button>
            </div>

            {isEditing && !supports.deleteBudget && (
              <p className="field__hint">
                A budget can&apos;t be deleted yet. When your next allowance lands, update
                the amount and period here.
              </p>
            )}
          </form>
        </Card>

        {isEditing && (
          <div className="row">
            <Button variant="quiet" size="sm" onClick={() => navigate('/dashboard')}>
              ← Back to dashboard
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

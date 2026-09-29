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
 * total_amount, cycle_end_date, savings_percentage and survival_threshold
 * (BudgetUpdateRequest), so the start date is read-only once a budget exists
 * rather than being a control that silently does nothing.
 *
 * Three more things live on this screen:
 *   - "Start next cycle" (RenewBudgetForm) — how a budget ends and the next
 *     one begins;
 *   - "Plan your priorities" (CategoryPlanner) — the student's categories, and
 *     the spreadsheet template built from them;
 *   - "Past budgets" — the finished cycles.
 * The preview uses lib/budgetMath.js, which divides by the same day count as
 * the backend's Daily Budget Split so the two numbers agree.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Button, Card, Eyebrow, Field, Input, Select,
} from '../components/ui/index.js';
import { useBudget, NSFAS } from '../context/BudgetContext.jsx';
import { useLanguage } from '../context/LanguageContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import CategoryPlanner from '../components/budget/CategoryPlanner.jsx';
import PastBudgets from '../components/budget/PastBudgets.jsx';
import RenewBudgetForm from '../components/budget/RenewBudgetForm.jsx';
import ListBudgetSummary from '../components/list/ListBudgetSummary.jsx';
import { budgetToFormValues } from '../api/normalise.js';
import { longDate, money, todayIso } from '../lib/format.js';
import { previewEdit, previewNewBudget } from '../lib/budgetMath.js';
import { PERIODS, RULES, START_DATE_HINT } from '../lib/budgetRules.js';
import { saveBlob } from '../lib/download.js';
import * as v from '../lib/validation.js';

const PRESETS = [
  { label: 'NSFAS living allowance', amount: NSFAS.livingAllowanceMonthly, days: 30 },
  { label: 'NSFAS living + travelling allowance', amount: 2535, days: 30 },
];

export default function BudgetEntry() {
  const { t } = useLanguage();
  const {
    budget, saveBudget, deleteBudget, supports, cycleEnded, categories: savedCategories,
    saveCategories, downloadTemplate, spendable: spendableNow,
  } = useBudget();
  const toast = useToast();
  const navigate = useNavigate();
  const formRef = useRef(null);
  const [deleting, setDeleting] = useState(false);
  /** "Start next cycle" opened early, before the payout date has passed. */
  const [showRenew, setShowRenew] = useState(false);

  /* The priority-category planner: { name, plannedAmount } rows. */
  const [plannerRows, setPlannerRows] = useState([]);
  const [plannerError, setPlannerError] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [savingCategories, setSavingCategories] = useState(false);

  async function handleDeleteBudget() {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Delete this budget and every spend recorded against it? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await deleteBudget();
      toast.info('Budget deleted. Set up a new one whenever you are ready.');
    } catch (err) {
      toast.error(err.message || 'Could not delete the budget.');
    } finally {
      setDeleting(false);
    }
  }

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

  // The saved priority categories fill the planner (again after each save).
  useEffect(() => {
    setPlannerRows(savedCategories.map((c) => ({
      name: c.name,
      plannedAmount: c.planned_amount == null ? '' : String(c.planned_amount),
    })));
  }, [savedCategories]);

  const plannerDirty = useMemo(() => {
    const saved = savedCategories.map((c) => `${c.name.toLowerCase()}|${c.planned_amount ?? ''}`);
    const now = plannerRows.map((r) => `${r.name.toLowerCase()}|${Number(r.plannedAmount) || ''}`);
    return saved.length !== now.length || saved.some((x, i) => x !== now[i]);
  }, [plannerRows, savedCategories]);

  /**
   * The live preview. Every figure comes from lib/budgetMath.js, which uses the
   * backend's own day count (today and payout day both included) and rounds the
   * daily figure down to the cent — so what is shown here is what the dashboard
   * says the moment the budget is saved. (The first version divided a new
   * budget by the period length: R57.17 here, R55.32 there.)
   *
   * On an existing budget the backend already knows what has been spent, so the
   * preview only previews the CHANGE, exactly as PUT /budgets/{id} applies it.
   */
  const preview = useMemo(() => {
    const amountNum = Number(String(values.amount).replace(/[^\d.]/g, ''));
    if (!Number.isFinite(amountNum) || amountNum <= 0) return null;
    const today = todayIso();

    if (budget) {
      return {
        editing: true,
        ...previewEdit({
          amount: amountNum,
          savingsPercentage: values.savingsPercentage,
          periodDays: values.periodDays,
          budget,
        }, today),
      };
    }
    return previewNewBudget({
      amount: amountNum,
      savingsPercentage: values.savingsPercentage,
      periodDays: values.periodDays,
      startDate: values.payoutDate,
    }, today);
  }, [values.amount, values.periodDays, values.savingsPercentage, values.payoutDate, budget]);

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
      const saved = await saveBudget({
        amount: Number(String(values.amount).replace(/[^\d.]/g, '')),
        payoutDate: values.payoutDate,
        periodDays: Number(values.periodDays),
        savingsPercentage: Number(values.savingsPercentage) || 0,
        survivalThreshold: values.survivalThreshold,
      });
      // Priorities picked before the budget existed belong to the new budget.
      if (!isEditing && plannerRows.length > 0) {
        try {
          await saveCategories(plannerRows, saved.id);
        } catch (err) {
          toast.error(`Budget set, but your categories were not saved: ${err.message}`);
        }
      }
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

  /** Build the spreadsheet for the chosen categories and hand it to the browser. */
  async function handleDownload() {
    setPlannerError(null);
    const amountNum = Number(String(values.amount).replace(/[^\d.]/g, ''));
    if (!isEditing && !(amountNum > 0)) {
      setPlannerError('Enter how much you received above first, so the sheet is sized to your money.');
      return;
    }
    setDownloading(true);
    try {
      const { blob, filename } = await downloadTemplate({
        categories: plannerRows,
        amount: amountNum > 0 ? amountNum : undefined,
        savingsPercentage: values.savingsPercentage,
        periodDays: values.periodDays,
        startDate: values.payoutDate,
      });
      saveBlob(blob, filename || 'uniwallet-budget.xlsx');
      toast.success('Your budget spreadsheet is ready. Check your downloads.');
    } catch (err) {
      setPlannerError(err.message || 'Could not build the spreadsheet. Please try again.');
    } finally {
      setDownloading(false);
    }
  }

  async function handleSaveCategories() {
    setPlannerError(null);
    setSavingCategories(true);
    try {
      await saveCategories(plannerRows);
      toast.success('Categories saved. Your dashboard now shows planned vs spent.');
    } catch (err) {
      setPlannerError(err.message || 'Could not save your categories.');
    } finally {
      setSavingCategories(false);
    }
  }

  const plannerSpendable = isEditing
    ? (preview?.editing ? Math.max(0, preview.total - preview.savings) : spendableNow)
    : (preview ? preview.spendable : null);

  return (
    <div className="page--narrow" style={{ margin: '0 auto' }}>
      <div className="stack stack--loose">
        <div>
          <Eyebrow>{isEditing ? 'Edit your budget' : t('budget.step1')}</Eyebrow>
          <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>
            {isEditing ? 'Update your budget' : t('budget.title')}
          </h1>
          <p style={{ color: 'var(--c-muted)', marginTop: 'var(--s-3)' }}>
            Tell UniWallet what landed and when. It will work out what you can safely
            spend each day so the money lasts to the next payout.
          </p>
        </div>

        {isEditing && supports.renewBudget && (cycleEnded || showRenew) && (
          <RenewBudgetForm ended={cycleEnded} />
        )}

        {isEditing && supports.renewBudget && !cycleEnded && !showRenew && (
          <div className="row row--between">
            <p className="field__hint" style={{ margin: 0, maxWidth: '44ch' }}>
              Your next allowance landed early? Start the next cycle now — this budget is kept in your history.
            </p>
            <Button variant="secondary" size="sm" onClick={() => setShowRenew(true)}>
              Start next cycle
            </Button>
          </div>
        )}

        <Card>
          {cycleEnded && (
            <p className="field__hint" style={{ marginBottom: 'var(--s-4)' }}>
              Only need to stretch this cycle a little? Edit it below instead.
            </p>
          )}
          <form ref={formRef} onSubmit={submit} noValidate className="stack">
            {formError && <Alert tone="danger" title="Could not save">{formError}</Alert>}

            {!isEditing && (
              <div>
                <p className="field__label" id="budget-presets-label" style={{ marginBottom: 'var(--s-2)' }}>
                  {t('budget.known')}
                </p>
                <div className="chips" role="group" aria-labelledby="budget-presets-label">
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
              label={t('budget.received')}
              hint="The full amount for this period, before you spend any of it."
              error={errors.amount}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  prefix="R"
                  placeholder="1715"
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
              label={t('budget.landed')}
              hint={isEditing
                ? 'The start date of a budget cannot be changed once it is set.'
                : START_DATE_HINT}
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
              label={t('budget.last')}
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
                so it is never spendable. Editable too: the server recomputes the
                amount from the percentage and the total, so the two never drift
                apart when the total changes. */}
            <Field
              id="savingsPercentage"
              label="Put some aside first?"
              hint={isEditing
                ? 'A percentage of your allowance (0–100). Changing it, or your allowance, recalculates what is set aside.'
                : 'A percentage of your allowance (0–100), taken off the top and kept out of your spendable balance. Leave at 0 to skip.'}
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

            {/* budgets.survival_threshold — the deck's "Broke Week Mode". When
                remaining_amount drops to this, the Daily Budget Split switches
                to survival mode and recommendations become essentials only. */}
            <Field
              id="survivalThreshold"
              label="Switch to survival mode below"
              hint="Optional. When what is left drops to this, UniWallet recommends essentials only. Leave blank (or 0) to turn it off."
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
                        + `spread over ${preview.daysLeft} days (today and payout day both count).`
                      : `${money(preview.amount)} spread evenly over ${preview.daysLeft} days `
                        + '(today and payout day both count).'}
                </p>
              </Card>
            )}

            <div className="row" style={{ gap: 'var(--s-3)' }}>
              <Button type="submit" size="lg" loading={submitting} className="grow">
                {submitting ? 'Saving…' : isEditing ? 'Save changes' : 'Set my budget'}
              </Button>
            </div>

            {isEditing && supports.deleteBudget && (
              <div className="row row--between" style={{ borderTop: '1.5px solid var(--c-line)', paddingTop: 'var(--s-4)' }}>
                <p className="field__hint" style={{ margin: 0, maxWidth: '40ch' }}>
                  Set this up by mistake? Deleting removes the budget and its spending.
                </p>
                <Button type="button" variant="ghost" size="sm" loading={deleting} onClick={handleDeleteBudget}>
                  Delete budget
                </Button>
              </div>
            )}
          </form>
        </Card>

        {/* Priorities -> the spreadsheet template, and (with a budget) the dashboard bars */}
        {supports.categories && (
          <CategoryPlanner
            rows={plannerRows}
            onChange={(rows) => { setPlannerRows(rows); setPlannerError(null); }}
            spendable={plannerSpendable}
            periodDays={Number(values.periodDays) || 30}
            onDownload={handleDownload}
            downloading={downloading}
            onSave={isEditing ? handleSaveCategories : null}
            saving={savingCategories}
            dirty={plannerDirty}
            error={plannerError}
          />
        )}

        {/* Your shopping list against what's left (live Checkers + catalogue items) */}
        {isEditing && <ListBudgetSummary />}

        <PastBudgets refreshKey={budget?.id ?? 'none'} />

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

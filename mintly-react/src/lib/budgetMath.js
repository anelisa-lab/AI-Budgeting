/**
 * Budget arithmetic the forms PREVIEW before anything is saved.
 *
 * "Pure" on purpose — no React, no DOM, `today` is passed in — so
 * tests/contract/run.mjs can check every figure against what the backend
 * (app/budget_calc.py, app/budget_split.py) produces for the same inputs.
 *
 * THE ONE RULE: the preview must agree with the dashboard the moment the budget
 * is saved. The backend's Daily Budget Split divides by the days from TODAY to
 * the payout date with both ends counted (budget_split.days_remaining), so a
 * 30-day budget that starts today is spread over 31 days, and the daily limit
 * is rounded DOWN to the cent. The first version of the entry form divided by
 * 30 and showed R57.17 where the dashboard then said R55.32.
 */

import { addDays, daysBetween } from '../api/normalise.js';

/** Round to the cent the way the backend does for money it stores (half up). */
export function roundCents(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/** The backend rounds the daily limit DOWN so the days never over-allocate. */
export function floorCents(value) {
  return Math.floor(Number(value) * 100 + 1e-9) / 100;
}

/**
 * Days the money has to cover: today AND payout day both count, never below 1.
 * Same as app/budget_split.py days_remaining().
 */
export function daysToPayout(endIso, todayIso) {
  return Math.max(1, daysBetween(todayIso, endIso) + 1);
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

/**
 * A brand-new budget (or the next cycle): what the dashboard will say once it is saved.
 *
 * @param {object} p
 * @param {number} p.amount              the fresh allowance
 * @param {number} p.savingsPercentage   0..100, of the FRESH allowance only
 * @param {number} p.periodDays          days until the next payout
 * @param {string} p.startDate           YYYY-MM-DD the allowance landed
 * @param {number} [p.carried]           money rolled in from the last cycle
 * @param {string} today                 YYYY-MM-DD
 */
export function previewNewBudget({
  amount, savingsPercentage = 0, periodDays = 30, startDate, carried = 0,
}, today) {
  const fresh = Number(amount) || 0;
  const pct = Math.min(100, Math.max(0, Number(savingsPercentage) || 0));
  const days = Math.max(1, Number(periodDays) || 30);
  const savings = roundCents(fresh * pct / 100);
  const total = roundCents(fresh + (Number(carried) || 0));
  const spendable = Math.max(0, roundCents(total - savings));

  const end = isIsoDate(startDate) ? addDays(startDate, days) : null;
  // No usable start date yet: assume it starts today, which is the common case.
  const daysLeft = end ? daysToPayout(end, today) : days + 1;
  const daily = floorCents(spendable / daysLeft);

  return {
    amount: fresh,
    carried: Number(carried) || 0,
    total,
    savings,
    spendable,
    days,
    daysLeft,
    end: end || addDays(today, days),
    daily,
    weekly: roundCents(daily * 7),
  };
}

/**
 * The next cycle: like a new budget, plus what the student chose to carry over.
 * Last cycle's leftover (and, if asked, its savings) roll into the total; the
 * savings percentage applies to the fresh allowance only.
 */
export function previewRenewal({
  amount, savingsPercentage, periodDays, startDate,
  leftover = 0, previousSavings = 0, carryLeftover = true, carrySavings = false,
}, today) {
  const carried = (carryLeftover ? Number(leftover) || 0 : 0)
    + (carrySavings ? Number(previousSavings) || 0 : 0);
  return previewNewBudget({ amount, savingsPercentage, periodDays, startDate, carried }, today);
}

/**
 * Editing a saved budget. Mirrors PUT /budgets/{id} (budget_calc.calculate_budget_edit):
 * savings follow the total and the percentage, and what is left moves by the
 * change in the SPENDABLE amount, so money already spent stays spent.
 */
export function previewEdit({
  amount, savingsPercentage, periodDays, budget,
}, today) {
  const total = Number(amount) || 0;
  const pct = Math.min(100, Math.max(0,
    savingsPercentage === '' || savingsPercentage === undefined
      ? budget.savings_percentage
      : Number(savingsPercentage) || 0));
  const carried = budget.carried_over_amount || 0;
  const savings = roundCents(Math.max(0, total - carried) * pct / 100);
  const oldSpendable = budget.total_amount - budget.savings_amount;
  const newSpendable = total - savings;
  const remaining = Math.min(
    Math.max(0, roundCents(budget.remaining_amount + (newSpendable - oldSpendable))),
    Math.max(0, newSpendable),
  );
  const days = Math.max(1, Number(periodDays) || 30);
  const end = addDays(budget.cycle_start_date, days);
  const daysLeft = daysToPayout(end, today);
  const daily = floorCents(remaining / daysLeft);
  return {
    total, savings, remaining, days, daysLeft, end, daily, weekly: roundCents(daily * 7),
  };
}

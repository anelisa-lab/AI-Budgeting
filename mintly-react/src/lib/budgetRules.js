/**
 * Validation rules and choices shared by the budget form (BudgetEntry) and the
 * "start next cycle" form (RenewBudgetForm), so the two can never disagree about
 * what a valid allowance, start date or period is.
 *
 * ABOUT THE START DATE
 * --------------------
 * "When did it land?" accepts:
 *   - any date the allowance already landed, as long as the period it starts
 *     has not already finished (a 30-day budget from 3 months ago is over, so
 *     it is refused with a message that says so);
 *   - a date up to MAX_DAYS_AHEAD days in the future, for an allowance that has
 *     not landed yet.
 * Anything further ahead is almost certainly a typo. These limits are
 * deliberate, and START_DATE_HINT says so where the student can read it.
 */

import { addDays } from '../api/normalise.js';
import { daysUntil, longDate } from './format.js';
import * as v from './validation.js';

export const MAX_DAYS_AHEAD = 31;

export const PERIODS = [
  { value: '30', label: 'One month (30 days)' },
  { value: '14', label: 'Two weeks (14 days)' },
  { value: '7', label: 'One week (7 days)' },
];

export const START_DATE_HINT = 'The day your allowance landed. Any past date works while that '
  + `period is still running; if it has not landed yet, up to ${MAX_DAYS_AHEAD} days ahead is fine.`;

export const RULES = {
  amount: (value) => v.amount(value, { min: 1, max: 50000, fieldName: 'Your allowance' }),
  payoutDate: (value, all) => {
    const base = v.validDate(value, 'Payout date');
    if (base) return base;
    // Editing: the start date is fixed server-side, so it is never the problem.
    if (all.isEditing) return null;
    if (daysUntil(value) > MAX_DAYS_AHEAD) {
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

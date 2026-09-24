/**
 * DailyBudgetSplit — Member 6's Daily Budget Split, on screen.
 * Member 8 (Phase 3: "Build the Daily Budget Split display component").
 *
 * Renders a BudgetSplitOut exactly the way docs/BUDGET_SPLIT_CONTRACT.md
 * describes, so every screen that shows the daily figure shows it the same:
 *
 *  - `daily_limit` is the headline and is NEVER recomputed here — the backend
 *    rounds it down so the days can't allocate more than the budget holds.
 *  - "left today" is `remaining_today`, with a bar of spent_today / daily_limit.
 *  - `tomorrow_limit` is shown only when it differs, and hidden when null
 *    (payout day — there is no tomorrow in this cycle).
 *  - survival mode leads with the rate from tomorrow, essentials only.
 *  - allowance exhausted is detected on the BALANCE, not on `mode` (§4), and
 *    hides the daily figure entirely.
 *  - `message` is written for students by the backend and rendered verbatim.
 *
 * If the split endpoint could not answer, `split` is null and the card falls
 * back to `fallbackAllowance` (remaining ÷ days left), labelled as such.
 */

import { Badge, Progress } from '../ui/index.js';
import { money, plural, shortDate } from '../../lib/format.js';

export default function DailyBudgetSplit({
  split,
  fallbackAllowance = 0,
  remaining = 0,
  daysLeft = 0,
  children,
}) {
  const survival = split?.mode === 'survival';
  const exhausted = remaining <= 0;
  const overToday = split ? split.spent_today > split.daily_limit : false;
  const headline = survival && split?.tomorrow_limit != null
    ? split.tomorrow_limit
    : (split?.daily_limit ?? fallbackAllowance);
  const schedule = (split?.days || []).slice(0, 7);

  return (
    <>
      <div className="row row--between">
        <p className="dash-label">Safe to spend</p>
        {survival && <Badge tone="danger">Survival mode</Badge>}
      </div>

      {exhausted ? (
        <p className="dash-sub dash-sub--on-butter" style={{ marginTop: 'var(--s-3)' }}>
          {plural(split?.days_remaining ?? daysLeft, 'day')} until your next payout.
        </p>
      ) : (
        <>
          <div className="dash-amount num" style={{ marginTop: 'var(--s-3)' }}>
            {money(headline)}
          </div>
          <p className="dash-sub dash-sub--on-butter">
            {survival ? 'a day from tomorrow — essentials only' : 'per day, for the rest of the period'}
          </p>
          {split && (
            <div style={{ marginTop: 'var(--s-4)' }}>
              <Progress
                value={split.daily_limit > 0 ? Math.min(1, split.spent_today / split.daily_limit) : 1}
                tone={overToday ? 'danger' : 'brand'}
                surface="butter"
                label={`${money(split.remaining_today)} left to spend today`}
              />
              <p className="dash-sub dash-sub--on-butter" style={{ marginTop: 'var(--s-2)' }}>
                {money(split.remaining_today)} left today
                {overToday && ` · ${money(split.spent_today - split.daily_limit)} over`}
                {split.tomorrow_limit != null && !survival
                  && split.tomorrow_limit !== split.daily_limit
                  && ` · from tomorrow ${money(split.tomorrow_limit)} a day`}
              </p>
            </div>
          )}
        </>
      )}

      {split?.message && (
        <p className="dash-sub dash-sub--on-butter" style={{ fontSize: 'var(--t-xs)', marginTop: 'var(--s-3)' }}>
          {split.message}
        </p>
      )}

      {!split && !exhausted && (
        <p className="dash-sub dash-sub--on-butter" style={{ fontSize: 'var(--t-xs)', marginTop: 'var(--s-2)' }}>
          Worked out in the app for now — remaining ÷ days left. It switches to the
          backend&apos;s Daily Budget Split as soon as that endpoint answers.
        </p>
      )}

      {schedule.length > 1 && !exhausted && (
        <details style={{ marginTop: 'var(--s-4)' }}>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--t-xs)', fontWeight: 'var(--fw-bold)' }}>
            The next {schedule.length} days
          </summary>
          <div className="stack stack--tight" style={{ marginTop: 'var(--s-3)' }}>
            {schedule.map((day) => (
              <div className="row row--between" key={day.limit_date}>
                <span style={{ fontSize: 'var(--t-xs)' }}>
                  {day.is_today ? 'Today' : shortDate(day.limit_date)}
                </span>
                <span className="num" style={{ fontSize: 'var(--t-xs)', fontWeight: 'var(--fw-bold)' }}>
                  {day.is_today && day.spent_amount > 0
                    ? `${money(day.spent_amount)} of ${money(day.planned_limit)}`
                    : money(day.planned_limit)}
                </span>
              </div>
            ))}
          </div>
          <p className="dash-sub dash-sub--on-butter" style={{ fontSize: 'var(--t-xs)', marginTop: 'var(--s-2)' }}>
            Each day&apos;s share of what is left — not money to add up.
          </p>
        </details>
      )}

      {children}
    </>
  );
}

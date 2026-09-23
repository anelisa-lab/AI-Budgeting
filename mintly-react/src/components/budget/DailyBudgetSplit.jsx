/**
 * DailyBudgetSplit — presentation for the backend's live daily allowance.
 */
import { Badge, Card, Progress } from '../ui/index.js';
import { money, shortDate } from '../../lib/format.js';

export default function DailyBudgetSplit({
  dailyAllowance = 0,
  remainingToday = 0,
  spentToday = 0,
  mode = 'normal',
  message = '',
  days = [],
}) {
  const usedRatio = dailyAllowance > 0
    ? Math.min(1, Math.max(0, spentToday / dailyAllowance))
    : 0;

  return (
    <Card tone="butter">
      <div className="row row--between" style={{ alignItems: 'flex-start' }}>
        <div>
          <p className="dash-label">Daily Budget Split</p>
          <div className="dash-amount num" style={{ marginTop: 'var(--s-3)' }}>
            {money(dailyAllowance)}
          </div>
          <p className="dash-sub dash-sub--on-butter">safe daily allowance</p>
        </div>
        {mode === 'survival' && <Badge tone="warning">Survival mode</Badge>}
      </div>

      {message && (
        <p style={{ marginTop: 'var(--s-4)', fontSize: 'var(--t-sm)', color: 'rgba(28,28,25,0.75)' }}>
          {message}
        </p>
      )}

      <div style={{ marginTop: 'var(--s-5)' }}>
        <div className="row row--between" style={{ marginBottom: 'var(--s-2)' }}>
          <span style={{ fontSize: 'var(--t-xs)', fontWeight: 'var(--fw-bold)' }}>Today</span>
          <span className="num" style={{ fontSize: 'var(--t-xs)', fontWeight: 'var(--fw-extra)' }}>
            {money(remainingToday)} left
          </span>
        </div>
        <Progress
          value={usedRatio}
          tone={usedRatio >= 1 ? 'danger' : usedRatio >= 0.75 ? 'warning' : 'brand'}
        />
        <p style={{ marginTop: 'var(--s-2)', fontSize: 'var(--t-xs)', color: 'var(--c-muted)' }}>
          {spentToday > 0 ? `${money(spentToday)} spent today.` : 'Nothing recorded today yet.'}
        </p>
      </div>

      {days.length > 0 && (
        <details style={{ marginTop: 'var(--s-5)' }}>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--t-xs)', fontWeight: 'var(--fw-bold)' }}>
            View day-by-day split
          </summary>
          <div className="stack stack--tight" style={{ marginTop: 'var(--s-3)' }}>
            {days.slice(0, 7).map((day, index) => (
              <div className="row row--between" key={day.date || day.day || index}>
                <span style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)' }}>
                  {day.date ? shortDate(day.date) : `Day ${day.day ?? index + 1}`}
                </span>
                <span className="num" style={{ fontSize: 'var(--t-xs)', fontWeight: 'var(--fw-bold)' }}>
                  {money(day.amount ?? day.daily_limit ?? 0)}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </Card>
  );
}
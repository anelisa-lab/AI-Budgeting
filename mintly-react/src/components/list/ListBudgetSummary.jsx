/**
 * "Your list vs what you have left" — shown on the Budget page and Compare.
 *
 * The total is the backend's list summary (GET /shopping-list): prices saved
 * when each item was added, counting only what can still be bought. It is
 * checked against the same `remaining` (this period) the Budget page and
 * dashboard use. Over budget = red.
 */

import { Link } from 'react-router-dom';
import { Alert, Card, Progress } from '../ui/index.js';
import { useBudget } from '../../context/BudgetContext.jsx';
import { useShopping } from '../../context/ShoppingContext.jsx';
import { money, plural } from '../../lib/format.js';

export function listBudgetStatus(total, remaining) {
  const over = total > remaining;
  return {
    over,
    difference: Number(Math.abs(remaining - total).toFixed(2)),
    share: remaining > 0 ? Math.min(1, total / remaining) : (total > 0 ? 1 : 0),
  };
}

export default function ListBudgetSummary({ showLink = true, title = 'Your list vs your budget' }) {
  const { listTotal, listCount, summary, ready } = useShopping();
  const { budget, remaining } = useBudget();
  if (!ready) return null;

  const status = listBudgetStatus(listTotal, remaining);

  return (
    <Card className="stack">
      <div className="card__head">
        <h2 className="card__title">{title}</h2>
        {showLink && listCount > 0 && <Link to="/compare">See your list →</Link>}
      </div>

      {listCount === 0 ? (
        <p className="field__hint" style={{ margin: 0 }}>
          Your list is empty. Add items from <Link to="/search">Search</Link> to see how they fit
          your budget.
        </p>
      ) : (
        <>
          <div className="row row--between">
            <span style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)' }}>
              {plural(listCount, 'item')} on your list
            </span>
            <span className="num list-budget__total">{money(listTotal)}</span>
          </div>

          {budget ? (
            <>
              <div className="row row--between">
                <span style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)' }}>Left this period</span>
                <span className="num" style={{ fontWeight: 'var(--fw-bold)' }}>{money(remaining)}</span>
              </div>
              <Progress
                value={status.share}
                tone={status.over ? 'danger' : 'brand'}
                label="Share of your remaining budget"
              />
              {status.over ? (
                <Alert tone="danger" title="Your list is over budget">
                  It comes to {money(listTotal)}, but you have {money(remaining)} left — {money(status.difference)} too
                  much. Remove something or look for cheaper options in Search.
                </Alert>
              ) : (
                <p style={{ fontSize: 'var(--t-sm)', color: 'var(--c-success)', fontWeight: 'var(--fw-semibold)', margin: 0 }}>
                  {money(status.difference)} left after this list.
                </p>
              )}
            </>
          ) : (
            <p className="field__hint" style={{ margin: 0 }}>
              <Link to="/budget">Set your budget</Link> to see how much this leaves you.
            </p>
          )}

          {summary.unavailable_count > 0 && (
            <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-warning)', margin: 0 }}>
              {plural(summary.unavailable_count, 'item')} out of stock or without a price right now — not
              counted in the total.
            </p>
          )}
          {summary.changed_count > 0 && (
            <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)', margin: 0 }}>
              {plural(summary.changed_count, 'price')} changed since you added {summary.changed_count === 1 ? 'it' : 'them'}.
              The total keeps the prices you saved.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

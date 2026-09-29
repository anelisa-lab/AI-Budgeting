/**
 * Past budgets — a small history of the cycles that are finished, newest first.
 *
 * Before budgets could be renewed there was nothing to show here: a budget stayed
 * "active" until it was deleted, and deleting wiped its spending. Now each
 * finished cycle is kept, with what came in, what was spent and what was saved.
 */

import { useEffect, useState } from 'react';
import { Badge, Card, Eyebrow } from '../ui/index.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { api } from '../../api/client.js';
import { money, shortDate } from '../../lib/format.js';

/** What a finished cycle amounted to. Pure, so it is easy to check. */
export function summariseBudget(b) {
  const fresh = Math.max(0, b.total_amount - (b.carried_over_amount || 0));
  const spendable = Math.max(0, b.total_amount - b.savings_amount);
  const spent = Math.max(0, Number((spendable - b.remaining_amount).toFixed(2)));
  return {
    received: fresh,
    carried: b.carried_over_amount || 0,
    spent,
    saved: b.savings_amount,
    leftOver: b.remaining_amount,
  };
}

export default function PastBudgets({ refreshKey }) {
  const { token } = useAuth();
  const [rows, setRows] = useState(null);

  // Re-read when the active budget changes (a renewal closes one and opens another).
  useEffect(() => {
    let cancelled = false;
    if (!token) return undefined;
    api.budgets.list(token)
      .then((all) => {
        if (cancelled) return;
        setRows(
          all
            .filter((b) => b.status !== 'active')
            .sort((a, b) => String(b.cycle_start_date).localeCompare(String(a.cycle_start_date))),
        );
      })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [token, refreshKey]);

  if (!rows || rows.length === 0) return null;

  return (
    <Card>
      <Eyebrow>History</Eyebrow>
      <h2 className="card__title" style={{ marginTop: 'var(--s-3)' }}>Past budgets</h2>
      <div style={{ marginTop: 'var(--s-4)' }}>
        {rows.map((b) => {
          const s = summariseBudget(b);
          return (
            <div className="txn" key={b.id} style={{ alignItems: 'flex-start' }}>
              <div className="grow">
                <p className="txn__name">
                  {shortDate(b.cycle_start_date)} – {shortDate(b.cycle_end_date)}
                </p>
                <p className="txn__meta">
                  {money(s.received)} received
                  {s.carried > 0 && ` + ${money(s.carried)} carried over`}
                  {' · '}{money(s.spent)} spent
                  {s.saved > 0 && ` · ${money(s.saved)} saved`}
                  {' · '}{money(s.leftOver)} left over
                </p>
              </div>
              <Badge tone={b.status === 'completed' ? 'accent' : 'neutral'}>
                {b.status === 'completed' ? 'Finished' : 'Cancelled'}
              </Badge>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

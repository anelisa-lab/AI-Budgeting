"""
Daily Budget Split endpoints — Member 6.

    GET  /budget-split              today's allowance for the active budget
    POST /budget-split/check        "can I afford R250 today?"
    GET  /budget-split/{budget_id}  the same, for a specific budget

The algorithm lives in app/budget_split.py (pure, unit-tested). This file
loads the budget and its transactions, calls it, and writes the result back
to budget_daily_limits so the dashboard can show history.

Handoff to Member 8 (frontend) — the response the UI renders:

    {
      "budget_id": 4, "currency": "ZAR",
      "as_of": "2026-09-22", "next_payout_date": "2026-10-15",
      "days_remaining": 24,
      "remaining_amount": "1850.00",
      "daily_limit": "77.08",        <- the big number on the dashboard
      "spent_today": "32.50",
      "remaining_today": "44.58",    <- the progress ring
      "mode": "normal",              <- 'survival' turns the UI amber
      "message": "R1850.00 over 24 days gives you R77.08 a day. ...",
      "days": [ { "limit_date": "2026-09-22", "planned_limit": "77.08",
                  "spent_amount": "32.50", "remaining_limit": "44.58",
                  "is_today": true }, ... ]
    }

Member 3 can call build_split() directly from budgets.py in Phase 3 to fold
`daily_limit` into the budget dashboard payload — it needs no HTTP hop.
"""

from datetime import date
from decimal import Decimal
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException

from app.budget_split import BudgetSplit, build_split, check_affordability
from app.database import get_connection
from app.dependencies import get_current_user_id
from app.schemas import (
    AffordabilityOut,
    AffordabilityRequest,
    BudgetSplitOut,
    DaySplitOut,
)

router = APIRouter(prefix="/budget-split", tags=["budget split"])


def _load_budget(cur, user_id: int, budget_id: Optional[int] = None) -> dict:
    if budget_id is None:
        cur.execute(
            "SELECT * FROM budgets WHERE user_id = %s AND status = 'active'", (user_id,)
        )
        budget = cur.fetchone()
        if not budget:
            raise HTTPException(
                status_code=404,
                detail="No active budget — set one up before asking for a daily split",
            )
        return budget

    cur.execute(
        "SELECT * FROM budgets WHERE id = %s AND user_id = %s", (budget_id, user_id)
    )
    budget = cur.fetchone()
    if not budget:
        raise HTTPException(status_code=404, detail="Budget not found")
    return budget


def _spent_by_date(cur, budget_id: int) -> Dict[date, Decimal]:
    """
    Daily spend for this budget.

    transaction_date is a TIMESTAMPTZ, so ::date buckets it in the database
    server's timezone. Set the dev database to Africa/Johannesburg (or run
    `SET TIME ZONE 'Africa/Johannesburg';`) or a late-evening purchase can
    land on the wrong day.
    """
    cur.execute(
        """SELECT transaction_date::date AS day, SUM(amount) AS total
           FROM transactions
           WHERE budget_id = %s AND transaction_status <> 'voided'
           GROUP BY 1""",
        (budget_id,),
    )
    return {row["day"]: Decimal(row["total"]) for row in cur.fetchall()}


def _persist(cur, split: BudgetSplit) -> None:
    """Write the recalculated schedule back so the dashboard has history."""
    cur.executemany(
        """INSERT INTO budget_daily_limits
               (budget_id, limit_date, planned_limit, spent_amount, remaining_limit, recalculated_at)
           VALUES (%s, %s, %s, %s, %s, NOW())
           ON CONFLICT (budget_id, limit_date) DO UPDATE
           SET planned_limit   = EXCLUDED.planned_limit,
               spent_amount    = EXCLUDED.spent_amount,
               remaining_limit = EXCLUDED.remaining_limit,
               recalculated_at = NOW()""",
        [
            (
                split.budget_id,
                day.limit_date,
                day.planned_limit,
                day.spent_amount,
                day.remaining_limit,
            )
            for day in split.days
        ],
    )

    # Keep budgets.daily_limit and budget_mode in step with what we just
    # calculated, so Member 3's dashboard and Member 5's recommender see the
    # same numbers without recomputing them.
    cur.execute(
        "UPDATE budgets SET daily_limit = %s, budget_mode = %s, updated_at = NOW() WHERE id = %s",
        (split.daily_limit, split.mode, split.budget_id),
    )


def _to_out(split: BudgetSplit) -> BudgetSplitOut:
    payload = split.as_dict()
    payload["days"] = [DaySplitOut(**d) for d in payload["days"]]
    return BudgetSplitOut(**payload)


def _compute(user_id: int, budget_id: Optional[int] = None) -> BudgetSplit:
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            budget = _load_budget(cur, user_id, budget_id)
            split = build_split(budget, spent_by_date=_spent_by_date(cur, budget["id"]))
            _persist(cur, split)
        return split
    finally:
        conn.close()


@router.get("", response_model=BudgetSplitOut)
def get_current_split(user_id: int = Depends(get_current_user_id)):
    """
    Today's allowance for the active budget.

    Recalculated on every call rather than read from a stored value — the
    answer changes the moment a transaction is recorded, which is the whole
    point of the feature.
    """
    return _to_out(_compute(user_id))


@router.post("/check", response_model=AffordabilityOut)
def check_purchase(
    payload: AffordabilityRequest, user_id: int = Depends(get_current_user_id)
):
    """
    "Can I afford this today?"

    Answers against the daily allowance, not just the balance, and says how
    many days of budget the purchase would eat. The frontend calls this from
    the product page before a student commits to anything.
    """
    verdict = check_affordability(_compute(user_id), payload.amount)
    return AffordabilityOut(**verdict.as_dict())


@router.get("/{budget_id}", response_model=BudgetSplitOut)
def get_split_for_budget(budget_id: int, user_id: int = Depends(get_current_user_id)):
    """The split for one specific budget — used by the budget history screen."""
    return _to_out(_compute(user_id, budget_id))

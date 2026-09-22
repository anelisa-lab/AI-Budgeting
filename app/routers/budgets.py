from decimal import Decimal

from fastapi import APIRouter, HTTPException, Depends, status
import psycopg2.errors

from app.budget_calc import (
    calculate_budget_health,
    calculate_budget_update,
    calculate_transaction_impact,
)
from app.budget_split import build_split
from app.database import get_connection
from app.dependencies import get_current_user_id
from app.routers.budget_split import persist_split, spent_by_date, split_to_out
from app.schemas import (
    BudgetCreateRequest,
    BudgetDashboardOut,
    BudgetHealthOut,
    BudgetUpdateRequest,
    BudgetOut,
    BudgetWithSplitOut,
    TransactionCreateRequest,
    TransactionOut,
    TransactionResult,
)

router = APIRouter(prefix="/budgets", tags=["budgets"])

# Budget-management spec (Member 3)
# ---------------------------------
# Entry:    POST /budgets creates a new cycle. remaining_amount starts equal
#           to total_amount; savings_amount is carved out up front from
#           savings_percentage so it's never spendable.
# Update:   PUT /budgets/{id} can raise/lower total_amount or push out
#           cycle_end_date. Changing total_amount shifts remaining_amount by
#           the same delta, so amount already spent this cycle is preserved.
# Remaining-balance calc: on every transaction,
#           remaining_amount = remaining_amount - transaction.amount
#           (never allowed to go below 0 — see overspend rule below).
# Overspend-warning rule: triggered when a transaction's amount is greater
#           than the budget's remaining_amount *at the time it's recorded*.
#           The transaction is still recorded (students need an accurate
#           spending log even when they go over) but the response carries
#           overspend_warning=True and remaining_amount is floored at 0
#           rather than going negative, since the schema enforces
#           remaining_amount >= 0.
#
# Pseudocode for the recalculation performed on each transaction:
#   1. fetch budget for (budget_id, user_id); 404 if missing
#   2. if budget.status != 'active': reject (400)
#   3. overspend = transaction.amount > budget.remaining_amount
#   4. new_remaining = max(budget.remaining_amount - transaction.amount, 0)
#   5. insert transaction row
#   6. update budgets.remaining_amount = new_remaining
#   7. return transaction + updated budget + overspend flag
#
# The actual arithmetic for steps 3-4 (and the equivalent for PUT
# /budgets/{id}) lives in app/budget_calc.py as pure, unit-tested
# functions — see tests/test_budget_calc.py — so the route handlers below
# and the tested logic can't drift apart.
#
# Phase 3 (Member 3) — dashboard wiring + Daily Budget Split in the payload
# -------------------------------------------------------------------------
# GET /budgets/dashboard  one call for the dashboard screen: the active
#                         budget, its Daily Budget Split, a health block
#                         (warning_level ok|caution|danger|exhausted, % spent,
#                         warnings[] ready to show) and the latest transactions.
# GET /budgets/current    now also carries `daily_split`, and `daily_limit` /
#                         `budget_mode` on the budget are fresh, not stale.
# POST .../transactions   now also returns the recalculated `daily_split`, plus
#                         `daily_limit_warning` when a purchase fits the cycle
#                         but is more than what is left of *today's* allowance.
# build_split() is called directly (no HTTP hop), and the result is written
# back to budgets.daily_limit / budget_daily_limits exactly as /budget-split does.


def _fresh_split(cur, budget: dict):
    """Recalculate the Daily Budget Split for a budget row and persist it."""
    split = build_split(budget, spent_by_date=spent_by_date(cur, budget["id"]))
    persist_split(cur, split)
    budget["daily_limit"] = split.daily_limit
    budget["budget_mode"] = split.mode
    return split


def _get_owned_budget(cur, budget_id: int, user_id: int) -> dict:
    cur.execute("SELECT * FROM budgets WHERE id = %s AND user_id = %s", (budget_id, user_id))
    budget = cur.fetchone()
    if not budget:
        raise HTTPException(status_code=404, detail="Budget not found")
    return budget


@router.post("", response_model=BudgetOut, status_code=status.HTTP_201_CREATED)
def create_budget(payload: BudgetCreateRequest, user_id: int = Depends(get_current_user_id)):
    if payload.cycle_end_date < payload.cycle_start_date:
        raise HTTPException(status_code=400, detail="cycle_end_date cannot be before cycle_start_date")

    savings_amount = (payload.total_amount * payload.savings_percentage / 100).quantize(Decimal("0.01"))
    remaining_amount = payload.total_amount - savings_amount

    conn = get_connection()
    try:
        try:
            with conn, conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO budgets
                        (user_id, budget_kind, total_amount, remaining_amount,
                         savings_percentage, savings_amount, cycle_start_date, cycle_end_date,
                         survival_threshold)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                       RETURNING *""",
                    (
                        user_id,
                        payload.budget_kind,
                        payload.total_amount,
                        remaining_amount,
                        payload.savings_percentage,
                        savings_amount,
                        payload.cycle_start_date,
                        payload.cycle_end_date,
                        payload.survival_threshold,
                    ),
                )
                budget = cur.fetchone()
                _fresh_split(cur, budget)
        except psycopg2.errors.UniqueViolation:
            raise HTTPException(status_code=409, detail="You already have an active budget for this cycle")
        return BudgetOut(**budget)
    finally:
        conn.close()


@router.get("", response_model=list[BudgetOut])
def list_budgets(user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM budgets WHERE user_id = %s ORDER BY created_at DESC", (user_id,)
            )
            budgets = cur.fetchall()
        return [BudgetOut(**b) for b in budgets]
    finally:
        conn.close()


@router.get("/current", response_model=BudgetWithSplitOut)
def get_current_budget(user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM budgets WHERE user_id = %s AND status = 'active'", (user_id,)
            )
            budget = cur.fetchone()
            if not budget:
                raise HTTPException(status_code=404, detail="No active budget")
            split = _fresh_split(cur, budget)
        return BudgetWithSplitOut(**budget, daily_split=split_to_out(split))
    finally:
        conn.close()


@router.get("/dashboard", response_model=BudgetDashboardOut)
def get_dashboard(
    recent: int = 5,
    user_id: int = Depends(get_current_user_id),
):
    """
    Everything the budget dashboard renders, in one round trip.

    404 "No active budget" when there is none — the same contract as
    GET /budgets/current, so the frontend can show its "set up a budget" state.
    """
    recent = max(0, min(recent, 50))
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM budgets WHERE user_id = %s AND status = 'active'", (user_id,)
            )
            budget = cur.fetchone()
            if not budget:
                raise HTTPException(status_code=404, detail="No active budget")

            split = _fresh_split(cur, budget)

            cur.execute(
                """SELECT * FROM transactions
                   WHERE budget_id = %s
                   ORDER BY transaction_date DESC, id DESC
                   LIMIT %s""",
                (budget["id"], recent),
            )
            transactions = cur.fetchall()

        health = calculate_budget_health(
            total_amount=budget["total_amount"],
            remaining_amount=budget["remaining_amount"],
            savings_amount=budget["savings_amount"],
            spent_today=split.spent_today,
            daily_limit=split.daily_limit,
            mode=split.mode,
        )
        return BudgetDashboardOut(
            budget=BudgetOut(**budget),
            daily_split=split_to_out(split),
            health=BudgetHealthOut(**health.as_dict()),
            recent_transactions=[TransactionOut(**t) for t in transactions],
        )
    finally:
        conn.close()


@router.put("/{budget_id}", response_model=BudgetOut)
def update_budget(budget_id: int, payload: BudgetUpdateRequest, user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            budget = _get_owned_budget(cur, budget_id, user_id)

            new_total, new_remaining = calculate_budget_update(
                current_total=budget["total_amount"],
                current_remaining=budget["remaining_amount"],
                new_total=payload.total_amount,
            )

            # Savings were carved out of the total up front, so the total can't
            # drop below them (the schema's budgets_savings_within_total CHECK
            # would otherwise turn this into a 500).
            if new_total < budget["savings_amount"]:
                raise HTTPException(
                    status_code=400,
                    detail=f"total_amount cannot be less than the R{budget['savings_amount']} already set aside as savings",
                )

            new_end_date = payload.cycle_end_date or budget["cycle_end_date"]
            if new_end_date < budget["cycle_start_date"]:
                raise HTTPException(status_code=400, detail="cycle_end_date cannot be before cycle_start_date")

            new_threshold = (
                payload.survival_threshold
                if payload.survival_threshold is not None
                else budget["survival_threshold"]
            )

            cur.execute(
                """UPDATE budgets
                   SET total_amount = %s, remaining_amount = %s, cycle_end_date = %s,
                       survival_threshold = %s, updated_at = NOW()
                   WHERE id = %s
                   RETURNING *""",
                (new_total, new_remaining, new_end_date, new_threshold, budget_id),
            )
            updated = cur.fetchone()
            _fresh_split(cur, updated)
        return BudgetOut(**updated)
    finally:
        conn.close()


@router.post("/{budget_id}/transactions", response_model=TransactionResult, status_code=status.HTTP_201_CREATED)
def create_transaction(budget_id: int, payload: TransactionCreateRequest, user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            budget = _get_owned_budget(cur, budget_id, user_id)
            if budget["status"] != "active":
                raise HTTPException(status_code=400, detail="Cannot record a transaction against a budget that is not active")

            impact = calculate_transaction_impact(
                remaining_amount=budget["remaining_amount"],
                transaction_amount=payload.amount,
            )

            # Today's allowance *before* this purchase — the daily warning is
            # about whether it fits what was left for today.
            split_before = build_split(budget, spent_by_date=spent_by_date(cur, budget_id))

            cur.execute(
                """INSERT INTO transactions (user_id, budget_id, item_name, amount, category, is_essential)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   RETURNING *""",
                (user_id, budget_id, payload.item_name, payload.amount, payload.category, payload.is_essential),
            )
            transaction = cur.fetchone()

            cur.execute(
                "UPDATE budgets SET remaining_amount = %s, updated_at = NOW() WHERE id = %s RETURNING *",
                (impact.new_remaining, budget_id),
            )
            updated_budget = cur.fetchone()
            split_after = _fresh_split(cur, updated_budget)

        warning_message = None
        if impact.overspend_warning:
            warning_message = f"This purchase is R{impact.over_by:.2f} over your remaining budget."

        # Only worth saying when the cycle-level warning hasn't already fired
        daily_warning = (
            not impact.overspend_warning and payload.amount > split_before.remaining_today
        )
        daily_message = None
        if daily_warning:
            daily_message = (
                f"This is R{payload.amount - split_before.remaining_today:.2f} more than "
                f"today's remaining R{split_before.remaining_today:.2f} allowance."
            )
            if split_after.tomorrow_limit is not None:
                daily_message += f" From tomorrow you have R{split_after.tomorrow_limit:.2f} a day."

        return TransactionResult(
            transaction=TransactionOut(**transaction),
            budget=BudgetOut(**updated_budget),
            overspend_warning=impact.overspend_warning,
            warning_message=warning_message,
            daily_limit_warning=daily_warning,
            daily_limit_message=daily_message,
            daily_split=split_to_out(split_after),
        )
    finally:
        conn.close()


@router.get("/{budget_id}/transactions", response_model=list[TransactionOut])
def list_transactions(budget_id: int, user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            _get_owned_budget(cur, budget_id, user_id)
            cur.execute(
                "SELECT * FROM transactions WHERE budget_id = %s ORDER BY transaction_date DESC, id DESC",
                (budget_id,),
            )
            transactions = cur.fetchall()
        return [TransactionOut(**t) for t in transactions]
    finally:
        conn.close()

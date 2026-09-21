from decimal import Decimal

from fastapi import APIRouter, HTTPException, Depends, status
import psycopg2.errors

from app.database import get_connection
from app.dependencies import get_current_user_id
from app.schemas import (
    BudgetCreateRequest,
    BudgetUpdateRequest,
    BudgetOut,
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
                         savings_percentage, savings_amount, cycle_start_date, cycle_end_date)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
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
                    ),
                )
                budget = cur.fetchone()
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


@router.get("/current", response_model=BudgetOut)
def get_current_budget(user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM budgets WHERE user_id = %s AND status = 'active'", (user_id,)
            )
            budget = cur.fetchone()
        if not budget:
            raise HTTPException(status_code=404, detail="No active budget")
        return BudgetOut(**budget)
    finally:
        conn.close()


@router.put("/{budget_id}", response_model=BudgetOut)
def update_budget(budget_id: int, payload: BudgetUpdateRequest, user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            budget = _get_owned_budget(cur, budget_id, user_id)

            new_total = budget["total_amount"]
            new_remaining = budget["remaining_amount"]
            if payload.total_amount is not None:
                delta = payload.total_amount - budget["total_amount"]
                new_total = payload.total_amount
                new_remaining = max(budget["remaining_amount"] + delta, 0)

            new_end_date = payload.cycle_end_date or budget["cycle_end_date"]
            if new_end_date < budget["cycle_start_date"]:
                raise HTTPException(status_code=400, detail="cycle_end_date cannot be before cycle_start_date")

            cur.execute(
                """UPDATE budgets
                   SET total_amount = %s, remaining_amount = %s, cycle_end_date = %s, updated_at = NOW()
                   WHERE id = %s
                   RETURNING *""",
                (new_total, new_remaining, new_end_date, budget_id),
            )
            updated = cur.fetchone()
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

            overspend_warning = payload.amount > budget["remaining_amount"]
            new_remaining = max(budget["remaining_amount"] - payload.amount, 0)

            cur.execute(
                """INSERT INTO transactions (user_id, budget_id, item_name, amount, category, is_essential)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   RETURNING *""",
                (user_id, budget_id, payload.item_name, payload.amount, payload.category, payload.is_essential),
            )
            transaction = cur.fetchone()

            cur.execute(
                "UPDATE budgets SET remaining_amount = %s, updated_at = NOW() WHERE id = %s RETURNING *",
                (new_remaining, budget_id),
            )
            updated_budget = cur.fetchone()

        warning_message = None
        if overspend_warning:
            over_by = payload.amount - budget["remaining_amount"]
            warning_message = f"This purchase is R{over_by:.2f} over your remaining budget."

        return TransactionResult(
            transaction=TransactionOut(**transaction),
            budget=BudgetOut(**updated_budget),
            overspend_warning=overspend_warning,
            warning_message=warning_message,
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
                "SELECT * FROM transactions WHERE budget_id = %s ORDER BY transaction_date DESC",
                (budget_id,),
            )
            transactions = cur.fetchall()
        return [TransactionOut(**t) for t in transactions]
    finally:
        conn.close()

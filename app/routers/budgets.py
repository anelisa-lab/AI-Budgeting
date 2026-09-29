from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Depends, Query, Response, status
import psycopg2.errors

from app.budget_calc import (
    calculate_budget_edit,
    calculate_budget_health,
    calculate_renewal,
    calculate_savings_amount,
    calculate_transaction_edit,
    calculate_transaction_impact,
    calculate_transaction_removal,
    normalise_survival_threshold,
    resolve_edit_datetime,
    resolve_transaction_datetime,
)
from app.budget_categories import check_allocation, dedupe_categories
from app.budget_split import build_split
from app.budget_template import build_budget_workbook, template_filename
from app.clock import APP_TIMEZONE, local_today
from app.database import get_connection
from app.dependencies import get_current_user_id
from app.notifications import create_notification, notify
from app.routers.budget_split import persist_split, spent_by_date, split_to_out
from app.schemas import (
    BudgetCategoriesRequest,
    BudgetCategoryOut,
    BudgetCreateRequest,
    BudgetDashboardOut,
    BudgetHealthOut,
    BudgetRenewRequest,
    BudgetTemplateRequest,
    BudgetUpdateRequest,
    BudgetOut,
    BudgetWithSplitOut,
    TransactionCreateRequest,
    TransactionDeleteResult,
    TransactionOut,
    TransactionResult,
    TransactionUpdateRequest,
    TransactionUpdateResult,
)

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

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
#
# Cycles, categories and the spreadsheet template (sql/014_*.sql)
# ----------------------------------------------------------------
# POST /budgets/{id}/renew   close this cycle (status -> completed, its savings
#                         go to savings_ledger) and open the next one, optionally
#                         carrying the leftover and/or last cycle's savings over.
#                         POST /budgets also closes an active budget whose
#                         cycle_end_date has passed instead of answering 409, so
#                         a student is never locked out at payout time.
# PUT  .../transactions/{tid}   edit a recorded spend (amount, name, category,
#                         essential flag, date) — remaining_amount is re-derived
#                         with the same ledger cap that deleting uses.
# POST .../transactions   takes an optional transaction_date (never in the
#                         future, never before the budget started) so a spend
#                         can be logged on the day it happened.
# GET/PUT /budgets/{id}/categories   the student's priority categories with an
#                         optional planned amount each; the dashboard shows
#                         planned vs spent for them.
# POST /budgets/template  the downloadable .xlsx budget template built from
#                         those categories (app/budget_template.py).
#
# Concurrency: every route that changes a budget reads it with SELECT ... FOR
# UPDATE (see _get_owned_budget), so two spends recorded at nearly the same time
# queue up instead of both starting from the same remaining_amount.


def _fresh_split(cur, budget: dict):
    """Recalculate the Daily Budget Split for a budget row and persist it."""
    split = build_split(budget, spent_by_date=spent_by_date(cur, budget["id"]))
    persist_split(cur, split)
    budget["daily_limit"] = split.daily_limit
    budget["budget_mode"] = split.mode
    return split


def _get_owned_budget(cur, budget_id: int, user_id: int, *, for_update: bool = False) -> dict:
    """
    Load a budget the user owns; 404 otherwise.

    Pass for_update=True on every path that writes to the budget. The row lock
    is held until the transaction commits, so a second request for the same
    budget waits for the first instead of reading the same remaining_amount and
    overwriting its result (two spends logged a moment apart used to lose one).
    """
    cur.execute(
        "SELECT * FROM budgets WHERE id = %s AND user_id = %s" + (" FOR UPDATE" if for_update else ""),
        (budget_id, user_id),
    )
    budget = cur.fetchone()
    if not budget:
        raise HTTPException(status_code=404, detail="Budget not found")
    return budget


def _complete_budget(cur, budget: dict, *, savings_carried: bool = False) -> None:
    """
    Close an active budget: status -> completed, and bank its savings.

    The savings carved out at the start of the cycle were never spendable, so
    they are recorded in savings_ledger as a contribution. If the student chose
    to spend last cycle's savings in the next one, a matching withdrawal keeps
    the ledger honest (net zero) rather than pretending they are still saved.
    """
    cur.execute(
        """UPDATE budgets SET status = 'completed', completed_at = NOW(), updated_at = NOW()
           WHERE id = %s AND status = 'active'""",
        (budget["id"],),
    )
    savings = budget["savings_amount"]
    if savings and savings > 0:
        note = f"Set aside for {budget['cycle_start_date']} to {budget['cycle_end_date']}"
        cur.execute(
            """INSERT INTO savings_ledger (user_id, budget_id, entry_type, amount, note)
               VALUES (%s, %s, 'contribution', %s, %s)""",
            (budget["user_id"], budget["id"], savings, note),
        )
        if savings_carried:
            cur.execute(
                """INSERT INTO savings_ledger (user_id, budget_id, entry_type, amount, note)
                   VALUES (%s, %s, 'withdrawal', %s, %s)""",
                (budget["user_id"], budget["id"], savings, "Moved into the next budget"),
            )


def _load_categories(cur, budget_id: int) -> list:
    """The budget's priority categories, each with what has been spent under its name."""
    cur.execute(
        """SELECT c.id, c.name, c.planned_amount, c.position,
                  COALESCE((SELECT SUM(t.amount) FROM transactions t
                            WHERE t.budget_id = c.budget_id
                              AND t.transaction_status <> 'voided'
                              AND LOWER(t.category) = LOWER(c.name)), 0) AS spent_amount
           FROM budget_categories c
           WHERE c.budget_id = %s
           ORDER BY c.position, c.id""",
        (budget_id,),
    )
    return [BudgetCategoryOut(**row) for row in cur.fetchall()]


def _insert_budget(cur, user_id: int, *, kind, total, remaining, pct, savings, start, end,
                   threshold, carried=Decimal("0"), renewed_from=None) -> dict:
    cur.execute(
        """INSERT INTO budgets
            (user_id, budget_kind, total_amount, remaining_amount,
             savings_percentage, savings_amount, cycle_start_date, cycle_end_date,
             survival_threshold, carried_over_amount, renewed_from_budget_id)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           RETURNING *""",
        (user_id, kind, total, remaining, pct, savings, start, end, threshold, carried, renewed_from),
    )
    return cur.fetchone()


@router.post("", response_model=BudgetOut, status_code=status.HTTP_201_CREATED)
def create_budget(payload: BudgetCreateRequest, user_id: int = Depends(get_current_user_id)):
    if payload.cycle_end_date < payload.cycle_start_date:
        raise HTTPException(status_code=400, detail="cycle_end_date cannot be before cycle_start_date")

    savings_amount = calculate_savings_amount(payload.total_amount, payload.savings_percentage)
    remaining_amount = payload.total_amount - savings_amount
    threshold = normalise_survival_threshold(payload.survival_threshold)

    conn = get_connection()
    try:
        try:
            with conn, conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM budgets WHERE user_id = %s AND status = 'active' FOR UPDATE",
                    (user_id,),
                )
                existing = cur.fetchone()
                if existing:
                    # One active budget per user. If its cycle is over, the next
                    # allowance has landed — close it rather than locking the
                    # student out with a 409 at the very moment they need a new one.
                    if existing["cycle_end_date"] < local_today():
                        _complete_budget(cur, existing)
                    else:
                        raise HTTPException(
                            status_code=409,
                            detail="You already have an active budget. Edit it, or start your "
                                   "next cycle once this one has ended.",
                        )
                budget = _insert_budget(
                    cur, user_id,
                    kind=payload.budget_kind, total=payload.total_amount, remaining=remaining_amount,
                    pct=payload.savings_percentage, savings=savings_amount,
                    start=payload.cycle_start_date, end=payload.cycle_end_date, threshold=threshold,
                )
                _fresh_split(cur, budget)
        except psycopg2.errors.UniqueViolation:
            raise HTTPException(status_code=409, detail="You already have an active budget for this cycle")
        notify(user_id, "budget", "Budget created",
               f"New budget of R{budget['total_amount']:.2f} for {budget['cycle_start_date']} to "
               f"{budget['cycle_end_date']} (R{budget['remaining_amount']:.2f} spendable after savings).",
               category="success")
        return BudgetOut(**budget)
    finally:
        conn.close()


@router.post("/{budget_id}/renew", response_model=BudgetOut, status_code=status.HTTP_201_CREATED)
def renew_budget(budget_id: int, payload: BudgetRenewRequest, user_id: int = Depends(get_current_user_id)):
    """
    Start the next cycle. Closes this budget and opens a new one in one step.

    Without this a budget could never leave `active`: the unique index allowed
    one active budget per user, so the next allowance could only be entered by
    stretching the old cycle or deleting it (and its spending history).
    """
    today = local_today()
    conn = get_connection()
    try:
        try:
            with conn, conn.cursor() as cur:
                old = _get_owned_budget(cur, budget_id, user_id, for_update=True)
                if old["status"] != "active":
                    raise HTTPException(status_code=400, detail="Only an active budget can be renewed")

                start = payload.cycle_start_date or today
                if payload.cycle_end_date:
                    end = payload.cycle_end_date
                else:
                    # Same length as the cycle that just finished.
                    length = max((old["cycle_end_date"] - old["cycle_start_date"]).days, 1)
                    end = start + timedelta(days=length)
                if end < start:
                    raise HTTPException(status_code=400, detail="cycle_end_date cannot be before cycle_start_date")
                if end < today:
                    raise HTTPException(
                        status_code=400,
                        detail="That cycle would already have ended. Enter the date your latest allowance landed.",
                    )

                pct = payload.savings_percentage if payload.savings_percentage is not None else old["savings_percentage"]
                if "survival_threshold" in payload.model_fields_set:
                    threshold = normalise_survival_threshold(payload.survival_threshold)
                else:
                    threshold = old["survival_threshold"]

                try:
                    renewal = calculate_renewal(
                        old_remaining=old["remaining_amount"],
                        old_savings=old["savings_amount"],
                        new_allowance=payload.total_amount,
                        savings_percentage=pct,
                        carry_over_leftover=payload.carry_over_leftover,
                        carry_over_savings=payload.carry_over_savings,
                    )
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail=str(exc))

                _complete_budget(cur, old, savings_carried=payload.carry_over_savings)
                budget = _insert_budget(
                    cur, user_id,
                    kind=old["budget_kind"], total=renewal.total_amount,
                    remaining=renewal.remaining_amount, pct=pct, savings=renewal.savings_amount,
                    start=start, end=end, threshold=threshold,
                    carried=renewal.carried_over_amount, renewed_from=old["id"],
                )
                if payload.keep_categories:
                    cur.execute(
                        """INSERT INTO budget_categories (budget_id, name, planned_amount, position)
                           SELECT %s, name, planned_amount, position
                           FROM budget_categories WHERE budget_id = %s""",
                        (budget["id"], old["id"]),
                    )
                _fresh_split(cur, budget)
        except psycopg2.errors.UniqueViolation:
            raise HTTPException(status_code=409, detail="A new budget for this cycle already exists")

        carried_text = (
            f" R{renewal.carried_over_amount:.2f} was carried over."
            if renewal.carried_over_amount > 0 else ""
        )
        notify(user_id, "budget", "Next cycle started",
               f"New budget of R{budget['total_amount']:.2f} for {budget['cycle_start_date']} to "
               f"{budget['cycle_end_date']} (R{budget['remaining_amount']:.2f} spendable after savings)."
               f"{carried_text}",
               category="success")
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
            categories = _load_categories(cur, budget["id"])

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
            categories=categories,
        )
    finally:
        conn.close()


@router.put("/{budget_id}", response_model=BudgetOut)
def update_budget(budget_id: int, payload: BudgetUpdateRequest, user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            budget = _get_owned_budget(cur, budget_id, user_id, for_update=True)
            if budget["status"] != "active":
                raise HTTPException(status_code=400, detail="Only an active budget can be edited")

            # Savings are a percentage of the fresh allowance, so they follow the
            # total (and the percentage, if it is edited) instead of staying at
            # the amount they were when the budget was created.
            try:
                new_total, new_remaining, new_savings, new_pct = calculate_budget_edit(
                    current_total=budget["total_amount"],
                    current_remaining=budget["remaining_amount"],
                    current_savings=budget["savings_amount"],
                    savings_percentage=budget["savings_percentage"],
                    carried_over_amount=budget.get("carried_over_amount") or Decimal("0"),
                    new_total=payload.total_amount,
                    new_savings_percentage=payload.savings_percentage,
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))

            new_end_date = payload.cycle_end_date or budget["cycle_end_date"]
            if new_end_date < budget["cycle_start_date"]:
                raise HTTPException(status_code=400, detail="cycle_end_date cannot be before cycle_start_date")

            # Left out -> keep the threshold. Sent as null or 0 -> clear it
            # (0 used to leave survival mode on for a fully used-up budget).
            if "survival_threshold" in payload.model_fields_set:
                new_threshold = normalise_survival_threshold(payload.survival_threshold)
            else:
                new_threshold = budget["survival_threshold"]

            cur.execute(
                """UPDATE budgets
                   SET total_amount = %s, remaining_amount = %s, savings_percentage = %s,
                       savings_amount = %s, cycle_end_date = %s,
                       survival_threshold = %s, updated_at = NOW()
                   WHERE id = %s
                   RETURNING *""",
                (new_total, new_remaining, new_pct, new_savings, new_end_date, new_threshold, budget_id),
            )
            updated = cur.fetchone()
            _fresh_split(cur, updated)
        notify(user_id, "budget", "Budget updated",
               f"Budget total is now R{updated['total_amount']:.2f}, R{updated['remaining_amount']:.2f} remaining, "
               f"cycle ends {updated['cycle_end_date']}.")
        return BudgetOut(**updated)
    finally:
        conn.close()


@router.post("/{budget_id}/transactions", response_model=TransactionResult, status_code=status.HTTP_201_CREATED)
def create_transaction(budget_id: int, payload: TransactionCreateRequest, user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            budget = _get_owned_budget(cur, budget_id, user_id, for_update=True)
            if budget["status"] != "active":
                raise HTTPException(status_code=400, detail="Cannot record a transaction against a budget that is not active")

            today = local_today()
            try:
                when = resolve_transaction_datetime(payload.transaction_date, today, budget["cycle_start_date"])
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
            # A spend dated yesterday is not today's spending, so it must not
            # trigger today's "over your allowance" warning.
            is_today = when is None

            impact = calculate_transaction_impact(
                remaining_amount=budget["remaining_amount"],
                transaction_amount=payload.amount,
            )

            # Today's allowance *before* this purchase — the daily warning is
            # about whether it fits what was left for today.
            split_before = build_split(budget, spent_by_date=spent_by_date(cur, budget_id))

            cur.execute(
                """INSERT INTO transactions
                       (user_id, budget_id, item_name, amount, category, is_essential, transaction_date)
                   VALUES (%s, %s, %s, %s, %s, %s, COALESCE(%s::timestamptz, NOW()))
                   RETURNING *""",
                (user_id, budget_id, payload.item_name, payload.amount, payload.category,
                 payload.is_essential, when),
            )
            transaction = cur.fetchone()
            create_notification(
                cur, user_id, category="success", module="transactions",
                title="Spend recorded",
                body=f"R{payload.amount:.2f} on {payload.item_name} ({payload.category}).",
            )

            cur.execute(
                "UPDATE budgets SET remaining_amount = %s, updated_at = NOW() WHERE id = %s RETURNING *",
                (impact.new_remaining, budget_id),
            )
            updated_budget = cur.fetchone()
            split_after = _fresh_split(cur, updated_budget)

            # This purchase could fire two different alerts below — survival
            # mode and the student's own low-balance line — so one lookup of
            # `users` covers both rather than querying it twice.
            became_survival = split_before.mode != "survival" and split_after.mode == "survival"
            cur.execute(
                "SELECT sms_low_balance_threshold FROM users WHERE id = %s",
                (user_id,),
            )
            notify_user = cur.fetchone()
            threshold = notify_user["sms_low_balance_threshold"] if notify_user else None
            threshold_check_needed = (
                threshold is not None
                and budget["remaining_amount"] > threshold
                and impact.new_remaining <= threshold
            )

            # This purchase is what tipped the budget into survival mode —
            # tell the student under
            # Notifications, not just leave it for the dashboard to notice
            # next time it's opened.
            if became_survival:
                survival_body = (
                    f"You've hit survival mode: R{split_after.remaining_amount:.2f} left for "
                    f"{split_after.days_remaining} more days. UniWallet will suggest essentials only."
                )
                create_notification(
                    cur, user_id, category="survival", module="budget",
                    title="You're in survival mode", body=survival_body,
                )

            # The student's own "tell me when it's getting low" line — set in
            # Profile under Notifications, separate from (and usually
            # higher than) the survival threshold. Only fires the moment the
            # balance crosses it, not on every purchase after.
            if threshold_check_needed:
                balance_body = (
                    f"Low balance alert: only R{impact.new_remaining:.2f} left — "
                    f"you asked to hear about it below R{threshold:.2f}."
                )
                create_notification(
                    cur, user_id, category="balance", module="budget",
                    title="Low balance alert", body=balance_body,
                )

        warning_message = None
        if impact.overspend_warning:
            warning_message = f"This purchase is R{impact.over_by:.2f} over your remaining budget."

        # Only worth saying when the cycle-level warning hasn't already fired
        daily_warning = (
            is_today and not impact.overspend_warning and payload.amount > split_before.remaining_today
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
def list_transactions(
    budget_id: int,
    limit: Optional[int] = Query(default=None, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    user_id: int = Depends(get_current_user_id),
):
    """Every spend for a budget, newest first. `limit`/`offset` page through long histories."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            _get_owned_budget(cur, budget_id, user_id)
            cur.execute(
                """SELECT * FROM transactions WHERE budget_id = %s
                   ORDER BY transaction_date DESC, id DESC
                   LIMIT %s OFFSET %s""",
                (budget_id, limit, offset),      # LIMIT NULL = no limit
            )
            transactions = cur.fetchall()
        return [TransactionOut(**t) for t in transactions]
    finally:
        conn.close()


@router.put("/{budget_id}/transactions/{transaction_id}", response_model=TransactionUpdateResult)
def update_transaction(
    budget_id: int,
    transaction_id: int,
    payload: TransactionUpdateRequest,
    user_id: int = Depends(get_current_user_id),
):
    """
    Correct a recorded spend without deleting and re-entering it.

    Only the fields sent change (send `category: null` to clear it). A bigger
    amount is spent like a fresh purchase, a smaller one is refunded — capped by
    the ledger so undoing part of an overspend cannot create money (see
    budget_calc.calculate_transaction_edit).
    """
    fields = payload.model_fields_set
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            budget = _get_owned_budget(cur, budget_id, user_id, for_update=True)
            if budget["status"] != "active":
                raise HTTPException(status_code=400, detail="Spends on a finished budget can't be edited")

            cur.execute(
                """SELECT *, transaction_date::date AS day FROM transactions
                   WHERE id = %s AND budget_id = %s AND user_id = %s FOR UPDATE""",
                (transaction_id, budget_id, user_id),
            )
            current = cur.fetchone()
            if not current:
                raise HTTPException(status_code=404, detail="Transaction not found")

            new_amount = payload.amount if payload.amount is not None else current["amount"]
            item_name = payload.item_name if payload.item_name is not None else current["item_name"]
            category = payload.category if "category" in fields else current["category"]
            is_essential = payload.is_essential if payload.is_essential is not None else current["is_essential"]
            try:
                new_when = resolve_edit_datetime(
                    payload.transaction_date, current["day"], local_today(),
                    budget["cycle_start_date"], datetime.now(ZoneInfo(APP_TIMEZONE)),
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))

            cur.execute(
                """UPDATE transactions
                   SET item_name = %s, amount = %s, category = %s, is_essential = %s,
                       transaction_date = COALESCE(%s::timestamptz, transaction_date)
                   WHERE id = %s
                   RETURNING *""",
                (item_name, new_amount, category, is_essential, new_when, transaction_id),
            )
            transaction = cur.fetchone()

            cur.execute(
                """SELECT COALESCE(SUM(amount), 0) AS spent FROM transactions
                   WHERE budget_id = %s AND transaction_status <> 'voided'""",
                (budget_id,),
            )
            spent_after = cur.fetchone()["spent"]
            new_remaining = calculate_transaction_edit(
                remaining_amount=budget["remaining_amount"],
                old_amount=current["amount"],
                new_amount=new_amount,
                spendable_amount=budget["total_amount"] - budget["savings_amount"],
                spent_after_edit=spent_after,
            )
            cur.execute(
                "UPDATE budgets SET remaining_amount = %s, updated_at = NOW() WHERE id = %s RETURNING *",
                (new_remaining, budget_id),
            )
            updated = cur.fetchone()
            split = _fresh_split(cur, updated)
            create_notification(
                cur, user_id, category="info", module="transactions",
                title="Spend updated",
                body=f"{item_name} is now R{new_amount:.2f} (R{updated['remaining_amount']:.2f} remaining).",
            )
        return TransactionUpdateResult(
            transaction=TransactionOut(**transaction),
            budget=BudgetOut(**updated),
            daily_split=split_to_out(split),
        )
    finally:
        conn.close()


# -------------------------
# Priority categories + the spreadsheet template
# -------------------------
# A student jots down the categories that matter this cycle ("Groceries",
# "Toiletries", "Transport"...), optionally with a planned amount each. They are
# stored per budget so the dashboard can show planned vs spent, and they are the
# rows of the .xlsx the student can download and budget in.

@router.get("/{budget_id}/categories", response_model=list[BudgetCategoryOut])
def list_categories(budget_id: int, user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            _get_owned_budget(cur, budget_id, user_id)
            return _load_categories(cur, budget_id)
    finally:
        conn.close()


@router.put("/{budget_id}/categories", response_model=list[BudgetCategoryOut])
def replace_categories(
    budget_id: int,
    payload: BudgetCategoriesRequest,
    user_id: int = Depends(get_current_user_id),
):
    """Replace the whole list. Duplicates (any case) collapse to the first one."""
    try:
        cleaned = dedupe_categories((c.name, c.planned_amount) for c in payload.categories)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            budget = _get_owned_budget(cur, budget_id, user_id, for_update=True)
            try:
                check_allocation(
                    (planned for _, planned in cleaned),
                    budget["total_amount"] - budget["savings_amount"],
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))

            cur.execute("DELETE FROM budget_categories WHERE budget_id = %s", (budget_id,))
            for position, (name, planned) in enumerate(cleaned):
                cur.execute(
                    """INSERT INTO budget_categories (budget_id, name, planned_amount, position)
                       VALUES (%s, %s, %s, %s)""",
                    (budget_id, name, planned, position),
                )
            return _load_categories(cur, budget_id)
    finally:
        conn.close()


@router.post("/template")
def download_budget_template(payload: BudgetTemplateRequest, user_id: int = Depends(get_current_user_id)):
    """
    The budget spreadsheet (.xlsx) for the chosen categories.

    The money and the period come from the request when sent, otherwise from the
    student's active budget — so it works before a budget exists (from the entry
    form) and after (from the dashboard). A budget that lasts up to a week gets
    daily columns; a longer one gets weekly columns.
    """
    total = payload.total_amount
    pct = payload.savings_percentage
    days = payload.period_days
    start = payload.start_date

    if total is None or days is None or pct is None or start is None:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM budgets WHERE user_id = %s AND status = 'active'", (user_id,)
                )
                active = cur.fetchone()
        finally:
            conn.close()
        if active:
            total = total if total is not None else active["total_amount"]
            pct = pct if pct is not None else active["savings_percentage"]
            days = days if days is not None else max((active["cycle_end_date"] - active["cycle_start_date"]).days, 1)
            start = start or active["cycle_start_date"]

    if total is None or days is None:
        raise HTTPException(
            status_code=400,
            detail="Tell us how much you received and how many days it must last, "
                   "or set up a budget first.",
        )
    pct = pct if pct is not None else Decimal("0")
    start = start or local_today()

    try:
        data = build_budget_workbook(
            [(c.name, c.planned_amount) for c in payload.categories],
            total_amount=total, period_days=int(days), start_date=start, savings_percentage=pct,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    filename = template_filename(start, int(days))
    return Response(
        content=data,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# -------------------------
# Deleting (Phase 5)
# -------------------------
# A student who logs R45 instead of R4.50, or logs the same bread twice, had no
# way to undo it — and a wrong spend skews the Daily Budget Split for the rest
# of the cycle. Budgets could not be removed either.

@router.delete("/{budget_id}/transactions/{transaction_id}", response_model=TransactionDeleteResult)
def delete_transaction(budget_id: int, transaction_id: int, user_id: int = Depends(get_current_user_id)):
    """
    Remove a recorded spend and give the money back to the budget — capped by
    what the other spends leave (see budget_calc.calculate_transaction_removal),
    so undoing an overspend can't create money. Returns the budget and the
    recalculated Daily Budget Split, like recording a spend does.
    """
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            budget = _get_owned_budget(cur, budget_id, user_id, for_update=True)
            cur.execute(
                """DELETE FROM transactions WHERE id = %s AND budget_id = %s AND user_id = %s
                   RETURNING amount""",
                (transaction_id, budget_id, user_id),
            )
            deleted = cur.fetchone()
            if not deleted:
                raise HTTPException(status_code=404, detail="Transaction not found")
            cur.execute(
                """SELECT COALESCE(SUM(amount), 0) AS spent FROM transactions
                   WHERE budget_id = %s AND transaction_status <> 'voided'""",
                (budget_id,),
            )
            spent_after = cur.fetchone()["spent"]
            new_remaining = calculate_transaction_removal(
                remaining_amount=budget["remaining_amount"],
                transaction_amount=deleted["amount"],
                spendable_amount=budget["total_amount"] - budget["savings_amount"],
                spent_after_removal=spent_after,
            )
            cur.execute(
                "UPDATE budgets SET remaining_amount = %s, updated_at = NOW() WHERE id = %s RETURNING *",
                (new_remaining, budget_id),
            )
            updated = cur.fetchone()
            split = _fresh_split(cur, updated) if updated["status"] == "active" else None
            create_notification(
                cur, user_id, category="info", module="transactions",
                title="Spend removed",
                body=f"R{deleted['amount']:.2f} was returned to your budget "
                     f"(R{updated['remaining_amount']:.2f} remaining).",
            )
        return TransactionDeleteResult(
            budget=BudgetOut(**updated),
            daily_split=split_to_out(split) if split else None,
        )
    finally:
        conn.close()


@router.delete("/{budget_id}", status_code=204)
def delete_budget(budget_id: int, user_id: int = Depends(get_current_user_id)):
    """
    Delete a budget and every spend recorded against it. For a budget set up
    by mistake; the student can then create a fresh one.
    """
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("DELETE FROM budgets WHERE id = %s AND user_id = %s RETURNING id", (budget_id, user_id))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Budget not found")
            create_notification(cur, user_id, category="info", module="budget",
                                title="Budget deleted",
                                body="A budget and all its recorded spends were deleted.")
    finally:
        conn.close()
    return Response(status_code=204)

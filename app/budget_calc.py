"""
Pure budget-calculation functions — no database, no FastAPI imports,
so they can be unit-tested in isolation (same pattern as Member 5's
recommender.py and Member 6's true_cost_ref.py).

app/routers/budgets.py should import and call these instead of doing
the arithmetic inline, so the route handler and the tested logic never
drift apart.
"""

from dataclasses import dataclass
from decimal import Decimal


@dataclass
class TransactionImpact:
    new_remaining: Decimal
    overspend_warning: bool
    over_by: Decimal  # 0 when there's no overspend


def calculate_transaction_impact(
    remaining_amount: Decimal, transaction_amount: Decimal
) -> TransactionImpact:
    """
    Given a budget's current remaining_amount and a new transaction's
    amount, returns the updated remaining_amount (never below 0, per
    the schema's CHECK constraint) and whether this transaction pushes
    the student over their remaining balance.

    Mirrors the logic in budgets.py's create_transaction handler:
        overspend_warning = payload.amount > budget["remaining_amount"]
        new_remaining = max(budget["remaining_amount"] - payload.amount, 0)
    """
    if transaction_amount < 0:
        raise ValueError("transaction_amount cannot be negative")
    if remaining_amount < 0:
        raise ValueError("remaining_amount cannot be negative")

    overspend_warning = transaction_amount > remaining_amount
    over_by = max(transaction_amount - remaining_amount, Decimal("0"))
    new_remaining = max(remaining_amount - transaction_amount, Decimal("0"))

    return TransactionImpact(
        new_remaining=new_remaining,
        overspend_warning=overspend_warning,
        over_by=over_by,
    )


def calculate_budget_update(
    current_total: Decimal,
    current_remaining: Decimal,
    new_total: Decimal | None,
) -> tuple[Decimal, Decimal]:
    """
    Given a budget's current total/remaining and an optional new total
    (from PUT /budgets/{id}), returns the updated (total, remaining).
    Shifting total_amount shifts remaining_amount by the same delta so
    amount already spent this cycle is preserved — never below 0.

    Mirrors update_budget in budgets.py:
        delta = payload.total_amount - budget["total_amount"]
        new_remaining = max(budget["remaining_amount"] + delta, 0)
    """
    if new_total is None:
        return current_total, current_remaining

    delta = new_total - current_total
    new_remaining = max(current_remaining + delta, Decimal("0"))
    return new_total, new_remaining

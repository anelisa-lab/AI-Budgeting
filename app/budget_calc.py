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



def calculate_transaction_removal(
    remaining_amount: Decimal,
    transaction_amount: Decimal,
    spendable_amount: Decimal,
    spent_after_removal: Decimal,
) -> Decimal:
    """
    remaining_amount after a recorded spend is deleted (Phase 5).

    Adding the amount straight back is wrong after an overspend: remaining is
    floored at 0 when a purchase goes over, so the floor already "absorbed"
    part of it. Deleting a R100 spend from a budget that is R100 overspent
    must leave R0, not R100.

    So the refund is capped by the ledger — what is left of the spendable
    amount (total - savings) once every OTHER spend is counted — and a
    deletion never LOWERS remaining (a raised total may already have lifted
    it above the ledger figure; deleting a spend must not take that away).
    """
    if transaction_amount < 0 or remaining_amount < 0:
        raise ValueError("amounts cannot be negative")
    ledger = max(spendable_amount - spent_after_removal, Decimal("0"))
    return max(remaining_amount, min(remaining_amount + transaction_amount, ledger))

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


# ---------------------------------------------------------------------------
# Phase 3 — dashboard health / warning display
# ---------------------------------------------------------------------------

LEVEL_OK = "ok"
LEVEL_CAUTION = "caution"
LEVEL_DANGER = "danger"
LEVEL_EXHAUSTED = "exhausted"

CAUTION_PERCENT = Decimal("75")
DANGER_PERCENT = Decimal("90")


@dataclass
class BudgetHealth:
    warning_level: str          # ok | caution | danger | exhausted
    spendable_amount: Decimal   # total minus savings — what the student may spend
    spent_amount: Decimal       # spendable minus remaining
    spent_percentage: Decimal   # 0..100, one decimal place
    over_daily_limit_by: Decimal
    warnings: list

    def as_dict(self) -> dict:
        return {
            "warning_level": self.warning_level,
            "spendable_amount": self.spendable_amount,
            "spent_amount": self.spent_amount,
            "spent_percentage": self.spent_percentage,
            "over_daily_limit_by": self.over_daily_limit_by,
            "warnings": list(self.warnings),
        }


def calculate_budget_health(
    total_amount: Decimal,
    remaining_amount: Decimal,
    savings_amount: Decimal,
    spent_today: Decimal = Decimal("0"),
    daily_limit: Decimal | None = None,
    mode: str = "normal",
) -> BudgetHealth:
    """
    What the budget dashboard's warning banner shows.

    Levels, most severe first:
        exhausted  remaining_amount is 0 — nothing left this cycle
        danger     90%+ of the spendable amount is gone, or survival mode
        caution    75%+ spent, or today's spend is over today's allowance
        ok         everything else

    `spendable_amount` excludes savings, because savings were carved out when
    the budget was created and were never available to spend.
    """
    total = Decimal(total_amount)
    remaining = Decimal(remaining_amount)
    savings = Decimal(savings_amount or 0)
    spent_today = Decimal(spent_today or 0)

    if remaining < 0 or total <= 0:
        raise ValueError("total_amount must be positive and remaining_amount non-negative")

    spendable = max(total - savings, Decimal("0"))
    spent = max(spendable - remaining, Decimal("0"))
    percent = (
        (spent / spendable * 100).quantize(Decimal("0.1"))
        if spendable > 0
        else Decimal("100.0")
    )

    over_daily = Decimal("0.00")
    if daily_limit is not None and spent_today > Decimal(daily_limit):
        over_daily = (spent_today - Decimal(daily_limit)).quantize(Decimal("0.01"))

    warnings = []
    if remaining == 0:
        level = LEVEL_EXHAUSTED
        warnings.append("Your budget for this cycle is used up. Only record essentials until your next payout.")
    elif mode == "survival" or percent >= DANGER_PERCENT:
        level = LEVEL_DANGER
        if mode == "survival":
            warnings.append(f"Survival mode: only R{remaining:.2f} left. Essentials only.")
        else:
            warnings.append(f"You've used {percent}% of this cycle's budget — R{remaining:.2f} left.")
    elif percent >= CAUTION_PERCENT or over_daily > 0:
        level = LEVEL_CAUTION
        if percent >= CAUTION_PERCENT:
            warnings.append(f"You've used {percent}% of this cycle's budget.")
    else:
        level = LEVEL_OK

    if over_daily > 0:
        warnings.append(
            f"You've spent R{spent_today:.2f} today — R{over_daily:.2f} over today's allowance, "
            "so the next few days get tighter."
        )

    return BudgetHealth(
        warning_level=level,
        spendable_amount=spendable.quantize(Decimal("0.01")),
        spent_amount=spent.quantize(Decimal("0.01")),
        spent_percentage=percent,
        over_daily_limit_by=over_daily,
        warnings=warnings,
    )

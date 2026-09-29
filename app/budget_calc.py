"""
Pure budget-calculation functions — no database, no FastAPI imports,
so they can be unit-tested in isolation (same pattern as Member 5's
recommender.py and Member 6's true_cost_ref.py).

app/routers/budgets.py should import and call these instead of doing
the arithmetic inline, so the route handler and the tested logic never
drift apart.
"""

from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal, ROUND_HALF_UP


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
# Editing a budget (savings stay in step with the total)
# ---------------------------------------------------------------------------

def _cents(value: Decimal) -> Decimal:
    return Decimal(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def calculate_savings_amount(
    total_amount: Decimal,
    savings_percentage: Decimal,
    carried_over_amount: Decimal = Decimal("0"),
) -> Decimal:
    """
    Savings are a percentage of the FRESH allowance only. Money carried over
    from the previous cycle (see calculate_renewal) is never re-saved, so it is
    taken out of the base before the percentage is applied.
    """
    base = max(Decimal(total_amount) - Decimal(carried_over_amount or 0), Decimal("0"))
    return _cents(base * Decimal(savings_percentage) / 100)


def calculate_budget_edit(
    current_total: Decimal,
    current_remaining: Decimal,
    current_savings: Decimal,
    savings_percentage: Decimal,
    carried_over_amount: Decimal,
    new_total: Decimal | None = None,
    new_savings_percentage: Decimal | None = None,
) -> tuple[Decimal, Decimal, Decimal, Decimal]:
    """
    Apply an edit to total_amount and/or savings_percentage.

    Returns (total, remaining, savings_amount, savings_percentage).

    The old rule shifted `remaining` by the change in total and left
    savings_amount fixed, so raising the total on a budget with 10% savings left
    the savings at 10% of the OLD total. Now savings are recomputed from the
    percentage, and `remaining` moves by the change in the SPENDABLE amount
    (total - savings), so what has already been spent is preserved exactly.
    """
    total = Decimal(new_total) if new_total is not None else Decimal(current_total)
    pct = (
        Decimal(new_savings_percentage)
        if new_savings_percentage is not None
        else Decimal(savings_percentage)
    )
    savings = calculate_savings_amount(total, pct, carried_over_amount)
    if savings > total:
        raise ValueError("savings cannot be more than the total")

    old_spendable = Decimal(current_total) - Decimal(current_savings)
    new_spendable = total - savings
    remaining = max(Decimal(current_remaining) + (new_spendable - old_spendable), Decimal("0"))
    remaining = min(remaining, new_spendable)
    return total, _cents(remaining), savings, pct


def normalise_survival_threshold(value: Decimal | None) -> Decimal | None:
    """0 means "survival mode off", exactly like no threshold at all."""
    if value is None or Decimal(value) <= 0:
        return None
    return Decimal(value)


# ---------------------------------------------------------------------------
# Renewing a budget — the next cycle
# ---------------------------------------------------------------------------

@dataclass
class Renewal:
    total_amount: Decimal
    remaining_amount: Decimal
    savings_amount: Decimal
    carried_over_amount: Decimal
    leftover_carried: Decimal
    savings_carried: Decimal


def calculate_renewal(
    old_remaining: Decimal,
    old_savings: Decimal,
    new_allowance: Decimal,
    savings_percentage: Decimal,
    carry_over_leftover: bool = True,
    carry_over_savings: bool = False,
) -> Renewal:
    """
    The numbers for the next cycle.

        total_amount = new allowance + whatever is carried over
        savings      = savings_percentage of the NEW allowance only
        remaining    = total - savings

    `old_remaining` is the spendable money the student did not use. The old
    cycle's savings are only spendable again if the student asks for that
    (carry_over_savings) — otherwise they stay banked in the savings ledger.
    """
    allowance = Decimal(new_allowance)
    if allowance < 0:
        raise ValueError("new allowance cannot be negative")
    leftover = _cents(old_remaining) if carry_over_leftover else Decimal("0.00")
    saved = _cents(old_savings) if carry_over_savings else Decimal("0.00")
    carried = leftover + saved
    total = _cents(allowance + carried)
    if total <= 0:
        raise ValueError("the new budget needs a total above zero")
    savings = calculate_savings_amount(total, savings_percentage, carried)
    return Renewal(
        total_amount=total,
        remaining_amount=_cents(total - savings),
        savings_amount=savings,
        carried_over_amount=carried,
        leftover_carried=leftover,
        savings_carried=saved,
    )


# ---------------------------------------------------------------------------
# Spend dates and editing a recorded spend
# ---------------------------------------------------------------------------

def resolve_transaction_datetime(
    requested: date | None,
    today: date,
    cycle_start: date,
) -> datetime | None:
    """
    When a spend happened.

    None  -> "now" (the caller lets the database default apply): no date given,
             or the date given is today.
    past  -> midday on that day. Midday keeps the purchase on the right
             calendar day whichever timezone the database session uses.

    A date in the future, or before the budget's cycle_start_date, is refused —
    the first would hide a spend from every split until that day arrives, the
    second belongs to a different cycle.
    """
    if requested is None or requested == today:
        return None
    if requested > today:
        raise ValueError("A spend cannot be dated in the future.")
    if requested < cycle_start:
        raise ValueError(f"A spend cannot be dated before this budget started on {cycle_start}.")
    return datetime.combine(requested, time(12, 0))


def resolve_edit_datetime(
    requested: date | None,
    current_day: date,
    today: date,
    cycle_start: date,
    now: datetime,
) -> datetime | None:
    """
    The new transaction_date when a spend is edited, or None to leave it alone.

    Unchanged when no date is sent or it is the day the spend already sits on.
    Otherwise the same rules as a new spend: today -> `now`, a past day -> midday,
    and never the future or before the budget started.
    """
    if requested is None or requested == current_day:
        return None
    resolved = resolve_transaction_datetime(requested, today, cycle_start)
    return resolved if resolved is not None else now


def calculate_transaction_edit(
    remaining_amount: Decimal,
    old_amount: Decimal,
    new_amount: Decimal,
    spendable_amount: Decimal,
    spent_after_edit: Decimal,
) -> Decimal:
    """
    remaining_amount after a recorded spend changes from old_amount to new_amount.

    Bigger  -> the difference is spent like a fresh purchase (floored at 0).
    Smaller -> the difference is refunded, capped by the ledger exactly as when
               a spend is deleted (calculate_transaction_removal), so undoing
               part of an overspend cannot create money.
    """
    old_amount, new_amount = Decimal(old_amount), Decimal(new_amount)
    if new_amount < 0 or old_amount < 0:
        raise ValueError("amounts cannot be negative")
    if new_amount == old_amount:
        return Decimal(remaining_amount)
    if new_amount > old_amount:
        return calculate_transaction_impact(remaining_amount, new_amount - old_amount).new_remaining
    return calculate_transaction_removal(
        remaining_amount=remaining_amount,
        transaction_amount=old_amount - new_amount,
        spendable_amount=spendable_amount,
        spent_after_removal=spent_after_edit,
    )


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

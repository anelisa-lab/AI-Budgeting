"""Daily allowance calculation for recommendation budget-fit scoring."""

from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from typing import Dict, Optional

ZERO = Decimal("0.00")
MODE_NORMAL = "normal"
MODE_SURVIVAL = "survival"


def _money(value) -> Decimal:
    return (Decimal("0") if value is None else Decimal(str(value))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def days_remaining(as_of: date, cycle_end: date) -> int:
    return max((cycle_end - as_of).days + 1, 1)


def daily_allowance(remaining: Decimal, cycle_start: date, cycle_end: date) -> Decimal:
    days = days_remaining(cycle_start, cycle_end)
    return (Decimal(remaining) / days).quantize(Decimal("0.01"), rounding="ROUND_DOWN")


@dataclass
class DaySplit:
    limit_date: date
    planned_limit: Decimal
    spent_amount: Decimal
    remaining_limit: Decimal
    is_today: bool = False


@dataclass
class BudgetSplit:
    budget_id: int
    currency: str
    as_of: date
    next_payout_date: date
    days_remaining: int
    remaining_amount: Decimal
    daily_limit: Decimal
    spent_today: Decimal
    remaining_today: Decimal
    mode: str
    survival_threshold: Optional[Decimal]
    message: str
    days: list = field(default_factory=list)


def build_split(budget: dict, as_of: Optional[date] = None,
                spent_by_date: Optional[Dict[date, Decimal]] = None,
                horizon_days: int = 14) -> BudgetSplit:
    as_of = as_of or date.today()
    spent_by_date = spent_by_date or {}
    remaining = _money(budget.get("remaining_amount"))
    end = budget["cycle_end_date"]
    days = days_remaining(as_of, end)
    daily = daily_allowance(remaining, as_of, end)
    spent_today = _money(spent_by_date.get(as_of, ZERO))
    remaining_today = max(_money(daily - spent_today), ZERO)
    threshold = budget.get("survival_threshold")
    threshold = _money(threshold) if threshold is not None else None
    mode = MODE_SURVIVAL if budget.get("budget_mode") == MODE_SURVIVAL or (
        threshold is not None and daily <= threshold
    ) else MODE_NORMAL
    schedule = []
    for index in range(min(max(horizon_days, 0), days)):
        day = as_of + timedelta(days=index)
        spent = _money(spent_by_date.get(day, ZERO))
        planned = daily if index < days - 1 else _money(remaining - daily * (days - 1))
        schedule.append(DaySplit(day, planned, spent, max(_money(planned - spent), ZERO), index == 0))
    message = (
        "Your allowance for this cycle is finished." if remaining <= 0 else
        f"Survival mode: R{remaining} over {days} days gives you R{daily} a day."
        if mode == MODE_SURVIVAL else f"R{remaining} over {days} days gives you R{daily} a day."
    )
    return BudgetSplit(budget["id"], budget.get("currency", "ZAR"), as_of, end, days,
                       remaining, daily, spent_today, remaining_today, mode, threshold, message, schedule)


@dataclass
class Affordability:
    amount: Decimal
    affordable_today: bool
    affordable_this_cycle: bool
    remaining_today: Decimal
    remaining_amount: Decimal
    days_of_budget: Optional[Decimal]
    message: str


def check_affordability(split: BudgetSplit, amount: Decimal) -> Affordability:
    amount = _money(amount)
    affordable_today = amount <= split.remaining_today
    affordable_cycle = amount <= split.remaining_amount
    days = (amount / split.daily_limit).quantize(Decimal("0.1")) if split.daily_limit else None
    if not affordable_cycle:
        message = "This purchase would cause an overspend."
    elif not affordable_today:
        message = "This purchase fits the cycle, but would make today's budget tighter."
    else:
        message = "This purchase fits today's allowance."
    return Affordability(amount, affordable_today, affordable_cycle,
                         max(_money(split.remaining_today - amount), ZERO),
                         max(_money(split.remaining_amount - amount), ZERO), days, message)
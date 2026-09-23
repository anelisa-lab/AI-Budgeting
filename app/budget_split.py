"""
Daily Budget Split — Member 6.

Phase 1 spec: remaining allowance / days to next payout.

This is the team's standout feature, so it's worth being precise about what
the words mean:

    remaining allowance = budgets.remaining_amount
        Savings were already carved out of the total when the budget was
        created (see Member 3's create_budget), so remaining_amount is money
        the student may actually spend. The split never touches savings.

    today's allowance is fixed at the START of the day:
        (remaining_amount + spent_today) / days
        remaining_amount already has today's purchases subtracted (Member 3's
        transaction handler does that), so dividing it and then subtracting
        spent_today again would count every purchase today twice. Fixing the
        allowance at start-of-day also means the headline number doesn't
        wobble every time the student buys something.

    tomorrow_limit = what's left after today's allowance / the remaining days.
        Overspend today and this is the number that drops.

    days to next payout = budgets.cycle_end_date, counted INCLUSIVELY from
        today. If today is the 20th and payout is the 22nd, that is 3 days of
        eating, not 2. Getting this off by one is the difference between a
        student having lunch money on payout day and not.

    daily limit = remaining / days, rounded DOWN to the cent.
        Rounding down guarantees the sum of every day's limit never exceeds
        what's in the budget. The few cents left over land on the last day.

The split is recalculated on every read rather than stored once, because the
answer changes the moment a transaction is recorded — that's the whole point.
budget_daily_limits then keeps a per-day record so the dashboard can show
"you were R12 under yesterday".

Survival mode: when remaining_amount drops to or below the budget's
survival_threshold, the student is in trouble and the app should stop
recommending non-essentials. The threshold is per-budget and optional; this
module reports the mode and the router persists it to budgets.budget_mode.

Pure Python — no database, no FastAPI — so every number below is unit-tested
in tests/test_budget_split.py without a Postgres connection.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP
from typing import Dict, List, Optional

from app.clock import local_today

ZERO = Decimal("0.00")

MODE_NORMAL = "normal"
MODE_SURVIVAL = "survival"

# A daily limit below this is effectively nothing, and the UI should say so
# rather than pretending R3.40 a day is a plan.
CRITICAL_DAILY_LIMIT = Decimal("20.00")


def _money(value) -> Decimal:
    if value is None:
        return ZERO
    if not isinstance(value, Decimal):
        value = Decimal(str(value))
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _money_down(value) -> Decimal:
    """Round down — used for the daily limit so the days never over-allocate."""
    if value is None:
        return ZERO
    if not isinstance(value, Decimal):
        value = Decimal(str(value))
    return value.quantize(Decimal("0.01"), rounding=ROUND_DOWN)


# ---------------------------------------------------------------------------
# Core arithmetic
# ---------------------------------------------------------------------------


def days_remaining(as_of: date, cycle_end_date: date) -> int:
    """
    Days left in the cycle, counting today and payout day. Never less than 1.

    A cycle that has already ended returns 1: the student is living on what's
    left until the next payout lands, and dividing by zero helps nobody.
    """
    delta = (cycle_end_date - as_of).days + 1
    return max(delta, 1)


def daily_allowance(remaining_amount, as_of: date, cycle_end_date: date) -> Decimal:
    """remaining / days, rounded down to the cent. The headline number."""
    remaining = _money(remaining_amount)
    if remaining <= 0:
        return ZERO
    days = days_remaining(as_of, cycle_end_date)
    return _money_down(remaining / Decimal(days))


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


@dataclass
class DaySplit:
    limit_date: date
    planned_limit: Decimal
    spent_amount: Decimal
    remaining_limit: Decimal
    is_today: bool = False

    def as_dict(self) -> dict:
        return {
            "limit_date": self.limit_date,
            "planned_limit": self.planned_limit,
            "spent_amount": self.spent_amount,
            "remaining_limit": self.remaining_limit,
            "is_today": self.is_today,
        }


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
    days: List[DaySplit] = field(default_factory=list)
    tomorrow_limit: Optional[Decimal] = None   # None on payout day / after it

    def as_dict(self) -> dict:
        return {
            "budget_id": self.budget_id,
            "currency": self.currency,
            "as_of": self.as_of,
            "next_payout_date": self.next_payout_date,
            "days_remaining": self.days_remaining,
            "remaining_amount": self.remaining_amount,
            "daily_limit": self.daily_limit,
            "spent_today": self.spent_today,
            "remaining_today": self.remaining_today,
            "tomorrow_limit": self.tomorrow_limit,
            "mode": self.mode,
            "survival_threshold": self.survival_threshold,
            "message": self.message,
            "days": [d.as_dict() for d in self.days],
        }


# ---------------------------------------------------------------------------
# The algorithm
# ---------------------------------------------------------------------------


def _plural_days(count: int) -> str:
    """"1 day" / "16 days" — the messages are shown to students, not to us."""
    return "1 day" if count == 1 else f"{count} days"


def _build_message(
    remaining: Decimal,
    daily_limit: Decimal,
    remaining_today: Decimal,
    days: int,
    mode: str,
    cycle_ended: bool,
    spent_today: Decimal = ZERO,
    tomorrow_limit: Optional[Decimal] = None,
) -> str:
    if spent_today > daily_limit and remaining > 0 and not cycle_ended and mode != MODE_SURVIVAL:
        over = _money(spent_today - daily_limit)
        tail = f" From tomorrow you have R{tomorrow_limit} a day." if tomorrow_limit is not None else ""
        return f"You're R{over} over today's R{daily_limit} allowance.{tail}"
    if remaining <= 0:
        return (
            "Your allowance for this cycle is finished. Nothing left to split — "
            "hold out until your next payout."
        )
    if cycle_ended:
        return (
            f"Your payout date has passed with R{remaining} left. Treat it as "
            "today's budget until the next one lands."
        )
    if mode == MODE_SURVIVAL:
        # Use remaining_today and tomorrow_limit here, not daily_limit.
        # daily_limit is today's allowance fixed at the START of today, so
        # pairing it with the CURRENT balance produced a sentence that
        # contradicted itself: a student with R80 left who had already spent
        # R120 was told "R80.00 must last 16 more days, so you have R12.50 a
        # day" — R80 over 16 days is R5, not R12.50. In survival mode the
        # forward-looking rate is the only number that matters anyway.
        tail = (
            f" You have R{remaining_today} left today, then about "
            f"R{tomorrow_limit} a day."
            if tomorrow_limit is not None
            else f" You have R{remaining_today} left for today."
        )
        return (
            f"Survival mode: R{remaining} must last {_plural_days(days)} more.{tail} "
            "Essentials only — the app will stop suggesting anything else."
        )
    if daily_limit < CRITICAL_DAILY_LIMIT:
        return (
            f"R{remaining} over {_plural_days(days)} is only R{daily_limit} a day. That's "
            "very tight — stick to essentials and look for cheaper stores."
        )
    return (
        f"R{_money(remaining + spent_today)} over {_plural_days(days)} gives you R{daily_limit} a day. "
        f"You have R{remaining_today} left to spend today."
    )


def build_split(
    budget: dict,
    as_of: Optional[date] = None,
    spent_by_date: Optional[Dict[date, Decimal]] = None,
    horizon_days: int = 14,
) -> BudgetSplit:
    """
    Work out the Daily Budget Split for one budget.

    Args:
        budget:         a budgets row (dict-like) — needs id, currency,
                        remaining_amount, cycle_start_date, cycle_end_date and
                        optionally survival_threshold.
        as_of:          the day being planned; defaults to today.
        spent_by_date:  {date: amount} of transactions already recorded, used
                        to fill in spent_amount per day. Days not in the map
                        count as zero spend.
        horizon_days:   how many days of the schedule to return. The dashboard
                        shows a fortnight; the maths is unaffected.

    Returns:
        BudgetSplit — the headline daily limit plus a day-by-day schedule.
    """
    as_of = as_of or local_today()
    spent_by_date = spent_by_date or {}

    cycle_end = budget["cycle_end_date"]
    remaining = _money(budget.get("remaining_amount"))
    threshold = budget.get("survival_threshold")
    threshold = _money(threshold) if threshold is not None else None

    days = days_remaining(as_of, cycle_end)
    cycle_ended = cycle_end < as_of
    spent_today = _money(spent_by_date.get(as_of, ZERO))

    # Today's allowance comes from the balance at the START of today — see the
    # module docstring. A budget that's run dry gets no allowance at all
    # (remaining_amount is floored at 0, so adding spent_today back would
    # invent money that was never there).
    start_of_day = _money(remaining + spent_today) if remaining > 0 else ZERO
    limit = daily_allowance(start_of_day, as_of, cycle_end)
    remaining_today = max(_money(limit - spent_today), ZERO)

    # Tomorrow onwards: whatever is left once today's allowance is used up,
    # spread over the days after today.
    tomorrow_limit = None
    if days > 1 and not cycle_ended:
        after_today = max(_money(remaining - remaining_today), ZERO)
        tomorrow_limit = _money_down(after_today / Decimal(days - 1))

    mode = MODE_SURVIVAL if (threshold is not None and remaining <= threshold) else MODE_NORMAL

    # Day-by-day schedule. Today carries today's allowance; the days after it
    # carry tomorrow_limit, so an overspend today shows up as tighter days
    # ahead. The split is recalculated from scratch on every read anyway.
    schedule: List[DaySplit] = []
    last_day = min(cycle_end, as_of + timedelta(days=horizon_days - 1))
    if last_day < as_of:
        last_day = as_of

    cursor_date = as_of
    while cursor_date <= last_day:
        spent = _money(spent_by_date.get(cursor_date, ZERO))
        planned = limit if cursor_date == as_of or tomorrow_limit is None else tomorrow_limit
        schedule.append(
            DaySplit(
                limit_date=cursor_date,
                planned_limit=planned,
                spent_amount=spent,
                remaining_limit=max(_money(planned - spent), ZERO),
                is_today=(cursor_date == as_of),
            )
        )
        cursor_date += timedelta(days=1)

    return BudgetSplit(
        budget_id=budget["id"],
        currency=budget.get("currency") or "ZAR",
        as_of=as_of,
        next_payout_date=cycle_end,
        days_remaining=days,
        remaining_amount=remaining,
        daily_limit=limit,
        spent_today=spent_today,
        remaining_today=remaining_today,
        mode=mode,
        survival_threshold=threshold,
        message=_build_message(
            remaining, limit, remaining_today, days, mode, cycle_ended,
            spent_today=spent_today, tomorrow_limit=tomorrow_limit,
        ),
        days=schedule,
        tomorrow_limit=tomorrow_limit,
    )


@dataclass
class AffordabilityVerdict:
    amount: Decimal
    affordable_today: bool
    affordable_this_cycle: bool
    remaining_today: Decimal
    remaining_amount: Decimal
    days_of_budget: Optional[Decimal]   # how many days' allowance this purchase eats
    message: str

    def as_dict(self) -> dict:
        return {
            "amount": self.amount,
            "affordable_today": self.affordable_today,
            "affordable_this_cycle": self.affordable_this_cycle,
            "remaining_today": self.remaining_today,
            "remaining_amount": self.remaining_amount,
            "days_of_budget": self.days_of_budget,
            "message": self.message,
        }


def check_affordability(split: BudgetSplit, amount) -> AffordabilityVerdict:
    """
    "Can I buy this today?" — answered against the split, not just the balance.

    The honest answer is usually "yes, but it costs you two days of food",
    which is exactly what days_of_budget says. Member 5's recommender uses
    the same idea to score budget fit.
    """
    amount = _money(amount)

    affordable_today = amount <= split.remaining_today
    affordable_cycle = amount <= split.remaining_amount

    days_of_budget = None
    if split.daily_limit > 0:
        days_of_budget = (amount / split.daily_limit).quantize(
            Decimal("0.1"), rounding=ROUND_HALF_UP
        )

    if not affordable_cycle:
        over_by = _money(amount - split.remaining_amount)
        message = (
            f"R{amount} is R{over_by} more than you have left for the whole cycle. "
            "This one would put you into overspend."
        )
    elif affordable_today:
        message = (
            f"R{amount} fits inside today's R{split.remaining_today} allowance."
        )
    else:
        message = (
            f"R{amount} is over today's R{split.remaining_today}, but you can "
            f"afford it this cycle — it uses about {days_of_budget} days of your "
            "allowance, so the next few days get tighter."
        )

    return AffordabilityVerdict(
        amount=amount,
        affordable_today=affordable_today,
        affordable_this_cycle=affordable_cycle,
        remaining_today=split.remaining_today,
        remaining_amount=split.remaining_amount,
        days_of_budget=days_of_budget,
        message=message,
    )

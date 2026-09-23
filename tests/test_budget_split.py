"""
Daily Budget Split tests — Member 6.

The edge cases that matter for a student: the inclusive day count, payout
day itself, a finished allowance, and survival mode.
"""

from datetime import date
from decimal import Decimal

from app.budget_split import (
    MODE_NORMAL,
    MODE_SURVIVAL,
    build_split,
    check_affordability,
    daily_allowance,
    days_remaining,
)

D = Decimal


def budget(remaining="1000.00", start="2026-09-01", end="2026-09-30", **extra):
    row = {
        "id": 1,
        "currency": "ZAR",
        "remaining_amount": D(remaining),
        "cycle_start_date": date.fromisoformat(start),
        "cycle_end_date": date.fromisoformat(end),
        "survival_threshold": None,
        "budget_mode": "normal",
    }
    row.update(extra)
    return row


# --- day counting ----------------------------------------------------------

def test_days_remaining_counts_today_and_payout_day():
    # 20th to 22nd is three days of eating, not two.
    assert days_remaining(date(2026, 9, 20), date(2026, 9, 22)) == 3


def test_payout_day_itself_is_one_day():
    assert days_remaining(date(2026, 9, 22), date(2026, 9, 22)) == 1


def test_past_payout_never_divides_by_zero():
    assert days_remaining(date(2026, 9, 25), date(2026, 9, 22)) == 1


# --- the split ------------------------------------------------------------

def test_daily_allowance_rounds_down():
    # 1000 / 30 = 33.333... -> 33.33, so 30 days never exceed the balance.
    limit = daily_allowance(D("1000.00"), date(2026, 9, 1), date(2026, 9, 30))
    assert limit == D("33.33")
    assert limit * 30 <= D("1000.00")


def test_zero_remaining_gives_zero_limit():
    split = build_split(budget(remaining="0.00"), as_of=date(2026, 9, 10))
    assert split.daily_limit == D("0.00")
    assert "finished" in split.message


def test_spent_today_reduces_todays_allowance():
    # R1000 at the start of the day, R40 spent: budgets.remaining_amount is
    # already R960 by the time the split is read (the transaction handler
    # subtracts it), so that's what the router passes in.
    today = date(2026, 9, 10)
    split = build_split(
        budget(remaining="960.00", end="2026-09-19"),
        as_of=today,
        spent_by_date={today: D("40.00")},
    )
    assert split.days_remaining == 10
    assert split.daily_limit == D("100.00")
    assert split.spent_today == D("40.00")
    assert split.remaining_today == D("60.00")


def test_todays_spend_is_not_counted_twice():
    # Regression: dividing the post-purchase balance and then subtracting
    # today's spend again gave R40.50 left instead of R45.
    today = date(2026, 9, 10)
    split = build_split(
        budget(remaining="855.00", end="2026-09-19"),
        as_of=today,
        spent_by_date={today: D("45.00")},
    )
    assert split.daily_limit == D("90.00")
    assert split.remaining_today == D("45.00")


def test_overspending_today_floors_at_zero_never_negative():
    today = date(2026, 9, 10)
    split = build_split(
        budget(remaining="750.00", end="2026-09-19"),
        as_of=today,
        spent_by_date={today: D("250.00")},
    )
    assert split.remaining_today == D("0.00")


def test_overspending_today_tightens_tomorrow():
    # R1000 over 10 days is R100/day; spending R250 today leaves R750 for
    # the other 9 days -> R83.33 from tomorrow.
    today = date(2026, 9, 10)
    split = build_split(
        budget(remaining="750.00", end="2026-09-19"),
        as_of=today,
        spent_by_date={today: D("250.00")},
    )
    assert split.daily_limit == D("100.00")
    assert split.tomorrow_limit == D("83.33")
    assert split.days[1].planned_limit == D("83.33")
    assert "over today's" in split.message


def test_no_spend_keeps_tomorrow_in_line_with_today():
    today = date(2026, 9, 10)
    split = build_split(budget(remaining="1000.00", end="2026-09-19"), as_of=today)
    assert split.daily_limit == D("100.00")
    assert split.tomorrow_limit == D("100.00")


def test_used_up_budget_gets_no_allowance_even_after_spending_today():
    # remaining_amount is floored at 0 on overspend; adding today's spend back
    # would invent an allowance out of money that never existed.
    today = date(2026, 9, 10)
    split = build_split(
        budget(remaining="0.00", end="2026-09-19"),
        as_of=today,
        spent_by_date={today: D("5000.00")},
    )
    assert split.daily_limit == D("0.00")
    assert split.remaining_today == D("0.00")


def test_payout_day_has_no_tomorrow():
    today = date(2026, 9, 19)
    split = build_split(budget(remaining="100.00", end="2026-09-19"), as_of=today)
    assert split.tomorrow_limit is None


def test_schedule_starts_today_and_respects_the_horizon():
    today = date(2026, 9, 10)
    split = build_split(budget(end="2026-09-30"), as_of=today, horizon_days=5)
    assert len(split.days) == 5
    assert split.days[0].limit_date == today
    assert split.days[0].is_today is True
    assert split.days[-1].limit_date == date(2026, 9, 14)


def test_schedule_stops_at_payout_day():
    today = date(2026, 9, 28)
    split = build_split(budget(end="2026-09-30"), as_of=today, horizon_days=14)
    assert [d.limit_date for d in split.days] == [
        date(2026, 9, 28), date(2026, 9, 29), date(2026, 9, 30),
    ]


# --- survival mode --------------------------------------------------------

def test_survival_mode_triggers_on_the_threshold():
    split = build_split(
        budget(remaining="80.00", survival_threshold=D("100.00")),
        as_of=date(2026, 9, 25),
    )
    assert split.mode == MODE_SURVIVAL
    assert "Survival mode" in split.message


def test_no_threshold_means_no_survival_mode():
    split = build_split(budget(remaining="5.00"), as_of=date(2026, 9, 25))
    assert split.mode == MODE_NORMAL


# --- affordability --------------------------------------------------------

def test_purchase_inside_todays_allowance():
    today = date(2026, 9, 10)
    split = build_split(budget(remaining="1000.00", end="2026-09-19"), as_of=today)
    verdict = check_affordability(split, D("60.00"))
    assert verdict.affordable_today is True
    assert verdict.affordable_this_cycle is True
    assert verdict.days_of_budget == D("0.6")


def test_purchase_over_today_but_inside_the_cycle():
    today = date(2026, 9, 10)
    split = build_split(budget(remaining="1000.00", end="2026-09-19"), as_of=today)
    verdict = check_affordability(split, D("300.00"))
    assert verdict.affordable_today is False
    assert verdict.affordable_this_cycle is True
    assert verdict.days_of_budget == D("3.0")       # three days of food
    assert "tighter" in verdict.message


def test_purchase_over_the_whole_cycle_is_an_overspend():
    split = build_split(budget(remaining="100.00"), as_of=date(2026, 9, 10))
    verdict = check_affordability(split, D("250.00"))
    assert verdict.affordable_this_cycle is False
    assert "overspend" in verdict.message


# ---------------------------------------------------------------------------
# Phase 3 — invariants that must hold as a student spends through a day
#
# These were written after walking a whole month through build_split(). They
# all describe the same property from different angles: the headline number
# must be stable and honest while money is being spent.
# ---------------------------------------------------------------------------

def _after_spending(start_of_day, spent, threshold=None, end="2026-10-08",
                    as_of=date(2026, 9, 23)):
    """
    A student who began today with `start_of_day` and has spent `spent`.

    remaining = max(start - spent, 0) is exactly what Member 3's transaction
    handler stores, including the floor at zero. Building the row this way
    keeps the test from describing states that cannot occur — a budget cannot
    show R1200 remaining after R2000 has been spent out of it.
    """
    return build_split(
        budget(
            remaining=str(max(D(start_of_day) - D(spent), D("0.00"))),
            end=end,
            survival_threshold=D(threshold) if threshold else None,
        ),
        as_of=as_of,
        spent_by_date={as_of: D(spent)},
    )


def test_daily_limit_does_not_move_as_the_student_spends():
    """
    The headline number is fixed at the start of the day. If it drifted with
    every purchase, the dashboard would tell a student their allowance had
    changed when only their spending had.
    """
    limits = {_after_spending("1200.00", s).daily_limit
              for s in ["0.00", "10.00", "50.00", "75.00", "120.00"]}
    assert limits == {D("75.00")}          # 1200 / 16 days


def test_remaining_today_falls_as_the_student_spends():
    assert _after_spending("1200.00", "0.00").remaining_today == D("75.00")
    assert _after_spending("1200.00", "50.00").remaining_today == D("25.00")
    assert _after_spending("1200.00", "75.00").remaining_today == D("0.00")
    assert _after_spending("1200.00", "200.00").remaining_today == D("0.00")


def test_tomorrow_drops_further_the_more_is_overspent():
    """
    Companion to test_overspending_today_tightens_tomorrow above, which pins
    the exact figures. This one pins the direction: the more you overspend,
    the less there is per day afterwards.
    """
    on_plan = _after_spending("1200.00", "75.00")
    overspent = _after_spending("1200.00", "200.00")
    worse = _after_spending("1200.00", "400.00")
    assert worse.tomorrow_limit < overspent.tomorrow_limit < on_plan.tomorrow_limit
    assert "over today's" in overspent.message


def test_spending_the_whole_balance_leaves_nothing_to_split():
    for spent in ["1200.00", "1500.00"]:
        split = _after_spending("1200.00", spent)
        assert split.remaining_amount == D("0.00")
        assert split.daily_limit == D("0.00")
        assert "finished" in split.message


def test_forward_allocation_never_exceeds_the_balance():
    """
    What the student may still spend — today's remainder plus every later
    day's limit — must not add up to more money than they have.
    """
    for spent in ["0.00", "50.00", "200.00"]:
        split = _after_spending("1200.00", spent)
        allocated = (
            split.remaining_today
            + (split.tomorrow_limit or D("0")) * (split.days_remaining - 1)
        )
        assert allocated <= split.remaining_amount


def test_survival_message_agrees_with_its_own_numbers():
    """
    Regression: the survival message paired the CURRENT balance with
    daily_limit, which is a start-of-day figure. A student with R80 left was
    told "R80.00 must last 16 more days, so you have R12.50 a day".
    """
    split = _after_spending("200.00", "120.00", threshold="150.00")
    assert split.mode == MODE_SURVIVAL
    assert split.remaining_amount == D("80.00")
    assert f"R{split.remaining_amount} must last" in split.message
    assert f"R{split.tomorrow_limit} a day" in split.message
    assert f"R{split.daily_limit} a day" not in split.message


def test_a_student_who_spends_exactly_the_limit_lands_on_zero_at_payout():
    """A week simulated end to end: the plan must actually work."""
    from datetime import timedelta

    start, end = date(2026, 9, 23), date(2026, 9, 30)
    remaining = D("700.00")
    spent_by_date = {}
    day = start
    seen_limits = set()

    while day <= end:
        split = build_split(
            budget(remaining=str(remaining), end=end.isoformat()),
            as_of=day,
            spent_by_date=dict(spent_by_date),
        )
        seen_limits.add(split.daily_limit)
        spend = split.remaining_today
        spent_by_date[day] = spend
        remaining = max(remaining - spend, D("0.00"))
        day += timedelta(days=1)

    assert seen_limits == {D("87.50")}     # 700 / 8 days, steady all week
    assert remaining == D("0.00")          # and nothing left over at payout

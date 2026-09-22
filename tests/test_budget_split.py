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
    today = date(2026, 9, 10)
    split = build_split(
        budget(remaining="1000.00", end="2026-09-19"),
        as_of=today,
        spent_by_date={today: D("40.00")},
    )
    assert split.days_remaining == 10
    assert split.daily_limit == D("100.00")
    assert split.spent_today == D("40.00")
    assert split.remaining_today == D("60.00")


def test_overspending_today_floors_at_zero_never_negative():
    today = date(2026, 9, 10)
    split = build_split(
        budget(remaining="1000.00", end="2026-09-19"),
        as_of=today,
        spent_by_date={today: D("250.00")},
    )
    assert split.remaining_today == D("0.00")


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

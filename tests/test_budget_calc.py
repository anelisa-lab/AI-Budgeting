"""
Unit tests for the budget-calc edge cases named in the sprint plan
(Member 3, Phase 2): zero, negative, and exact match.

Run with:  pytest tests/test_budget_calc.py -v
"""

from decimal import Decimal

import pytest

from app.budget_calc import (
    calculate_budget_health,
    calculate_budget_update,
    calculate_transaction_impact,
)


class TestCalculateTransactionImpact:
    # --- Zero cases ---

    def test_zero_remaining_any_purchase_is_overspend(self):
        """A student with R0 left buying anything should be flagged."""
        result = calculate_transaction_impact(
            remaining_amount=Decimal("0.00"), transaction_amount=Decimal("18.99")
        )
        assert result.overspend_warning is True
        assert result.new_remaining == Decimal("0.00")  # floored, never negative
        assert result.over_by == Decimal("18.99")

    def test_zero_transaction_amount_is_not_overspend(self):
        """A R0 transaction (e.g. a free item) never triggers a warning."""
        result = calculate_transaction_impact(
            remaining_amount=Decimal("100.00"), transaction_amount=Decimal("0.00")
        )
        assert result.overspend_warning is False
        assert result.new_remaining == Decimal("100.00")
        assert result.over_by == Decimal("0.00")

    def test_zero_and_zero(self):
        """R0 remaining, R0 transaction — edge of the edge case."""
        result = calculate_transaction_impact(
            remaining_amount=Decimal("0.00"), transaction_amount=Decimal("0.00")
        )
        assert result.overspend_warning is False
        assert result.new_remaining == Decimal("0.00")

    # --- Negative-input validation ---

    def test_negative_transaction_amount_raises(self):
        """A negative transaction amount should never reach this function
        in practice (the schema's CHECK amount > 0 blocks it at the DB
        layer), but the function itself should refuse to silently
        process one rather than produce a nonsensical result."""
        with pytest.raises(ValueError):
            calculate_transaction_impact(
                remaining_amount=Decimal("100.00"), transaction_amount=Decimal("-10.00")
            )

    def test_negative_remaining_amount_raises(self):
        """remaining_amount is CHECK >= 0 in the schema, so a negative
        value reaching this function indicates a bug upstream — fail
        loudly rather than compute a misleading result."""
        with pytest.raises(ValueError):
            calculate_transaction_impact(
                remaining_amount=Decimal("-5.00"), transaction_amount=Decimal("10.00")
            )

    # --- Exact match ---

    def test_transaction_exactly_equals_remaining(self):
        """Spending exactly what's left should NOT be flagged as
        overspend (the rule is amount > remaining, not >=) and should
        leave exactly R0 remaining."""
        result = calculate_transaction_impact(
            remaining_amount=Decimal("92.50"), transaction_amount=Decimal("92.50")
        )
        assert result.overspend_warning is False
        assert result.new_remaining == Decimal("0.00")
        assert result.over_by == Decimal("0.00")

    def test_transaction_one_cent_over_remaining(self):
        """One cent over the exact match should flip to overspend —
        confirms the boundary is handled correctly, not off-by-one."""
        result = calculate_transaction_impact(
            remaining_amount=Decimal("92.50"), transaction_amount=Decimal("92.51")
        )
        assert result.overspend_warning is True
        assert result.over_by == Decimal("0.01")
        assert result.new_remaining == Decimal("0.00")

    # --- Ordinary case, for a sanity baseline ---

    def test_ordinary_within_budget_purchase(self):
        result = calculate_transaction_impact(
            remaining_amount=Decimal("500.00"), transaction_amount=Decimal("120.00")
        )
        assert result.overspend_warning is False
        assert result.new_remaining == Decimal("380.00")
        assert result.over_by == Decimal("0.00")


class TestCalculateBudgetUpdate:
    def test_no_change_when_new_total_is_none(self):
        total, remaining = calculate_budget_update(
            current_total=Decimal("1000.00"),
            current_remaining=Decimal("400.00"),
            new_total=None,
        )
        assert total == Decimal("1000.00")
        assert remaining == Decimal("400.00")

    def test_increasing_total_increases_remaining_by_same_delta(self):
        total, remaining = calculate_budget_update(
            current_total=Decimal("1000.00"),
            current_remaining=Decimal("400.00"),
            new_total=Decimal("1200.00"),
        )
        assert total == Decimal("1200.00")
        assert remaining == Decimal("600.00")  # 400 + 200 delta

    def test_decreasing_total_decreases_remaining_but_floors_at_zero(self):
        """If the student already spent more than the new (lower) total
        would allow, remaining should floor at 0, not go negative."""
        total, remaining = calculate_budget_update(
            current_total=Decimal("1000.00"),
            current_remaining=Decimal("100.00"),
            new_total=Decimal("500.00"),
        )
        assert total == Decimal("500.00")
        # delta = 500 - 1000 = -500; 100 + (-500) = -400 -> floored to 0
        assert remaining == Decimal("0.00")

    def test_exact_zero_total_change(self):
        """Setting new_total equal to current_total is a no-op delta."""
        total, remaining = calculate_budget_update(
            current_total=Decimal("1000.00"),
            current_remaining=Decimal("400.00"),
            new_total=Decimal("1000.00"),
        )
        assert total == Decimal("1000.00")
        assert remaining == Decimal("400.00")


# ---------------------------------------------------------------------------
# Phase 3 — calculate_budget_health (dashboard warning display)
# ---------------------------------------------------------------------------


def test_health_ok_when_little_spent():
    h = calculate_budget_health(Decimal("1000"), Decimal("900"), Decimal("0"))
    assert h.warning_level == "ok"
    assert h.spent_amount == Decimal("100.00")
    assert h.spent_percentage == Decimal("10.0")
    assert h.warnings == []


def test_health_excludes_savings_from_spendable():
    # R1000 total, R100 saved, R900 still remaining -> nothing spent yet
    h = calculate_budget_health(Decimal("1000"), Decimal("900"), Decimal("100"))
    assert h.spendable_amount == Decimal("900.00")
    assert h.spent_amount == Decimal("0.00")
    assert h.warning_level == "ok"


def test_health_caution_at_75_percent():
    h = calculate_budget_health(Decimal("1000"), Decimal("250"), Decimal("0"))
    assert h.warning_level == "caution"
    assert h.spent_percentage == Decimal("75.0")


def test_health_danger_at_90_percent():
    h = calculate_budget_health(Decimal("1000"), Decimal("100"), Decimal("0"))
    assert h.warning_level == "danger"


def test_health_exhausted_at_zero_remaining():
    h = calculate_budget_health(Decimal("1000"), Decimal("0"), Decimal("0"))
    assert h.warning_level == "exhausted"
    assert h.warnings


def test_health_survival_mode_is_danger_even_when_little_spent():
    h = calculate_budget_health(Decimal("1000"), Decimal("900"), Decimal("0"), mode="survival")
    assert h.warning_level == "danger"
    assert "Survival mode" in h.warnings[0]


def test_health_over_daily_limit_is_caution():
    h = calculate_budget_health(
        Decimal("1000"), Decimal("900"), Decimal("0"),
        spent_today=Decimal("60"), daily_limit=Decimal("40"),
    )
    assert h.warning_level == "caution"
    assert h.over_daily_limit_by == Decimal("20.00")
    assert any("over today's allowance" in w for w in h.warnings)


def test_health_exactly_at_daily_limit_is_not_a_warning():
    h = calculate_budget_health(
        Decimal("1000"), Decimal("900"), Decimal("0"),
        spent_today=Decimal("40"), daily_limit=Decimal("40"),
    )
    assert h.warning_level == "ok"
    assert h.over_daily_limit_by == Decimal("0.00")


def test_health_rejects_negative_remaining():
    with pytest.raises(ValueError):
        calculate_budget_health(Decimal("1000"), Decimal("-1"), Decimal("0"))

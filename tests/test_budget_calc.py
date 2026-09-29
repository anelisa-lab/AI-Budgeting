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


# ---------------------------------------------------------------------------
# Phase 5: deleting a recorded spend
# ---------------------------------------------------------------------------

from app.budget_calc import calculate_transaction_removal  # noqa: E402


def test_deleting_a_spend_gives_the_money_back():
    # R1000 spendable, R300 spent (R100 of it the one being deleted) -> R700 left
    assert calculate_transaction_removal(
        Decimal("700"), Decimal("100"), Decimal("1000"), Decimal("200")
    ) == Decimal("800")


def test_deleting_part_of_an_overspend_does_not_create_money():
    # R1000 spendable, R1100 spent -> remaining floored at 0. Deleting R50
    # still leaves R1050 spent, so there is still nothing left.
    assert calculate_transaction_removal(
        Decimal("0"), Decimal("50"), Decimal("1000"), Decimal("1050")
    ) == Decimal("0")


def test_deleting_the_overspending_purchase_returns_only_what_was_really_left():
    # R1000 spendable, R900 spent, then a R300 purchase floors remaining at 0.
    # Deleting the R300 puts back R100 — what was left before it — not R300.
    assert calculate_transaction_removal(
        Decimal("0"), Decimal("300"), Decimal("1000"), Decimal("900")
    ) == Decimal("100")


def test_deleting_a_spend_never_lowers_remaining():
    # A raised total already lifted remaining above the ledger figure.
    assert calculate_transaction_removal(
        Decimal("50"), Decimal("10"), Decimal("1050"), Decimal("1090")
    ) == Decimal("50")


def test_removal_rejects_negative_amounts():
    with pytest.raises(ValueError):
        calculate_transaction_removal(Decimal("10"), Decimal("-1"), Decimal("100"), Decimal("0"))


# ---------------------------------------------------------------------------
# Editing a budget — savings follow the total
# ---------------------------------------------------------------------------

from datetime import date, datetime, time  # noqa: E402

from app.budget_calc import (  # noqa: E402
    calculate_budget_edit,
    calculate_renewal,
    calculate_savings_amount,
    calculate_transaction_edit,
    normalise_survival_threshold,
    resolve_edit_datetime,
    resolve_transaction_datetime,
)

D = Decimal


def test_savings_are_a_percentage_of_the_fresh_allowance_only():
    assert calculate_savings_amount(D("1715"), D("10")) == D("171.50")
    # R500 of the R1715 was carried over: only R1215 is fresh money.
    assert calculate_savings_amount(D("1715"), D("10"), D("500")) == D("121.50")


class TestCalculateBudgetEdit:
    def test_raising_the_total_recomputes_savings_to_match_the_percentage(self):
        # R1000 with 10% aside: R900 spendable. R100 spent -> R800 remaining.
        total, remaining, savings, pct = calculate_budget_edit(
            D("1000"), D("800"), D("100"), D("10"), D("0"), new_total=D("2000"),
        )
        assert (total, savings, pct) == (D("2000"), D("200.00"), D("10"))
        # Spendable went 900 -> 1800, so remaining moves by 900 and the R100 spent stays spent.
        assert remaining == D("1700.00")

    def test_old_behaviour_would_have_left_savings_at_the_old_amount(self):
        _, _, savings, _ = calculate_budget_edit(
            D("1000"), D("900"), D("100"), D("10"), D("0"), new_total=D("2000"),
        )
        assert savings != D("100")

    def test_lowering_the_total_floors_remaining_at_zero(self):
        _, remaining, savings, _ = calculate_budget_edit(
            D("1000"), D("50"), D("0"), D("0"), D("0"), new_total=D("500"),
        )
        assert savings == D("0.00")
        assert remaining == D("0.00")

    def test_changing_only_the_percentage_moves_money_between_savings_and_remaining(self):
        total, remaining, savings, pct = calculate_budget_edit(
            D("1000"), D("900"), D("100"), D("10"), D("0"), new_savings_percentage=D("20"),
        )
        assert (total, savings, pct) == (D("1000"), D("200.00"), D("20"))
        assert remaining == D("800.00")

    def test_no_change_is_a_no_op(self):
        assert calculate_budget_edit(
            D("1000"), D("640.25"), D("100"), D("10"), D("0"),
        ) == (D("1000"), D("640.25"), D("100.00"), D("10"))

    def test_remaining_never_exceeds_the_new_spendable_amount(self):
        # Zero savings -> 50% savings would shrink spendable to R500.
        _, remaining, _, _ = calculate_budget_edit(
            D("1000"), D("1000"), D("0"), D("0"), D("0"), new_savings_percentage=D("50"),
        )
        assert remaining == D("500.00")

    def test_carried_over_money_is_not_saved_again(self):
        total, remaining, savings, _ = calculate_budget_edit(
            D("1500"), D("1350"), D("150"), D("10"), D("500"), new_total=D("1600"),
        )
        # Fresh money is now R1100; 10% of that is R110, not 10% of R1600.
        assert savings == D("110.00")
        assert remaining == D("1350") + (D("1490") - D("1350"))


class TestSurvivalThreshold:
    def test_zero_and_none_mean_off(self):
        assert normalise_survival_threshold(None) is None
        assert normalise_survival_threshold(D("0")) is None
        assert normalise_survival_threshold(D("0.00")) is None

    def test_a_real_threshold_is_kept(self):
        assert normalise_survival_threshold(D("200")) == D("200")


# ---------------------------------------------------------------------------
# Renewing a budget
# ---------------------------------------------------------------------------

class TestCalculateRenewal:
    def test_fresh_start_with_no_carry_over(self):
        r = calculate_renewal(D("300"), D("100"), D("1715"), D("10"),
                              carry_over_leftover=False, carry_over_savings=False)
        assert r.total_amount == D("1715.00")
        assert r.savings_amount == D("171.50")
        assert r.remaining_amount == D("1543.50")
        assert r.carried_over_amount == D("0.00")

    def test_leftover_is_carried_into_the_total_and_not_saved_again(self):
        r = calculate_renewal(D("300"), D("100"), D("1715"), D("10"))
        assert r.total_amount == D("2015.00")
        assert r.carried_over_amount == D("300.00")
        assert r.savings_amount == D("171.50")            # 10% of the R1715, not of R2015
        assert r.remaining_amount == D("1843.50")

    def test_last_cycles_savings_only_come_back_when_asked_for(self):
        without = calculate_renewal(D("0"), D("100"), D("1000"), D("0"), carry_over_savings=False)
        with_ = calculate_renewal(D("0"), D("100"), D("1000"), D("0"), carry_over_savings=True)
        assert without.total_amount == D("1000.00")
        assert with_.total_amount == D("1100.00")
        assert with_.savings_carried == D("100.00")

    def test_a_zero_leftover_and_zero_allowance_is_refused(self):
        with pytest.raises(ValueError):
            calculate_renewal(D("0"), D("0"), D("0"), D("0"))

    def test_renewal_can_be_all_carry_over(self):
        r = calculate_renewal(D("250"), D("0"), D("0"), D("0"))
        assert r.total_amount == D("250.00")
        assert r.remaining_amount == D("250.00")

    def test_negative_allowance_is_refused(self):
        with pytest.raises(ValueError):
            calculate_renewal(D("0"), D("0"), D("-1"), D("0"))

    def test_remaining_never_exceeds_total(self):
        r = calculate_renewal(D("999.99"), D("50"), D("1715"), D("100"), carry_over_savings=True)
        assert r.remaining_amount <= r.total_amount
        assert r.savings_amount <= r.total_amount


# ---------------------------------------------------------------------------
# Spend dates
# ---------------------------------------------------------------------------

TODAY = date(2026, 9, 29)
START = date(2026, 9, 1)


class TestResolveTransactionDatetime:
    def test_no_date_means_now(self):
        assert resolve_transaction_datetime(None, TODAY, START) is None

    def test_today_means_now(self):
        assert resolve_transaction_datetime(TODAY, TODAY, START) is None

    def test_a_past_day_is_recorded_at_midday(self):
        assert resolve_transaction_datetime(date(2026, 9, 28), TODAY, START) == datetime(2026, 9, 28, 12, 0)

    def test_the_first_day_of_the_budget_is_allowed(self):
        assert resolve_transaction_datetime(START, TODAY, START) == datetime.combine(START, time(12, 0))

    def test_future_dates_are_refused(self):
        with pytest.raises(ValueError):
            resolve_transaction_datetime(date(2026, 9, 30), TODAY, START)

    def test_dates_before_the_budget_started_are_refused(self):
        with pytest.raises(ValueError):
            resolve_transaction_datetime(date(2026, 8, 31), TODAY, START)


class TestResolveEditDatetime:
    NOW = datetime(2026, 9, 29, 14, 30)

    def test_unchanged_when_no_date_is_sent(self):
        assert resolve_edit_datetime(None, date(2026, 9, 10), TODAY, START, self.NOW) is None

    def test_unchanged_when_the_date_is_the_one_it_already_has(self):
        assert resolve_edit_datetime(date(2026, 9, 10), date(2026, 9, 10), TODAY, START, self.NOW) is None

    def test_moving_to_today_uses_now(self):
        assert resolve_edit_datetime(TODAY, date(2026, 9, 10), TODAY, START, self.NOW) == self.NOW

    def test_moving_to_a_past_day_uses_midday(self):
        assert resolve_edit_datetime(date(2026, 9, 5), date(2026, 9, 10), TODAY, START, self.NOW) == datetime(2026, 9, 5, 12, 0)

    def test_moving_into_the_future_is_refused(self):
        with pytest.raises(ValueError):
            resolve_edit_datetime(date(2026, 10, 1), date(2026, 9, 10), TODAY, START, self.NOW)


# ---------------------------------------------------------------------------
# Editing a recorded spend
# ---------------------------------------------------------------------------

class TestCalculateTransactionEdit:
    def test_same_amount_changes_nothing(self):
        assert calculate_transaction_edit(D("400"), D("50"), D("50"), D("1000"), D("600")) == D("400")

    def test_a_bigger_amount_is_spent_like_a_new_purchase(self):
        # R50 became R80: R30 more comes out.
        assert calculate_transaction_edit(D("400"), D("50"), D("80"), D("1000"), D("630")) == D("370")

    def test_a_bigger_amount_that_overspends_floors_at_zero(self):
        assert calculate_transaction_edit(D("20"), D("50"), D("120"), D("1000"), D("1050")) == D("0")

    def test_a_smaller_amount_refunds_the_difference(self):
        # R80 -> R50 with R630 spent afterwards (so R660 before, R340 left): R30 comes back.
        assert calculate_transaction_edit(D("340"), D("80"), D("50"), D("1000"), D("630")) == D("370")

    def test_reducing_part_of_an_overspend_cannot_create_money(self):
        # R1000 spendable, R1100 spent (remaining floored at 0). Trimming a spend by R50
        # still leaves R1050 spent, so nothing comes back.
        assert calculate_transaction_edit(D("0"), D("300"), D("250"), D("1000"), D("1050")) == D("0")

    def test_negative_amounts_are_refused(self):
        with pytest.raises(ValueError):
            calculate_transaction_edit(D("10"), D("5"), D("-1"), D("100"), D("0"))

"""Priority categories — the pure helpers behind the plan-my-priorities feature."""

from decimal import Decimal

import pytest

from app.budget_categories import (
    MAX_CATEGORIES,
    SUGGESTED_CATEGORIES,
    check_allocation,
    clean_category_name,
    dedupe_categories,
)

D = Decimal


def test_names_are_trimmed_and_inner_whitespace_collapsed():
    assert clean_category_name("  Airtime   &  data ") == "Airtime & data"
    assert clean_category_name("Tab\tname") == "Tab name"        # tabs and newlines count as spaces


@pytest.mark.parametrize("bad", ["", "   ", None, "x" * 61, "Bad\x00name", "Wild*card", "What?", "~tilde"])
def test_bad_names_are_refused(bad):
    with pytest.raises(ValueError):
        clean_category_name(bad)


def test_a_leading_formula_character_is_stripped():
    # Otherwise the name would run as a formula in the spreadsheet.
    assert clean_category_name("=SUM(A1)") == "SUM(A1)"
    assert clean_category_name("+cmd") == "cmd"
    assert clean_category_name("@home") == "home"


def test_a_name_that_is_only_formula_characters_is_refused():
    with pytest.raises(ValueError):
        clean_category_name("=+-@")


def test_duplicates_collapse_case_insensitively_keeping_the_first():
    out = dedupe_categories([("Groceries", D("500")), ("groceries", D("50")), ("Toiletries", None)])
    assert out == [("Groceries", D("500")), ("Toiletries", None)]


def test_too_many_categories_is_refused():
    with pytest.raises(ValueError):
        dedupe_categories([(f"Cat {i}", None) for i in range(MAX_CATEGORIES + 1)])


def test_allocation_within_the_spendable_amount_returns_the_sum():
    assert check_allocation([D("500"), None, D("250.50")], D("1000")) == D("750.50")


def test_allocation_exactly_equal_to_spendable_is_fine():
    assert check_allocation([D("600"), D("400")], D("1000")) == D("1000")


def test_over_allocation_says_by_how_much():
    with pytest.raises(ValueError) as err:
        check_allocation([D("800"), D("400")], D("1000"))
    assert "R200.00" in str(err.value)


def test_the_suggestions_are_valid_names_without_duplicates():
    cleaned = [clean_category_name(n) for n in SUGGESTED_CATEGORIES]
    assert cleaned == list(SUGGESTED_CATEGORIES)
    assert len({n.lower() for n in cleaned}) == len(cleaned)

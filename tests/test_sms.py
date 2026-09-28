"""
app/sms.py — pure text handling for SMS mode. No database, no FastAPI, so
these run in any environment (see tests/test_budget_split.py for the same
philosophy).
"""

from datetime import date
from decimal import Decimal

from app.sms import (
    balance_reply,
    cmp_reply,
    help_reply,
    near_reply,
    no_active_budget_reply,
    no_location_reply,
    not_found_reply,
    parse_command,
    today_reply,
    unknown_command_reply,
)


def test_parse_command_uppercases_and_splits_args():
    assert parse_command("cmp bread") == ("CMP", "bread")


def test_parse_command_with_no_args():
    assert parse_command("BAL") == ("BAL", "")


def test_parse_command_blank_defaults_to_help():
    assert parse_command("") == ("HELP", "")
    assert parse_command("   ") == ("HELP", "")


def test_parse_command_extra_whitespace_is_trimmed():
    assert parse_command("  cmp   maize meal  ") == ("CMP", "maize meal")


def test_help_reply_lists_every_command():
    reply = help_reply()
    for command in ("BAL", "TODAY", "CMP", "NEAR", "HELP"):
        assert command in reply


def test_no_active_budget_reply_says_so():
    assert "active budget" in no_active_budget_reply()


def test_balance_reply_normal_mode():
    reply = balance_reply(
        remaining=Decimal("1200.00"), days_left=16, mode="normal",
        next_payout=date(2026, 10, 8),
    )
    assert "R1200.00" in reply
    assert "16 days" in reply
    assert "survival" not in reply.lower()


def test_balance_reply_singular_day():
    reply = balance_reply(
        remaining=Decimal("50.00"), days_left=1, mode="normal",
        next_payout=date(2026, 10, 8),
    )
    assert "1 day to go" in reply
    assert "1 days" not in reply


def test_balance_reply_survival_mode_says_so():
    reply = balance_reply(
        remaining=Decimal("80.00"), days_left=16, mode="survival",
        next_payout=date(2026, 10, 8),
    )
    assert "survival mode" in reply.lower()


def test_today_reply_includes_tomorrow_when_present():
    reply = today_reply(
        daily_limit=Decimal("78.62"), remaining_today=Decimal("20.63"),
        tomorrow_limit=Decimal("78.62"), mode="normal",
    )
    assert "R20.63" in reply
    assert "tomorrow" in reply.lower()


def test_today_reply_omits_tomorrow_when_none():
    reply = today_reply(
        daily_limit=Decimal("240.00"), remaining_today=Decimal("240.00"),
        tomorrow_limit=None, mode="normal",
    )
    assert "tomorrow" not in reply.lower()


def test_today_reply_survival_mode_says_essentials_only():
    reply = today_reply(
        daily_limit=Decimal("12.50"), remaining_today=Decimal("0.00"),
        tomorrow_limit=Decimal("5.33"), mode="survival",
    )
    assert "essentials only" in reply.lower()


def test_not_found_reply_names_the_query():
    assert "bread" in not_found_reply("bread")


def test_cmp_reply_with_distance():
    reply = cmp_reply(
        product_name="Super Maize Meal", store_name="Shoprite Warwick",
        price=Decimal("40.49"), distance_km=0.6,
    )
    assert "R40.49" in reply
    assert "Shoprite Warwick" in reply
    assert "0.6km" in reply


def test_cmp_reply_without_distance():
    reply = cmp_reply(
        product_name="Bread", store_name="Online Store",
        price=Decimal("18.00"), distance_km=None,
    )
    assert "km" not in reply


def test_near_reply_lists_nearest_first():
    stores = [{"name": "Shoprite Warwick", "distance_km": 0.6}, {"name": "PnP Musgrave", "distance_km": 2.1}]
    reply = near_reply(stores)
    assert reply.index("Shoprite Warwick") < reply.index("PnP Musgrave")
    assert "0.6km" in reply and "2.1km" in reply


def test_near_reply_empty_list():
    assert "no stores" in near_reply([]).lower() or "nearby" in near_reply([]).lower()


def test_no_location_reply_points_to_profile():
    assert "profile" in no_location_reply().lower()


def test_unknown_command_reply_echoes_the_command_and_help():
    reply = unknown_command_reply("XYZ")
    assert "XYZ" in reply
    assert "BAL" in reply

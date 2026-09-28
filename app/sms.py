"""
SMS mode — pure text handling, no database.

`app/routers/sms.py` does the database work (loading the budget, searching
products, saving a notification); this module only turns that data into the
short, plain-text replies an SMS screen can show — and a real 160-character
SMS could carry unchanged. Kept pure and separate so the wording can be
unit-tested without a database (see tests/test_sms.py), the same split the
project already uses for app/budget_split.py and app/geo.py.

Commands a student can text (or type into the in-app SMS Mode screen, which
calls the same POST /sms/reply this wording comes from):

    HELP            this list
    BAL             what's left, and how many days it must last
    TODAY           today's allowance
    CMP <item>      the cheapest store selling it right now
    NEAR            the closest stores to your saved location
"""

from __future__ import annotations

from decimal import Decimal
from typing import List, Optional, Tuple

COMMANDS_HELP = (
    "UniWallet SMS commands:\n"
    "BAL - your balance and days left\n"
    "TODAY - today's allowance\n"
    "CMP <item> - cheapest store for it\n"
    "NEAR - closest stores to you\n"
    "HELP - this list"
)

_KNOWN = {"HELP", "BAL", "TODAY", "CMP", "NEAR"}


def parse_command(text: str) -> Tuple[str, str]:
    """
    "cmp bread" -> ("CMP", "bread"). Blank input defaults to HELP, matching
    what a student texting the shortcode for the first time actually wants.
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return "HELP", ""
    parts = cleaned.split(maxsplit=1)
    command = parts[0].strip().upper()
    args = parts[1].strip() if len(parts) > 1 else ""
    return command, args


def help_reply() -> str:
    return COMMANDS_HELP


def no_active_budget_reply() -> str:
    return "You don't have an active budget yet. Set one up in UniWallet, then text BAL."


def balance_reply(*, remaining: Decimal, days_left: int, mode: str, next_payout) -> str:
    survival = " You're in survival mode - essentials only." if mode == "survival" else ""
    day_word = "day" if days_left == 1 else "days"
    return (
        f"Balance: R{remaining:.2f} left, {days_left} {day_word} to go "
        f"(next payout {next_payout}).{survival}"
    )


def today_reply(*, daily_limit: Decimal, remaining_today: Decimal, tomorrow_limit: Optional[Decimal], mode: str) -> str:
    survival = " Survival mode: essentials only." if mode == "survival" else ""
    tail = f" From tomorrow: R{tomorrow_limit:.2f}/day." if tomorrow_limit is not None else ""
    return f"Today: R{remaining_today:.2f} left of R{daily_limit:.2f}.{tail}{survival}"


def not_found_reply(query: str) -> str:
    return f"No store lists '{query}' right now. Try a shorter word, e.g. CMP bread."


def cmp_reply(*, product_name: str, store_name: str, price: Decimal, distance_km: Optional[float]) -> str:
    where = f", {distance_km:.1f}km away" if distance_km is not None else ""
    return f"Cheapest {product_name}: R{price:.2f} at {store_name}{where}."


def near_reply(stores: List[dict]) -> str:
    """`stores`: [{ name, distance_km }], nearest first, already limited."""
    if not stores:
        return "No stores with a saved location found nearby."
    lines = [f"{s['name']} ({s['distance_km']:.1f}km)" for s in stores]
    return "Nearest stores: " + "; ".join(lines)


def no_location_reply() -> str:
    return "Save your location in Profile first, then text NEAR."


def unknown_command_reply(command: str) -> str:
    return f"'{command}' isn't a command I know. " + COMMANDS_HELP

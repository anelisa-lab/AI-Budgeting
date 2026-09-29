"""
Priority categories for a budget — pure helpers, no database, no FastAPI.

A student lists the categories that matter this cycle ("Groceries",
"Toiletries", "Transport"...) and, optionally, how much they plan to give each.
The same list drives three things:

  * the dashboard's "planned vs spent" bars (budget_categories table),
  * the spreadsheet template the student can download (app/budget_template.py),
  * the category pick-list on the "record a spend" form.

Names are matched to transactions.category case-insensitively, so "groceries"
typed here and "Groceries" chosen on the spend form are the same category.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Iterable, List, Optional, Tuple

MAX_CATEGORIES = 25
MAX_NAME_LENGTH = 60

# Offered as one-tap suggestions; students can add their own.
SUGGESTED_CATEGORIES = (
    "Groceries",
    "Toiletries",
    "Transport",
    "Airtime & data",
    "Stationery",
    "Cleaning supplies",
    "Laundry",
    "Emergencies",
)


def clean_category_name(name: object) -> str:
    """Trim, collapse inner whitespace, and refuse empty / oversized / control-character names."""
    text = " ".join(str(name or "").split())
    if not text:
        raise ValueError("A category needs a name.")
    if len(text) > MAX_NAME_LENGTH:
        raise ValueError(f"Keep category names under {MAX_NAME_LENGTH} characters.")
    if any(ord(ch) < 32 for ch in text):
        raise ValueError("Category names cannot contain control characters.")
    # * ? ~ are wildcards in a spreadsheet's SUMIFS, which the template uses to
    # total each category — a name containing one would match the wrong rows.
    if any(ch in text for ch in "*?~"):
        raise ValueError("Category names cannot contain * ? or ~.")
    # A leading = + - @ would be run as a formula when the name lands in a
    # spreadsheet cell; the template escapes it, but there is no reason to keep it.
    return text.lstrip("=+-@ ").strip() or _reject_formula_only()


def _reject_formula_only() -> str:
    raise ValueError("A category needs a name.")


def dedupe_categories(
    items: Iterable[Tuple[str, Optional[Decimal]]],
) -> List[Tuple[str, Optional[Decimal]]]:
    """Clean every name and drop later duplicates (case-insensitive), keeping order."""
    seen = set()
    out: List[Tuple[str, Optional[Decimal]]] = []
    for name, planned in items:
        cleaned = clean_category_name(name)
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append((cleaned, planned))
    if len(out) > MAX_CATEGORIES:
        raise ValueError(f"Choose at most {MAX_CATEGORIES} categories.")
    return out


def check_allocation(planned_amounts: Iterable[Optional[Decimal]], spendable: Decimal) -> Decimal:
    """
    Sum of the planned amounts, refusing a plan that gives away more than the
    student can spend. Returns the sum so the caller can show what is unallocated.
    """
    total = sum((Decimal(a) for a in planned_amounts if a is not None), Decimal("0"))
    if total > Decimal(spendable):
        raise ValueError(
            f"Your planned amounts add up to R{total:.2f}, which is R{total - Decimal(spendable):.2f} "
            f"more than the R{Decimal(spendable):.2f} you can spend."
        )
    return total

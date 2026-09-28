"""
Shared refresh logic used by both `python -m app.price_feed refresh --provider csv`
and the optional background scheduler (see scheduler.py). Kept separate from
__main__.py so the scheduler doesn't import a script module.
"""

from __future__ import annotations

from typing import List, Tuple

from app.database import get_connection
from app.price_feed.providers import CsvPriceProvider
from app.price_feed.refresh import (RefreshPlan, apply_plan, load_catalogue_offers,
                                    only_enabled_stores, plan_refresh)
from app.scrapers import enabled_stores


def run_csv_refresh(file: str, dry_run: bool = False) -> Tuple[RefreshPlan, List[str]]:
    """
    Refresh product_offers prices from the verified-prices CSV. Returns the
    plan and the list of store keys the CSV covers but LIVE_PRICE_STORES
    doesn't list (skipped, left exactly as they are).
    """
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            offers = load_catalogue_offers(cur)
            provider = CsvPriceProvider(file)
            listings = provider.fetch()
            listings, covered, skipped = only_enabled_stores(
                listings, provider.covered_stores(), enabled_stores())
            plan = plan_refresh(offers, listings, covered_stores=covered)
            if dry_run:
                conn.rollback()
            else:
                apply_plan(cur, plan)
            return plan, skipped
    finally:
        conn.close()

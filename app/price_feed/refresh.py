"""
Turn live listings into price updates — the pure half of the refresh.

plan_refresh() decides; apply_plan() writes. Keeping them apart means a
--dry-run shows exactly what would change, and the deciding is unit-tested.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Dict, Iterable, List, Sequence

from app.price_feed.matching import best_match
from app.price_feed.models import CatalogueOffer, LivePrice

# A matched price that moved more than this from what we hold is sent to
# review instead of being applied. Real shelf prices move; they rarely halve
# or double, and when they seem to, it is usually a mismatch (a 5 kg bag
# matched to a 2.5 kg product) or a promotion that needs a human look.
MAX_PRICE_JUMP = Decimal("0.60")


@dataclass
class PriceUpdate:
    offer_id: int
    old_price: Decimal
    new_price: Decimal
    source: str
    source_detail: str
    observed_at: object
    url: str = None
    title: str = ""


@dataclass
class RefreshPlan:
    updates: List[PriceUpdate] = field(default_factory=list)
    review: List[str] = field(default_factory=list)
    unmatched: List[str] = field(default_factory=list)
    stores_without_source: List[str] = field(default_factory=list)

    def summary(self) -> str:
        return (f"{len(self.updates)} to update, {len(self.review)} for review, "
                f"{len(self.unmatched)} unmatched, "
                f"{len(self.stores_without_source)} stores with no live source")


def plan_refresh(
    offers: Sequence[CatalogueOffer],
    listings: Iterable[LivePrice],
    covered_stores: Iterable[str] = (),
) -> RefreshPlan:
    by_store: Dict[str, List[LivePrice]] = {}
    for listing in listings:
        by_store.setdefault(listing.store_key, []).append(listing)
    covered = set(covered_stores) | set(by_store)

    plan = RefreshPlan()
    plan.stores_without_source = sorted({o.store_key for o in offers} - covered)

    for offer in offers:
        if offer.store_key not in covered:
            continue
        label = f"#{offer.offer_id} {offer.product_name} ({offer.size}) @ {offer.store_key}"
        listing, reason = best_match(offer, by_store.get(offer.store_key, []))
        if listing is None:
            (plan.review if reason.startswith("ambiguous") else plan.unmatched).append(f"{label}: {reason}")
            continue
        if listing.price <= 0:
            plan.review.append(f"{label}: source gave R{listing.price}")
            continue
        if offer.price > 0:
            jump = abs(listing.price - offer.price) / offer.price
            if jump > MAX_PRICE_JUMP:
                plan.review.append(
                    f"{label}: R{offer.price} -> R{listing.price} ({jump:.0%} change) "
                    f"from '{listing.title}' — check before applying"
                )
                continue
        plan.updates.append(PriceUpdate(
            offer_id=offer.offer_id, old_price=offer.price, new_price=listing.price,
            source=listing.source, source_detail=listing.source_detail,
            observed_at=listing.observed_at, url=listing.url, title=listing.title,
        ))
    return plan


# ---------------------------------------------------------------------------
# Database side — takes an open cursor, like app.geo.fetch_user_location
# ---------------------------------------------------------------------------

LOAD_OFFERS_SQL = """
    SELECT o.id AS offer_id, s.external_store_id AS store_key,
           p.name AS product_name, p.brand, p.size, o.price, o.price_source
    FROM product_offers o
    JOIN products p ON p.id = o.product_id
    JOIN stores s ON s.id = o.store_id
    WHERE s.external_store_id IS NOT NULL
    ORDER BY o.id
"""


def load_catalogue_offers(cur) -> List[CatalogueOffer]:
    cur.execute(LOAD_OFFERS_SQL)
    return [
        CatalogueOffer(
            offer_id=r["offer_id"], store_key=r["store_key"], product_name=r["product_name"],
            brand=r["brand"], size=r["size"], price=Decimal(r["price"]),
            price_source=r["price_source"],
        )
        for r in cur.fetchall()
    ]


def apply_plan(cur, plan: RefreshPlan) -> int:
    """Write the updates and keep a history row for each. Returns rows changed."""
    for u in plan.updates:
        cur.execute(
            """UPDATE product_offers
                  SET price = %s, price_source = %s, price_source_detail = %s,
                      price_verified_at = %s, last_checked_at = NOW(),
                      product_url = COALESCE(%s, product_url)
                WHERE id = %s""",
            (u.new_price, u.source, u.source_detail, u.observed_at, u.url, u.offer_id),
        )
        cur.execute(
            """INSERT INTO offer_price_history
                   (offer_id, price, price_source, source_detail, source_title, observed_at)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (u.offer_id, u.new_price, u.source, u.source_detail, u.title, u.observed_at),
        )
    return len(plan.updates)

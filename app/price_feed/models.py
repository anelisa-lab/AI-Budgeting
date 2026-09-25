"""The shape every price source is turned into."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Optional


@dataclass(frozen=True)
class LivePrice:
    """One product listing, as a live source reported it."""

    store_key: str                    # our stores.external_store_id, e.g. 'checkers'
    title: str                        # the retailer's own product title
    price: Decimal
    observed_at: datetime
    source: str                       # 'live_api' | 'verified_manual'
    source_detail: str = ""           # provider name, or who verified it
    brand: Optional[str] = None
    size: Optional[str] = None
    url: Optional[str] = None
    on_promotion: bool = False


@dataclass(frozen=True)
class CatalogueOffer:
    """One of OUR product_offers rows, as the refresh needs it."""

    offer_id: int
    store_key: str
    product_name: str
    brand: Optional[str]
    size: Optional[str]
    price: Decimal
    price_source: str = "seed_estimate"

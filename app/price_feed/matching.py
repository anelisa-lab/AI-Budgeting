"""
Match a retailer's listing to one of our products — conservatively.

The one failure this module exists to prevent: attaching the price of the
WRONG product. "Albany Brown Bread 600g" is not our "Albany Brown Bread 700g",
and a 5 kg maize meal is not our 2.5 kg one. A wrong live price is worse than
an honest estimate, because the app would then call it confirmed.

So a listing only matches when:
  * the brand is in the title (when we know the brand),
  * the size is the same quantity after normalising units ("2,5 kg" = "2.5kg"
    = "2500g"; "18 pack" = "18s"), when both sides state one,
  * enough of our product-name words are in the title (MIN_NAME_COVERAGE),
and best_match() refuses to choose between two listings that match equally
well but disagree on price.
"""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Iterable, Optional, Tuple

from app.price_feed.models import CatalogueOffer, LivePrice

MIN_NAME_COVERAGE = 0.75
STOP = {"the", "and", "&", "in", "of", "with", "a", "loose"}

_UNITS = {
    "kg": ("g", 1000), "g": ("g", 1), "gram": ("g", 1), "grams": ("g", 1),
    "l": ("ml", 1000), "litre": ("ml", 1000), "liter": ("ml", 1000), "ml": ("ml", 1),
    "s": ("count", 1), "pack": ("count", 1), "pk": ("count", 1), "x": ("count", 1),
    "sheets": ("sheets", 1), "page": ("pages", 1), "pages": ("pages", 1),
    "gb": ("gb", 1), "mah": ("mah", 1),
}


def normalise_size(text: Optional[str]) -> Optional[Tuple[str, Decimal]]:
    """'2,5 kg' -> ('g', 2500). None when no recognisable quantity is present."""
    if not text:
        return None
    t = text.lower().replace(",", ".")
    # multipacks: "5 x 73g" -> 365 g
    multi = re.search(r"(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b", t)
    if multi:
        unit, factor = _UNITS[multi.group(3)]
        return unit, Decimal(multi.group(1)) * Decimal(multi.group(2)) * factor
    m = re.search(r"(\d+(?:\.\d+)?)\s*(kg|grams?|g|litre|liter|l|ml|s|pack|pk|sheets|pages?|gb|mah)\b", t)
    if not m:
        return None
    unit, factor = _UNITS[m.group(2)]
    return unit, (Decimal(m.group(1)) * factor).normalize()


def _words(text: str) -> set:
    return {w for w in re.findall(r"[a-z0-9]+", (text or "").lower()) if w not in STOP}


def _stem(word: str) -> str:
    return word[:-1] if len(word) > 3 and word.endswith("s") else word


def match_score(product: CatalogueOffer, listing: LivePrice) -> float:
    """0.0 (not this product) to 1.0 (certainly this product)."""
    title = f"{listing.brand or ''} {listing.title} {listing.size or ''}"
    title_words = {_stem(w) for w in _words(title)}

    if product.brand and product.brand.lower() not in {"loose", "n/a"}:
        brand_words = {_stem(w) for w in _words(product.brand)}
        if not brand_words <= title_words:
            return 0.0

    ours = normalise_size(product.size)
    theirs = normalise_size(listing.size) or normalise_size(listing.title)
    if ours and theirs and ours != theirs:
        return 0.0

    name_words = {_stem(w) for w in _words(product.product_name)}
    if not name_words:
        return 0.0
    coverage = len(name_words & title_words) / len(name_words)
    if coverage < MIN_NAME_COVERAGE:
        return 0.0
    # A stated, agreeing size is worth more than an unknown one.
    return round(0.8 * coverage + (0.2 if ours and theirs else 0.0), 4)


def best_match(product: CatalogueOffer, listings: Iterable[LivePrice]) -> Tuple[Optional[LivePrice], str]:
    """
    (listing, reason). listing is None when nothing matches or when the call
    is too close to make — reason says which, for the review report.
    """
    scored = sorted(
        ((match_score(product, l), l) for l in listings),
        key=lambda pair: pair[0], reverse=True,
    )
    scored = [(s, l) for s, l in scored if s > 0]
    if not scored:
        return None, "no listing matched brand, size and name"
    top_score, top = scored[0]
    rivals = [l for s, l in scored[1:] if top_score - s < 0.05 and l.price != top.price]
    if rivals:
        return None, (f"ambiguous: '{top.title}' R{top.price} vs "
                      f"'{rivals[0].title}' R{rivals[0].price}")
    return top, f"matched '{top.title}' (score {top_score})"

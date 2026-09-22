"""Explainable, rule-based product ranking."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Callable, Dict, List, Optional, Sequence

from app.geo import distance_between, proximity_score, within_radius
from app.query_parser import ParsedQuery
from app.true_cost import Offer, TrueCostBreakdown, money, store_true_cost

DEFAULT_WEIGHTS = {"budget_fit": .35, "price_value": .20, "preference_match": .20,
                   "proximity": .15, "rating": .07, "freshness": .03}


@dataclass
class Candidate:
    offer_id: int
    product_id: Optional[int] = None
    product_name: str = ""
    brand: Optional[str] = None
    category: Optional[str] = None
    subcategory: Optional[str] = None
    colour: Optional[str] = None
    size: Optional[str] = None
    is_essential: bool = False
    store_id: Optional[int] = None
    store_name: Optional[str] = None
    store_type: str = "online"
    store_latitude: Optional[float] = None
    store_longitude: Optional[float] = None
    price: Decimal = Decimal("0")
    shipping_cost: Decimal = Decimal("0")
    currency: str = "ZAR"
    availability_status: str = "available"
    rating: Optional[Decimal] = None
    rating_count: int = 0
    last_updated: Optional[datetime] = None
    product_url: Optional[str] = None

    @classmethod
    def from_row(cls, row):
        return cls(
            offer_id=row["offer_id"], product_id=row.get("product_id"),
            product_name=row.get("product_name") or "", brand=row.get("brand"),
            category=row.get("category"), subcategory=row.get("subcategory"),
            colour=row.get("colour"), size=row.get("size"),
            is_essential=bool(row.get("is_essential")), store_id=row.get("store_id"),
            store_name=row.get("store_name"), store_type=row.get("store_type") or "online",
            store_latitude=float(row["store_latitude"]) if row.get("store_latitude") is not None else None,
            store_longitude=float(row["store_longitude"]) if row.get("store_longitude") is not None else None,
            price=money(row.get("price")), shipping_cost=money(row.get("shipping_cost")),
            currency=row.get("currency") or "ZAR", availability_status=row.get("availability_status") or "unknown",
            rating=Decimal(str(row["rating"])) if row.get("rating") is not None else None,
            rating_count=int(row.get("rating_count") or 0), last_updated=row.get("last_updated"),
            product_url=row.get("product_url"),
        )

    def to_offer(self):
        return Offer(self.offer_id, self.price, self.shipping_cost, self.currency,
                     self.store_id, self.store_name, self.store_type, self.product_name)


@dataclass
class UserContext:
    remaining_amount: Optional[Decimal] = None
    daily_limit: Optional[Decimal] = None
    budget_mode: str = "normal"
    preferred_categories: Sequence[str] = ()
    preferred_stores: Sequence[str] = ()
    preferred_brands: Sequence[str] = ()
    preferred_colours: Sequence[str] = ()
    preferred_sizes: Sequence[str] = ()
    max_distance_km: Optional[float] = None
    require_available: bool = True
    essential_only: bool = False
    location: Optional[tuple] = None
    currency: str = "ZAR"


@dataclass
class ScoredOffer:
    candidate: Candidate
    breakdown: TrueCostBreakdown
    score: float
    components: Dict[str, float]
    rank: int = 0
    meets_budget: bool = False
    meets_preferences: bool = False
    distance_km: Optional[float] = None
    explanation: str = ""
    reasons: List[str] = field(default_factory=list)

    @property
    def true_cost(self):
        return self.breakdown.true_cost


def budget_fit_score(cost, remaining, daily_limit=None):
    if remaining is None:
        return 0.5
    remaining, cost = money(remaining), money(cost)
    if remaining <= 0 or cost > remaining:
        return 0.0
    if daily_limit and money(daily_limit) > 0 and cost <= money(daily_limit):
        return 1.0
    return round(max(.85 - .55 * float(cost / remaining), 0), 4)


def price_value_score(cost, cheapest, dearest):
    cost, cheapest, dearest = money(cost), money(cheapest), money(dearest)
    return 1.0 if dearest <= cheapest else round(max(0, min(1, 1 - float((cost - cheapest) / (dearest - cheapest)))), 4)


def rating_score(rating, count=0, rating_count=None):
    if rating_count is not None:
        count = rating_count
    if rating is None:
        return 0.5
    confidence = min(max(int(count), 0) / 20, 1)
    return round((float(rating) / 5) * confidence + .5 * (1 - confidence), 4)


def freshness_score(updated, now=None):
    if not updated:
        return 0.3
    now = now or datetime.now(timezone.utc)
    if updated.tzinfo is None:
        updated = updated.replace(tzinfo=timezone.utc)
    age = max((now - updated).total_seconds() / 86400, 0)
    return round(max(0, 1 - age / 30), 4)


def _matches(value, allowed):
    return bool(value and allowed and any(str(value).strip().lower() == str(x).strip().lower() for x in allowed))


def preference_match_score(candidate, context, parsed=None):
    applicable = matched = 0
    reasons = []
    saved_hits = []
    for allowed, value, label in (
        (context.preferred_categories, candidate.category, "category"),
        (context.preferred_stores, candidate.store_name, "store"),
        (context.preferred_brands, candidate.brand, "brand"),
        (context.preferred_colours, candidate.colour, "colour"),
        (context.preferred_sizes, candidate.size, "size"),
    ):
        if allowed:
            applicable += 1
            if _matches(value, allowed):
                matched += 1
                saved_hits.append(f"{label} {value}")
    if parsed:
        for wanted, value in ((parsed.category, candidate.category), (parsed.subcategory, candidate.subcategory),
                              (parsed.colour, candidate.colour), (parsed.size, candidate.size)):
            if wanted:
                applicable += 1
                if value and str(value).lower() == str(wanted).lower():
                    matched += 1
    if saved_hits:
        reasons.append("matches your saved " + ", ".join(saved_hits))
    return (0.5 if not applicable else round(matched / applicable, 4)), reasons


def _distance(candidate, context):
    return distance_between(context.location, (candidate.store_latitude, candidate.store_longitude)) if candidate.store_type != "online" else None


def _passes(candidate, context, parsed, distance):
    if context.require_available and candidate.availability_status != "available":
        return False
    if context.essential_only and not candidate.is_essential:
        return False
    if context.budget_mode == "survival" and not candidate.is_essential:
        return False
    if parsed:
        for wanted, value in ((parsed.category, candidate.category), (parsed.colour, candidate.colour), (parsed.size, candidate.size)):
            if wanted and (not value or str(value).lower() != str(wanted).lower()):
                return False
        if parsed.subcategory and candidate.subcategory and candidate.subcategory.lower() != parsed.subcategory.lower():
            return False
        if parsed.nearby_only and candidate.store_type != "online" and not within_radius(distance, context.max_distance_km or 5):
            return False
    return candidate.store_type == "online" or within_radius(distance, context.max_distance_km)


def recommend(candidates: Sequence[Candidate], context: UserContext, parsed: Optional[ParsedQuery] = None,
              *, pricer: Optional[Callable] = None, weights=None, limit=10,
              include_unaffordable=True, now=None):
    weights = {**DEFAULT_WEIGHTS, **(weights or {})}
    pricer = pricer or (lambda candidate, _: store_true_cost(candidate.to_offer()))
    now = now or datetime.now(timezone.utc)
    priced = []
    for candidate in candidates:
        distance = _distance(candidate, context)
        if not _passes(candidate, context, parsed, distance):
            continue
        breakdown = pricer(candidate, context)
        if not include_unaffordable and context.remaining_amount is not None and breakdown.true_cost > money(context.remaining_amount):
            continue
        priced.append((candidate, breakdown, distance))
    if not priced:
        return []
    costs = [item[1].true_cost for item in priced]
    results = []
    for candidate, breakdown, distance in priced:
        pref, reasons = preference_match_score(candidate, context, parsed)
        components = {
            "budget_fit": budget_fit_score(breakdown.true_cost, context.remaining_amount, context.daily_limit),
            "price_value": price_value_score(breakdown.true_cost, min(costs), max(costs)),
            "preference_match": pref,
            "proximity": .6 if candidate.store_type == "online" else proximity_score(distance, context.max_distance_km),
            "rating": rating_score(candidate.rating, candidate.rating_count),
            "freshness": freshness_score(candidate.last_updated, now),
        }
        score = round(sum(components[key] * weights.get(key, 0) for key in components), 5)
        affordable = context.remaining_amount is not None and breakdown.true_cost <= money(context.remaining_amount)
        headline = (f"fits today's R{money(context.daily_limit)} allowance" if context.daily_limit and breakdown.true_cost <= money(context.daily_limit) else
                    "within your remaining budget" if affordable else
                    f"R{money(breakdown.true_cost - money(context.remaining_amount))} over your remaining budget"
                    if context.remaining_amount is not None else "no active budget")
        reasons = [headline, *reasons]
        if distance is not None:
            reasons.append(f"{distance:.1f} km away")
        elif candidate.store_type == "online":
            reasons.append("delivered, no travel")
        hidden = (
            f" (R{breakdown.hidden_cost} of that is delivery and fees)"
            if breakdown.hidden_cost > 0 else ""
        )
        explanation = f"R{breakdown.true_cost} all in at {candidate.store_name or 'this store'}{hidden} — {'; '.join(reasons[:4])}."
        results.append(ScoredOffer(candidate, breakdown, score, components, meets_budget=affordable,
                                   meets_preferences=bool(reasons[1:]), distance_km=distance,
                                   explanation=explanation, reasons=reasons))
    results.sort(key=lambda item: (not item.meets_budget, -item.score, item.true_cost, item.candidate.offer_id))
    for rank, item in enumerate(results[:limit], 1):
        item.rank = rank
    return results[:limit]
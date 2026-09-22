"""
Rule-based recommendation engine — Member 5.

Phase 1 spec: score by budget fit, category match and distance.
Phase 2/3 implementation: six weighted components, scored 0–1 each and
combined into a single 0–1 score.

    component          weight   what it rewards
    ---------------------------------------------------------------
    budget_fit          0.35    fits today's allowance, then the cycle
    price_value         0.20    cheap relative to the other candidates
    preference_match    0.20    matches saved preferences and the query
    proximity           0.15    close enough to actually go and get
    rating              0.07    other people rated it well
    freshness           0.03    the price was checked recently
                        ----
                        1.00

Two things make this more than a sort-by-price:

1.  It ranks on TRUE cost (Member 6's store_true_cost), not sticker price. A
    R199 item with a R60 delivery fee loses to a R240 item with free
    collection, which is the correct answer for a student with R300 left.
2.  budget_fit is scored against the DAILY allowance, not just the balance.
    Something affordable this month but equal to four days of food is not a
    good recommendation on day 3 of a 30-day cycle.

Every ranked result carries an `explanation` string. That is a deliberate
requirement, not decoration: a budgeting app that tells a struggling student
"buy this" without saying why has not earned the trust to be followed.

Why rule-based rather than a trained model: no labelled data exists (the app
has no users yet), the seed dataset is 30–50 items, and a scoring function
you can read is one you can defend in a demo. The weights live in
DEFAULT_WEIGHTS and can be tuned in one place — see Phase 4, "tune scoring
based on integration-test results".

Pure Python — no database, no FastAPI. app/routers/recommendations.py does
the SQL and hands rows in here. Tests: tests/test_recommender.py.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Callable, Dict, List, Optional, Sequence

from app.geo import distance_between, proximity_score, within_radius
from app.query_parser import ParsedQuery
from app.true_cost import Offer, TrueCostBreakdown, money, store_true_cost

ZERO = Decimal("0.00")

DEFAULT_WEIGHTS: Dict[str, float] = {
    "budget_fit": 0.35,
    "price_value": 0.20,
    "preference_match": 0.20,
    "proximity": 0.15,
    "rating": 0.07,
    "freshness": 0.03,
}

# A price older than this scores zero for freshness.
FRESHNESS_HORIZON_DAYS = 30.0

# An online store needs no travel, so it scores slightly above neutral on
# proximity rather than being punished for having no coordinates.
ONLINE_STORE_PROXIMITY = 0.6


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


@dataclass
class Candidate:
    """One product offer being considered. Mirrors a /search result row."""

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
    price: Decimal = ZERO
    shipping_cost: Decimal = ZERO
    currency: str = "ZAR"
    availability_status: str = "available"
    rating: Optional[Decimal] = None
    rating_count: int = 0
    last_updated: Optional[datetime] = None
    product_url: Optional[str] = None

    @classmethod
    def from_row(cls, row) -> "Candidate":
        """Build from a psycopg2 RealDictCursor row."""
        def num(key):
            value = row.get(key)
            return float(value) if value is not None else None

        return cls(
            offer_id=row["offer_id"],
            product_id=row.get("product_id"),
            product_name=row.get("product_name") or "",
            brand=row.get("brand"),
            category=row.get("category"),
            subcategory=row.get("subcategory"),
            colour=row.get("colour"),
            size=row.get("size"),
            is_essential=bool(row.get("is_essential")),
            store_id=row.get("store_id"),
            store_name=row.get("store_name"),
            store_type=row.get("store_type") or "online",
            store_latitude=num("store_latitude"),
            store_longitude=num("store_longitude"),
            price=money(row.get("price")),
            shipping_cost=money(row.get("shipping_cost") or 0),
            currency=row.get("currency") or "ZAR",
            availability_status=row.get("availability_status") or "unknown",
            rating=row.get("rating"),
            rating_count=row.get("rating_count") or 0,
            last_updated=row.get("last_updated"),
            product_url=row.get("product_url"),
        )

    def to_offer(self) -> Offer:
        """Hand off to Member 6's true-cost calculator."""
        return Offer(
            offer_id=self.offer_id,
            price=self.price,
            shipping_cost=self.shipping_cost,
            currency=self.currency,
            store_id=self.store_id,
            store_name=self.store_name,
            store_type=self.store_type,
            product_name=self.product_name,
        )


@dataclass
class UserContext:
    """Everything known about the student at the moment they search."""

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
    location: Optional[tuple] = None          # (lat, lng)
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
    def true_cost(self) -> Decimal:
        return self.breakdown.true_cost


# ---------------------------------------------------------------------------
# Component scores — each returns 0.0 to 1.0
# ---------------------------------------------------------------------------


def budget_fit_score(
    true_cost: Decimal,
    remaining_amount: Optional[Decimal],
    daily_limit: Optional[Decimal] = None,
) -> float:
    """
    How comfortably this purchase fits the student's money.

        1.00  fits inside today's allowance — buy it today, nothing breaks
        0.85  costs almost nothing relative to the cycle
        0.30  affordable, but eats the entire remaining balance
        0.00  unaffordable, or there is no money left

    The jump to 1.0 at the daily limit is intentional: "you can afford this
    today without borrowing from tomorrow" is a genuinely different answer
    from "you can afford this, but it's four days of food".
    """
    if remaining_amount is None:
        return 0.5                       # no budget set — stay neutral
    remaining = money(remaining_amount)
    cost = money(true_cost)

    if remaining <= 0 or cost > remaining:
        return 0.0
    if daily_limit and money(daily_limit) > 0 and cost <= money(daily_limit):
        return 1.0

    share = float(cost / remaining) if remaining > 0 else 1.0
    return round(max(0.85 - 0.55 * share, 0.0), 4)


def price_value_score(true_cost: Decimal, cheapest: Decimal, dearest: Decimal) -> float:
    """
    Cheapness relative to the other candidates: 1.0 for the cheapest option
    found, 0.0 for the dearest, linear in between. When everything costs the
    same, everything scores 1.0 — price is then not a differentiator.
    """
    cheapest, dearest, cost = money(cheapest), money(dearest), money(true_cost)
    if dearest <= cheapest:
        return 1.0
    ratio = float((cost - cheapest) / (dearest - cheapest))
    return round(max(0.0, min(1.0, 1.0 - ratio)), 4)


def _matches(value: Optional[str], allowed: Sequence[str]) -> bool:
    if not value or not allowed:
        return False
    needle = value.strip().lower()
    return any(needle == str(a).strip().lower() for a in allowed if a)


def preference_match_score(
    candidate: Candidate,
    context: UserContext,
    parsed: Optional[ParsedQuery] = None,
) -> tuple:
    """
    Fraction of the signals that actually apply which this offer matches.

    Returns (score, reasons). Only signals the student has expressed count
    towards the denominator, so someone who saved no preferences and typed a
    bare keyword isn't penalised — they score a neutral 0.5.
    """
    applicable = 0
    matched = 0
    saved_hits: List[str] = []
    query_hits: List[str] = []

    checks = [
        (context.preferred_categories, candidate.category, "category"),
        (context.preferred_stores, candidate.store_name, "store"),
        (context.preferred_brands, candidate.brand, "brand"),
        (context.preferred_colours, candidate.colour, "colour"),
        (context.preferred_sizes, candidate.size, "size"),
    ]
    for allowed, value, label in checks:
        if not allowed:
            continue
        applicable += 1
        if _matches(value, allowed):
            matched += 1
            saved_hits.append(f"{label} {value}")

    if parsed:
        query_checks = [
            (parsed.category, candidate.category),
            (parsed.subcategory, candidate.subcategory),
            (parsed.colour, candidate.colour),
            (parsed.size, candidate.size),
        ]
        for wanted, value in query_checks:
            if not wanted:
                continue
            applicable += 1
            if value and str(value).strip().lower() == str(wanted).strip().lower():
                matched += 1
                query_hits.append(str(value))

    # Collapsed into at most two phrases. Listing five separate matches would
    # push the useful parts of the explanation past where anyone reads.
    reasons: List[str] = []
    if saved_hits:
        reasons.append("matches your saved " + ", ".join(saved_hits))
    if query_hits:
        reasons.append(" / ".join(query_hits) + " — exactly what you searched for")

    if applicable == 0:
        return 0.5, reasons
    return round(matched / applicable, 4), reasons


def rating_score(rating: Optional[Decimal], rating_count: int = 0) -> float:
    """
    Rating out of 5, normalised. An unrated offer scores a neutral 0.5 rather
    than 0 — no reviews is not the same as bad reviews.

    A rating backed by fewer than 3 reviews is pulled halfway towards neutral,
    because one enthusiastic review is not evidence.
    """
    if rating is None:
        return 0.5
    base = float(rating) / 5.0
    base = max(0.0, min(1.0, base))
    if rating_count < 3:
        base = (base + 0.5) / 2
    return round(base, 4)


def freshness_score(last_updated: Optional[datetime], now: Optional[datetime] = None) -> float:
    """
    How recently the price was checked. Decays linearly to 0 over 30 days.
    A price nobody has verified in a month should not win on being cheap.
    """
    if last_updated is None:
        return 0.3
    now = now or datetime.now(timezone.utc)
    if last_updated.tzinfo is None:
        last_updated = last_updated.replace(tzinfo=timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    age_days = (now - last_updated).total_seconds() / 86400.0
    if age_days <= 0:
        return 1.0
    return round(max(0.0, 1.0 - age_days / FRESHNESS_HORIZON_DAYS), 4)


# ---------------------------------------------------------------------------
# Filtering and ranking
# ---------------------------------------------------------------------------


def _distance_for(candidate: Candidate, context: UserContext) -> Optional[float]:
    if candidate.store_type == "online":
        return None
    return distance_between(
        context.location, (candidate.store_latitude, candidate.store_longitude)
    )


def passes_hard_filters(
    candidate: Candidate,
    context: UserContext,
    parsed: Optional[ParsedQuery] = None,
    distance_km: Optional[float] = None,
) -> bool:
    """
    The rules that are not negotiable, applied before anything is scored.

    Scoring an out-of-stock item at 0.9 and showing it anyway would be worse
    than not showing it, so these drop the row entirely.
    """
    if context.require_available and candidate.availability_status != "available":
        return False

    # Survival mode is a hard stop on non-essentials. This is the feature
    # doing its job: a student down to their last R80 should not be shown
    # sneakers, however well they score.
    if (context.essential_only or context.budget_mode == "survival") and not candidate.is_essential:
        return False

    if parsed and parsed.essential_only and not candidate.is_essential:
        return False

    # Attributes the student named explicitly are requirements, not preferences.
    # Somebody who asked for a BLACK hoodie should not be shown a blue one
    # ranked first because it happens to be cheaper.
    #
    # These mirror the WHERE clause in routers/recommendations.py, on purpose:
    # the SQL keeps the candidate pool small, and these keep recommend() correct
    # on its own, so the ranking can't drift from the query that fed it. A
    # candidate with the attribute missing is dropped too, exactly as
    # `p.colour ILIKE 'black'` drops NULLs. Subcategory is deliberately NOT
    # here — seed data has gaps, and the SQL lets NULLs through as well.
    if parsed:
        for wanted, value in (
            (parsed.category, candidate.category),
            (parsed.colour, candidate.colour),
            (parsed.size, candidate.size),
        ):
            if wanted and (not value or str(value).strip().lower() != str(wanted).strip().lower()):
                return False

    if candidate.store_type != "online":
        limit = context.max_distance_km
        if parsed and parsed.nearby_only and limit is None:
            limit = 5.0                  # "near me" with no saved preference
        if not within_radius(distance_km, limit):
            return False

    return True


def _default_pricer(candidate: Candidate, context: UserContext) -> TrueCostBreakdown:
    """Price + shipping only — used when no store_charges are supplied."""
    return store_true_cost(candidate.to_offer())


def _explain(scored_reasons: List[str], breakdown: TrueCostBreakdown, candidate: Candidate) -> str:
    """One sentence a student can act on."""
    head = f"R{breakdown.true_cost} all in at {candidate.store_name or 'this store'}"
    if breakdown.hidden_cost > 0:
        head += f" (R{breakdown.hidden_cost} of that is delivery and fees)"
    if scored_reasons:
        return head + " — " + "; ".join(scored_reasons[:4]) + "."
    return head + "."


def recommend(
    candidates: Sequence[Candidate],
    context: UserContext,
    parsed: Optional[ParsedQuery] = None,
    *,
    pricer: Optional[Callable[[Candidate, UserContext], TrueCostBreakdown]] = None,
    weights: Optional[Dict[str, float]] = None,
    limit: int = 10,
    include_unaffordable: bool = True,
    now: Optional[datetime] = None,
) -> List[ScoredOffer]:
    """
    Rank offers for this student.

    Args:
        candidates:  offers to consider (from the search query).
        context:     budget, preferences and location.
        parsed:      the parsed query, if the student typed one.
        pricer:      (candidate, context) -> TrueCostBreakdown. The router
                     passes one that applies store_charges; the default is
                     price + shipping.
        weights:     override DEFAULT_WEIGHTS to re-tune ranking.
        limit:       how many results to return.
        include_unaffordable:
                     keep offers over the remaining balance (ranked last,
                     flagged meets_budget=False) so the student sees that the
                     thing exists and what it would cost. Set False to hide
                     them entirely.

    Returns:
        ScoredOffers, best first, with rank starting at 1.
    """
    weights = {**DEFAULT_WEIGHTS, **(weights or {})}
    pricer = pricer or _default_pricer
    now = now or datetime.now(timezone.utc)

    # Pass 1 — filter, and price whatever survives.
    priced: List[tuple] = []
    for candidate in candidates:
        distance_km = _distance_for(candidate, context)
        if not passes_hard_filters(candidate, context, parsed, distance_km):
            continue
        breakdown = pricer(candidate, context)
        if not include_unaffordable and context.remaining_amount is not None:
            if breakdown.true_cost > money(context.remaining_amount):
                continue
        priced.append((candidate, breakdown, distance_km))

    if not priced:
        return []

    costs = [b.true_cost for _, b, _ in priced]
    cheapest, dearest = min(costs), max(costs)

    # Pass 2 — score.
    scored: List[ScoredOffer] = []
    for candidate, breakdown, distance_km in priced:
        pref_score, reasons = preference_match_score(candidate, context, parsed)

        if candidate.store_type == "online":
            prox = ONLINE_STORE_PROXIMITY
        else:
            prox = proximity_score(distance_km, context.max_distance_km)

        components = {
            "budget_fit": budget_fit_score(
                breakdown.true_cost, context.remaining_amount, context.daily_limit
            ),
            "price_value": price_value_score(breakdown.true_cost, cheapest, dearest),
            "preference_match": pref_score,
            "proximity": prox,
            "rating": rating_score(candidate.rating, candidate.rating_count),
            "freshness": freshness_score(candidate.last_updated, now),
        }
        total = round(sum(components[k] * weights.get(k, 0.0) for k in components), 5)

        meets_budget = (
            context.remaining_amount is not None
            and breakdown.true_cost <= money(context.remaining_amount)
        )

        # Build the human-readable reasons in priority order.
        headline: List[str] = []
        if components["budget_fit"] >= 1.0:
            headline.append(f"fits today's R{money(context.daily_limit)} allowance")
        elif meets_budget:
            headline.append("within your remaining budget")
        elif context.remaining_amount is not None:
            over_by = money(breakdown.true_cost - money(context.remaining_amount))
            headline.append(f"R{over_by} over your remaining budget")

        headline.extend(reasons)
        if breakdown.true_cost == cheapest and len(priced) > 1:
            headline.append("cheapest true cost of everything found")
        if distance_km is not None:
            headline.append(f"{distance_km:.1f} km away")
        elif candidate.store_type == "online":
            headline.append("delivered, no travel")

        scored.append(
            ScoredOffer(
                candidate=candidate,
                breakdown=breakdown,
                score=total,
                components=components,
                meets_budget=meets_budget,
                meets_preferences=bool(reasons),
                distance_km=round(distance_km, 2) if distance_km is not None else None,
                reasons=headline,
                explanation=_explain(headline, breakdown, candidate),
            )
        )

    # Affordable options always outrank unaffordable ones, whatever the score:
    # a perfect match you cannot pay for is not a recommendation.
    scored.sort(
        key=lambda s: (not s.meets_budget, -s.score, s.true_cost, s.candidate.offer_id)
    )

    for index, item in enumerate(scored[:limit], start=1):
        item.rank = index
    return scored[:limit]

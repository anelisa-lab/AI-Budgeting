"""
Rule-based recommendation engine — Member 5.

Phase 1 spec: score by budget fit, category match and distance.
Phase 3 implementation: seven weighted components, scored 0–1 each and
combined into a single 0–1 score.

    component          weight   what it rewards
    ---------------------------------------------------------------
    relevance           0.22    matches the words the student typed
    budget_fit          0.30    fits today's allowance, then the cycle
    price_value         0.16    cheap relative to the other candidates
    preference_match    0.13    matches saved preferences and the query
    proximity           0.12    close enough to actually go and get
    rating              0.05    other people rated it well
    freshness           0.02    the price was checked recently
                        ----
                        1.00

`relevance` is new in Phase 3 and it fixed a bad bug. Phase 2 left keyword
matching entirely to the SQL, so within the rows SQL returned, the ranker had
no idea what had been searched for. Run against Member 9's real catalogue,
"maize meal" ranked Baked Beans first and "sanitary pads" ranked soap first:
both are cheap groceries near the student, and cheap-and-near was all the
scorer could see. Relevance both ranks and gates — an offer matching none of
the student's words is dropped rather than ranked low.

budget_fit keeps the largest single weight, because this is a budgeting app
before it is a search engine: among things that genuinely match, what you can
afford today should come first.

Two more things make this more than a sort-by-price:

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

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Callable, Dict, List, Optional, Sequence

from app.geo import distance_between, proximity_score, within_radius
from app.query_parser import ParsedQuery
from app.true_cost import Offer, TrueCostBreakdown, money, store_true_cost

ZERO = Decimal("0.00")

DEFAULT_WEIGHTS: Dict[str, float] = {
    "relevance": 0.22,
    "budget_fit": 0.30,
    "price_value": 0.16,
    "preference_match": 0.13,
    "proximity": 0.12,
    "rating": 0.05,
    "freshness": 0.02,
}

# ---------------------------------------------------------------------------
# Phase 4 tuning (Member 5) — driven by scripts/eval_recommender.py
# ---------------------------------------------------------------------------
#
# Integration testing showed proximity double-counting distance. When a
# student COLLECTS, travel is already inside true cost (app/geo.py), so a far
# store pays twice: once in rands through price_value and budget_fit, and
# again through proximity. When a student has it DELIVERED, distance costs
# them nothing at all — the courier fee is already in true cost — yet
# proximity still carried 12% of the score. Either way the result was the
# same: a dearer offer from a nearer store outranked a cheaper offer of the
# identical product, which is the one thing a budgeting app must not do.
#
# The weight proximity gives up goes to price_value. Everything else is
# unchanged. Weights still sum to 1.0 in both modes.
FULFILMENT_WEIGHT_SHIFTS: Dict[str, Dict[str, float]] = {
    # Distance is irrelevant to a delivery; the fee is in true cost already.
    "delivery": {"proximity": 0.00, "price_value": 0.28},
    # Travel is already costed in rands; keep a small nudge for time and
    # effort, which a taxi fare does not capture.
    "collection": {"proximity": 0.04, "price_value": 0.24},
}


def weights_for(fulfilment: Optional[str], base: Optional[Dict[str, float]] = None) -> Dict[str, float]:
    """The weights to score with, for how the student is getting the item."""
    weights = dict(base or DEFAULT_WEIGHTS)
    weights.update(FULFILMENT_WEIGHT_SHIFTS.get(fulfilment or "", {}))
    return weights


# Words that describe the FORM a product comes in rather than what it is.
# "Sunlight Soap Bar" is soap; "Margarine Spread" is margarine. Used by the
# head-noun rule in relevance_score().
FORM_WORDS = {"bar", "bars", "pack", "packs", "portions", "spread", "tin", "loaf"}

# Relevance for a keyword that hits the product name as a modifier rather
# than as the thing itself: "sugar" in "Sugar Beans".
MODIFIER_MATCH = 0.75

# How much each field a keyword can hit is worth. A hit on the product name is
# what the student actually meant; a hit on the category is the weakest kind of
# match ("groceries" matching 142 items tells you almost nothing).
RELEVANCE_FIELD_WEIGHTS = (
    ("product_name", 1.0),
    ("brand", 0.7),
    ("subcategory", 0.6),
    ("category", 0.5),
)

# A price older than this scores zero for freshness.
FRESHNESS_HORIZON_DAYS = 30.0

# An online store needs no travel, so it scores slightly above neutral on
# proximity rather than being punished for having no coordinates.
ONLINE_STORE_PROXIMITY = 0.6


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


def attribute_matches(wanted: str, value: Optional[str], product_name: str = "") -> bool:
    """
    True when a parsed colour/size is satisfied: the offer's attribute equals
    it, or the word appears in the product name ("Brown Bread", "Full Cream
    Milk"). Mirrors the SQL in routers/search.py and routers/recommendations.py.
    """
    wanted = str(wanted).strip().lower()
    if value and str(value).strip().lower() == wanted:
        return True
    return re.search(rf"\b{re.escape(wanted)}\b", (product_name or "").lower()) is not None


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
    # Phase 4: where the price came from, and when it was last confirmed
    # against a real source. A 'seed_estimate' has never been confirmed.
    price_source: str = "seed_estimate"
    price_verified_at: Optional[datetime] = None
    delivery_available: Optional[bool] = None
    collection_available: Optional[bool] = None

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
            price_source=row.get("price_source") or "seed_estimate",
            price_verified_at=row.get("price_verified_at"),
            delivery_available=row.get("delivery_available"),
            collection_available=row.get("collection_available"),
        )

    @property
    def price_is_estimate(self) -> bool:
        return self.price_source == "seed_estimate" or self.price_verified_at is None

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
            delivery_available=self.delivery_available,
            collection_available=self.collection_available,
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
    # Phase 4: how the student is getting it (drives the weights), and the
    # price ceiling / floor they set, enforced on TRUE cost.
    fulfilment: str = "delivery"
    max_price: Optional[Decimal] = None
    min_price: Optional[Decimal] = None


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
    # False when this came from the category fallback — the student's words
    # matched nothing, so this is the nearest aisle rather than the thing asked
    # for. The UI should label these differently.
    matched_query: bool = True
    # Phase 4: the product's head noun is one of the student's words — it IS
    # the thing searched for ("White Sugar" for "sugar"), rather than merely
    # containing the word ("Sugar Beans").
    names_query: bool = True

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


def _contains_word(haystack: str, needle: str) -> bool:
    """
    Whole-word match, not a bare substring.

    "phone" must not match "Wired Earphones" — with plain `in`, a search for
    "phone charger" ranked earphones first on the real catalogue, because
    "earphones" contains "phone". The catalogue has no charger at all, so the
    honest answer is no keyword match, which then hands over to the category
    fallback in recommend().
    """
    if not haystack or not needle:
        return False
    return re.search(rf"\b{re.escape(needle.lower())}\b", haystack) is not None


def relevance_score(candidate: Candidate, parsed: Optional[ParsedQuery] = None) -> float:
    """
    How well this offer matches the words the student actually typed.

    Scored per keyword against the best field it hits (name beats brand beats
    subcategory beats category), then averaged. A query with no keywords left
    after parsing scores a neutral 0.5 for everybody, so browsing is ranked on
    budget and price alone.

    This is the component that was missing in Phase 2, and its absence was not
    subtle: with a catalogue of 142 grocery offers, a search for "maize meal"
    ranked Baked Beans first, because nothing in the scoring function had any
    idea what the student had asked for. The SQL was filtering on the keywords
    and the ranker was not, so the ranker could only sort by price and
    distance — which is exactly what it did.
    """
    if not parsed or not parsed.keywords:
        return 0.5

    fields = {
        "product_name": (candidate.product_name or "").lower(),
        "brand": (candidate.brand or "").lower(),
        "subcategory": (candidate.subcategory or "").lower(),
        "category": (candidate.category or "").lower(),
    }

    head = _head_noun(candidate.product_name)

    total = 0.0
    for keyword in parsed.keywords:
        best = 0.0
        for field, weight in RELEVANCE_FIELD_WEIGHTS:
            if _contains_word(fields[field], keyword):
                best = weight
                # Phase 4 head-noun rule: "sugar" names the product in
                # "White Sugar" but only describes it in "Sugar Beans".
                # Integration testing found "sugar" recommending beans,
                # because both names contain the word and beans were cheaper.
                if field == "product_name" and head and not _is_head_match(keyword, head):
                    best = weight * MODIFIER_MATCH
                break
        total += best

    return round(total / len(parsed.keywords), 4)


def _head_noun(name: str) -> str:
    """
    The word that says what a product IS — the last word of its name, once
    form words ("bar", "spread") and pack sizes ("2-Ply") are stripped.
    """
    words = re.findall(r"[a-z0-9][a-z0-9'-]*", (name or "").lower())
    while words and (words[-1] in FORM_WORDS or any(ch.isdigit() for ch in words[-1])):
        words.pop()
    return words[-1] if words else ""


def names_the_query(candidate: Candidate, parsed: Optional[ParsedQuery]) -> bool:
    """True when the product's head noun is one of the student's keywords."""
    if not parsed or not parsed.keywords:
        return True
    head = _head_noun(candidate.product_name)
    return bool(head) and any(_is_head_match(k, head) for k in parsed.keywords)


def _is_head_match(keyword: str, head: str) -> bool:
    """Tolerates the plural either way: 'bean' / 'beans', 'pen' / 'pens'."""
    k, h = keyword.lower(), head.lower()
    return k == h or k + "s" == h or k == h + "s" or k + "es" == h


def rating_score(rating: Optional[Decimal], rating_count: int = 0) -> float:
    """
    Rating out of 5, normalised. An unrated offer scores a neutral 0.5 rather
    than 0 — no reviews is not the same as bad reviews.

    A rating backed by 1 or 2 reviews is pulled halfway towards neutral,
    because one enthusiastic review is not evidence.

    `rating_count == 0` means the review count was never recorded, which is
    different from "nobody reviewed it" — Member 9's dataset carries a rating
    for every listing but no counts at all. Dampening those would quietly
    flatten the component to a constant across the whole catalogue, so a
    missing count is treated as no information about evidence strength rather
    than as weak evidence.
    """
    if rating is None:
        return 0.5
    base = float(rating) / 5.0
    base = max(0.0, min(1.0, base))
    if 0 < rating_count < 3:
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


def price_freshness(candidate: Candidate, now: datetime) -> float:
    """
    Phase 4: freshness is scored on when the price was last CONFIRMED against
    a real source, not on product_offers.last_checked_at. The seed script set
    last_checked_at to NOW() for every modelled price, so an estimate that had
    never been checked against a shelf scored as perfectly fresh.
    """
    if candidate.price_is_estimate:
        return 0.0
    return freshness_score(candidate.price_verified_at, now)


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
    require_keyword_match: bool = True,
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
    # `p.colour ILIKE 'black'` drops NULLs.
    #
    # Category is the exception, and it is a deliberate reversal of the Phase 2
    # behaviour. A GUESSED category is not something the student said — the
    # parser infers it, and on the real catalogue it guesses wrong often enough
    # to matter: the seed files Auto Washing Powder under Toiletries, while the
    # Phase 2 vocabulary mapped "washing powder" to "household", so the filter
    # threw away every row and the search returned nothing. An inferred
    # category now only nudges the ranking (through preference_match); an
    # EXPLICIT one from the API caller still filters. Subcategory never
    # filters — the seed has gaps and the SQL lets NULLs through too.
    if parsed:
        if (
            parsed.category_is_explicit and parsed.category
            and (candidate.category or "").strip().lower() != parsed.category.strip().lower()
        ):
            return False
        # A colour or size the parser pulled out of free text is also met when
        # the word is part of the product's own name: "Brown Bread" and "Full
        # Cream Milk" have no colour on record, and treating "brown"/"cream" as
        # a missing attribute used to drop the very product that was searched.
        for wanted, value in ((parsed.colour, candidate.colour), (parsed.size, candidate.size)):
            if wanted and not attribute_matches(wanted, value, candidate.product_name):
                return False

        # Nothing the student typed appears anywhere on this offer. Showing it
        # is worse than showing nothing — it reads as the app not listening.
        # recommend() relaxes this (require_keyword_match=False) only when it
        # would otherwise return an empty screen.
        if require_keyword_match and parsed.keywords:
            if relevance_score(candidate, parsed) == 0.0:
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
    if candidate.price_is_estimate:
        head += " (estimated price — not yet confirmed with the store)"

    # Name the extra honestly. Calling a taxi fare "delivery and fees" is the
    # kind of small lie that stops a student trusting the number.
    if breakdown.travel_cost > 0:
        other = breakdown.hidden_cost - breakdown.travel_cost
        if other > 0:
            head += (
                f" (R{breakdown.travel_cost} of that is getting there and back, "
                f"plus R{other} in fees)"
            )
        else:
            head += f" (R{breakdown.travel_cost} of that is getting there and back)"
    elif breakdown.hidden_cost > 0:
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
    # Explicit weights win outright (that is how the tests and the eval script
    # compare settings); otherwise the Phase 4 fulfilment-aware weights apply.
    weights = {**DEFAULT_WEIGHTS, **weights} if weights else weights_for(context.fulfilment)
    pricer = pricer or _default_pricer
    ceiling = context.max_price if context.max_price is not None else (parsed.max_price if parsed else None)
    floor = context.min_price if context.min_price is not None else (parsed.min_price if parsed else None)
    now = now or datetime.now(timezone.utc)

    # Pass 1 — filter, and price whatever survives.
    def collect(require_keyword_match: bool) -> List[tuple]:
        kept: List[tuple] = []
        for candidate in candidates:
            distance_km = _distance_for(candidate, context)
            if not passes_hard_filters(
                candidate, context, parsed, distance_km, require_keyword_match
            ):
                continue
            if not require_keyword_match:
                # Fallback pass: the student's words matched nothing, so the
                # parser's inferred category is all we have to go on. Without
                # this the category would be ignored entirely here and the
                # fallback would return the whole catalogue.
                wanted = parsed.category if parsed else None
                if not wanted:
                    continue
                if (candidate.category or "").strip().lower() != wanted.strip().lower():
                    continue
            breakdown = pricer(candidate, context)
            # Phase 4: a store that can't serve the student the way they
            # asked is not a recommendation (true_cost.py rule 7).
            if not breakdown.fulfilment_available:
                continue
            # Phase 4: the student's ceiling is a promise. Phase 3 let the SQL
            # over-fetch by 15% and never checked again, so "under R50" could
            # recommend something at R56.
            if ceiling is not None and breakdown.true_cost > money(ceiling):
                continue
            if floor is not None and breakdown.true_cost < money(floor):
                continue
            if not include_unaffordable and context.remaining_amount is not None:
                if breakdown.true_cost > money(context.remaining_amount):
                    continue
            kept.append((candidate, breakdown, distance_km))
        return kept

    priced = collect(require_keyword_match=True)

    # Nothing matched the student's actual words. Rather than an empty screen,
    # fall back to the category those words imply: the catalogue calls it an
    # "A4 Feint & Margin Book", the student typed "notebook", and Stationery is
    # a better answer than nothing. Results from this pass are flagged
    # matched_query=False so the UI can say so honestly.
    matched_query = True
    if not priced and parsed and parsed.keywords and parsed.category:
        priced = collect(require_keyword_match=False)
        matched_query = False

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
            "relevance": relevance_score(candidate, parsed),
            "budget_fit": budget_fit_score(
                breakdown.true_cost, context.remaining_amount, context.daily_limit
            ),
            "price_value": price_value_score(breakdown.true_cost, cheapest, dearest),
            "preference_match": pref_score,
            "proximity": prox,
            "rating": rating_score(candidate.rating, candidate.rating_count),
            "freshness": price_freshness(candidate, now),
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

        if not matched_query:
            headline.append(
                f"closest match in {candidate.category}"
                if candidate.category else "closest match we could find"
            )
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
                matched_query=matched_query,
                names_query=names_the_query(candidate, parsed),
            )
        )

    # Phase 4 ordering, in tiers:
    #
    #  1. Products that ARE what was searched for outrank products that only
    #     contain the word. Integration testing found "sugar" recommending
    #     Sugar Beans in 7 of 8 scenario/fulfilment runs: beans were R27
    #     cheaper, and no relevance weight small enough to leave budget
    #     ranking intact could outweigh that. A tier can. It only reorders
    #     when at least one candidate names the query, so category browsing
    #     and the closest-match fallback are unaffected. It sits ABOVE
    #     affordability because substituting a different product is worse
    #     than showing the right one flagged "R.. over your budget".
    #  2. Affordable options outrank unaffordable ones, whatever the score.
    #  3. Score, then true cost.
    scored.sort(
        key=lambda s: (
            not s.names_query, not s.meets_budget, -s.score, s.true_cost, s.candidate.offer_id,
        )
    )

    for index, item in enumerate(scored[:limit], start=1):
        item.rank = index
    return scored[:limit]

"""
True-cost calculator — Member 6.

Phase 1 spec: true cost = base price + shipping + fees.

Phase 2 implementation, in full:

    true_cost = (price x quantity)          <- subtotal
              + shipping                    <- product_offers.shipping_cost, per order
              + store charges               <- store_charges rows that apply
              + travel                      <- only when collecting in person

The point of the feature: a R199 item at a store with a R60 courier fee and
a 2.5% handling fee actually costs R264.
A R210 item down the road with free collection costs R210. The sticker price
says the first one is cheaper; the true cost says it isn't. Member 5's
recommender ranks on the number this function returns, not on price.

Rules the calculator follows (all of them are decisions, so they're written
down rather than left implicit in the code):

1.  Shipping is per ORDER, not per unit. Buying two of something doesn't
    double the courier fee.
2.  A store_charges row with charge_type='delivery' is skipped when the offer
    already carries its own shipping_cost. The offer-level number is more
    specific, and adding both would double-charge delivery.
3.  Collection means no shipping and no delivery-type charges, but it does
    mean travel cost — see app/geo.py. A student who "saves" R60 on delivery
    and spends R48 on taxi fare has saved R12, and the breakdown says so.
4.  free_over_amount is tested against the SUBTOTAL (what the student spends
    with that store), which is how South African retailers advertise free
    delivery thresholds.
5.  Percentage charges are clamped to [min_charge, max_charge] when set.
6.  Everything is Decimal and rounded to cents at each step, so the lines in
    the breakdown always add up to the total shown. Never use float for money.

This module is pure Python — no database, no FastAPI — so the numbers can be
unit-tested directly (see tests/test_true_cost.py). The router in
app/routers/true_cost.py does the SQL and calls in here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP
from typing import Iterable, List, Optional, Sequence

from app.geo import estimate_travel_cost

ZERO = Decimal("0.00")

FULFILMENT_DELIVERY = "delivery"
FULFILMENT_COLLECTION = "collection"
VALID_FULFILMENT = (FULFILMENT_DELIVERY, FULFILMENT_COLLECTION)


def money(value) -> Decimal:
    """Round anything money-shaped to cents. The one rounding rule in here."""
    if value is None:
        return ZERO
    if not isinstance(value, Decimal):
        value = Decimal(str(value))
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Offer:
    """The bits of a product_offers row the calculator needs."""

    offer_id: int
    price: Decimal
    shipping_cost: Decimal = ZERO
    currency: str = "ZAR"
    store_id: Optional[int] = None
    store_name: Optional[str] = None
    store_type: str = "online"
    product_name: Optional[str] = None

    @classmethod
    def from_row(cls, row) -> "Offer":
        """Build from a psycopg2 RealDictCursor row (search or offer query)."""
        return cls(
            offer_id=row["offer_id"] if "offer_id" in row else row["id"],
            price=money(row["price"]),
            shipping_cost=money(row.get("shipping_cost") or 0),
            currency=row.get("currency") or "ZAR",
            store_id=row.get("store_id"),
            store_name=row.get("store_name"),
            store_type=row.get("store_type") or "online",
            product_name=row.get("product_name") or row.get("name"),
        )


@dataclass(frozen=True)
class ChargeRule:
    """One store_charges row."""

    charge_type: str
    label: str
    calculation: str = "flat"           # 'flat' | 'percentage'
    amount: Decimal = ZERO
    percentage: Decimal = ZERO
    applies_to: str = "delivery"        # 'delivery' | 'collection' | 'both'
    free_over_amount: Optional[Decimal] = None
    min_charge: Optional[Decimal] = None
    max_charge: Optional[Decimal] = None
    is_active: bool = True
    store_id: Optional[int] = None

    @classmethod
    def from_row(cls, row) -> "ChargeRule":
        def opt(key):
            value = row.get(key)
            return money(value) if value is not None else None

        return cls(
            charge_type=row["charge_type"],
            label=row["label"],
            calculation=row.get("calculation") or "flat",
            amount=money(row.get("amount") or 0),
            percentage=Decimal(str(row.get("percentage") or 0)),
            applies_to=row.get("applies_to") or "delivery",
            free_over_amount=opt("free_over_amount"),
            min_charge=opt("min_charge"),
            max_charge=opt("max_charge"),
            is_active=row.get("is_active", True),
            store_id=row.get("store_id"),
        )


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


@dataclass
class ChargeLine:
    """One line of the breakdown the frontend shows under the price."""

    label: str
    charge_type: str
    amount: Decimal
    waived: bool = False
    note: Optional[str] = None

    def as_dict(self) -> dict:
        return {
            "label": self.label,
            "charge_type": self.charge_type,
            "amount": self.amount,
            "waived": self.waived,
            "note": self.note,
        }


@dataclass
class TrueCostBreakdown:
    offer_id: int
    currency: str
    quantity: int
    fulfilment: str
    subtotal: Decimal
    shipping: Decimal
    charges: List[ChargeLine] = field(default_factory=list)
    charges_total: Decimal = ZERO
    travel_cost: Decimal = ZERO
    true_cost: Decimal = ZERO
    distance_km: Optional[float] = None
    hidden_cost: Decimal = ZERO          # everything above the sticker price
    notes: List[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "offer_id": self.offer_id,
            "currency": self.currency,
            "quantity": self.quantity,
            "fulfilment": self.fulfilment,
            "subtotal": self.subtotal,
            "shipping": self.shipping,
            "charges": [c.as_dict() for c in self.charges],
            "charges_total": self.charges_total,
            "travel_cost": self.travel_cost,
            "true_cost": self.true_cost,
            "distance_km": self.distance_km,
            "hidden_cost": self.hidden_cost,
            "notes": self.notes,
        }


# ---------------------------------------------------------------------------
# The calculator
# ---------------------------------------------------------------------------


def _charge_applies(rule: ChargeRule, fulfilment: str) -> bool:
    if not rule.is_active:
        return False
    return rule.applies_to in (fulfilment, "both")


def _charge_amount(rule: ChargeRule, subtotal: Decimal) -> Decimal:
    if rule.calculation == "percentage":
        raw = subtotal * rule.percentage / Decimal("100")
    else:
        raw = rule.amount

    raw = money(raw)
    if rule.min_charge is not None and raw < rule.min_charge:
        raw = rule.min_charge
    if rule.max_charge is not None and raw > rule.max_charge:
        raw = rule.max_charge
    return money(raw)


def store_true_cost(
    offer: Offer,
    charges: Sequence[ChargeRule] = (),
    *,
    quantity: int = 1,
    fulfilment: str = FULFILMENT_DELIVERY,
    distance_km: Optional[float] = None,
    travel_rate_per_km: Optional[Decimal] = None,
    include_travel: bool = True,
) -> TrueCostBreakdown:
    """
    What this offer really costs, itemised.

    Args:
        offer:          the product offer (price, shipping, store).
        charges:        that store's store_charges rows. Pass () for a store
                        with no recorded fees — the result is then just
                        price x quantity + shipping.
        quantity:       units. Multiplies price, never shipping (rule 1).
        fulfilment:     'delivery' or 'collection'.
        distance_km:    student -> store, from app.geo. Only used for
                        collection.
        travel_rate_per_km: override the default taxi rate.
        include_travel: set False to price the goods alone.

    Returns:
        TrueCostBreakdown — every line the frontend needs, already rounded so
        subtotal + shipping + charges_total + travel_cost == true_cost.
    """
    if quantity < 1:
        raise ValueError("quantity must be at least 1")
    if fulfilment not in VALID_FULFILMENT:
        raise ValueError(f"fulfilment must be one of {VALID_FULFILMENT}")

    notes: List[str] = []
    subtotal = money(offer.price * quantity)

    # --- shipping (rule 1 and 3) -------------------------------------------
    if fulfilment == FULFILMENT_COLLECTION:
        shipping = ZERO
        if offer.shipping_cost > 0:
            notes.append(
                f"Collecting in person saves the R{offer.shipping_cost} delivery fee."
            )
    else:
        shipping = money(offer.shipping_cost)

    # --- store charges (rules 2, 4, 5) -------------------------------------
    lines: List[ChargeLine] = []
    charges_total = ZERO

    for rule in charges:
        if not _charge_applies(rule, fulfilment):
            continue

        # Rule 2: don't charge delivery twice.
        if rule.charge_type == "delivery" and shipping > 0:
            lines.append(
                ChargeLine(
                    label=rule.label,
                    charge_type=rule.charge_type,
                    amount=ZERO,
                    waived=True,
                    note="Already included in this offer's shipping cost",
                )
            )
            continue

        # Rule 4: free over a threshold.
        if rule.free_over_amount is not None and subtotal >= rule.free_over_amount:
            lines.append(
                ChargeLine(
                    label=rule.label,
                    charge_type=rule.charge_type,
                    amount=ZERO,
                    waived=True,
                    note=f"Waived on orders over R{rule.free_over_amount}",
                )
            )
            continue

        amount = _charge_amount(rule, subtotal)
        if amount <= 0:
            continue

        lines.append(
            ChargeLine(label=rule.label, charge_type=rule.charge_type, amount=amount)
        )
        charges_total = money(charges_total + amount)

    # --- travel (rule 3) ----------------------------------------------------
    travel_cost = ZERO
    if include_travel and fulfilment == FULFILMENT_COLLECTION and distance_km:
        travel_cost = estimate_travel_cost(distance_km, rate_per_km=travel_rate_per_km)
        if travel_cost > 0:
            notes.append(
                f"Includes an estimated R{travel_cost} to travel {distance_km:.1f} km "
                "there and back."
            )

    true_cost = money(subtotal + shipping + charges_total + travel_cost)
    hidden_cost = money(true_cost - subtotal)

    if hidden_cost > 0 and subtotal > 0:
        pct = (hidden_cost / subtotal * Decimal("100")).quantize(Decimal("0.1"))
        notes.append(f"R{hidden_cost} ({pct}%) of this is not in the listed price.")

    return TrueCostBreakdown(
        offer_id=offer.offer_id,
        currency=offer.currency,
        quantity=quantity,
        fulfilment=fulfilment,
        subtotal=subtotal,
        shipping=shipping,
        charges=lines,
        charges_total=charges_total,
        travel_cost=travel_cost,
        true_cost=true_cost,
        distance_km=round(distance_km, 2) if distance_km is not None else None,
        hidden_cost=hidden_cost,
        notes=notes,
    )


def cheapest(breakdowns: Iterable[TrueCostBreakdown]) -> Optional[TrueCostBreakdown]:
    """The lowest true cost of a set — the answer to 'where should I buy this?'."""
    items = list(breakdowns)
    if not items:
        return None
    return min(items, key=lambda b: (b.true_cost, b.offer_id))


def group_charges_by_store(rows: Iterable[dict]) -> dict:
    """
    Turn a flat store_charges query result into {store_id: [ChargeRule, ...]}.

    Lets a router load every relevant store's charges in ONE query rather
    than one per offer — which matters when the recommender is pricing 50
    candidates at once.
    """
    grouped: dict = {}
    for row in rows:
        rule = ChargeRule.from_row(row)
        grouped.setdefault(row["store_id"], []).append(rule)
    return grouped


def load_store_charges(cur, store_ids: Sequence[int]) -> dict:
    """
    The one database call in this module — kept here so both /true-cost and
    /recommendations load charges the same way, with one query for all stores.

    Takes an open cursor, like app.geo.fetch_user_location does. Returns
    {store_id: [ChargeRule, ...]}; stores with no rows simply don't appear,
    and store_true_cost() handles an empty list fine.
    """
    ids = [int(i) for i in store_ids if i is not None]
    if not ids:
        return {}
    cur.execute(
        """SELECT id, store_id, charge_type, label, calculation, amount, percentage,
                  applies_to, free_over_amount, min_charge, max_charge, is_active
           FROM store_charges
           WHERE store_id = ANY(%s) AND is_active = TRUE
           ORDER BY store_id, charge_type""",
        (ids,),
    )
    return group_charges_by_store(cur.fetchall())

"""Pure true-cost calculation used by the recommender."""

from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional, Sequence

from app.geo import estimate_travel_cost

ZERO = Decimal("0.00")


def money(value) -> Decimal:
    return (Decimal("0") if value is None else Decimal(str(value))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


@dataclass(frozen=True)
class Offer:
    offer_id: int
    price: Decimal
    shipping_cost: Decimal = ZERO
    currency: str = "ZAR"
    store_id: Optional[int] = None
    store_name: Optional[str] = None
    store_type: str = "online"
    product_name: Optional[str] = None

    @classmethod
    def from_row(cls, row):
        return cls(row["offer_id"], money(row["price"]), money(row.get("shipping_cost")),
                   row.get("currency") or "ZAR", row.get("store_id"), row.get("store_name"),
                   row.get("store_type") or "online", row.get("product_name"))


@dataclass(frozen=True)
class ChargeRule:
    charge_type: str
    label: str
    calculation: str = "flat"
    amount: Decimal = ZERO
    percentage: Decimal = ZERO
    applies_to: str = "delivery"
    free_over_amount: Optional[Decimal] = None
    min_charge: Optional[Decimal] = None
    max_charge: Optional[Decimal] = None
    is_active: bool = True
    note: Optional[str] = None
    store_id: Optional[int] = None

    @classmethod
    def from_row(cls, row):
        return cls(row["charge_type"], row["label"], row.get("calculation") or "flat",
                   money(row.get("amount")), Decimal(str(row.get("percentage") or 0)),
                   row.get("applies_to") or "delivery",
                   money(row["free_over_amount"]) if row.get("free_over_amount") is not None else None,
                   money(row["min_charge"]) if row.get("min_charge") is not None else None,
                   money(row["max_charge"]) if row.get("max_charge") is not None else None,
                   row.get("is_active", True), row.get("note"), row.get("store_id"))


@dataclass
class ChargeLine:
    label: str
    charge_type: str
    amount: Decimal
    waived: bool = False
    note: Optional[str] = None

    def as_dict(self):
        return self.__dict__.copy()


@dataclass
class TrueCostBreakdown:
    offer_id: int
    currency: str
    quantity: int
    fulfilment: str
    subtotal: Decimal
    shipping: Decimal
    charges: list = field(default_factory=list)
    charges_total: Decimal = ZERO
    travel_cost: Decimal = ZERO
    true_cost: Decimal = ZERO
    distance_km: Optional[float] = None
    hidden_cost: Decimal = ZERO
    notes: list = field(default_factory=list)

    def as_dict(self):
        data = self.__dict__.copy()
        data["charges"] = [c.as_dict() for c in self.charges]
        return data


def store_true_cost(offer: Offer, charges: Sequence[ChargeRule] = (), *, quantity: int = 1,
                    fulfilment: str = "delivery", distance_km: Optional[float] = None) -> TrueCostBreakdown:
    if quantity < 1:
        raise ValueError("quantity must be at least 1")
    if fulfilment not in ("delivery", "collection"):
        raise ValueError("fulfilment must be delivery or collection")
    subtotal = money(offer.price * quantity)
    shipping = ZERO if fulfilment == "collection" else money(offer.shipping_cost)
    lines, total = [], ZERO
    for rule in charges:
        if not rule.is_active or rule.applies_to not in (fulfilment, "both"):
            continue
        if rule.charge_type == "delivery" and shipping > 0:
            lines.append(ChargeLine(rule.label, rule.charge_type, ZERO, True, rule.note))
            continue
        value = (subtotal * rule.percentage / Decimal("100")) if rule.calculation == "percentage" else rule.amount
        if rule.free_over_amount is not None and subtotal >= rule.free_over_amount:
            value = ZERO
        value = money(value)
        if rule.min_charge is not None:
            value = max(value, rule.min_charge)
        if rule.max_charge is not None:
            value = min(value, rule.max_charge)
        lines.append(ChargeLine(rule.label, rule.charge_type, money(value), value == 0, rule.note))
        total += value
    travel = money(estimate_travel_cost(distance_km)) if fulfilment == "collection" else ZERO
    true_cost = money(subtotal + shipping + total + travel)
    return TrueCostBreakdown(offer.offer_id, offer.currency, quantity, fulfilment, subtotal, shipping, lines,
                             money(total), travel, true_cost, distance_km, money(true_cost - subtotal),
                             ["Travel cost is an estimate." ] if travel else [])


def cheapest(breakdowns):
    if not breakdowns:
        raise ValueError("at least one cost breakdown is required")
    return min(breakdowns, key=lambda result: (result.true_cost, result.offer_id))


def load_store_charges(cur, store_ids) -> dict:
    ids = list({int(i) for i in store_ids if i is not None})
    if not ids:
        return {}
    cur.execute("SELECT * FROM store_charges WHERE is_active = TRUE AND store_id = ANY(%s)", (ids,))
    result = {}
    for row in cur.fetchall():
        result.setdefault(row["store_id"], []).append(ChargeRule.from_row(row))
    return result
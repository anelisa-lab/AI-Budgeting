"""
Basket comparison — "where should I do this whole shop?" — Phase 4.

Pure Python, no database. app/routers/compare.py loads the offers and calls
compare_basket(); tests/test_basket.py pins every rule.

WHY THIS MOVED TO THE BACKEND
-----------------------------
The Compare screen used to do this in the browser, and got it wrong in ways
that all came down to not having the data the backend has:

  * A store that didn't stock an item was charged ANOTHER store's price for
    it, "so the totals stay comparable". That is a made-up number shown as a
    store total. Now a missing item is listed as missing and never priced.
  * Delivery was approximated as "the largest shipping_cost on any line",
    because the browser can't see store_charges. Free-delivery thresholds on
    the whole basket were ignored, and a store that doesn't deliver at all
    (Shoprite Warwick in the seed) showed as FREE delivery.
  * The split-shop figure added up item prices only, so "split across
    stores" never paid for the second trip or the second delivery.

THE RULES
---------
1.  One order per store. Its subtotal is sum(price x qty) of the lines that
    store stocks and has in stock.
2.  Delivery once per order: the store's own delivery rule (a store_charges
    row, charge_type='delivery') tested against the ORDER subtotal, so a
    R450 free-delivery threshold is judged on the basket. With no rule, the
    largest per-offer shipping_cost stands in, and a note says so.
3.  Other store charges once per order, via true_cost.store_true_cost().
4.  Travel once per trip (collection), beyond walking distance only.
5.  A store that can't serve the student the way they asked is priced the
    only way it can be and flagged — never ranked as the answer.
6.  Nothing is imputed. A partial store's total covers only what it stocks.
7.  The best plan tries every combination of up to MAX_PLAN_STORES stores
    that covers the list, charging each store's delivery/trip, and keeps the
    cheapest. "Split the shop" is only suggested when it wins after paying
    for the extra trip.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from itertools import combinations
from typing import Dict, List, Optional, Sequence

from app.true_cost import ChargeRule, Offer, money, store_true_cost

ZERO = Decimal("0.00")
MAX_PLAN_STORES = 3          # nobody walks to four shops for a basket


@dataclass
class BasketLine:
    product_id: int
    qty: int = 1


@dataclass
class StoreInfo:
    store_id: int
    store_name: str
    store_type: str = "physical"
    delivery_available: Optional[bool] = None
    collection_available: Optional[bool] = None
    distance_km: Optional[float] = None


@dataclass
class BasketOffer:
    offer_id: int
    product_id: int
    store_id: int
    price: Decimal
    product_name: str = ""
    size: Optional[str] = None
    shipping_cost: Decimal = ZERO
    availability_status: str = "available"
    price_source: str = "seed_estimate"
    price_verified_at: Optional[datetime] = None
    product_url: Optional[str] = None

    @property
    def in_stock(self) -> bool:
        return self.availability_status == "available"

    @property
    def is_estimate(self) -> bool:
        return self.price_source == "seed_estimate" or self.price_verified_at is None


@dataclass
class StoreQuote:
    store: StoreInfo
    lines: List[dict]                   # {product_id, product_name, qty, offer_id, price, line_total, is_estimate}
    missing: List[dict]                 # {product_id, product_name, reason}
    subtotal: Decimal
    delivery: Decimal
    fees: Decimal
    travel: Decimal
    total: Decimal
    fulfilment: str
    fulfilment_available: bool
    notes: List[str] = field(default_factory=list)

    @property
    def full(self) -> bool:
        return not self.missing and bool(self.lines)

    @property
    def estimate_count(self) -> int:
        return sum(1 for line in self.lines if line["is_estimate"])

    def as_dict(self) -> dict:
        return {
            "store_id": self.store.store_id,
            "store_name": self.store.store_name,
            "store_type": self.store.store_type,
            "distance_km": round(self.store.distance_km, 2) if self.store.distance_km is not None else None,
            "fulfilment": self.fulfilment,
            "fulfilment_available": self.fulfilment_available,
            "full": self.full,
            "stocked": len(self.lines),
            "missing_count": len(self.missing),
            "lines": self.lines,
            "missing": self.missing,
            "subtotal": self.subtotal,
            "delivery": self.delivery,
            "fees": self.fees,
            "travel": self.travel,
            "total": self.total,
            "estimate_count": self.estimate_count,
            "notes": self.notes,
        }


def _names(offers_by_product: Dict[int, Sequence[BasketOffer]]) -> Dict[int, str]:
    names = {}
    for pid, offers in offers_by_product.items():
        for o in offers:
            if o.product_name:
                names[pid] = o.product_name + (f" · {o.size}" if o.size else "")
                break
    return names


def quote_store(
    store: StoreInfo,
    assigned: Sequence[tuple],               # (BasketLine, BasketOffer)
    missing: Sequence[dict],
    charges: Sequence[ChargeRule],
    fulfilment: str,
) -> StoreQuote:
    """Price ONE order at ONE store (rules 1-5)."""
    subtotal = money(sum((o.price * line.qty for line, o in assigned), ZERO))
    has_delivery_rule = any(c.charge_type == "delivery" and c.is_active for c in charges)
    notes: List[str] = []
    if has_delivery_rule or not assigned:
        shipping = ZERO
    else:
        shipping = max(o.shipping_cost for _, o in assigned)
        if fulfilment == "delivery" and shipping > 0:
            notes.append("Delivery estimated from the item listings — no store delivery rule on record.")

    breakdown = store_true_cost(
        Offer(
            offer_id=0, price=subtotal, shipping_cost=money(shipping),
            store_id=store.store_id, store_name=store.store_name, store_type=store.store_type,
            delivery_available=store.delivery_available,
            collection_available=store.collection_available,
        ),
        charges,
        fulfilment=fulfilment,
        distance_km=store.distance_km if store.store_type != "online" else None,
    )
    delivery_charges = sum(
        (c.amount for c in breakdown.charges if c.charge_type == "delivery" and not c.waived), ZERO
    )
    delivery = money(breakdown.shipping + delivery_charges)
    fees = money(breakdown.charges_total - delivery_charges)
    notes.extend(n for n in breakdown.notes if "not in the listed price" not in n)

    lines = [
        {
            "product_id": line.product_id,
            "product_name": o.product_name + (f" · {o.size}" if o.size else ""),
            "qty": line.qty,
            "offer_id": o.offer_id,
            "price": o.price,
            "line_total": money(o.price * line.qty),
            "is_estimate": o.is_estimate,
            "price_source": o.price_source,
            "price_verified_at": o.price_verified_at,
        }
        for line, o in assigned
    ]
    return StoreQuote(
        store=store, lines=lines, missing=list(missing), subtotal=subtotal,
        delivery=delivery, fees=fees, travel=breakdown.travel_cost, total=breakdown.true_cost,
        fulfilment=breakdown.fulfilment, fulfilment_available=breakdown.fulfilment_available,
        notes=notes,
    )


def _merge(lines: Sequence[BasketLine]) -> List[BasketLine]:
    """The same product added twice (from two stores) is one line."""
    merged: Dict[int, BasketLine] = {}
    for line in lines:
        if line.product_id in merged:
            merged[line.product_id].qty += line.qty
        else:
            merged[line.product_id] = BasketLine(line.product_id, line.qty)
    return list(merged.values())


def compare_basket(
    lines: Sequence[BasketLine],
    offers_by_product: Dict[int, Sequence[BasketOffer]],
    stores: Dict[int, StoreInfo],
    charges_by_store: Dict[int, Sequence[ChargeRule]],
    fulfilment: str = "collection",
    max_plan_stores: int = MAX_PLAN_STORES,
) -> dict:
    lines = _merge(lines)
    names = _names(offers_by_product)

    # In-stock offers per (store, product).
    stock: Dict[int, Dict[int, BasketOffer]] = {}
    for pid, offers in offers_by_product.items():
        for o in offers:
            if o.in_stock:
                current = stock.setdefault(o.store_id, {}).get(pid)
                if current is None or o.price < current.price:
                    stock[o.store_id][pid] = o

    # --- one quote per store, nothing imputed (rule 6) -----------------------
    quotes: List[StoreQuote] = []
    for store_id, store in stores.items():
        here = stock.get(store_id, {})
        if not here:
            continue
        assigned, missing = [], []
        for line in lines:
            offer = here.get(line.product_id)
            if offer:
                assigned.append((line, offer))
            else:
                listed = any(o.store_id == store_id for o in offers_by_product.get(line.product_id, []))
                missing.append({
                    "product_id": line.product_id,
                    "product_name": names.get(line.product_id, f"Product {line.product_id}"),
                    "reason": "out of stock" if listed else "not stocked",
                })
        quotes.append(quote_store(store, assigned, missing, charges_by_store.get(store_id, []), fulfilment))

    quotes.sort(key=lambda q: (
        not q.fulfilment_available,
        not q.full,
        -len(q.lines),
        q.total,
        q.store.store_name,
    ))
    best_single = next((q for q in quotes if q.full and q.fulfilment_available), None)

    # --- the best plan: cheapest set of up to N usable stores (rule 7) -------
    usable = [q.store.store_id for q in quotes if q.fulfilment_available]
    coverable = {l.product_id for l in lines if any(l.product_id in stock.get(s, {}) for s in usable)}
    unavailable = [
        {"product_id": l.product_id, "product_name": names.get(l.product_id, f"Product {l.product_id}")}
        for l in lines if l.product_id not in coverable
    ]
    wanted = [l for l in lines if l.product_id in coverable]

    best_plan = None
    for size in range(1, max_plan_stores + 1):
        for combo in combinations(usable, size):
            if not all(any(l.product_id in stock[s] for s in combo) for l in wanted):
                continue
            by_store: Dict[int, list] = {s: [] for s in combo}
            for line in wanted:
                s = min(
                    (s for s in combo if line.product_id in stock[s]),
                    key=lambda s: (stock[s][line.product_id].price, s),
                )
                by_store[s].append((line, stock[s][line.product_id]))
            if any(not items for items in by_store.values()):
                continue            # a store with nothing assigned isn't a trip
            parts = [
                quote_store(stores[s], items, [], charges_by_store.get(s, []), fulfilment)
                for s, items in by_store.items()
            ]
            total = money(sum((p.total for p in parts), ZERO))
            if best_plan is None or (total, len(parts)) < (best_plan["total"], len(best_plan["parts"])):
                best_plan = {"total": total, "parts": parts}

    plan_out = None
    if best_plan:
        parts = sorted(best_plan["parts"], key=lambda p: p.store.store_name)
        plan_out = {
            "total": best_plan["total"],
            "store_count": len(parts),
            "stores": [p.as_dict() for p in parts],
            "saving_vs_best_single": (
                money(best_single.total - best_plan["total"]) if best_single else None
            ),
        }

    # --- item by item: every in-stock listing, cheapest first ----------------
    items = []
    for line in lines:
        rows = []
        for o in offers_by_product.get(line.product_id, []):
            store = stores.get(o.store_id)
            if not store:
                continue
            rows.append({
                "offer_id": o.offer_id,
                "store_id": o.store_id,
                "store_name": store.store_name,
                "price": o.price,
                "line_total": money(o.price * line.qty),
                "in_stock": o.in_stock,
                "is_estimate": o.is_estimate,
                "price_source": o.price_source,
                "price_verified_at": o.price_verified_at,
                "product_url": o.product_url,
            })
        rows.sort(key=lambda r: (not r["in_stock"], r["line_total"], r["store_name"]))
        items.append({
            "product_id": line.product_id,
            "product_name": names.get(line.product_id, f"Product {line.product_id}"),
            "qty": line.qty,
            "offers": rows,
        })

    used = [line for q in quotes for line in q.lines]
    estimates = sum(1 for line in used if line["is_estimate"])
    return {
        "fulfilment": fulfilment,
        "stores": [q.as_dict() for q in quotes],
        "best_single_store_id": best_single.store.store_id if best_single else None,
        "best_plan": plan_out,
        "unavailable": unavailable,
        "items": items,
        "prices": {
            "listings": len(used),
            "estimates": estimates,
            "confirmed": len(used) - estimates,
            "all_confirmed": bool(used) and estimates == 0,
        },
    }

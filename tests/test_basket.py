"""
Basket comparison — app/basket.py, the backend half of the Compare fix.

Each test is one of the things the browser-side comparison got wrong.
"""

import json
from decimal import Decimal
from pathlib import Path

from app.basket import BasketLine, BasketOffer, StoreInfo, compare_basket
from app.geo import distance_between
from app.true_cost import ChargeRule

D = Decimal
CAMPUS = (-29.8500, 31.0100)


def rule(amount, free_over=None):
    return ChargeRule(charge_type="delivery", label="Delivery", applies_to="delivery",
                      amount=D(amount), free_over_amount=D(free_over) if free_over else None)


def offer(offer_id, product_id, store_id, price, name="Item", **kw):
    return BasketOffer(offer_id=offer_id, product_id=product_id, store_id=store_id,
                       price=D(price), product_name=name, **kw)


STORES = {
    1: StoreInfo(1, "Walk-in A", "physical", delivery_available=False, distance_km=0.6),
    2: StoreInfo(2, "Walk-in B", "physical", delivery_available=True, distance_km=1.0),
    3: StoreInfo(3, "Online C", "online", delivery_available=True, collection_available=False),
}


def test_a_missing_item_is_never_priced_at_another_stores_price():
    offers = {
        10: [offer(1, 10, 1, "20.00", "Bread"), offer(2, 10, 2, "22.00", "Bread")],
        11: [offer(3, 11, 2, "30.00", "Milk")],            # only B has milk
    }
    out = compare_basket([BasketLine(10), BasketLine(11)], offers, STORES, {}, "collection")
    a = next(s for s in out["stores"] if s["store_id"] == 1)
    assert a["full"] is False
    assert a["total"] == D("20.00")                      # bread only — no invented milk
    assert a["missing"] == [{"product_id": 11, "product_name": "Milk", "reason": "not stocked"}]
    assert out["best_single_store_id"] == 2
    assert out["stores"][0]["store_id"] == 2             # the complete store ranks first


def test_delivery_is_charged_once_and_the_threshold_is_judged_on_the_basket():
    offers = {10: [offer(1, 10, 2, "300.00", "Kettle")], 11: [offer(2, 11, 2, "200.00", "Towel")]}
    charges = {2: [rule("50.00", free_over="450.00")]}
    one = compare_basket([BasketLine(10)], offers, STORES, charges, "delivery")
    both = compare_basket([BasketLine(10), BasketLine(11)], offers, STORES, charges, "delivery")
    assert one["stores"][0]["delivery"] == D("50.00")
    assert both["stores"][0]["delivery"] == D("0.00")    # R500 order clears R450
    assert both["stores"][0]["total"] == D("500.00")


def test_a_store_that_does_not_deliver_is_never_free_delivery():
    offers = {10: [offer(1, 10, 1, "18.00", "Bread"), offer(2, 10, 2, "20.00", "Bread")]}
    charges = {2: [rule("35.00")]}
    out = compare_basket([BasketLine(10)], offers, STORES, charges, "delivery")
    a = next(s for s in out["stores"] if s["store_id"] == 1)
    assert a["fulfilment_available"] is False
    assert out["stores"][-1]["store_id"] == 1            # flagged and ranked last
    assert out["best_single_store_id"] == 2
    assert out["best_plan"]["total"] == D("55.00")


def test_an_online_store_is_not_the_cheapest_place_to_collect_from():
    offers = {10: [offer(1, 10, 3, "10.00", "Pens", shipping_cost=D("60.00")),
                   offer(2, 10, 2, "40.00", "Pens")]}
    out = compare_basket([BasketLine(10)], offers, STORES, {}, "collection")
    assert out["best_single_store_id"] == 2
    online = next(s for s in out["stores"] if s["store_id"] == 3)
    assert online["fulfilment_available"] is False and online["delivery"] == D("60.00")


def test_splitting_the_shop_must_pay_for_the_extra_trip():
    far = StoreInfo(4, "Far D", "physical", delivery_available=True, distance_km=5.0)
    stores = {**STORES, 4: far}
    offers = {
        10: [offer(1, 10, 2, "20.00", "Bread"), offer(2, 10, 4, "15.00", "Bread")],
        11: [offer(3, 11, 2, "30.00", "Milk")],
    }
    out = compare_basket([BasketLine(10), BasketLine(11)], offers, stores, {}, "collection")
    # Bread is R5 cheaper at D, but D is a R25 taxi each way — staying at B wins.
    assert out["best_plan"]["store_count"] == 1
    assert out["best_plan"]["total"] == D("50.00")
    assert out["best_plan"]["saving_vs_best_single"] == D("0.00")


def test_out_of_stock_is_reported_as_such_and_unavailable_items_are_listed():
    offers = {
        10: [offer(1, 10, 2, "20.00", "Bread", availability_status="out_of_stock"),
             offer(2, 10, 1, "21.00", "Bread")],
        12: [offer(3, 12, 2, "9.00", "Gone", availability_status="out_of_stock")],
    }
    out = compare_basket([BasketLine(10), BasketLine(12)], offers, STORES, {}, "collection")
    b = next(s for s in out["stores"] if s["store_id"] == 1)
    assert b["missing"][0]["product_name"] == "Gone"
    assert out["unavailable"] == [{"product_id": 12, "product_name": "Gone"}]
    assert out["best_plan"]["total"] == D("21.00")        # the plan covers what exists


def test_same_product_twice_is_one_line_and_estimates_are_counted():
    offers = {10: [offer(1, 10, 2, "20.00", "Bread")]}
    out = compare_basket([BasketLine(10, 1), BasketLine(10, 2)], offers, STORES, {}, "collection")
    assert out["stores"][0]["lines"][0]["qty"] == 3
    assert out["stores"][0]["total"] == D("60.00")
    assert out["prices"] == {"listings": 1, "estimates": 1, "confirmed": 0, "all_confirmed": False}


def test_real_catalogue_basket_adds_up():
    """A representative student basket over Member 9's real data."""
    data = json.loads((Path(__file__).resolve().parents[1] / "mintly-react" / "docs" / "seed"
                       / "products.json").read_text())
    store_ids = {s["store_id"]: i for i, s in enumerate(data["stores"], start=1)}
    stores, charges = {}, {}
    for s in data["stores"]:
        sid = store_ids[s["store_id"]]
        stores[sid] = StoreInfo(
            sid, s["store_name"], "online" if s["online_only"] else "physical",
            delivery_available=s["delivery_available"], collection_available=s["collection_available"],
            distance_km=None if s["online_only"] else distance_between(CAMPUS, (s["lat"], s["lng"])),
        )
        if s["delivery_available"]:
            charges[sid] = [rule(str(s["base_shipping_fee"]),
                                 str(s["free_delivery_over"]) if s["free_delivery_over"] else None)]
    names = ["Super Maize Meal", "Brown Bread", "Full Cream Milk", "Large Eggs", "Sunflower Oil"]
    pids = {n: i for i, n in enumerate(names, start=1)}
    offers = {}
    for i, row in enumerate(data["products"], start=1):
        if row["name"] in pids:
            offers.setdefault(pids[row["name"]], []).append(
                offer(i, pids[row["name"]], store_ids[row["store_id"]], str(row["price"]),
                      row["name"], shipping_cost=D(str(row["shipping_fee"]))))
    basket = [BasketLine(pid) for pid in pids.values()]

    for fulfilment in ("collection", "delivery"):
        out = compare_basket(basket, offers, stores, charges, fulfilment)
        for s in out["stores"]:
            assert s["subtotal"] + s["delivery"] + s["fees"] + s["travel"] == s["total"]
            assert s["subtotal"] == sum(line["line_total"] for line in s["lines"])
        best = next(s for s in out["stores"] if s["store_id"] == out["best_single_store_id"])
        assert best["full"] and best["fulfilment_available"]
        assert out["best_plan"]["total"] <= best["total"]
        if fulfilment == "delivery":
            assert all(s["store_name"] != "Shoprite Warwick Junction" or not s["fulfilment_available"]
                       for s in out["stores"])

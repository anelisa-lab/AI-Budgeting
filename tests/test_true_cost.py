"""
True-cost tests — Member 6.

Covers the six rules written at the top of app/true_cost.py. No database
needed: store_true_cost() is a pure function, so these run anywhere with
`pytest`.
"""

from decimal import Decimal

import pytest

from app.true_cost import ChargeRule, Offer, cheapest, store_true_cost

D = Decimal


def offer(price="100.00", shipping="0.00", store_type="online", offer_id=1):
    return Offer(
        offer_id=offer_id,
        price=D(price),
        shipping_cost=D(shipping),
        store_id=1,
        store_name="Test Store",
        store_type=store_type,
        product_name="Test Product",
    )


def test_no_charges_is_price_plus_shipping():
    result = store_true_cost(offer(price="199.99", shipping="60.00"))
    assert result.subtotal == D("199.99")
    assert result.shipping == D("60.00")
    assert result.true_cost == D("259.99")
    assert result.hidden_cost == D("60.00")


def test_quantity_multiplies_price_but_not_shipping():
    """Rule 1: shipping is per order."""
    result = store_true_cost(offer(price="50.00", shipping="60.00"), quantity=3)
    assert result.subtotal == D("150.00")
    assert result.shipping == D("60.00")
    assert result.true_cost == D("210.00")


def test_flat_charge_is_added():
    rule = ChargeRule(charge_type="service", label="Handling", amount=D("15.00"),
                      applies_to="both")
    result = store_true_cost(offer(price="100.00"), [rule])
    assert result.charges_total == D("15.00")
    assert result.true_cost == D("115.00")
    assert result.charges[0].label == "Handling"


def test_percentage_charge_is_clamped_to_max():
    rule = ChargeRule(
        charge_type="service", label="Handling", calculation="percentage",
        percentage=D("10"), applies_to="both", max_charge=D("45.00"),
    )
    result = store_true_cost(offer(price="1000.00"), [rule])
    assert result.charges_total == D("45.00")     # 100.00 clamped down to 45.00


def test_percentage_charge_is_clamped_to_min():
    rule = ChargeRule(
        charge_type="service", label="Handling", calculation="percentage",
        percentage=D("2.5"), applies_to="both", min_charge=D("5.00"),
    )
    result = store_true_cost(offer(price="20.00"), [rule])
    assert result.charges_total == D("5.00")      # 0.50 raised to the 5.00 floor


def test_delivery_charge_skipped_when_offer_has_its_own_shipping():
    """Rule 2: never charge delivery twice."""
    rule = ChargeRule(charge_type="delivery", label="Courier", amount=D("60.00"))
    result = store_true_cost(offer(price="100.00", shipping="45.00"), [rule])
    assert result.shipping == D("45.00")
    assert result.charges_total == D("0.00")
    assert result.charges[0].waived is True
    assert result.true_cost == D("145.00")


def test_delivery_charge_applies_when_offer_has_no_shipping():
    rule = ChargeRule(charge_type="delivery", label="Courier", amount=D("60.00"))
    result = store_true_cost(offer(price="100.00", shipping="0.00"), [rule])
    assert result.charges_total == D("60.00")
    assert result.true_cost == D("160.00")


def test_free_over_threshold_waives_the_charge():
    """Rule 4: free delivery over R500, measured on the subtotal."""
    rule = ChargeRule(
        charge_type="delivery", label="Courier", amount=D("60.00"),
        free_over_amount=D("500.00"),
    )
    under = store_true_cost(offer(price="499.00"), [rule])
    over = store_true_cost(offer(price="500.00"), [rule])

    assert under.true_cost == D("559.00")
    assert over.true_cost == D("500.00")
    assert over.charges[0].waived is True


def test_collection_drops_shipping_and_delivery_charges():
    """Rule 3: collecting means no courier."""
    rule = ChargeRule(charge_type="delivery", label="Courier", amount=D("60.00"),
                      applies_to="delivery")
    result = store_true_cost(
        offer(price="100.00", shipping="60.00", store_type="physical"),
        [rule],
        fulfilment="collection",
    )
    assert result.shipping == D("0.00")
    assert result.charges_total == D("0.00")
    assert result.true_cost == D("100.00")


def test_collection_adds_travel_cost():
    """The saving on delivery isn't free if you have to get there."""
    result = store_true_cost(
        offer(price="100.00", shipping="60.00", store_type="physical"),
        fulfilment="collection",
        distance_km=6.0,
    )
    # 6 km x R2.50 = R15 one way, over the R10 minimum, doubled for the return trip
    assert result.travel_cost == D("30.00")
    assert result.true_cost == D("130.00")
    assert result.distance_km == 6.0


def test_travel_cost_respects_the_minimum_fare():
    result = store_true_cost(
        offer(price="100.00", store_type="physical"),
        fulfilment="collection",
        distance_km=0.5,
    )
    # 0.5 km x R2.50 = R1.25, raised to the R10 minimum, doubled
    assert result.travel_cost == D("20.00")


def test_collection_only_charge_ignored_on_delivery():
    rule = ChargeRule(charge_type="packaging", label="Bags", amount=D("2.00"),
                      applies_to="collection")
    result = store_true_cost(offer(price="100.00"), [rule], fulfilment="delivery")
    assert result.charges_total == D("0.00")


def test_inactive_charges_are_ignored():
    rule = ChargeRule(charge_type="service", label="Old fee", amount=D("99.00"),
                      applies_to="both", is_active=False)
    result = store_true_cost(offer(price="100.00"), [rule])
    assert result.true_cost == D("100.00")


def test_breakdown_lines_always_add_up_to_the_total():
    """The number shown must equal the lines shown under it."""
    charges = [
        ChargeRule(charge_type="delivery", label="Courier", amount=D("60.00")),
        ChargeRule(charge_type="service", label="Handling", calculation="percentage",
                   percentage=D("2.5"), applies_to="both"),
        ChargeRule(charge_type="card", label="Card fee", amount=D("3.50"),
                   applies_to="both"),
    ]
    result = store_true_cost(offer(price="333.33"), charges, quantity=3)
    total = result.subtotal + result.shipping + result.charges_total + result.travel_cost
    assert total == result.true_cost


def test_cheapest_picks_the_lowest_true_cost_not_the_lowest_price():
    """The headline behaviour of the whole feature."""
    a = store_true_cost(
        offer(price="199.00", shipping="60.00", offer_id=1),
        [ChargeRule(charge_type="service", label="Handling", calculation="percentage",
                    percentage=D("2.5"), applies_to="both")],
    )
    b = store_true_cost(offer(price="240.00", shipping="0.00", offer_id=2))

    assert a.subtotal < b.subtotal          # a looks cheaper on the shelf
    assert a.true_cost > b.true_cost        # but costs more to actually buy
    assert cheapest([a, b]).offer_id == 2


def test_rejects_bad_input():
    with pytest.raises(ValueError):
        store_true_cost(offer(), quantity=0)
    with pytest.raises(ValueError):
        store_true_cost(offer(), fulfilment="teleport")

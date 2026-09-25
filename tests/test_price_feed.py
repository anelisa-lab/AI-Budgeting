"""
Live price layer — app/price_feed. No network: the RapidAPI provider is
exercised with recorded-shape payloads and a fake opener.
"""

import io
import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest

from app.price_feed.matching import best_match, match_score, normalise_size
from app.price_feed.models import CatalogueOffer, LivePrice
from app.price_feed.providers import CsvPriceProvider, RapidApiSaGroceryProvider, parse_listings, parse_price
from app.price_feed.refresh import plan_refresh

D = Decimal
NOW = datetime(2026, 9, 24, tzinfo=timezone.utc)
MAIZE = CatalogueOffer(1, "checkers", "Super Maize Meal", "Ace", "2.5kg", D("42.99"))


def live(title, price, store="checkers", size=None, brand=None):
    return LivePrice(store_key=store, title=title, price=D(price), observed_at=NOW,
                     source="live_api", source_detail="test", size=size, brand=brand)


def test_sizes_normalise_across_notations():
    assert normalise_size("2.5kg") == normalise_size("2,5 kg") == normalise_size("2500g")
    assert normalise_size("2L") == normalise_size("2000 ml")
    assert normalise_size("5 x 73g") == ("g", D("365"))
    assert normalise_size("18 pack") == normalise_size("18s")
    assert normalise_size("Single") is None


def test_the_right_listing_matches_and_the_wrong_sizes_do_not():
    assert match_score(MAIZE, live("Ace Super Maize Meal 2.5kg", "44.99")) > 0.9
    assert match_score(MAIZE, live("Ace Super Maize Meal 5kg", "79.99")) == 0.0      # wrong size
    assert match_score(MAIZE, live("White Star Super Maize Meal 2.5kg", "39.99")) == 0.0  # wrong brand
    assert match_score(MAIZE, live("Ace Instant Porridge 1kg", "30.00")) == 0.0


def test_ambiguous_matches_are_refused():
    listing, reason = best_match(MAIZE, [live("Ace Super Maize Meal 2.5kg", "44.99"),
                                         live("Ace Super Maize Meal 2.5 kg", "41.99")])
    assert listing is None and reason.startswith("ambiguous")


def test_refresh_plan_applies_sane_matches_and_holds_back_big_jumps():
    offers = [MAIZE, CatalogueOffer(2, "checkers", "Brown Bread", "Albany", "700g", D("18.99")),
              CatalogueOffer(3, "spar", "Brown Bread", "Albany", "700g", D("19.49"))]
    listings = [live("Ace Super Maize Meal 2.5kg", "44.99"),
                live("Albany Superior Brown Bread 700g", "9.99")]     # -47%: in range
    plan = plan_refresh(offers, listings)
    assert [u.offer_id for u in plan.updates] == [1, 2]
    assert plan.stores_without_source == ["spar"]

    jumpy = plan_refresh(offers, [live("Ace Super Maize Meal 2.5kg", "99.99")])
    assert jumpy.updates == [] and "check before applying" in jumpy.review[0]


def test_prices_parse_from_south_african_formats():
    assert parse_price("R 19,99") == D("19.99")
    assert parse_price("R1 299.00") == D("1299.00")
    assert parse_price(42) == D("42.00")
    assert parse_price("n/a") is None and parse_price(True) is None


def test_parse_listings_accepts_common_response_shapes():
    for payload in (
        {"data": [{"name": "Ace Super Maize Meal 2.5kg", "price": "R44.99", "url": "https://x"}]},
        {"products": [{"title": "Ace Super Maize Meal", "current_price": 44.99, "size": "2.5kg"}]},
        {"result": {"items": [{"productName": "Ace Super Maize Meal 2.5kg",
                               "price": {"amount": 44.99, "currency": "ZAR"}}]}},
        [{"name": "Ace Super Maize Meal 2.5kg", "salePrice": 44.99, "wasPrice": 49.99}],
    ):
        listings = parse_listings(payload, "checkers", now=NOW)
        assert len(listings) == 1, payload
        assert listings[0].price == D("44.99")
        assert match_score(MAIZE, listings[0]) > 0
    assert parse_listings({"data": [{"name": "No price"}]}, "checkers") == []


def test_rapidapi_provider_builds_the_documented_request():
    seen = {}

    class Response(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def opener(request, timeout):
        seen["url"] = request.full_url
        seen["headers"] = dict(request.header_items())
        return Response(json.dumps({"data": [{"name": "Ace Super Maize Meal 2.5kg",
                                              "price": 44.99}]}).encode())

    provider = RapidApiSaGroceryProvider(key="k", store_map={"picknpay": "pnp"}, opener=opener)
    listings = provider.search("picknpay", "maize meal")
    assert seen["url"].startswith(
        "https://south-african-grocery-prices-api.p.rapidapi.com/v1/pnp/products?")
    assert "search=maize+meal" in seen["url"] and "limit=20" in seen["url"]
    assert seen["headers"]["X-rapidapi-key"] == "k"
    assert listings[0].store_key == "picknpay"
    assert provider.search("shoprite", "x") == []           # no slug, no request
    assert provider.requests_made == 1


def test_rapidapi_provider_refuses_to_run_without_a_key():
    with pytest.raises(RuntimeError):
        RapidApiSaGroceryProvider(key="", store_map={"checkers": "checkers"}).search("checkers", "x")


def test_the_csv_template_loads_and_blank_rows_are_skipped(tmp_path=None):
    template = Path(__file__).resolve().parents[1] / "docs" / "prices" / "verified_prices.csv"
    assert CsvPriceProvider(template).fetch() == []          # all blank: nothing invented
    filled = Path("/tmp/verified_prices_test.csv")
    filled.write_text(
        "store_key,product_name,brand,size,price,observed_at,source_url,checked_by\n"
        "checkers,Super Maize Meal,Ace,2.5kg,R44.99,2026-09-24,https://www.checkers.co.za/x,M9\n"
        "checkers,Brown Bread,Albany,700g,,,,\n"
    )
    listings = CsvPriceProvider(filled).fetch()
    assert len(listings) == 1
    assert listings[0].source == "verified_manual" and listings[0].price == D("44.99")
    plan = plan_refresh([MAIZE], listings)
    assert plan.updates[0].new_price == D("44.99")

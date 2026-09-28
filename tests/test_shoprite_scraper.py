"""
app/scrapers/shoprite.py parsing, offline. The product dicts below are
trimmed from a REAL captured response — a live POST to
shoprite.co.za/api/catalogue/get-products-filter for "beans" (Sep 2026),
saved locally and used as fixed sample data here so this test suite runs
without the network. They are not invented.

The parsing itself (price/stock rules, slugify) lives in
app/scrapers/sixty60_platform.py and is exercised end to end here, plus
already covered in depth by tests/test_checkers_scraper.py (same shared
code, same guarantees) — this file focuses on Shoprite's own wiring:
its base URL, display name, and that fetch_raw/parse_products are wired to
the right store key.
"""

from unittest.mock import Mock

import pytest
import requests

from app.scrapers import shoprite

# --- real sample rows, trimmed (see module docstring) -----------------------

IN_STOCK_SAMPLE = {
    "id": "5d3af641f434cf8420738055", "storeId": "65cb65a1f88f400671ab9c79",
    "name": "KOO Baked Beans in Tomato Sauce 400g",
    "displayName": "KOO Baked Beans in Tomato Sauce 400g",
    "articleNumber": "10126789", "unitOfMeasure": "EA", "brand": "KOO",
    "price": 15.99, "discountedPrice": 15.99, "priceWithoutDecimal": 1599, "priceFactor": 100,
    "isOnPromotion": True, "outOfStock": False, "isStockAvailable": True,
    "imageURL": "https://catalog.sixty60.co.za/files/6a5f7a2084c9006bff14eadd",
    "imageProductCardURL": "https://catalog.sixty60.co.za/v2/files/6a5f7a2084c9006bff14eadd?width=600&height=600",
}

# A REAL out-of-stock sample from the same response: price 0,
# priceWithoutDecimal 0, discountedPrice null, outOfStock true,
# isStockAvailable false — the same shape Checkers uses for "no price".
OUT_OF_STOCK_SAMPLE = {
    "id": "5fd79c16d8f8b5818644788f", "storeId": None,
    "name": "KOO Speckled Sugar Beans In Brine Can 410g",
    "displayName": "KOO Speckled Sugar Beans In Brine Can 410g",
    "articleNumber": "10127832", "unitOfMeasure": "", "brand": "",
    "price": 0, "discountedPrice": None, "priceWithoutDecimal": 0, "priceFactor": 0,
    "isOnPromotion": False, "outOfStock": True, "isStockAvailable": False,
    "imageURL": "https://catalog.sixty60.co.za/files/6a6030f18c5778fb0e0fa446",
    "imageProductCardURL": "https://catalog.sixty60.co.za/v2/files/6a6030f18c5778fb0e0fa446?width=600&height=600",
}


def test_parses_real_in_stock_sample():
    [p] = shoprite.parse_products({"products": [IN_STOCK_SAMPLE]})
    assert p == {
        "name": "KOO Baked Beans in Tomato Sauce 400g", "price": 15.99,
        "image_url": "https://catalog.sixty60.co.za/v2/files/6a5f7a2084c9006bff14eadd?width=600&height=600",
        "product_url": "https://www.shoprite.co.za/product/koo-baked-beans-in-tomato-sauce-400g-10126789EA",
        "sku": "10126789", "brand": "KOO", "on_promotion": True, "in_stock": True,
        "store": "Shoprite",
    }


def test_parses_real_out_of_stock_sample_never_r0():
    [p] = shoprite.parse_products({"products": [OUT_OF_STOCK_SAMPLE]})
    assert p["price"] is None and p["price"] != 0
    assert p["in_stock"] is False
    assert p["store"] == "Shoprite"
    # articleNumber present but unitOfMeasure is "" (falsy) -> falls back to the id-based URL
    assert p["product_url"] == \
        "https://www.shoprite.co.za/product/koo-speckled-sugar-beans-in-brine-can-410g-5fd79c16d8f8b5818644788f"


def test_skips_duplicates_and_junk():
    products = [IN_STOCK_SAMPLE, IN_STOCK_SAMPLE, {**IN_STOCK_SAMPLE, "name": "", "displayName": ""}, "x"]
    assert len(shoprite.parse_products({"products": products})) == 1


def _session(status=200, json_body=None, headers=None, text=""):
    response = Mock(status_code=status, headers=headers or {}, text=text)
    if json_body is None:
        response.json.side_effect = ValueError("not json")
    else:
        response.json.return_value = json_body
    return Mock(post=Mock(return_value=response))


def test_search_end_to_end_with_stubbed_http():
    s = _session(json_body={"products": [IN_STOCK_SAMPLE], "totalCount": 1})
    assert [p["name"] for p in shoprite.search("beans", session=s)] == \
        ["KOO Baked Beans in Tomato Sauce 400g"]
    sent = s.post.call_args
    assert sent.args[0] == "https://www.shoprite.co.za/api/catalogue/get-products-filter"
    assert sent.kwargs["json"]["filterData"]["filter"]["productListSource"] == {"search": "beans"}
    assert sent.kwargs["headers"]["Origin"] == "https://www.shoprite.co.za"


def test_waf_challenge_returns_empty(caplog):
    s = _session(202, headers={"x-amzn-waf-action": "challenge"}, text="<html>")
    assert shoprite.search("beans", session=s) == []
    assert "shoprite bot protection" in caplog.text.lower()


def test_http_error_non_json_and_network_error_return_empty():
    assert shoprite.search("beans", session=_session(500, json_body={})) == []
    assert shoprite.search("beans", session=_session(200, None, text="<html>")) == []
    broken = Mock(post=Mock(side_effect=requests.ConnectionError("down")))
    assert shoprite.search("beans", session=broken) == []
    assert shoprite.search("   ") == []


def test_changed_api_shape_logs_and_returns_empty(caplog):
    assert shoprite.search("beans", session=_session(json_body={"items": []})) == []
    assert "no 'products' list" in caplog.text

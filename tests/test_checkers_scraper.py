"""
app/scrapers/checkers.py parsing, offline. The product dicts below are
trimmed from a real get-products-filter response (search "bread", Sep 2026).
"""

from unittest.mock import Mock

import pytest

import requests

from app.scrapers import checkers


def _product(**overrides):
    base = {
        "id": "5d3af63af434cf8420737d74", "storeId": "5ece6935faafe599532665b2",
        "name": "Albany Superior White Bread 700g",
        "displayName": "Albany Superior White Bread 700g",
        "articleNumber": "10136301", "unitOfMeasure": "EA", "brand": "Albany",
        "price": 18.99, "discountedPrice": 18.99, "priceWithoutDecimal": 1899,
        "priceFactor": 100, "isOnPromotion": False, "outOfStock": False,
        "imageURL": "https://catalog.sixty60.co.za/files/abc",
        "imageProductCardURL": "https://catalog.sixty60.co.za/v2/files/abc?width=600&height=600",
    }
    base.update(overrides)
    return base


def test_parses_real_product_shape():
    [p] = checkers.parse_products({"products": [_product()], "totalCount": 1})
    assert p == {
        "name": "Albany Superior White Bread 700g", "price": 18.99,
        "image_url": "https://catalog.sixty60.co.za/v2/files/abc?width=600&height=600",
        "product_url": "https://www.checkers.co.za/product/albany-superior-white-bread-700g-10136301EA",
        "sku": "10136301", "brand": "Albany", "on_promotion": False, "in_stock": True,
        "store": "Checkers",
    }


def test_promotional_price_and_fallbacks():
    [p] = checkers.parse_products({"products": [_product(
        discountedPrice=15.49, isOnPromotion=True, imageProductCardURL=None)]})
    assert (p["price"], p["on_promotion"]) == (15.49, True)
    assert p["image_url"] == "https://catalog.sixty60.co.za/files/abc"
    [p] = checkers.parse_products({"products": [_product(price=None, discountedPrice=None)]})
    assert p["price"] == 18.99                           # from priceWithoutDecimal / priceFactor


def test_skips_duplicates_and_junk():
    products = [_product(), _product(storeId="other"), _product(name="", displayName=""), "x"]
    assert len(checkers.parse_products({"products": products})) == 1


# Trimmed from the real response for "red speckled beans" (Sep 2026): an
# out-of-stock product comes with price 0, priceWithoutDecimal 0,
# discountedPrice null, outOfStock true and isStockAvailable false.
OUT_OF_STOCK = dict(name="Pride Red Speckled Beans 2kg", displayName="Pride Red Speckled Beans 2kg",
                    articleNumber="10500001", price=0, discountedPrice=None, oldPrice=0,
                    priceWithoutDecimal=0, outOfStock=True, isStockAvailable=False,
                    stockOnHand=None, ranged=False, storeProductActive=False)


def test_out_of_stock_product_has_no_price_never_zero():
    [p] = checkers.parse_products({"products": [_product(**OUT_OF_STOCK)]})
    assert p["price"] is None and p["price"] != 0
    assert p["in_stock"] is False


@pytest.mark.parametrize("flags", [{"outOfStock": True}, {"isStockAvailable": False}])
def test_either_stock_flag_means_out_of_stock(flags):
    [p] = checkers.parse_products({"products": [_product(**flags)]})
    assert (p["price"], p["in_stock"]) == (None, False)


@pytest.mark.parametrize("prices", [
    {"price": 0, "discountedPrice": 0, "priceWithoutDecimal": 0},
    {"price": None, "discountedPrice": None, "priceWithoutDecimal": None},
    {"price": -1, "discountedPrice": None, "priceWithoutDecimal": 0},
])
def test_zero_or_missing_price_in_stock_is_none(prices):
    [p] = checkers.parse_products({"products": [_product(**prices)]})
    assert p["price"] is None and p["in_stock"] is True


def test_slug_matches_site_rule():
    assert checkers._slugify("SASKO Low G.I Wholewheat Brown Bread 800g") == \
        "sasko-low-gi-wholewheat-brown-bread-800g"
    assert checkers._slugify("Mac & Cheese  Café 1/2kg") == "mac-and-cheese-cafe-1-2kg"


def _session(status=200, json_body=None, headers=None, text=""):
    response = Mock(status_code=status, headers=headers or {}, text=text)
    if json_body is None:
        response.json.side_effect = ValueError("not json")
    else:
        response.json.return_value = json_body
    return Mock(post=Mock(return_value=response))


def test_search_end_to_end_with_stubbed_http():
    s = _session(json_body={"products": [_product()], "totalCount": 1})
    assert [p["name"] for p in checkers.search_checkers("bread", session=s)] == \
        ["Albany Superior White Bread 700g"]
    sent = s.post.call_args.kwargs["json"]
    assert sent["filterData"]["filter"]["productListSource"] == {"search": "bread"}


def test_waf_challenge_returns_empty(caplog):
    s = _session(202, headers={"x-amzn-waf-action": "challenge"}, text="<html>")
    assert checkers.search_checkers("bread", session=s) == []
    assert "bot protection" in caplog.text


def test_changed_api_shape_logs_and_returns_empty(caplog):
    assert checkers.search_checkers("bread", session=_session(json_body={"items": []})) == []
    assert "no 'products' list" in caplog.text


def test_http_error_non_json_and_network_error_return_empty():
    assert checkers.search_checkers("bread", session=_session(500, json_body={})) == []
    assert checkers.search_checkers("bread", session=_session(200, None, text="<html>")) == []
    broken = Mock(post=Mock(side_effect=requests.ConnectionError("down")))
    assert checkers.search_checkers("bread", session=broken) == []
    assert checkers.search_checkers("   ") == []

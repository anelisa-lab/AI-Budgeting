"""
app/scrapers/checkers.py parsing, offline. The fixture below is a guessed
__NEXT_DATA__ shape, not a captured Checkers page — the parser searches the
whole tree, so what matters is that it finds products wherever they sit.
"""

import json
from unittest.mock import Mock

import requests

from app.scrapers import checkers


def _page(next_data) -> str:
    return ('<html><body><div id="__next"></div>'
            f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(next_data)}</script>'
            '</body></html>')


NEXT_DATA = {
    "props": {"pageProps": {
        "categories": [{"name": "Bakery", "url": "/c/bakery"}],
        "searchResults": {"products": [
            {"name": "Albany Superior White Bread 700g", "code": "10145623EA",
             "price": {"value": 18.99, "formattedValue": "R18.99"},
             "images": [{"url": "//images.checkers.co.za/albany.png"}],
             "url": "/p/albany-superior-white-bread-700g/10145623EA"},
            {"name": "Sasko Brown Bread 700g", "sku": 222,
             "price": "R16,49", "imageUrl": "https://img.example/sasko.png",
             "url": "https://www.checkers.co.za/p/sasko/222"},
            {"name": "Out of stock thing"},                       # no price: skipped
        ]},
    }},
    "page": "/search",
}


def test_finds_products_anywhere_in_next_data():
    results = checkers.parse_products(checkers.extract_next_data(_page(NEXT_DATA)))
    assert results == [
        {"name": "Albany Superior White Bread 700g", "price": 18.99,
         "image_url": "https://images.checkers.co.za/albany.png",
         "product_url": "https://www.checkers.co.za/p/albany-superior-white-bread-700g/10145623EA",
         "sku": "10145623EA", "store": "Checkers"},
        {"name": "Sasko Brown Bread 700g", "price": 16.49,
         "image_url": "https://img.example/sasko.png",
         "product_url": "https://www.checkers.co.za/p/sasko/222",
         "sku": "222", "store": "Checkers"},
    ]


def test_unrecognised_structure_logs_and_returns_empty(caplog):
    assert checkers.parse_products({"props": {"pageProps": {"foo": 1}}}) == []
    assert "No product list found" in caplog.text


def test_page_without_next_data_returns_none(caplog):
    assert checkers.extract_next_data("<html>nope</html>") is None
    assert "no __NEXT_DATA__" in caplog.text


def _session(status=200, text="", headers=None):
    response = Mock(status_code=status, text=text, headers=headers or {})
    return Mock(get=Mock(return_value=response))


def test_search_end_to_end_with_stubbed_http():
    assert len(checkers.search_checkers("bread", session=_session(text=_page(NEXT_DATA)))) == 2


def test_cloudflare_challenge_returns_empty(caplog):
    s = _session(403, "<title>Just a moment...</title>", {"cf-mitigated": "challenge"})
    assert checkers.search_checkers("bread", session=s) == []
    assert "bot-challenge" in caplog.text


def test_http_error_and_network_error_return_empty():
    assert checkers.search_checkers("bread", session=_session(500, "oops")) == []
    broken = Mock(get=Mock(side_effect=requests.ConnectionError("down")))
    assert checkers.search_checkers("bread", session=broken) == []

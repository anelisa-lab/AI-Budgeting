"""
app/scrapers/superbhyper.py parsing, offline.

IN_STOCK_HTML below is trimmed straight from a REAL page fetched from
https://superbhyper.co.za/?s=bread&post_type=product (Sep 2026) — only the
decorative inline SVG icon was cut for length; every class, price and data
attribute is exactly as the site sent it. It is not invented.

OUT_OF_STOCK_HTML is NOT a captured sample — no out-of-stock product came up
in what was searched while building this scraper. It is built from the same
real product's markup with two documented, real WooCommerce-core facts
applied: the "outofstock" class (the stated counterpart of the "instock"
class actually observed) replaces "instock", and the add-to-cart button is
removed (WooCommerce's own default template swaps it for a plain "Read
more" link on an unpurchasable product) — see the scraper's docstring for
why the SKU fallback exists at all.
"""

from unittest.mock import Mock

import pytest
import requests

from app.scrapers import superbhyper

# --- real sample HTML, trimmed (see module docstring) -----------------------

IN_STOCK_HTML = """
<ul class="products columns-4">
<li class="product type-product post-10329108 status-publish first instock product_cat-new-arrivals has-post-thumbnail taxable shipping-taxable purchasable product-type-simple">
    <div class="astra-shop-thumbnail-wrap">
        <a href="https://superbhyper.co.za/product/bakers-pro-vita-crisp-bread-whole-wheat-23gr/" class="woocommerce-LoopProduct-link woocommerce-loop-product__link">
            <img width="160" height="160" src="https://superbhyper.co.za/wp-content/uploads/2026/09/Bakers-Pro-Vita-Crisp-Bread-Whole-Wheat-23gr-160x160.jpg" class="attachment-woocommerce_thumbnail" alt="Bakers Pro-Vita Crisp Bread Whole Wheat 23gr" />
        </a>
        <a href="/?s=bread&#038;post_type=product&#038;add-to-cart=10329108" class="ast-on-card-button add_to_cart_button ajax_add_to_cart" data-product_id="10329108" data-product_sku="10569" rel="nofollow">Add to cart</a>
    </div>
    <div class="astra-shop-summary-wrap">
        <a href="https://superbhyper.co.za/product/bakers-pro-vita-crisp-bread-whole-wheat-23gr/" class="ast-loop-product__link"><h2 class="woocommerce-loop-product__title">Bakers Pro-Vita Crisp Bread Whole Wheat 23gr</h2></a>
        <span class="price"><span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol">&#82;</span>9.99</bdi></span></span>
        <a href="/?s=bread&#038;post_type=product&#038;add-to-cart=10329108" data-product_id="10329108" data-product_sku="10569" class="button product_type_simple add_to_cart_button ajax_add_to_cart">Add to cart</a>
    </div>
</li>
</ul>
"""

# Not captured — see module docstring.
OUT_OF_STOCK_HTML = """
<ul class="products columns-4">
<li class="product type-product post-99999 status-publish outofstock product_cat-bakery has-post-thumbnail product-type-simple">
    <div class="astra-shop-thumbnail-wrap">
        <a href="https://superbhyper.co.za/product/sasko-brown-bread-700g/" class="woocommerce-LoopProduct-link woocommerce-loop-product__link">
            <img width="160" height="160" src="https://superbhyper.co.za/wp-content/uploads/2026/09/Sasko-Brown-Bread-700g-160x160.jpg" class="attachment-woocommerce_thumbnail" alt="Sasko Brown Bread 700g" />
        </a>
    </div>
    <div class="astra-shop-summary-wrap">
        <a href="https://superbhyper.co.za/product/sasko-brown-bread-700g/" class="ast-loop-product__link"><h2 class="woocommerce-loop-product__title">Sasko Brown Bread 700g</h2></a>
        <span class="price"><span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol">&#82;</span>18.99</bdi></span></span>
        <a href="https://superbhyper.co.za/product/sasko-brown-bread-700g/" class="button product_type_simple">Read more</a>
    </div>
</li>
</ul>
"""


def test_parses_real_in_stock_sample():
    [p] = superbhyper.parse_products(IN_STOCK_HTML)
    assert p == {
        "name": "Bakers Pro-Vita Crisp Bread Whole Wheat 23gr", "price": 9.99,
        "image_url": "https://superbhyper.co.za/wp-content/uploads/2026/09/"
                     "Bakers-Pro-Vita-Crisp-Bread-Whole-Wheat-23gr-160x160.jpg",
        "product_url": "https://superbhyper.co.za/product/bakers-pro-vita-crisp-bread-whole-wheat-23gr/",
        "sku": "10569", "brand": None, "on_promotion": False, "in_stock": True,
        "store": "SuperbHyper",
    }


def test_out_of_stock_never_shows_r0_and_falls_back_to_url_slug_for_sku():
    [p] = superbhyper.parse_products(OUT_OF_STOCK_HTML)
    assert p["price"] is None and p["price"] != 0
    assert p["in_stock"] is False
    assert p["sku"] == "sasko-brown-bread-700g"    # no add-to-cart button -> URL slug
    assert p["store"] == "SuperbHyper"


def test_skips_duplicates_and_junk():
    products = superbhyper.parse_products(IN_STOCK_HTML + IN_STOCK_HTML)
    assert len(products) == 1
    assert superbhyper.parse_products("<ul class='products'><li>no title here</li></ul>") == []


def _session(status=200, text="", raise_exc=None):
    if raise_exc:
        return Mock(get=Mock(side_effect=raise_exc))
    response = Mock(status_code=status, text=text)
    return Mock(get=Mock(return_value=response))


def test_search_end_to_end_with_stubbed_http():
    s = _session(text=IN_STOCK_HTML)
    assert [p["name"] for p in superbhyper.search("bread", session=s)] == \
        ["Bakers Pro-Vita Crisp Bread Whole Wheat 23gr"]
    sent = s.get.call_args
    assert sent.args[0] == "https://superbhyper.co.za/"
    assert sent.kwargs["params"] == {"s": "bread", "post_type": "product"}


def test_http_error_and_network_error_return_empty():
    assert superbhyper.search("bread", session=_session(500, "")) == []
    assert superbhyper.search("bread", session=_session(raise_exc=requests.ConnectionError("down"))) == []
    assert superbhyper.search("   ") == []


def test_blocked_page_returns_empty(caplog):
    blocked_html = "<html><body>Attention Required! | Cloudflare</body></html>"
    assert superbhyper.search("bread", session=_session(text=blocked_html)) == []
    assert "blocked" in caplog.text.lower()

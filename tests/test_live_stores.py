"""app/scrapers/__init__.py — only the stores in LIVE_PRICE_STORES are called."""

import logging
import sys

from app import scrapers


def test_default_is_checkers_only(monkeypatch):
    monkeypatch.delenv("LIVE_PRICE_STORES", raising=False)
    assert scrapers.active_stores() == ["checkers"]


def test_unknown_and_duplicate_keys_are_dropped(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    monkeypatch.setenv("LIVE_PRICE_STORES", " Checkers, picknpay ,checkers,")
    assert scrapers.active_stores() == ["checkers"]            # no live scraper for picknpay
    assert "picknpay" in caplog.text


def test_enabled_stores_include_stores_without_a_scraper(monkeypatch):
    # app/price_feed stores (e.g. picknpay via RapidAPI) are switched on here too
    monkeypatch.setenv("LIVE_PRICE_STORES", "checkers,PicknPay")
    assert scrapers.enabled_stores() == ["checkers", "picknpay"]
    assert scrapers.is_enabled("picknpay") and not scrapers.is_enabled("shoprite")
    monkeypatch.delenv("LIVE_PRICE_STORES")
    assert scrapers.enabled_stores() == ["checkers"]
    assert not scrapers.is_enabled("picknpay")


def test_store_names():
    assert scrapers.store_name("checkers") == "Checkers"
    assert scrapers.store_name("shoprite") == "Shoprite"
    assert scrapers.store_name("pnp") == "Pick n Pay"


def test_inactive_scrapers_are_never_imported_or_called(monkeypatch):
    calls = []
    fake = type(sys)("fake_store")
    fake.search = lambda q: calls.append(q) or [{"name": "x"}]
    monkeypatch.setitem(sys.modules, "fake_store", fake)
    monkeypatch.setitem(scrapers.SCRAPERS, "fake", "fake_store:search")
    monkeypatch.setitem(scrapers.SCRAPERS, "checkers", "not_imported_module:nope")

    monkeypatch.setenv("LIVE_PRICE_STORES", "fake")
    assert scrapers.search_live("bread") == [{"name": "x"}]
    assert calls == ["bread"]

    monkeypatch.setenv("LIVE_PRICE_STORES", "")
    assert scrapers.search_live("bread") == []
    assert calls == ["bread"]


def test_a_failing_store_does_not_break_the_search(monkeypatch):
    broken = type(sys)("broken_store")
    broken.search = lambda q: 1 / 0
    monkeypatch.setitem(sys.modules, "broken_store", broken)
    monkeypatch.setitem(scrapers.SCRAPERS, "broken", "broken_store:search")
    monkeypatch.setenv("LIVE_PRICE_STORES", "broken")
    assert scrapers.search_live("bread") == []


def test_shoprite_is_registered_and_can_be_switched_on(monkeypatch):
    assert scrapers.SCRAPERS["shoprite"] == "app.scrapers.shoprite:search"
    monkeypatch.setenv("LIVE_PRICE_STORES", "checkers,shoprite")
    assert scrapers.active_stores() == ["checkers", "shoprite"]
    assert scrapers.store_name("shoprite") == "Shoprite"
    # switching it back off is one line, no code change
    monkeypatch.setenv("LIVE_PRICE_STORES", "checkers")
    assert scrapers.active_stores() == ["checkers"]


def test_checkers_failing_does_not_hide_real_shoprite_results(monkeypatch):
    """Same guarantee as test_one_failing_store_does_not_hide_another_store,
    but through the actual registered checkers/shoprite modules rather than
    fakes, so a wiring mistake between the two real scrapers would show up
    here."""
    import app.scrapers.checkers as checkers_module
    import app.scrapers.shoprite as shoprite_module

    monkeypatch.setattr(checkers_module, "search",
                        lambda query: (_ for _ in ()).throw(RuntimeError("Checkers is down")))
    monkeypatch.setattr(shoprite_module, "search",
                        lambda query: [{"name": "Bread", "store": "Shoprite"}])
    monkeypatch.setenv("LIVE_PRICE_STORES", "checkers,shoprite")
    assert scrapers.search_live("bread") == [{"name": "Bread", "store": "Shoprite"}]


def test_one_failing_store_does_not_hide_another_store(monkeypatch):
    good = type(sys)("good_store")
    good.search = lambda q: [{"name": "Bread", "store": "Good"}]
    broken = type(sys)("broken_store")
    broken.search = lambda q: 1 / 0
    monkeypatch.setitem(sys.modules, "good_store", good)
    monkeypatch.setitem(sys.modules, "broken_store", broken)
    monkeypatch.setitem(scrapers.SCRAPERS, "good", "good_store:search")
    monkeypatch.setitem(scrapers.SCRAPERS, "broken", "broken_store:search")
    monkeypatch.setenv("LIVE_PRICE_STORES", "broken,good")
    assert scrapers.search_live("bread") == [{"name": "Bread", "store": "Good"}]

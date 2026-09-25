"""
Live prices — Phase 4.

The seed prices in docs/seed/products.json are MODELLED (base price x a
chain's price index x a category modifier) — the dataset says so itself.
This package is how real prices get in, and how the app knows which prices
are real.

    price_source on product_offers
        seed_estimate     modelled by build_seed.py; never checked
        live_api          fetched from a live price source by `refresh`
        verified_manual   typed in by a team member from the retailer's own
                          site or shelf, with the date and the URL

Sources (see providers.py):

    RapidApiSaGroceryProvider   the third-party "South African Grocery Prices
                                API" on RapidAPI (Pick n Pay, Checkers,
                                Woolworths). Needs RAPIDAPI_KEY. NOT TESTED
                                against the live service — run
                                `python -m app.price_feed probe` first.
    CsvPriceProvider            docs/prices/verified_prices.csv, filled in by
                                hand. Works today, no key needed.

There is no official public price API from any South African grocer. Every
live source is either a third party or scraping, so a matched price is only
applied when the match is unambiguous (matching.py) and the price moved by
less than MAX_PRICE_JUMP (refresh.py); everything else goes to review.

    python -m app.price_feed status
    python -m app.price_feed probe --store checkers --query "maize meal"
    python -m app.price_feed refresh --provider csv --file docs/prices/verified_prices.csv --dry-run
    python -m app.price_feed refresh --provider rapidapi --dry-run
"""

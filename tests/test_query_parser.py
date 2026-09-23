"""
Query-parser tests — Member 5.

These double as the spec for what the parser promises to understand. If a
phrase students actually type isn't in here, it isn't supported.
"""

from decimal import Decimal

from app.query_parser import parse_query

D = Decimal


def test_empty_query_is_harmless():
    parsed = parse_query("")
    assert parsed.keywords == []
    assert parsed.max_price is None
    assert parse_query(None).raw_query == ""


def test_the_headline_example():
    """
    Category names come from Member 9's catalogue, not from this parser's
    imagination — see CATEGORY_KEYWORDS. Phase 2 guessed "household" for
    washing powder; the seed files it under Toiletries/Laundry, and the
    mismatch made the search return nothing at all.
    """
    parsed = parse_query("cheap washing powder under R100 near me")
    assert parsed.max_price == D("100")
    assert parsed.category == "Toiletries"
    assert parsed.subcategory == "Laundry"
    assert parsed.nearby_only is True
    assert parsed.sort_hint == "price_asc"
    assert parsed.keywords == ["washing", "powder"]
    # Inferred, so it may only nudge the ranking — never filter.
    assert parsed.category_is_explicit is False


def test_colour_and_size_are_still_extracted():
    parsed = parse_query("black bath towel size L")
    assert parsed.colour == "black"
    assert parsed.size == "L"
    assert parsed.category == "Homeware"
    assert parsed.subcategory == "Bathroom"


def test_size_is_not_mistaken_for_a_price():
    """The bug this ordering exists to prevent."""
    parsed = parse_query("shoes size 9")
    assert parsed.size == "9"
    assert parsed.max_price is None


def test_size_next_to_a_price_keeps_both_intact():
    parsed = parse_query("takkies under 500 size 9")
    assert parsed.max_price == D("500")
    assert parsed.size == "9"


def test_currency_formats():
    assert parse_query("under R500").max_price == D("500")
    assert parse_query("under r 500").max_price == D("500")
    assert parse_query("under 500 rand").max_price == D("500")
    assert parse_query("under R1 200").max_price == D("1200")
    assert parse_query("under R1,200").max_price == D("1200")
    assert parse_query("under 2k").max_price == D("2000")
    assert parse_query("under R1.5k").max_price == D("1500")


def test_max_price_phrasings():
    for phrase in [
        "laptop under R5000",
        "laptop below R5000",
        "laptop less than R5000",
        "laptop no more than R5000",
        "laptop up to R5000",
        "laptop max R5000",
        "laptop with a budget of R5000",
    ]:
        assert parse_query(phrase).max_price == D("5000"), phrase


def test_min_price_phrasing():
    parsed = parse_query("headphones over R300")
    assert parsed.min_price == D("300")
    assert parsed.max_price is None


def test_between_sets_both_bounds():
    parsed = parse_query("jacket between R200 and R600")
    assert parsed.min_price == D("200")
    assert parsed.max_price == D("600")


def test_between_handles_reversed_bounds():
    parsed = parse_query("jacket between R600 and R200")
    assert (parsed.min_price, parsed.max_price) == (D("200"), D("600"))


def test_bare_amount_is_read_as_a_ceiling():
    parsed = parse_query("sneakers R500")
    assert parsed.max_price == D("500")


def test_first_colour_typed_wins():
    parsed = parse_query("red and black hoodie")
    assert parsed.colour == "red"


def test_gray_normalises_to_grey():
    assert parse_query("gray jacket").colour == "grey"


def test_essentials_flag():
    parsed = parse_query("essential groceries for the week")
    assert parsed.essential_only is True
    assert parsed.category == "Groceries"


def test_free_delivery_phrase():
    parsed = parse_query("kettle with free delivery")
    assert parsed.free_delivery_only is True
    assert parsed.category == "Homeware"


def test_collection_phrase():
    parsed = parse_query("rice I can collect")
    assert parsed.prefer_collection is True


def test_best_sets_a_rating_sort_hint():
    assert parse_query("best earphones").sort_hint == "rating_desc"
    assert parse_query("cheapest earphones").sort_hint == "price_asc"


def test_clothing_sizes():
    assert parse_query("hoodie size XL").size == "XL"
    assert parse_query("jacket XXL").size == "XXL"


def test_category_mapping_covers_student_staples():
    """Every pair here exists in mintly-react/docs/seed/products.json."""
    cases = {
        "maize meal": ("Groceries", "Staples"),
        "sanitary pads": ("Toiletries", "Feminine Care"),
        "a calculator for stats": ("Stationery", "Calculators"),
        "phone charger": ("Electronics", "Power"),
        "washing powder": ("Toiletries", "Laundry"),
        "kettle": ("Homeware", "Kitchen"),
        "brown bread": ("Groceries", "Bakery"),
        "toothpaste": ("Toiletries", "Oral Care"),
    }
    for query, (category, subcategory) in cases.items():
        parsed = parse_query(query)
        assert (parsed.category, parsed.subcategory) == (category, subcategory), query


def test_constraints_are_json_safe():
    """parsed_constraints goes into a JSONB column, so no Decimals allowed."""
    constraints = parse_query("black sneakers under R500").to_constraints()
    assert constraints["max_price"] == "500"
    assert isinstance(constraints["keywords"], list)
    assert all(
        isinstance(v, (str, list, bool, type(None)))
        for v in constraints.values()
    )


def test_unparseable_query_still_returns_keywords():
    parsed = parse_query("something completely unexpected")
    assert parsed.category is None
    assert "unexpected" in parsed.keywords


def test_intent_words_are_not_left_as_keywords():
    # Regression: "rated" stayed in keywords, so /search required it in the
    # product name and "best rated bread" found nothing.
    parsed = parse_query("best rated bread")
    assert parsed.sort_hint == "rating_desc"
    assert parsed.keywords == ["bread"]
    assert parse_query("affordable essentials soap").keywords == ["soap"]


def test_r_ending_a_word_is_not_a_rand_amount():
    # Regression: the "r" of "paper 2-ply" read as R2, so /search for the
    # catalogue's own "Toilet Paper 2-Ply" was capped at R2 and found nothing.
    parsed = parse_query("Toilet Paper 2-Ply")
    assert parsed.max_price is None
    assert "paper" in parsed.keywords
    assert parse_query("soap R25").max_price == Decimal("25")


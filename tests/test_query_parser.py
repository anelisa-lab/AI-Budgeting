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
    parsed = parse_query("cheap black sneakers under R500 near me size 9")
    assert parsed.colour == "black"
    assert parsed.size == "9"
    assert parsed.max_price == D("500")
    assert parsed.category == "clothing"
    assert parsed.subcategory == "footwear"
    assert parsed.nearby_only is True
    assert parsed.sort_hint == "price_asc"
    assert parsed.keywords == ["sneakers"]


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
    assert parsed.category == "groceries"


def test_free_delivery_phrase():
    parsed = parse_query("kettle with free delivery")
    assert parsed.free_delivery_only is True
    assert parsed.category == "household"


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
    cases = {
        "maize meal": ("groceries", "staples"),
        "sanitary pads": ("toiletries", "sanitary"),
        "a calculator for stats": ("stationery", "equipment"),
        "phone charger": ("electronics", "accessories"),
        "washing powder": ("household", "cleaning"),
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

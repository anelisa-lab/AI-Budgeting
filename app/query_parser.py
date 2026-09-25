"""
Natural-language query parser — Member 5.

Phase 1 decision (agreed with Member 4): keyword parsing, not NLP. No model,
no external service, no API key — a student on a slow connection types
"cheap black sneakers under R500 near me size 9" and this turns it into:

    ParsedQuery(keywords=['sneakers'], colour='black', size='9',
                max_price=Decimal('500'), category='clothing',
                subcategory='footwear', nearby_only=True,
                sort_hint='price_asc')

which the recommender and Member 4's /search both understand. Rule-based
parsing is also the honest choice for a 7-day sprint: it is fast, it works
offline, and when it gets something wrong you can see exactly which rule did
it. Swapping in a real NLP layer later only means replacing parse_query() —
everything downstream takes the ParsedQuery object.

How it works: each extractor runs in turn over the query, and whatever it
matches is blanked out of the working string so later extractors can't match
the same words twice. Order matters — sizes are pulled out before prices so
"size 9" is never read as a R9 budget.

Pure Python, no dependencies. Tests in tests/test_query_parser.py.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Dict, List, Optional

# ---------------------------------------------------------------------------
# Vocabularies — extend these as the seed data grows (Member 9's dataset is
# the source of truth for what actually exists to be found).
# ---------------------------------------------------------------------------

COLOURS = [
    "black", "white", "grey", "gray", "silver", "gold", "beige", "cream",
    "brown", "tan", "navy", "blue", "red", "maroon", "burgundy", "pink",
    "purple", "green", "olive", "yellow", "orange", "khaki", "denim",
]

# keyword -> (category, subcategory)
#
# These names are taken FROM Member 9's dataset, not invented here: they are
# the exact strings in products.category / products.subcategory
# (mintly-react/docs/seed/products.json). Guessing them is what made the
# Phase 2 version return nothing for "kettle" — it mapped to "household"
# while the catalogue calls it "Homeware".
#
# Matching is case-insensitive, so the capitalisation below is only for
# readability. Keep this table in step with the seed data: when Member 9 adds
# a category, add its words here.
#
# A category guessed here is a HINT, not a filter — see the note on
# category_is_explicit below.
CATEGORY_KEYWORDS: Dict[str, tuple] = {
    # ---- Groceries ----
    "groceries": ("Groceries", None),
    "grocery": ("Groceries", None),
    "food": ("Groceries", None),
    "maize": ("Groceries", "Staples"),
    "mealie": ("Groceries", "Staples"),
    "pap": ("Groceries", "Staples"),
    "rice": ("Groceries", "Staples"),
    "samp": ("Groceries", "Staples"),
    "oats": ("Groceries", "Staples"),
    "flour": ("Groceries", "Staples"),
    "beans": ("Groceries", "Staples"),
    "bread": ("Groceries", "Bakery"),
    "milk": ("Groceries", "Dairy"),
    "eggs": ("Groceries", "Dairy"),
    "margarine": ("Groceries", "Dairy"),
    "butter": ("Groceries", "Dairy"),
    "chicken": ("Groceries", "Meat"),
    "meat": ("Groceries", "Meat"),
    "polony": ("Groceries", "Meat"),
    "vegetables": ("Groceries", "Fresh Produce"),
    "veggies": ("Groceries", "Fresh Produce"),
    "fruit": ("Groceries", "Fresh Produce"),
    "potatoes": ("Groceries", "Fresh Produce"),
    "onions": ("Groceries", "Fresh Produce"),
    "tomatoes": ("Groceries", "Fresh Produce"),
    "cabbage": ("Groceries", "Fresh Produce"),
    "bananas": ("Groceries", "Fresh Produce"),
    "noodles": ("Groceries", "Pantry"),
    "oil": ("Groceries", "Pantry"),
    "sugar": ("Groceries", "Pantry"),
    "tea": ("Groceries", "Pantry"),
    "teabags": ("Groceries", "Pantry"),
    "coffee": ("Groceries", "Pantry"),
    "tinned": ("Groceries", "Canned"),
    "canned": ("Groceries", "Canned"),
    "pilchards": ("Groceries", "Canned"),
    "fish": ("Groceries", "Canned"),

    # ---- Toiletries ----
    "toiletries": ("Toiletries", None),
    "soap": ("Toiletries", "Body"),
    "deodorant": ("Toiletries", "Body"),
    "roll-on": ("Toiletries", "Body"),
    "shampoo": ("Toiletries", "Hair"),
    "conditioner": ("Toiletries", "Hair"),
    "toothpaste": ("Toiletries", "Oral Care"),
    "toothbrush": ("Toiletries", "Oral Care"),
    "pads": ("Toiletries", "Feminine Care"),
    "sanitary": ("Toiletries", "Feminine Care"),
    "tampons": ("Toiletries", "Feminine Care"),
    "washing": ("Toiletries", "Laundry"),
    "detergent": ("Toiletries", "Laundry"),
    "laundry": ("Toiletries", "Laundry"),
    "dishwashing": ("Toiletries", "Household"),
    "toilet": ("Toiletries", "Household"),
    "vaseline": ("Toiletries", "Skin"),
    "lotion": ("Toiletries", "Skin"),

    # ---- Homeware ----
    "homeware": ("Homeware", None),
    "household": ("Homeware", None),
    "kettle": ("Homeware", "Kitchen"),
    "hotplate": ("Homeware", "Kitchen"),
    "stove": ("Homeware", "Kitchen"),
    "pot": ("Homeware", "Kitchen"),
    "pan": ("Homeware", "Kitchen"),
    "towel": ("Homeware", "Bathroom"),
    "sheet": ("Homeware", "Bedding"),
    "sheets": ("Homeware", "Bedding"),
    "bedding": ("Homeware", "Bedding"),
    "blanket": ("Homeware", "Bedding"),
    "duvet": ("Homeware", "Bedding"),
    "crate": ("Homeware", "Storage"),

    # ---- Stationery ----
    "stationery": ("Stationery", None),
    "notebook": ("Stationery", "Books"),
    "textbook": ("Stationery", "Books"),
    "textbooks": ("Stationery", "Books"),
    "paper": ("Stationery", "Paper"),
    "printing": ("Stationery", "Paper"),
    "pen": ("Stationery", "Writing"),
    "pens": ("Stationery", "Writing"),
    "ballpoint": ("Stationery", "Writing"),
    "calculator": ("Stationery", "Calculators"),

    # ---- Electronics ----
    "electronics": ("Electronics", None),
    "earphones": ("Electronics", "Audio"),
    "headphones": ("Electronics", "Audio"),
    "earbuds": ("Electronics", "Audio"),
    "lamp": ("Electronics", "Lighting"),
    "globe": ("Electronics", "Lighting"),
    "charger": ("Electronics", "Power"),
    "adaptor": ("Electronics", "Power"),
    "adapter": ("Electronics", "Power"),
    "powerbank": ("Electronics", "Power"),
    "battery": ("Electronics", "Power"),
    "usb": ("Electronics", "Storage"),
    "flash": ("Electronics", "Storage"),

    # ---- Maintenance (Phase 5) ----
    "maintenance": ("Maintenance", None),
    "repair": ("Maintenance", "Repairs"),
    "repairs": ("Maintenance", "Repairs"),
    "fix": ("Maintenance", "Repairs"),
    "tape": ("Maintenance", "Repairs"),
    "glue": ("Maintenance", "Repairs"),
    "bulb": ("Maintenance", "Lighting"),
    "bulbs": ("Maintenance", "Lighting"),
    "batteries": ("Maintenance", "Batteries"),
    "padlock": ("Maintenance", "Security"),
    "lock": ("Maintenance", "Security"),
    "extension": ("Maintenance", "Electrical"),
    "cord": ("Maintenance", "Electrical"),
}

ESSENTIAL_WORDS = {"essential", "essentials", "basics", "necessity", "necessities", "need"}
NEARBY_WORDS = {"nearby", "near", "close", "closest", "walking", "around"}
CHEAP_WORDS = {"cheap", "cheapest", "affordable", "budget", "sale", "special", "specials", "discount"}
BEST_WORDS = {"best", "top", "highest", "rated", "quality", "reliable"}
FREE_DELIVERY_PHRASES = ["free delivery", "free shipping", "no delivery fee"]
COLLECTION_PHRASES = ["collect", "collection", "click and collect", "pick up", "pickup", "in store", "in-store"]

# Words that carry no search meaning once the rules above have run.
STOPWORDS = {
    "a", "an", "the", "and", "or", "for", "of", "to", "in", "on", "at", "with",
    "me", "my", "i", "want", "need", "looking", "find", "get", "buy", "some",
    "any", "that", "this", "is", "are", "please", "show", "something", "good",
    "under", "below", "over", "above", "between", "than", "less", "more",
    "max", "maximum", "min", "minimum", "up", "most", "least", "about",
    "around", "cheapest", "cheap", "best", "near", "nearby", "closest",
    "size", "rand", "r", "zar", "bucks", "delivery", "shipping", "free",
    # Intent words: they already set a flag or sort hint above, and as search
    # text they'd require e.g. "rated" to appear in the product name.
    "rated", "highest", "affordable", "essential", "essentials", "basics", "close",
}

# ---------------------------------------------------------------------------
# Regexes
# ---------------------------------------------------------------------------

# A money amount: R500, r 500, 500 rand, 1 200, 1,200, 1.2k, 2k
#
# The grouped-thousands alternative is tried first and requires exactly three
# digits after each separator, so "1 200" reads as 1200 while "500  9" (which
# is what "under 500 size 9" looks like once the size has been blanked out)
# only ever reads as 500.
_NUMBER = r"\d{1,3}(?:[ ,]\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?"
_AMOUNT = rf"(?:r\s*)?({_NUMBER})\s*(k\b)?\s*(?:rand|zar|bucks)?"

_BETWEEN_RE = re.compile(rf"between\s+{_AMOUNT}\s+and\s+{_AMOUNT}", re.I)
_MAX_RE = re.compile(
    rf"(?:under|below|less\s+than|cheaper\s+than|no\s+more\s+than|at\s+most|"
    rf"up\s+to|within|max(?:imum)?(?:\s+of)?|budget\s+of)\s+{_AMOUNT}",
    re.I,
)
_MIN_RE = re.compile(
    rf"(?:over|above|more\s+than|at\s+least|from|min(?:imum)?(?:\s+of)?)\s+{_AMOUNT}",
    re.I,
)
# A bare amount that is explicitly money (has R or 'rand'), e.g. "sneakers R500".
# The R must start a word: without \b the "r" ending "paper 2-ply" read as R2.
_BARE_MONEY_RE = re.compile(
    rf"(?:\br\s*({_NUMBER})\s*(k\b)?|({_NUMBER})\s*(k\b)?\s*(?:rand|zar|bucks))", re.I
)

_SIZE_RE = re.compile(r"\bsize\s*[:]?\s*([a-z0-9]{1,4})\b", re.I)
_SIZE_STANDALONE_RE = re.compile(r"\b(xxs|xs|xl|xxl|xxxl|uk\s*\d{1,2}|sa\s*\d{1,2})\b", re.I)


def _to_decimal(raw: str, thousand_suffix: Optional[str] = None) -> Optional[Decimal]:
    """
    '1 200' / '1,200' / '1200' -> 1200 ; '1.2' + 'k' -> 1200.

    South African prices are written with a space or comma as the thousands
    separator, so both are stripped. A trailing 'k' multiplies by 1000.
    """
    if not raw:
        return None
    cleaned = raw.replace(" ", "").replace(",", "").strip()
    try:
        value = Decimal(cleaned)
    except (InvalidOperation, ValueError):
        return None
    if thousand_suffix:
        value *= 1000
    if value < 0:
        return None
    return value


def _blank(text: str, start: int, end: int) -> str:
    """Replace a matched span with spaces so later rules skip it."""
    return text[:start] + " " * (end - start) + text[end:]


@dataclass
class ParsedQuery:
    """Structured constraints pulled out of a free-text query."""

    raw_query: str = ""
    keywords: List[str] = field(default_factory=list)
    category: Optional[str] = None
    subcategory: Optional[str] = None
    colour: Optional[str] = None
    size: Optional[str] = None
    min_price: Optional[Decimal] = None
    max_price: Optional[Decimal] = None
    essential_only: bool = False
    nearby_only: bool = False
    free_delivery_only: bool = False
    prefer_collection: bool = False
    sort_hint: Optional[str] = None          # 'price_asc' | 'rating_desc'

    # False when `category` was GUESSED from a keyword, True when the caller
    # passed it as an explicit filter (POST /recommendations {"category": ...}).
    #
    # This distinction is the difference between a search that works and one
    # that returns nothing. A student saying "black" has stated a colour — a
    # blue item is wrong. A student saying "washing powder" has stated no
    # category at all; this parser *infers* one, and it can be wrong (the seed
    # files Auto Washing Powder under Toiletries, not Homeware). So an inferred
    # category only nudges the ranking, while an explicit one filters.
    category_is_explicit: bool = False

    @property
    def search_text(self) -> str:
        """What's left to match against product name/brand — may be empty."""
        return " ".join(self.keywords)

    def to_constraints(self) -> dict:
        """
        JSON-safe dict for shopping_searches.parsed_constraints.

        Storing this makes the parser auditable: QA (Member 10) can look at a
        saved search and see exactly what the system thought the student
        asked for.
        """
        return {
            "keywords": self.keywords,
            "category": self.category,
            "subcategory": self.subcategory,
            "colour": self.colour,
            "size": self.size,
            "min_price": str(self.min_price) if self.min_price is not None else None,
            "max_price": str(self.max_price) if self.max_price is not None else None,
            "essential_only": self.essential_only,
            "nearby_only": self.nearby_only,
            "free_delivery_only": self.free_delivery_only,
            "prefer_collection": self.prefer_collection,
            "sort_hint": self.sort_hint,
            "category_is_explicit": self.category_is_explicit,
        }


def parse_query(query: Optional[str]) -> ParsedQuery:
    """
    Turn free text into a ParsedQuery. Never raises — an unparseable query
    just comes back as keywords, which the recommender handles fine.
    """
    if not query or not query.strip():
        return ParsedQuery(raw_query=query or "")

    raw = query.strip()
    working = " " + raw.lower() + " "

    parsed = ParsedQuery(raw_query=raw)

    # 1. Phrases first — they contain words later rules would eat.
    for phrase in FREE_DELIVERY_PHRASES:
        idx = working.find(phrase)
        if idx != -1:
            parsed.free_delivery_only = True
            working = _blank(working, idx, idx + len(phrase))
    for phrase in COLLECTION_PHRASES:
        idx = working.find(phrase)
        if idx != -1:
            parsed.prefer_collection = True
            working = _blank(working, idx, idx + len(phrase))

    # 2. Sizes before prices, so "size 9" is not read as R9.
    match = _SIZE_RE.search(working)
    if match:
        parsed.size = match.group(1).upper()
        working = _blank(working, *match.span())
    else:
        match = _SIZE_STANDALONE_RE.search(working)
        if match:
            parsed.size = re.sub(r"\s+", " ", match.group(1)).upper()
            working = _blank(working, *match.span())

    # 3. Price ranges.
    match = _BETWEEN_RE.search(working)
    if match:
        low = _to_decimal(match.group(1), match.group(2))
        high = _to_decimal(match.group(3), match.group(4))
        if low is not None and high is not None and low > high:
            low, high = high, low
        parsed.min_price, parsed.max_price = low, high
        working = _blank(working, *match.span())

    if parsed.max_price is None:
        match = _MAX_RE.search(working)
        if match:
            parsed.max_price = _to_decimal(match.group(1), match.group(2))
            working = _blank(working, *match.span())

    if parsed.min_price is None:
        match = _MIN_RE.search(working)
        if match:
            parsed.min_price = _to_decimal(match.group(1), match.group(2))
            working = _blank(working, *match.span())

    # A bare "R500" with no qualifier is read as a ceiling: a student who
    # types "sneakers R500" is stating a budget, not a target price.
    if parsed.max_price is None:
        match = _BARE_MONEY_RE.search(working)
        if match:
            digits = match.group(1) or match.group(3)
            suffix = match.group(2) or match.group(4)
            parsed.max_price = _to_decimal(digits, suffix)
            working = _blank(working, *match.span())

    # 4. Colour — the one the student typed first wins, not the one that
    #    happens to come first in the COLOURS list.
    colour_hits = []
    for colour in COLOURS:
        match = re.search(rf"\b{colour}\b", working)
        if match:
            colour_hits.append((match.start(), colour, match.span()))
    if colour_hits:
        _, colour, span = min(colour_hits)
        parsed.colour = "grey" if colour == "gray" else colour
        working = _blank(working, *span)

    # 5. Category / subcategory. Longest keyword wins so "sanitary pads"
    #    doesn't get claimed by a shorter, vaguer word.
    for keyword in sorted(CATEGORY_KEYWORDS, key=len, reverse=True):
        match = re.search(rf"\b{re.escape(keyword)}\b", working)
        if match:
            category, subcategory = CATEGORY_KEYWORDS[keyword]
            parsed.category = category
            parsed.subcategory = subcategory
            # The word itself stays in the keywords — "sneakers" is still the
            # best text match against product names.
            break

    # 6. Intent flags and sort hints.
    tokens = re.findall(r"[a-z0-9'+-]+", working)
    token_set = set(tokens)

    if token_set & ESSENTIAL_WORDS:
        parsed.essential_only = True
    if token_set & NEARBY_WORDS:
        parsed.nearby_only = True
    if token_set & CHEAP_WORDS:
        parsed.sort_hint = "price_asc"
    elif token_set & BEST_WORDS:
        parsed.sort_hint = "rating_desc"

    # 7. Whatever is left is the text to search product names with.
    parsed.keywords = [
        token for token in tokens
        if token not in STOPWORDS and len(token) > 1 and not token.isdigit()
    ]

    return parsed


def word_pattern(word: str) -> str:
    """Postgres regex (for `~*`) matching `word` as a whole word."""
    return r"\m" + re.escape(str(word).strip()) + r"\M"

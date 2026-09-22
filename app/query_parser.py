"""Transparent keyword parsing for recommendation searches."""

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import re
from typing import List, Optional

COLOURS = "black white grey gray silver gold beige cream brown tan navy blue red maroon pink purple green olive yellow orange khaki denim".split()
CATEGORY_KEYWORDS = {
    "groceries": ("groceries", None), "grocery": ("groceries", None), "food": ("groceries", None),
    "maize": ("groceries", "staples"), "meal": ("groceries", "staples"),
    "toiletries": ("toiletries", None), "soap": ("toiletries", "bath"),
    "shampoo": ("toiletries", "haircare"), "toothpaste": ("toiletries", "oral"),
    "deodorant": ("toiletries", "bath"), "pads": ("toiletries", "sanitary"),
    "stationery": ("stationery", None), "notebook": ("stationery", "paper"),
    "pen": ("stationery", "writing"), "pens": ("stationery", "writing"),
    "calculator": ("stationery", "equipment"), "textbook": ("stationery", "books"),
    "electronics": ("electronics", None), "laptop": ("electronics", "computing"),
    "charger": ("electronics", "accessories"), "cable": ("electronics", "accessories"),
    "phone": ("electronics", "mobile"), "clothing": ("clothing", None),
    "sneakers": ("clothing", "footwear"), "takkies": ("clothing", "footwear"),
    "hoodie": ("clothing", "outerwear"), "jeans": ("clothing", "trousers"),
    "household": ("household", None), "kettle": ("household", "appliances"),
    "washing": ("household", "cleaning"), "powder": ("household", "cleaning"),
}


@dataclass
class ParsedQuery:
    keywords: List[str]
    raw_query: str = ""
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
    sort_hint: Optional[str] = None

    def to_constraints(self) -> dict:
        data = self.__dict__.copy()
        data.pop("raw_query", None)
        for key in ("min_price", "max_price"):
            if data[key] is not None:
                data[key] = format(data[key], "f").rstrip("0").rstrip(".")
        return data


def _amount(value: str) -> Optional[Decimal]:
    try:
        value = value.lower().replace(",", "").replace(" ", "")
        multiplier = Decimal("1000") if value.endswith("k") else Decimal("1")
        value = value.rstrip("k")
        return (Decimal(value) * multiplier).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        return None


def parse_query(query: Optional[str]) -> ParsedQuery:
    text = (query or "").lower().strip()
    working = f" {text} "
    result = ParsedQuery(keywords=[], raw_query=query or "")

    between = re.search(r"\bbetween\s+r?\s*([0-9][0-9, ]*(?:\.[0-9]+)?k?)\s+and\s+r?\s*([0-9][0-9, ]*(?:\.[0-9]+)?k?)", working)
    if between:
        amounts = [_amount(between.group(1)), _amount(between.group(2))]
        result.min_price, result.max_price = min(amounts), max(amounts)
        working = working.replace(between.group(0), " ")

    match = re.search(r"(?:under|below|less than|max(?:imum)?|up to|no more than|budget of)\s+r?\s*([0-9][0-9, ]*(?:\.[0-9]+)?k?)", working)
    if match:
        result.max_price = _amount(match.group(1))
        working = working.replace(match.group(0), " ")
    match = re.search(r"(?:over|above|from|at least)\s+r?\s*([0-9][0-9, ]*(?:\.[0-9]+)?k?)", working)
    if match:
        result.min_price = _amount(match.group(1))
        working = working.replace(match.group(0), " ")

    size = re.search(r"\bsize\s*(XL|XXL|XXXL|[0-9]{1,2}(?:\.[05])?)\b|\b(XXXL|XXL|XL)\b", working, re.I)
    if size:
        result.size = next(group for group in size.groups() if group).upper()
        working = working.replace(size.group(0), " ")
    colour_matches = [
        (match.start(), match.group(1))
        for match in re.finditer(
            r"\b(" + "|".join(map(re.escape, COLOURS)) + r")\b", working
        )
    ]
    if colour_matches:
        _, colour = min(colour_matches)
        result.colour = "grey" if colour == "gray" else colour
        working = re.sub(
            r"\b(" + "|".join(map(re.escape, COLOURS)) + r")\b", " ", working
        )
    # A product phrase can map to a category without leaving a keyword behind.
    special = re.search(r"\b(maize\s+meal|sanitary\s+pads|washing\s+powder|phone\s+charger)\b", working)
    if special:
        phrase = special.group(1)
        mapped = {"maize meal": ("groceries", "staples"), "sanitary pads": ("toiletries", "sanitary"),
                  "washing powder": ("household", "cleaning"), "phone charger": ("electronics", "accessories")}[phrase]
        result.category, result.subcategory = mapped
        working = working.replace(phrase, " ")
    for word, (category, subcategory) in CATEGORY_KEYWORDS.items():
        if re.search(rf"\b{re.escape(word)}\b", working):
            result.category, result.subcategory = category, subcategory
            working = re.sub(rf"\b{re.escape(word)}\b", " ", working, count=1)
            if word in {"sneakers", "takkies"}:
                result.keywords.append(word)
            break

    result.nearby_only = bool(re.search(r"\b(near|nearby|close|around me)\b", text))
    result.free_delivery_only = bool(re.search(r"\b(free delivery|free shipping)\b", text))
    result.prefer_collection = bool(re.search(r"\b(collect|collection|pickup|pick up)\b", text))
    result.essential_only = bool(re.search(r"\b(essential|essentials)\b", text))
    if re.search(r"\bbest\b", text):
        result.sort_hint = "rating_desc"
    elif re.search(r"\bcheap(?:est)?\b|\blowest price\b", text):
        result.sort_hint = "price_asc"
    # Standalone amounts are ceilings too (e.g. "sneakers R500").
    bare = re.search(r"\br?\s*([0-9][0-9, ]*(?:\.[0-9]+)?k?)\b", working)
    if bare and result.max_price is None:
        result.max_price = _amount(bare.group(1))
        working = working.replace(bare.group(0), " ")
    ignored = {"cheap", "cheapest", "best", "near", "nearby", "me", "and", "with", "a", "for",
               "the", "of", "no", "more", "than", "rand", "can", "i", "collect"}
    result.keywords += [w for w in re.findall(r"[a-z0-9]+", working) if w not in ignored]
    return result
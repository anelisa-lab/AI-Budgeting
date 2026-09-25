#!/usr/bin/env python3
"""
Member 9 — seed product dataset for the AI Shopping for Budgeting app.

Produces products.json, products.csv and stores.csv.

TWO COUNTS, AND THEY ARE DIFFERENT — say this clearly in the demo:

  * 40 distinct PRODUCTS  (the "30-50 items" in the task brief)
  * ~150 LISTINGS         (one product at one store, each with its own price)

A product stocked by five stores produces five listings. That is deliberate:
without the same item appearing at several stores there is nothing to compare,
and the comparison screen is the whole point of the app.

FIELD CONTRACT — see SEED_DATA_CONTRACT.md. Every filter the Project Synopsis
names is backed by exactly one field:

    synopsis filter        ->  field
    budget / price          ->  price, total_cost
    lowest-to-highest sort  ->  price, total_cost
    colour                  ->  colour
    size                    ->  size
    shipping cost           ->  shipping_fee
    product location        ->  store_lat / store_lng / distance_km
    25 km radius            ->  distance_km
    store                   ->  store_id / store_name
    category                ->  category / subcategory

Distances are real haversine distances from DUT Steve Biko Campus.

Per-store prices are modelled from each chain's MEASURED price position in
published South African multi-retailer basket surveys (October 2025), then
adjusted by that chain's category specialism. They are indicative, not
scraped. Regenerate with this script rather than editing the JSON by hand —
`total_cost` is derived and will drift if you hand-edit.
"""

import csv
import json
from math import radians, sin, cos, asin, sqrt, floor

CAMPUS = {"name": "DUT Steve Biko Campus", "lat": -29.8547, "lng": 31.0084}


def haversine_km(lat1, lng1, lat2, lng2):
    r = 6371.0
    dlat, dlng = radians(lat2 - lat1), radians(lng2 - lng1)
    a = (sin(dlat / 2) ** 2
         + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2)
    return round(2 * r * asin(sqrt(a)), 2)


# id, name, suburb, lat, lng, delivery?, base shipping, free-over, price index
#
# price_index comes from measured basket totals across these chains:
#   Makro 375.55 · Food Lover's 387.21 · Shoprite 407.25 · SPAR 410.91
#   Checkers 415.91 · Pick n Pay 438.91   (mean 405.96)
# Clicks, Game, Takealot and Incredible Connection are positioned from their
# general market standing, not from that grocery basket.
STORES_RAW = [
    ("shoprite",   "Shoprite Warwick Junction",     "Warwick",          -29.8570, 31.0140, False, 0.00,  0,    1.003),
    ("checkers",   "Checkers Berea Centre",         "Berea",            -29.8489, 31.0056, True,  35.00, 0,    1.025),
    ("game",       "Game Durban CBD",               "Durban Central",   -29.8587, 31.0218, True,  60.00, 1000, 1.020),
    ("picknpay",   "Pick n Pay Musgrave Centre",    "Musgrave",         -29.8437, 30.9997, True,  45.00, 0,    1.081),
    ("clicks",     "Clicks Musgrave Centre",        "Musgrave",         -29.8437, 30.9997, True,  50.00, 450,  1.060),
    ("spar",       "SPAR Glenwood",                 "Glenwood",         -29.8690, 30.9990, True,  40.00, 0,    1.012),
    ("foodlovers", "Food Lover's Market Overport",  "Overport",         -29.8330, 31.0000, True,  45.00, 0,    0.954),
    ("makro",      "Makro Springfield",             "Springfield Park", -29.8100, 31.0150, True,  65.00, 1000, 0.925),
    ("incredible", "Incredible Connection Gateway", "Umhlanga",         -29.7250, 31.0670, True,  99.00, 2000, 1.100),
    ("takealot",   "Takealot (online only)",        "Online",           None,     None,    True,  60.00, 450,  0.980),
]

# Each chain's real specialism, as a multiplier on the base price.
# Maintenance (Phase 5) reuses each chain's Homeware multiplier: these stores
# shelve hardware with homeware, and the basket surveys give no separate
# hardware figure, so inventing one would be less honest than reusing it.
MODIFIERS = {
    "shoprite":   {"Groceries": 0.96, "Toiletries": 0.97, "Stationery": 1.02, "Electronics": 1.06, "Homeware": 1.02, "Maintenance": 1.02},
    "checkers":   {"Groceries": 1.00, "Toiletries": 0.99, "Stationery": 1.02, "Electronics": 1.05, "Homeware": 1.01, "Maintenance": 1.01},
    "game":       {"Groceries": 1.02, "Toiletries": 1.00, "Stationery": 0.95, "Electronics": 0.97, "Homeware": 0.93, "Maintenance": 0.93},
    "picknpay":   {"Groceries": 1.02, "Toiletries": 0.99, "Stationery": 1.01, "Electronics": 1.05, "Homeware": 1.02, "Maintenance": 1.02},
    "clicks":     {"Groceries": 1.10, "Toiletries": 0.94, "Stationery": 1.04, "Electronics": 1.04, "Homeware": 1.05, "Maintenance": 1.05},
    "spar":       {"Groceries": 1.02, "Toiletries": 1.02, "Stationery": 1.05, "Electronics": 1.08, "Homeware": 1.05, "Maintenance": 1.05},
    "foodlovers": {"Groceries": 0.94, "Toiletries": 1.06, "Stationery": 1.08, "Electronics": 1.10, "Homeware": 1.06, "Maintenance": 1.06},
    "makro":      {"Groceries": 0.92, "Toiletries": 0.92, "Stationery": 0.94, "Electronics": 0.94, "Homeware": 0.92, "Maintenance": 0.92},
    "incredible": {"Groceries": 1.10, "Toiletries": 1.10, "Stationery": 1.02, "Electronics": 0.99, "Homeware": 1.06, "Maintenance": 1.06},
    "takealot":   {"Groceries": 1.04, "Toiletries": 0.98, "Stationery": 0.93, "Electronics": 0.92, "Homeware": 0.95, "Maintenance": 0.95},
}

GROCERS = ["shoprite", "checkers", "picknpay", "spar", "foodlovers", "makro"]
PHARMACY = ["clicks", "shoprite", "checkers", "picknpay", "spar", "makro"]
GENERAL = ["game", "takealot", "makro"]
TECH = ["takealot", "incredible", "game", "makro"]

# name, brand, category, subcategory, colour, size, unit, base price, icon,
# stores that stock it, rating
ITEMS = [
    # ---- Groceries: staples every store carries -------------------------
    ("Super Maize Meal", "Ace", "Groceries", "Staples", "n/a", "2.5kg", "pack", 41.99, "🌽", GROCERS, 4.4),
    ("Parboiled White Rice", "Tastic", "Groceries", "Staples", "n/a", "2kg", "pack", 42.99, "🍚", GROCERS, 4.6),
    ("Cake Flour", "Snowflake", "Groceries", "Staples", "n/a", "2.5kg", "pack", 32.99, "🌾", GROCERS, 4.4),
    ("Samp", "Imbo", "Groceries", "Staples", "n/a", "1kg", "pack", 19.99, "🌽", ["shoprite", "checkers", "picknpay", "makro"], 4.2),
    ("Sugar Beans", "Imbo", "Groceries", "Staples", "n/a", "1kg", "pack", 32.99, "🫘", ["shoprite", "checkers", "picknpay", "spar", "makro"], 4.3),
    ("2-Minute Noodles", "Maggi", "Groceries", "Pantry", "n/a", "5 x 73g", "pack", 26.99, "🍜", GROCERS, 4.0),
    ("Instant Oats", "Jungle", "Groceries", "Staples", "n/a", "1kg", "pack", 46.99, "🥣", ["shoprite", "checkers", "picknpay", "spar", "makro"], 4.4),

    ("White Bread", "Albany", "Groceries", "Bakery", "n/a", "700g", "loaf", 19.99, "🍞", GROCERS, 4.2),
    ("Brown Bread", "Albany", "Groceries", "Bakery", "n/a", "700g", "loaf", 18.49, "🍞", GROCERS, 4.2),

    ("Full Cream Milk", "Clover", "Groceries", "Dairy", "n/a", "2L", "bottle", 34.99, "🥛", GROCERS, 4.5),
    ("Large Eggs", "Nulaid", "Groceries", "Dairy", "n/a", "18 pack", "tray", 57.99, "🥚", GROCERS, 4.3),
    ("Margarine Spread", "Rama", "Groceries", "Dairy", "n/a", "1kg", "tub", 46.99, "🧈", ["shoprite", "checkers", "picknpay", "spar", "makro"], 4.1),

    ("Frozen Chicken Portions", "Goldi", "Groceries", "Meat", "n/a", "2kg", "pack", 89.99, "🍗", GROCERS, 4.1),
    ("Polony", "Eskort", "Groceries", "Meat", "n/a", "1kg", "roll", 29.99, "🥓", ["shoprite", "checkers", "picknpay", "spar"], 3.9),

    ("Sunflower Oil", "Sunfoil", "Groceries", "Pantry", "n/a", "2L", "bottle", 69.99, "🫗", GROCERS, 4.4),
    ("White Sugar", "Huletts", "Groceries", "Pantry", "n/a", "2.5kg", "pack", 59.99, "🧂", GROCERS, 4.5),
    ("Baked Beans", "Koo", "Groceries", "Canned", "n/a", "410g", "tin", 15.99, "🫘", GROCERS, 4.3),
    ("Pilchards in Tomato Sauce", "Lucky Star", "Groceries", "Canned", "n/a", "400g", "tin", 27.99, "🐟", GROCERS, 4.4),
    ("Peanut Butter", "Black Cat", "Groceries", "Pantry", "n/a", "400g", "jar", 46.99, "🥜", ["shoprite", "checkers", "picknpay", "spar", "makro"], 4.5),
    ("Tagless Teabags", "Five Roses", "Groceries", "Pantry", "n/a", "100s", "box", 44.99, "🍵", GROCERS, 4.4),

    ("Potatoes", "Loose", "Groceries", "Fresh Produce", "n/a", "2kg", "bag", 29.99, "🥔", GROCERS, 4.5),
    ("Onions", "Loose", "Groceries", "Fresh Produce", "n/a", "2kg", "bag", 32.99, "🧅", GROCERS, 4.4),
    ("Tomatoes", "Loose", "Groceries", "Fresh Produce", "Red", "1kg", "bag", 24.99, "🍅", GROCERS, 4.3),
    ("Bananas", "Loose", "Groceries", "Fresh Produce", "Yellow", "1kg", "bag", 21.99, "🍌", GROCERS, 4.6),
    ("Cabbage", "Loose", "Groceries", "Fresh Produce", "Green", "1 head", "each", 24.99, "🥬", GROCERS, 4.2),

    # ---- Toiletries -----------------------------------------------------
    ("Toothpaste", "Colgate", "Toiletries", "Oral Care", "White", "100ml", "tube", 32.99, "🪥", PHARMACY, 4.6),
    ("Sunlight Soap Bar", "Sunlight", "Toiletries", "Body", "Green", "175g", "bar", 13.99, "🧼", PHARMACY, 4.3),
    ("Antibacterial Soap", "Dettol", "Toiletries", "Body", "Blue", "175g", "bar", 17.99, "🧼", PHARMACY, 4.5),
    ("Roll-On Deodorant", "Shield", "Toiletries", "Body", "Blue", "50ml", "roll-on", 34.99, "🧴", PHARMACY, 4.2),
    ("Petroleum Jelly", "Vaseline", "Toiletries", "Skin", "White", "250ml", "tub", 42.99, "🧴", PHARMACY, 4.7),
    ("Shampoo", "Head & Shoulders", "Toiletries", "Hair", "White", "400ml", "bottle", 54.99, "🧴", ["clicks", "checkers", "picknpay", "makro", "takealot"], 4.4),
    ("Toilet Paper 2-Ply", "Baby Soft", "Toiletries", "Household", "White", "9 pack", "pack", 74.99, "🧻", PHARMACY, 4.5),
    ("Auto Washing Powder", "OMO", "Toiletries", "Laundry", "n/a", "2kg", "box", 94.99, "🧺", PHARMACY, 4.4),
    ("Sanitary Pads", "Always", "Toiletries", "Feminine Care", "n/a", "10 pack", "pack", 32.99, "🩹", PHARMACY, 4.6),
    ("Dishwashing Liquid", "Sunlight", "Toiletries", "Household", "Yellow", "750ml", "bottle", 34.99, "🧽", PHARMACY, 4.3),

    # ---- Stationery -----------------------------------------------------
    ("A4 Feint & Margin Book", "Croxley", "Stationery", "Books", "Blue", "72 page", "book", 18.99, "📓", ["game", "takealot", "makro", "picknpay", "checkers"], 4.2),
    ("Ballpoint Pens", "BIC", "Stationery", "Writing", "Blue", "10 pack", "pack", 39.99, "🖊️", ["game", "takealot", "makro", "clicks", "checkers"], 4.5),
    ("Scientific Calculator", "Casio", "Stationery", "Calculators", "Black", "FX-82ZA", "unit", 349.00, "🧮", ["game", "takealot", "makro", "incredible"], 4.8),
    ("A4 Printing Paper", "Typek", "Stationery", "Paper", "White", "500 sheets", "ream", 109.99, "📄", GENERAL + ["game"], 4.6),

    # ---- Electronics ----------------------------------------------------
    ("USB Flash Drive", "SanDisk", "Electronics", "Storage", "Black", "64GB", "unit", 179.00, "💾", TECH, 4.6),
    ("Wired Earphones", "Sony", "Electronics", "Audio", "Black", "3.5mm", "unit", 199.00, "🎧", TECH, 4.3),
    ("Power Bank", "Romoss", "Electronics", "Power", "Black", "10000mAh", "unit", 349.00, "🔋", TECH, 4.4),
    ("Multi-Plug Adaptor", "Ellies", "Electronics", "Power", "White", "4-way", "unit", 149.99, "🔌", ["game", "takealot", "makro", "incredible"], 4.2),
    ("LED Desk Lamp", "Eurolux", "Electronics", "Lighting", "White", "Small", "unit", 249.00, "💡", ["game", "takealot", "makro"], 4.1),

    # ---- Homeware -------------------------------------------------------
    ("Single Fitted Sheet", "Sheraton", "Homeware", "Bedding", "Grey", "Single", "unit", 189.00, "🛏️", ["game", "takealot", "makro"], 4.2),
    ("Bath Towel", "Colibri", "Homeware", "Bathroom", "Navy", "Large", "unit", 149.00, "🛁", ["game", "takealot", "makro", "checkers"], 4.4),
    ("2-Plate Hotplate", "Salton", "Homeware", "Kitchen", "White", "Compact", "unit", 449.00, "🍳", ["game", "takealot", "makro", "incredible"], 4.0),
    ("Kettle", "Russell Hobbs", "Homeware", "Kitchen", "Silver", "1.7L", "unit", 329.00, "🫖", ["game", "takealot", "makro", "incredible", "checkers"], 4.5),
    ("Storage Crate", "Addis", "Homeware", "Storage", "Clear", "30L", "unit", 129.99, "📦", ["game", "takealot", "makro"], 4.3),

    # ---- Maintenance (Phase 5) -----------------------------------------
    # Small fixes a student in res does themselves. Appended at the END so
    # every existing product and listing keeps its id.
    ("LED Light Bulb", "Eurolux", "Maintenance", "Lighting", "White", "9W E27", "bulb", 29.99, "💡", ["game", "makro", "checkers", "picknpay", "takealot"], 4.3),
    ("AA Batteries", "Duracell", "Maintenance", "Batteries", "n/a", "4 pack", "pack", 64.99, "🔋", ["game", "makro", "checkers", "picknpay", "clicks", "takealot"], 4.6),
    ("Duct Tape", "Tesa", "Maintenance", "Repairs", "Silver", "48mm x 10m", "roll", 54.99, "🩹", ["game", "makro", "takealot"], 4.2),
    ("Super Glue", "Pratley", "Maintenance", "Repairs", "Clear", "3g", "tube", 39.99, "🧴", ["game", "makro", "checkers", "picknpay", "takealot"], 4.4),
    ("Padlock", "Yale", "Maintenance", "Security", "Brass", "40mm", "unit", 119.99, "🔒", ["game", "makro", "takealot"], 4.5),
    ("Extension Cord", "Ellies", "Maintenance", "Electrical", "White", "5m", "unit", 139.99, "🔌", ["game", "makro", "takealot", "incredible"], 4.1),
]


def snap(price):
    """Snap to a realistic South African shelf price ending."""
    if price <= 0:
        return 0.0
    base = floor(price)
    candidates = []
    for b in (base - 1, base, base + 1):
        if b < 0:
            continue
        for end in (0.49, 0.95, 0.99):
            candidates.append(round(b + end, 2))
        if b >= 100:
            candidates.append(float(b))
    return min([c for c in candidates if c > 0], key=lambda c: abs(c - price))


def build():
    stores, store_by = [], {}
    for (sid, name, suburb, lat, lng, delivery, ship, free_over, index) in STORES_RAW:
        distance = None if lat is None else haversine_km(
            CAMPUS["lat"], CAMPUS["lng"], lat, lng)
        s = {
            "store_id": sid, "store_name": name, "suburb": suburb,
            "lat": lat, "lng": lng, "distance_km": distance,
            "online_only": lat is None,
            "delivery_available": delivery,
            "collection_available": lat is not None,
            "base_shipping_fee": ship, "free_delivery_over": free_over,
            "price_index": index,
        }
        stores.append(s)
        store_by[sid] = s

    products, n = [], 0
    for (name, brand, cat, sub, colour, size, unit,
         base, icon, store_ids, rating) in ITEMS:
        for sid in store_ids:
            s = store_by[sid]
            n += 1
            price = snap(base * s["price_index"] * MODIFIERS[sid][cat])
            free_over = s["free_delivery_over"]
            shipping = 0.0 if (free_over and price >= free_over) else s["base_shipping_fee"]

            products.append({
                "id": f"P{n:03d}",
                "name": name, "brand": brand,
                "category": cat, "subcategory": sub,
                "colour": colour, "size": size, "unit": unit,
                "price": round(price, 2), "currency": "ZAR",
                "store_id": sid, "store_name": s["store_name"],
                "store_suburb": s["suburb"],
                "store_lat": s["lat"], "store_lng": s["lng"],
                "distance_km": s["distance_km"],
                "shipping_fee": round(shipping, 2),
                "total_cost": round(price + shipping, 2),
                "delivery_available": s["delivery_available"],
                "collection_available": s["collection_available"],
                "in_stock": True, "rating": rating, "icon": icon,
            })

    for s in stores:
        s.pop("price_index", None)

    return {
        "meta": {
            "dataset": "AI Shopping for Budgeting — seed product dataset",
            "owner": "Member 9 (Data / Frontend Dev)",
            "version": "2.0.0",
            "generated": "2026-09-21",
            "currency": "ZAR",
            "origin": CAMPUS,
            "distinct_products": len(ITEMS),
            "listing_count": len(products),
            "store_count": len(stores),
            "note": ("Indicative South African retail prices, Durban, September 2026. "
                     "Per-store prices are modelled from each chain's measured price "
                     "position in published basket surveys, not scraped. Replace with "
                     "live retailer feeds before production."),
        },
        "origin": CAMPUS,
        "stores": stores,
        "products": products,
    }


if __name__ == "__main__":
    data = build()

    with open("products.json", "w") as fh:
        json.dump(data, fh, indent=1)

    cols = list(data["products"][0].keys())
    with open("products.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(data["products"])

    with open("stores.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(data["stores"][0].keys()))
        w.writeheader()
        w.writerows(data["stores"])

    p = data["products"]
    from collections import Counter
    keys = Counter((x["name"], x["size"]) for x in p)
    multi = [k for k, v in keys.items() if v > 1]

    print(f"distinct products : {len(ITEMS)}")
    print(f"listings          : {len(p)}")
    print(f"stores            : {len(data['stores'])}")
    print(f"categories        : {sorted({x['category'] for x in p})}")
    print(f"colours           : {sorted({x['colour'] for x in p})}")
    print(f"price range       : R{min(x['price'] for x in p):.2f} – R{max(x['price'] for x in p):.2f}")
    print(f"within 25 km      : {sum(1 for x in p if x['distance_km'] is not None and x['distance_km'] <= 25)}")
    print(f"online-only       : {sum(1 for x in p if x['distance_km'] is None)}")
    print(f"free shipping     : {sum(1 for x in p if x['shipping_fee'] == 0)}")
    print(f"comparable items  : {len(multi)} of {len(ITEMS)} sold at >1 store")
    print(f"avg stores/product: {len(p) / len(ITEMS):.1f}")

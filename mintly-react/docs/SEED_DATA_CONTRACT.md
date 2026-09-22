# Seed data contract

**Owner:** Member 9 (Data / Frontend Dev)
**Needs sign-off from:** Member 4 (filter list), Member 3 (database schema)

> **⚠ This dataset is no longer loaded by the app.** It used to be bundled into
> the frontend and filtered in the browser. The backend now owns the catalogue:
> `GET /search` reads `product_offers` joined to `products` and `stores`. The
> dataset's job is to POPULATE those tables — run
> `docs/seed/seed_backend.sql` against the database or `/search` returns
> nothing. The field contract below still describes the source data and is
> still what `build_backend_seed.py` reads.

Files:

| File | Use |
|---|---|
| `docs/seed/products.json` | the dataset itself |
| `docs/seed/build_backend_seed.py` | turns it into SQL for the backend's real schema |
| `docs/seed/seed_backend.sql` | generated — run this against Postgres |
| `docs/seed/products.csv` | flat export |
| `docs/seed/stores.csv` | store table export |
| `docs/seed/build_seed.py` | regenerates the JSON/CSVs — **edit this, not the JSON** |

### How the source fields land in the backend schema

| Dataset field | Backend column | Note |
|---|---|---|
| `name`, `brand`, `category`, `colour`, `size` | `products.*` | deduplicated to 49 rows |
| `price`, `shipping_fee` | `product_offers.price`, `.shipping_cost` | `total_cost` is GENERATED — never inserted |
| `in_stock` | `product_offers.availability_status` | `available` / `out_of_stock` |
| `store_name`, `suburb`, `lat`, `lng`, `online_only` | `stores.*` | `store_type` = `online` \| `physical` |
| `id` (`P001`…) | `product_offers.external_product_id` | keeps the seed re-runnable |
| — | `products.is_essential` | **derived**: Groceries + Toiletries. Not in the source data |
| `distance_km`, `rating` | *(dropped)* | the schema has no distance or rating column — this is why the Search screen shows its radius filter as unavailable |

**49 distinct products · 257 listings · 10 stores · 5 categories · Durban · September 2026.**

### Two counts, and they are different — say this in the demo

| | |
|---|---|
| **Distinct products** | **49** — the "30–50 items" the task brief asks for |
| **Listings** | **257** — one product at one store, each with its own price |

A product stocked by five stores produces five listings, averaging **5.2 stores
per product**. This is deliberate: without the same item appearing at several
stores there is nothing to compare, and the comparison screen is the point of
the app. The first version of this dataset had one listing per product and the
comparison screen returned identical totals for every store — useless.

---

## ⚠ Member 4 — the field contract

Every filter named in the Project Synopsis maps to exactly one field. If your
filter list uses a different name for any of these, change it **here and in
`docs/seed/build_backend_seed.py` together** — the filters themselves now live
in the backend's `search.py`.

| Synopsis wording | Field | Type | Notes |
|---|---|---|---|
| "type in their budget" | `total_cost` | number | filter compares against this, **not** `price` — a cheap item with R99 delivery is not cheap |
| "prices from lowest to highest or vice versa" | `price`, `total_cost` | number | both sort directions supported |
| "colour" | `colour` | string | `"n/a"` for items where colour is meaningless (a loaf of bread) |
| "size" | `size` | string | free text: `"2kg"`, `"18 pack"`, `"64GB"` |
| "shipping cost" | `shipping_fee` | number | `0.00` means free delivery **or** collect in store |
| "product location" | `store_lat`, `store_lng`, `store_suburb` | number / string | `null` lat/lng = online-only retailer |
| "within a 25-kilometre range" | `distance_km` | number \| null | straight-line km from DUT Steve Biko Campus; `null` = online-only |
| — | `store_id`, `store_name` | string | |
| — | `category`, `subcategory` | string | |

**The `null` distance rule matters.** Online-only stores (Takealot) have no
location. They are included only when the student ticks "Include online-only
stores". Any filter you write must handle `distance_km === null` explicitly
rather than letting it compare as `0` — otherwise Takealot looks like it is on
campus.

---

## Product fields

```json
{
  "id": "P001",
  "name": "Super Maize Meal",
  "brand": "Ace",
  "category": "Groceries",
  "subcategory": "Staples",
  "colour": "n/a",
  "size": "2.5kg",
  "unit": "pack",
  "price": 41.99,
  "currency": "ZAR",
  "store_id": "shoprite",
  "store_name": "Shoprite Warwick Junction",
  "store_suburb": "Warwick",
  "store_lat": -29.857,
  "store_lng": 31.014,
  "distance_km": 0.63,
  "shipping_fee": 0.0,
  "total_cost": 41.99,
  "delivery_available": false,
  "collection_available": true,
  "in_stock": true,
  "rating": 4.4,
  "icon": "🌽"
}
```

`total_cost` is always `price + shipping_fee`, precomputed so no screen has to
do arithmetic to sort. If you change `price` or `shipping_fee` by hand, you
must update `total_cost` too — which is the reason to regenerate with the
script instead.

## Store fields

```json
{
  "store_id": "makro",
  "store_name": "Makro Springfield",
  "suburb": "Springfield Park",
  "lat": -29.81, "lng": 31.015,
  "distance_km": 4.99,
  "online_only": false,
  "delivery_available": true,
  "collection_available": true,
  "base_shipping_fee": 65.0,
  "free_delivery_over": 1000
}
```

## The ten stores

| Store | Suburb | km from campus | Delivery |
|---|---|---:|---|
| Shoprite Warwick Junction | Warwick | 0.6 | collect only |
| Checkers Berea Centre | Berea | 0.7 | R35 |
| Game Durban CBD | Durban Central | 1.4 | R60, free over R1 000 |
| Pick n Pay Musgrave Centre | Musgrave | 1.5 | R45 |
| Clicks Musgrave Centre | Musgrave | 1.5 | R50, free over R450 |
| SPAR Glenwood | Glenwood | 1.8 | R40 |
| Food Lover's Market Overport | Overport | 2.6 | R45 |
| Makro Springfield | Springfield Park | 5.0 | R65, free over R1 000 |
| Incredible Connection Gateway | Umhlanga | 15.5 | R99, free over R2 000 |
| Takealot | online only | — | R60, free over R450 |

Distances are real haversine distances from DUT Steve Biko Campus
(−29.8547, 31.0084), computed in `build_seed.py` — not typed in by hand.

---

## Deliberate properties of this dataset

These are not accidents; the screens depend on them.

- **Every one of the 49 products is stocked by at least two stores**, averaging
  5.2. Without duplicates the comparison screen has nothing to compare.
- **Prices span R11.95 to R523.49**, so budget filtering visibly does something
  at any realistic student ceiling.
- **34 listings have free shipping** and 15 are online-only, so the "no delivery
  fee" and "include online" filters both have results and both change the answer.
- **Store price positions come from measured basket surveys**, so a full basket
  ranks Makro cheapest and Pick n Pay dearest — matching published South African
  comparisons rather than random numbers. A representative 8-item student shop
  runs **R336,30 at Makro against R431,92 at Pick n Pay**, a R95,62 spread.

### Two modelling rules that are easy to get wrong

Both of these were bugs in the first version. Do not reintroduce them.

1. **Delivery is an order-level cost, not a per-item one.** `shipping_fee` on a
   listing is what you pay if you order *only that item*. When pricing a
   basket, add the store's fee **once**, and not at all for a store you can
   walk into. Charging it per line billed one student eight delivery fees for
   a single shop and made Makro look R500 more expensive than it is.
2. **A store that stocks nothing on your list is not the cheapest store.**
   Missing lines are priced at the cheapest store so totals stay comparable —
   which means a store carrying none of your list inherits the cheapest total
   and would rank first. Rank on coverage before price, and only call a store
   the "cheapest single shop" if it stocks the whole list.

---

## Regenerating

```bash
cd docs
python3 build_seed.py
cp products.json ../src/data/products.json
```

The script prints a summary and integrity check. Keep the counts in this
document in step with what it prints.

---

## Known limits — say these out loud in the demo

- Prices are **indicative**, collected September 2026, and go stale.
- Distances are straight-line, not walking or taxi routes.
- There is no live retailer feed: South African supermarkets do not publish
  public price APIs. Production needs either a data partnership, scraping
  (check each retailer's terms first), or crowd-sourced "what did you pay?"
  entries from students.
- `in_stock` is `true` for every row. Real stock status needs a live feed.

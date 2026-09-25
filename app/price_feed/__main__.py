"""
python -m app.price_feed <command>

    status                         how many prices are estimates vs confirmed
    probe --store S --query Q      call the live API once and print what comes back
    refresh --provider csv|rapidapi [--file F] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import sys

from app.price_feed.providers import CsvPriceProvider, RapidApiSaGroceryProvider
from app.price_feed.refresh import apply_plan, load_catalogue_offers, plan_refresh


def _connect():
    from app.database import get_connection
    return get_connection()


def cmd_status(_args):
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute("""SELECT price_source, COUNT(*) AS n, MAX(price_verified_at) AS newest
                           FROM product_offers GROUP BY price_source ORDER BY price_source""")
            for row in cur.fetchall():
                print(f"{row['price_source']:16} {row['n']:5}   newest check: {row['newest'] or '—'}")
    finally:
        conn.close()


def cmd_probe(args):
    provider = RapidApiSaGroceryProvider()
    slug = provider.store_map.get(args.store, args.store)
    payload = provider.get(slug, {provider.search_param: args.query, "page": 1, "limit": 5})
    print("RAW RESPONSE (first 2 000 chars):")
    print(json.dumps(payload, indent=2)[:2000])
    from app.price_feed.providers import parse_listings
    listings = parse_listings(payload, args.store)
    print(f"\nPARSED {len(listings)} listing(s):")
    for l in listings:
        print(f"  R{l.price:>8}  {l.title}  | brand={l.brand} size={l.size} url={l.url}")
    if not listings:
        print("  none — the field names differ from what parse_listings() expects; "
              "add them to the _*_KEYS tuples in providers.py")


def cmd_refresh(args):
    conn = _connect()
    try:
        with conn, conn.cursor() as cur:
            offers = load_catalogue_offers(cur)
            if args.provider == "csv":
                provider = CsvPriceProvider(args.file)
                listings = provider.fetch()
            else:
                provider = RapidApiSaGroceryProvider(max_requests=args.max_requests)
                wanted = sorted({(o.store_key, f"{o.brand or ''} {o.product_name}".strip())
                                 for o in offers if o.store_key in provider.store_map})
                listings = provider.fetch_for(wanted)
            plan = plan_refresh(offers, listings, covered_stores=provider.covered_stores())
            print(plan.summary())
            for u in plan.updates:
                print(f"  UPDATE #{u.offer_id}: R{u.old_price} -> R{u.new_price}  ({u.title})")
            for line in plan.review:
                print(f"  REVIEW {line}")
            if args.verbose:
                for line in plan.unmatched:
                    print(f"  UNMATCHED {line}")
            if args.dry_run:
                print("dry run — nothing written")
                conn.rollback()
            else:
                print(f"wrote {apply_plan(cur, plan)} price(s)")
    finally:
        conn.close()


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m app.price_feed")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    probe = sub.add_parser("probe")
    probe.add_argument("--store", default="checkers")
    probe.add_argument("--query", default="maize meal")
    refresh = sub.add_parser("refresh")
    refresh.add_argument("--provider", choices=["csv", "rapidapi"], required=True)
    refresh.add_argument("--file", default="docs/prices/verified_prices.csv")
    refresh.add_argument("--dry-run", action="store_true")
    refresh.add_argument("--max-requests", type=int, default=120)
    refresh.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)
    {"status": cmd_status, "probe": cmd_probe, "refresh": cmd_refresh}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())

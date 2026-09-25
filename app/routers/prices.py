"""
Price provenance — GET /prices/status (Phase 4).

Tells the frontend (and a marker) how many of the prices in the catalogue are
modelled estimates and how many have been confirmed against a real source,
so the app never calls an estimate "live". The refresh itself is a CLI —
`python -m app.price_feed refresh` — not an HTTP endpoint: it can make a
hundred outbound requests and should be run deliberately by the team, not
triggered by any logged-in student.
"""

from fastapi import APIRouter, Depends

from app.database import get_connection
from app.dependencies import get_current_user_id
from app.price_feed.providers import RapidApiSaGroceryProvider
from app.schemas import PriceStatusOut

router = APIRouter(prefix="/prices", tags=["prices"])


@router.get("/status", response_model=PriceStatusOut)
def price_status(user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT price_source, COUNT(*) AS n, MAX(price_verified_at) AS newest
                   FROM product_offers GROUP BY price_source"""
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    by_source = {r["price_source"]: r["n"] for r in rows}
    newest = max((r["newest"] for r in rows if r["newest"]), default=None)
    total = sum(by_source.values())
    estimates = by_source.get("seed_estimate", 0)
    if total == 0:
        message = "There are no prices in the catalogue yet."
    elif estimates == total:
        message = (f"All {total} prices are estimates from the seed data. None has been "
                   "confirmed with a store yet.")
    elif estimates:
        message = f"{total - estimates} of {total} prices are confirmed; {estimates} are still estimates."
    else:
        message = f"All {total} prices have been confirmed with a store."
    return PriceStatusOut(
        by_source=by_source,
        newest_verification=newest,
        live_provider_configured=RapidApiSaGroceryProvider().configured,
        message=message,
    )

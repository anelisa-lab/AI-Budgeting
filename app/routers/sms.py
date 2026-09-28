"""
SMS mode — POST /sms/reply, GET/PUT /sms/preferences (Phase 6).

A text-command endpoint: a student sends a short body ("BAL", "CMP bread",
...), gets back a plain-text reply. It is built so a real SMS/USSD gateway's
webhook could point at this same route unchanged — the request is just
{ body: <what arrived> } and the response's `reply` is exactly what would be
texted back — but nothing here requires one: the in-app SMS Mode screen calls
it directly, so the feature works with no gateway account at all.

Every call writes the exchange to the notifications log (app/notifications.py)
under channel='sms', so the Notifications tab shows the same thing a real
phone would have received — and if the student has a phone number saved and
SMS turned on, the reply is also handed to app.notifications.dispatch_sms,
which really texts it once a gateway is configured (SMS_GATEWAY_URL) and
otherwise logs what would have been sent.

The wording lives in app/sms.py (pure, unit-tested); this file only loads
what each command needs and calls into it.
"""

from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends

from app import sms as wording
from app.budget_split import build_split
from app.database import get_connection
from app.dependencies import get_current_user_id
from app.geo import distance_between, fetch_user_location
from app.notifications import create_notification, dispatch_sms
from app.routers.budget_split import spent_by_date
from app.schemas import (
    NotificationOut,
    SmsPreferencesOut,
    SmsPreferencesUpdate,
    SmsReplyOut,
    SmsRequest,
)

router = APIRouter(prefix="/sms", tags=["sms"])

_PRODUCT_SEARCH_SQL = """
    SELECT o.id AS offer_id, o.price, o.shipping_cost, o.availability_status,
           p.id AS product_id, p.name AS product_name,
           s.id AS store_id, s.name AS store_name, s.latitude, s.longitude
    FROM product_offers o
    JOIN products p ON p.id = o.product_id
    JOIN stores s ON s.id = o.store_id
    WHERE p.name ILIKE %s AND o.availability_status = 'available'
    ORDER BY (o.price + COALESCE(o.shipping_cost, 0)) ASC
    LIMIT 20
"""

_NEAREST_STORES_SQL = """
    SELECT DISTINCT s.id, s.name, s.latitude, s.longitude
    FROM stores s
    WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
"""


def _current_budget(cur, user_id: int) -> Optional[dict]:
    cur.execute("SELECT * FROM budgets WHERE user_id = %s AND status = 'active'", (user_id,))
    return cur.fetchone()


def _handle(command: str, args: str, user_id: int, cur) -> str:
    if command == "HELP":
        return wording.help_reply()

    if command == "BAL":
        budget = _current_budget(cur, user_id)
        if not budget:
            return wording.no_active_budget_reply()
        split = build_split(budget, spent_by_date=spent_by_date(cur, budget["id"]))
        return wording.balance_reply(
            remaining=split.remaining_amount, days_left=split.days_remaining,
            mode=split.mode, next_payout=split.next_payout_date,
        )

    if command == "TODAY":
        budget = _current_budget(cur, user_id)
        if not budget:
            return wording.no_active_budget_reply()
        split = build_split(budget, spent_by_date=spent_by_date(cur, budget["id"]))
        return wording.today_reply(
            daily_limit=split.daily_limit, remaining_today=split.remaining_today,
            tomorrow_limit=split.tomorrow_limit, mode=split.mode,
        )

    if command == "CMP":
        item = args.strip()
        if not item:
            return "Text CMP followed by an item, e.g. CMP bread."
        cur.execute(_PRODUCT_SEARCH_SQL, (f"%{item}%",))
        rows = cur.fetchall()
        if not rows:
            return wording.not_found_reply(item)
        location = fetch_user_location(cur, user_id)
        best = rows[0]
        distance = distance_between(location, (best["latitude"], best["longitude"]))
        price = Decimal(best["price"]) + Decimal(best["shipping_cost"] or 0)
        return wording.cmp_reply(
            product_name=best["product_name"], store_name=best["store_name"],
            price=price, distance_km=distance,
        )

    if command == "NEAR":
        location = fetch_user_location(cur, user_id)
        if location is None:
            return wording.no_location_reply()
        cur.execute(_NEAREST_STORES_SQL)
        stores = []
        for row in cur.fetchall():
            d = distance_between(location, (row["latitude"], row["longitude"]))
            if d is not None:
                stores.append({"name": row["name"], "distance_km": d})
        stores.sort(key=lambda s: s["distance_km"])
        return wording.near_reply(stores[:5])

    return wording.unknown_command_reply(command)


@router.post("/reply", response_model=SmsReplyOut)
def sms_reply(payload: SmsRequest, user_id: int = Depends(get_current_user_id)):
    command, args = wording.parse_command(payload.body)

    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            reply = _handle(command, args, user_id, cur)

            cur.execute(
                "SELECT phone_number, sms_enabled FROM users WHERE id = %s", (user_id,)
            )
            user = cur.fetchone()
            sms_status = dispatch_sms(
                user["phone_number"] if user else None,
                bool(user["sms_enabled"]) if user else False,
                reply,
            )

            notification = create_notification(
                cur, user_id, category="sms_out", channel="sms",
                title=f"SMS: {command}", body=reply, sms_status=sms_status,
            )
        return SmsReplyOut(
            command=command, reply=reply,
            notification=NotificationOut(
                id=notification["id"], category=notification["category"],
                channel=notification["channel"], title=notification["title"],
                body=notification["body"], sms_status=notification["sms_status"],
                is_read=notification["read_at"] is not None, created_at=notification["created_at"],
            ),
        )
    finally:
        conn.close()


@router.get("/preferences", response_model=SmsPreferencesOut)
def get_sms_preferences(user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT phone_number, sms_enabled, sms_low_balance_threshold
                   FROM users WHERE id = %s""",
                (user_id,),
            )
            row = cur.fetchone()
        return SmsPreferencesOut(
            phone_number=row["phone_number"], sms_enabled=row["sms_enabled"],
            low_balance_threshold=row["sms_low_balance_threshold"],
        )
    finally:
        conn.close()


@router.put("/preferences", response_model=SmsPreferencesOut)
def update_sms_preferences(payload: SmsPreferencesUpdate, user_id: int = Depends(get_current_user_id)):
    """
    Only the fields actually sent are changed — the same "omitted = unchanged,
    field present = use it" contract PUT /profile/ uses (via model_fields_set)
    — so turning SMS on doesn't require resending the phone number too, and an
    explicit "" clears the phone number rather than being ignored.
    """
    columns = {
        "phone_number": "phone_number",
        "sms_enabled": "sms_enabled",
        "low_balance_threshold": "sms_low_balance_threshold",
    }
    sets, params = [], []
    for field, column in columns.items():
        if field in payload.model_fields_set:
            value = getattr(payload, field)
            sets.append(f"{column} = %s")
            params.append(value if value != "" else None)

    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            if sets:
                cur.execute(
                    f"""UPDATE users SET {", ".join(sets)} WHERE id = %s
                        RETURNING phone_number, sms_enabled, sms_low_balance_threshold""",
                    (*params, user_id),
                )
                row = cur.fetchone()
            else:
                cur.execute(
                    """SELECT phone_number, sms_enabled, sms_low_balance_threshold
                       FROM users WHERE id = %s""",
                    (user_id,),
                )
                row = cur.fetchone()
        return SmsPreferencesOut(
            phone_number=row["phone_number"], sms_enabled=row["sms_enabled"],
            low_balance_threshold=row["sms_low_balance_threshold"],
        )
    finally:
        conn.close()

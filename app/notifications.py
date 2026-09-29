"""
Notifications — the one place every system event is reported to the user.

Any action, event, status change or important activity in any module calls
one of these two functions, and the Notifications tab (GET /notifications)
shows it, with what happened (title/body), where (module) and when
(created_at).

    create_notification(cur, ...)  inserts one row on an open cursor, so it
                                    joins the caller's transaction.

    notify(user_id, ...)           best-effort variant that opens its own
                                    connection. It never raises: a failure
                                    to log an event must not fail the
                                    request that caused it.
"""

from __future__ import annotations

import logging
from typing import Optional

from app.database import get_connection

logger = logging.getLogger("app.notifications")

# success | info | warning | alert | survival | balance | system
NotificationCategory = str


def create_notification(
    cur,
    user_id: int,
    category: NotificationCategory,
    title: str,
    body: str,
    module: str = "system",
    channel: str = "app",
    sms_status: Optional[str] = None,
) -> dict:
    """Insert one notification row and return it (RETURNING *)."""
    cur.execute(
        """INSERT INTO notifications (user_id, category, channel, title, body, sms_status, module)
           VALUES (%s, %s, %s, %s, %s, %s, %s)
           RETURNING *""",
        (user_id, category, channel, title[:150], body, sms_status, module[:30]),
    )
    return cur.fetchone()


def notify(
    user_id: int,
    module: str,
    title: str,
    body: str,
    category: NotificationCategory = "info",
) -> None:
    """Record an event for `user_id` on its own connection. Never raises."""
    try:
        conn = get_connection()
        try:
            with conn, conn.cursor() as cur:
                create_notification(cur, user_id, category, title, body, module=module)
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 — logging an event must never break the caller
        logger.exception("Could not record notification %r for user %s", title, user_id)

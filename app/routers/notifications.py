"""
Notifications — GET /notifications, PUT /notifications/{id}/read,
PUT /notifications/read-all, DELETE /notifications/{id},
GET/PUT /notifications/preferences.

The central feed of every system event. Rows are written by
app/notifications (create_notification / notify) from every module; this
router only reads and marks them read.
"""

from fastapi import APIRouter, Depends, HTTPException

from app.database import get_connection
from app.dependencies import get_current_user_id
from app.schemas import (
    NotificationListOut,
    NotificationOut,
    NotificationPreferencesOut,
    NotificationPreferencesUpdate,
)

router = APIRouter(prefix="/notifications", tags=["notifications"])


def _to_out(row: dict) -> NotificationOut:
    return NotificationOut(
        id=row["id"], category=row["category"], module=row["module"],
        title=row["title"], body=row["body"],
        is_read=row["read_at"] is not None, created_at=row["created_at"],
    )


@router.get("", response_model=NotificationListOut)
def list_notifications(limit: int = 50, user_id: int = Depends(get_current_user_id)):
    limit = max(1, min(limit, 200))
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT * FROM notifications WHERE user_id = %s
                   ORDER BY created_at DESC, id DESC LIMIT %s""",
                (user_id, limit),
            )
            rows = cur.fetchall()
            cur.execute(
                "SELECT COUNT(*) AS n FROM notifications WHERE user_id = %s AND read_at IS NULL",
                (user_id,),
            )
            unread = cur.fetchone()["n"]
        return NotificationListOut(items=[_to_out(r) for r in rows], unread_count=unread)
    finally:
        conn.close()


@router.get("/preferences", response_model=NotificationPreferencesOut)
def get_preferences(user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT sms_low_balance_threshold FROM users WHERE id = %s", (user_id,))
            row = cur.fetchone()
        return NotificationPreferencesOut(low_balance_threshold=row["sms_low_balance_threshold"])
    finally:
        conn.close()


@router.put("/preferences", response_model=NotificationPreferencesOut)
def update_preferences(payload: NotificationPreferencesUpdate, user_id: int = Depends(get_current_user_id)):
    """Only sent fields change; an explicit null clears the low-balance line."""
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            if "low_balance_threshold" in payload.model_fields_set:
                cur.execute(
                    "UPDATE users SET sms_low_balance_threshold = %s WHERE id = %s",
                    (payload.low_balance_threshold, user_id),
                )
            cur.execute("SELECT sms_low_balance_threshold FROM users WHERE id = %s", (user_id,))
            row = cur.fetchone()
        return NotificationPreferencesOut(low_balance_threshold=row["sms_low_balance_threshold"])
    finally:
        conn.close()


@router.put("/read-all", response_model=dict)
def mark_all_read(user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE notifications SET read_at = NOW() WHERE user_id = %s AND read_at IS NULL",
                (user_id,),
            )
            updated = cur.rowcount
        return {"updated": updated}
    finally:
        conn.close()


@router.put("/{notification_id}/read", response_model=NotificationOut)
def mark_read(notification_id: int, user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """UPDATE notifications SET read_at = COALESCE(read_at, NOW())
                   WHERE id = %s AND user_id = %s
                   RETURNING *""",
                (notification_id, user_id),
            )
            row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Notification not found")
        return _to_out(row)
    finally:
        conn.close()


@router.delete("/{notification_id}", status_code=204)
def delete_notification(notification_id: int, user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "DELETE FROM notifications WHERE id = %s AND user_id = %s RETURNING id",
                (notification_id, user_id),
            )
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Notification not found")
    finally:
        conn.close()

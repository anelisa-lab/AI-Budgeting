"""
Notifications — the in-app log every SMS exchange (and a handful of
app-triggered alerts) writes to, so "what UniWallet told you" is the same
list whether you read it as a text message or under the Notifications tab.

Two functions, both deliberately small:

    create_notification(cur, ...)  inserts one row and returns it. Takes an
                                    open cursor, like app/geo.py's
                                    fetch_user_location, so it joins whatever
                                    transaction the caller is already in.

    dispatch_sms(...)              best-effort delivery to a real phone.
                                    Pure — no DB access, no exceptions escape
                                    it — so a broken gateway can never take a
                                    request down with it. With no
                                    SMS_GATEWAY_URL configured (the normal
                                    case in this environment: no Twilio/
                                    Africa's Talking account exists to hold
                                    credentials for), it logs the message and
                                    reports 'simulated' rather than pretending
                                    to have sent something. Point
                                    SMS_GATEWAY_URL at a real provider's
                                    webhook and the same call starts actually
                                    texting, with no other code to change.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger("app.sms")

NotificationCategory = str  # 'sms_in' | 'sms_out' | 'survival' | 'balance' | 'system'


def create_notification(
    cur,
    user_id: int,
    category: NotificationCategory,
    title: str,
    body: str,
    channel: str = "app",
    sms_status: Optional[str] = None,
) -> dict:
    """Insert one notification row and return it (RETURNING *)."""
    cur.execute(
        """INSERT INTO notifications (user_id, category, channel, title, body, sms_status)
           VALUES (%s, %s, %s, %s, %s, %s)
           RETURNING *""",
        (user_id, category, channel, title[:150], body, sms_status),
    )
    return cur.fetchone()


def dispatch_sms(phone_number: Optional[str], sms_enabled: bool, body: str) -> str:
    """
    Best-effort delivery of `body` to `phone_number`.

    Returns one of: 'no_phone', 'disabled', 'simulated', 'sent', 'failed'.
    Never raises — a caller should always be able to log the result and move
    on, the way a real gateway's outcome would arrive out-of-band anyway.
    """
    if not phone_number:
        return "no_phone"
    if not sms_enabled:
        return "disabled"

    gateway_url = os.getenv("SMS_GATEWAY_URL")
    if not gateway_url:
        # No Twilio/Africa's Talking account is configured in this sandbox.
        # This is the honest "would have sent" path: the same call, once
        # SMS_GATEWAY_URL and any auth env vars are set, actually texts.
        logger.info("SMS (simulated — no SMS_GATEWAY_URL set) to %s: %s", phone_number, body)
        return "simulated"

    try:
        import requests  # local import: only needed on the configured path

        auth_token = os.getenv("SMS_GATEWAY_TOKEN")
        headers = {"Authorization": f"Bearer {auth_token}"} if auth_token else {}
        response = requests.post(
            gateway_url, json={"to": phone_number, "body": body}, headers=headers, timeout=5
        )
        response.raise_for_status()
        return "sent"
    except Exception:  # noqa: BLE001 — a gateway failure must never break the caller
        logger.exception("SMS gateway dispatch to %s failed", phone_number)
        return "failed"

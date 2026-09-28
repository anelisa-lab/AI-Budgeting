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


def _dispatch_via_africastalking(phone_number: str, body: str) -> str:
    """
    POST to Africa's Talking's messaging endpoint. `AFRICASTALKING_USERNAME`
    is literally "sandbox" for a free Sandbox app (production apps use the
    app's real username); `from` is omitted for Sandbox — it has no
    registered sender ID to send from.
    """
    import requests  # local import: only needed on the configured path

    username = os.getenv("AFRICASTALKING_USERNAME")
    api_key = os.getenv("AFRICASTALKING_API_KEY")
    sender_id = os.getenv("AFRICASTALKING_SENDER_ID")
    is_sandbox = username == "sandbox"

    url = (
        "https://api.sandbox.africastalking.com/version1/messaging"
        if is_sandbox
        else "https://api.africastalking.com/version1/messaging"
    )
    data = {"username": username, "to": phone_number, "message": body}
    if sender_id:
        data["from"] = sender_id

    response = requests.post(
        url,
        data=data,
        headers={
            "apiKey": api_key,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        timeout=5,
    )
    if not response.ok:
        logger.warning(
            "Africa's Talking rejected the message: %s %s", response.status_code, response.text
        )
        response.raise_for_status()

    # Africa's Talking answers 201 (or 200) with 200 *and* per-recipient
    # statuses inside the body — a delivery failure doesn't raise, it's
    # buried in Recipients[0].status, so it has to be checked explicitly.
    payload = response.json()
    recipients = payload.get("SMSMessageData", {}).get("Recipients", [])
    if not recipients or recipients[0].get("status") != "Success":
        logger.warning("Africa's Talking did not report success: %s", payload)
        raise RuntimeError(f"Africa's Talking send failed: {payload}")
    return "sent"


def _dispatch_via_textbelt(phone_number: str, body: str) -> str:
    """
    POST to Textbelt — no account, no dashboard, nothing to sign up for.
    TEXTBELT_KEY='textbelt' (the literal string) is the public free-tier
    key: 1 real text per day, on a quota shared by everyone using that key
    worldwide. A quota failure is reported in the response body, not the
    HTTP status, so (like Africa's Talking) it's checked explicitly.
    """
    import requests  # local import: only needed on the configured path

    response = requests.post(
        "https://textbelt.com/text",
        data={
            "phone": phone_number,
            "message": body,
            "key": os.getenv("TEXTBELT_KEY"),
        },
        timeout=5,
    )
    response.raise_for_status()
    payload = response.json()
    if not payload.get("success"):
        logger.warning("Textbelt did not report success: %s", payload)
        raise RuntimeError(f"Textbelt send failed: {payload}")
    return "sent"


def _dispatch_via_twilio(phone_number: str, body: str) -> str:
    """
    POST to Twilio's Messages resource directly (no `twilio` SDK dependency —
    it's one REST call with HTTP Basic Auth). Twilio's 201 means "accepted
    for delivery", not "delivered" — same fire-and-forget contract as the
    rest of dispatch_sms.
    """
    import requests  # local import: only needed on the configured path

    account_sid = os.getenv("TWILIO_ACCOUNT_SID")
    auth_token = os.getenv("TWILIO_AUTH_TOKEN")
    from_number = os.getenv("TWILIO_FROM_NUMBER")

    url = f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json"
    response = requests.post(
        url,
        data={"To": phone_number, "From": from_number, "Body": body},
        auth=(account_sid, auth_token),
        timeout=5,
    )
    if not response.ok:
        # raise_for_status() discards the body, which is where Twilio's
        # actual reason lives (e.g. {"code": 21211, "message": "..."}).
        logger.warning("Twilio rejected the message: %s %s", response.status_code, response.text)
    response.raise_for_status()
    return "sent"


def _dispatch_via_generic_gateway(gateway_url: str, phone_number: str, body: str) -> str:
    """POST { to, body } to a custom gateway URL, Bearer-token authenticated."""
    import requests  # local import: only needed on the configured path

    auth_token = os.getenv("SMS_GATEWAY_TOKEN")
    headers = {"Authorization": f"Bearer {auth_token}"} if auth_token else {}
    response = requests.post(
        gateway_url, json={"to": phone_number, "body": body}, headers=headers, timeout=5
    )
    response.raise_for_status()
    return "sent"


def dispatch_sms(phone_number: Optional[str], sms_enabled: bool, body: str) -> str:
    """
    Best-effort delivery of `body` to `phone_number`.

    Returns one of: 'no_phone', 'disabled', 'simulated', 'sent', 'failed'.
    Never raises — a caller should always be able to log the result and move
    on, the way a real gateway's outcome would arrive out-of-band anyway.

    Tries, in order: Textbelt (if TEXTBELT_KEY is set — no account needed,
    the literal value 'textbelt' is the public free-tier key), Africa's
    Talking (if AFRICASTALKING_USERNAME/AFRICASTALKING_API_KEY are set),
    Twilio (if TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER are
    all set), then a generic SMS_GATEWAY_URL, then simulation.
    `phone_number` must be in E.164 format (e.g. +27821234567).
    """
    if not phone_number:
        return "no_phone"
    if not sms_enabled:
        return "disabled"

    textbelt_configured = bool(os.getenv("TEXTBELT_KEY"))
    at_configured = all(
        os.getenv(k) for k in ("AFRICASTALKING_USERNAME", "AFRICASTALKING_API_KEY")
    )
    twilio_configured = all(
        os.getenv(k) for k in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER")
    )
    gateway_url = os.getenv("SMS_GATEWAY_URL")

    # TEMPORARY debug line — remove once real delivery is confirmed working.
    logger.warning(
        "dispatch_sms debug: textbelt_configured=%s at_configured=%s twilio_configured=%s gateway_url=%r",
        textbelt_configured, at_configured, twilio_configured, gateway_url,
    )

    try:
        if textbelt_configured:
            return _dispatch_via_textbelt(phone_number, body)
        if at_configured:
            return _dispatch_via_africastalking(phone_number, body)
        if twilio_configured:
            return _dispatch_via_twilio(phone_number, body)
        if gateway_url:
            return _dispatch_via_generic_gateway(gateway_url, phone_number, body)
    except Exception:  # noqa: BLE001 — a gateway failure must never break the caller
        logger.exception("SMS gateway dispatch to %s failed", phone_number)
        return "failed"

    # No Twilio account and no generic gateway configured. This is the
    # honest "would have sent" path: the same call, once the env vars above
    # are set, actually texts.
    logger.info("SMS (simulated — no SMS gateway configured) to %s: %s", phone_number, body)
    return "simulated"

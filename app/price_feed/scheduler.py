"""
Optional background refresh of catalogue prices from
docs/prices/verified_prices.csv, run on a timer inside the FastAPI process —
no OS cron needed, works the same on Windows as anywhere else.

Off by default — set PRICE_FEED_AUTO_REFRESH=true in .env to turn it on, and
PRICE_FEED_REFRESH_HOURS to change how often (default 24). It only refreshes
stores that are BOTH in LIVE_PRICE_STORES and have a non-blank price row in
the CSV: right now that CSV is a template with every price column empty, so
this runs safely and does nothing useful until someone fills in real,
verified prices — see the CSV's own header for the columns to fill in.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Optional

from app.price_feed.service import run_csv_refresh

log = logging.getLogger(__name__)

DEFAULT_FILE = "docs/prices/verified_prices.csv"
DEFAULT_HOURS = 24.0

_timer: Optional[threading.Timer] = None


def _tick(file: str, hours: float) -> None:
    try:
        plan, skipped = run_csv_refresh(file)
        log.info("price_feed auto-refresh: %s", plan.summary())
        if skipped:
            log.info("price_feed auto-refresh: switched-off store(s) skipped: %s",
                      ", ".join(skipped))
    except FileNotFoundError:
        log.warning("price_feed auto-refresh: %s not found — skipping this run", file)
    except Exception:
        log.exception("price_feed auto-refresh failed")
    finally:
        _schedule_next(file, hours)


def _schedule_next(file: str, hours: float) -> None:
    global _timer
    _timer = threading.Timer(hours * 3600, _tick, args=(file, hours))
    _timer.daemon = True
    _timer.start()


def start() -> None:
    """Call once at app startup. No-op unless PRICE_FEED_AUTO_REFRESH=true."""
    if os.getenv("PRICE_FEED_AUTO_REFRESH", "false").strip().lower() not in ("1", "true", "yes"):
        return
    file = os.getenv("PRICE_FEED_CSV_FILE", DEFAULT_FILE)
    try:
        hours = float(os.getenv("PRICE_FEED_REFRESH_HOURS", DEFAULT_HOURS))
    except ValueError:
        hours = DEFAULT_HOURS
    hours = max(1.0, hours)
    log.info("price_feed auto-refresh enabled: every %.1fh from %s", hours, file)
    _schedule_next(file, hours)


def stop() -> None:
    global _timer
    if _timer is not None:
        _timer.cancel()
        _timer = None

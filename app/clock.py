"""
One definition of "today" for the whole backend.

The Daily Budget Split buckets spending by calendar day, and two clocks are
involved: Python decides which day "today" is, and Postgres decides which day
each transaction_date (a TIMESTAMPTZ) falls on. If they disagree — a UTC
database host and a laptop in Durban, say — a purchase at 23:30 lands on the
wrong day and today's allowance is wrong. Both now use APP_TIMEZONE.
"""

import os
from datetime import date, datetime
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

load_dotenv()

APP_TIMEZONE = os.getenv("APP_TIMEZONE", "Africa/Johannesburg")


def local_today() -> date:
    """Today's date in APP_TIMEZONE, whatever the server's own clock says."""
    return datetime.now(ZoneInfo(APP_TIMEZONE)).date()

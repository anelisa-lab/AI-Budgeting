import os
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

from app.clock import APP_TIMEZONE

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")


def get_connection():
    """
    Opens a new connection per request. Simple and safe for a 7-day sprint —
    if the team wants pooling later, swap this for psycopg2.pool.SimpleConnectionPool.
    Returns rows as dicts (RealDictCursor) so route code can use row["field"].

    The session timezone is pinned to APP_TIMEZONE so `transaction_date::date`
    buckets spending on the same calendar day that app/clock.py calls today.
    """
    conn = psycopg2.connect(
        DATABASE_URL,
        cursor_factory=psycopg2.extras.RealDictCursor,
        options=f"-c timezone={APP_TIMEZONE}",
    )
    return conn

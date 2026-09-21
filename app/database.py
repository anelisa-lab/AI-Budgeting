import os
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")


def get_connection():
    """
    Opens a new connection per request. Simple and safe for a 7-day sprint —
    if the team wants pooling later, swap this for psycopg2.pool.SimpleConnectionPool.
    Returns rows as dicts (RealDictCursor) so route code can use row["field"].
    """
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    return conn

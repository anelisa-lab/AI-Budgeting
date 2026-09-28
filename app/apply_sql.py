"""
Apply .sql files to the app's database, for machines without psql.

    python -m app.apply_sql sql/009_shopping_list_live_items.sql
    python -m app.apply_sql sql/008_live_items_missing_price.sql sql/009_shopping_list_live_items.sql

Uses DATABASE_URL from .env (app/database.py), runs each file as-is (the
files manage their own BEGIN/COMMIT) and stops at the first error.
"""

from __future__ import annotations

import sys
from pathlib import Path

import psycopg2

from app.database import DATABASE_URL


def apply(paths) -> int:
    if not DATABASE_URL:
        print("DATABASE_URL is not set — add it to .env first.")
        return 1
    try:
        conn = psycopg2.connect(DATABASE_URL)
    except psycopg2.OperationalError as exc:
        print(f"Could not connect to the database in DATABASE_URL:\n  {str(exc).strip()}\n"
              "Is PostgreSQL running, and are the password and database name in .env right?")
        return 1
    conn.autocommit = True            # each file's own BEGIN/COMMIT decides
    try:
        for path in paths:
            sql = Path(path).read_text(encoding="utf-8")
            with conn.cursor() as cur:
                try:
                    cur.execute(sql)
                except psycopg2.Error as exc:
                    print(f"FAILED  {path}\n  {exc.pgerror or exc}")
                    return 1
            for notice in conn.notices:
                print("  " + notice.strip())
            conn.notices.clear()
            print(f"applied {path}")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sys.exit(apply(sys.argv[1:]))

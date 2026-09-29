"""
Integration tests for the budgeting chatbot against a REAL Postgres database.

Unlike tests/test_chatbot.py (pure logic, mocked everything), these prove
the chatbot's tools return real, correct, grounded data: nothing here is
mocked except the Claude API call itself, which is replaced with a
scripted-but-realistic sequence of tool_use requests. Every store name,
price and total asserted below came from an actual SQL query against the
app's real seeded catalogue (10 stores / 55 products / 283 offers, see
mintly-react/docs/seed/seed_backend.sql) — exactly what a live demo would
show, including Checkers, Shoprite, Food Lover's Market and Makro.

Requires TEST_DATABASE_URL pointed at a database already loaded with
sql/schema.sql plus that seed (see README's Setup). Skipped otherwise —
same convention as tests/test_shopping_list.py, so a plain `pytest` run
still needs no database.
"""

import os
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app import chatbot
from app.clock import local_today
from app.routers import budget_split, budgets, compare, recommendations, search, shopping_list

D = Decimal
DB_URL = os.getenv("TEST_DATABASE_URL")
# Every module the chatbot's tools call into, each with its own
# `from app.database import get_connection` binding to monkeypatch.
ROUTER_MODULES = [chatbot, budgets, budget_split, compare, recommendations, search, shopping_list]


@pytest.fixture
def db(monkeypatch):
    if not DB_URL:
        pytest.skip("set TEST_DATABASE_URL to run the chatbot integration tests")
    import psycopg2
    import psycopg2.extras

    def connect():
        return psycopg2.connect(DB_URL, cursor_factory=psycopg2.extras.RealDictCursor)

    conn = connect()
    with conn.cursor() as cur:
        cur.execute("DELETE FROM users WHERE email = 'chatbot-integration@list.test'")
        cur.execute(
            """INSERT INTO users (name, email, password_hash)
               VALUES ('Chatbot Test Student', 'chatbot-integration@list.test', 'x')
               RETURNING id""",
        )
        user_id = cur.fetchone()["id"]
        # A real weekly budget — R400 over 7 days, like the README's own
        # example. Uses the app's OWN definition of "today" (Africa/
        # Johannesburg, app/clock.py), not the test host's system clock —
        # they can disagree by a day, which silently threw off every
        # days-remaining assertion below the first time this ran.
        today = local_today()
        cur.execute(
            """INSERT INTO budgets (user_id, total_amount, remaining_amount,
                                     cycle_start_date, cycle_end_date)
               VALUES (%s, 400, 400, %s, %s) RETURNING id""",
            (user_id, today, today + timedelta(days=6)),
        )
        budget_id = cur.fetchone()["id"]
    conn.commit()

    for mod in ROUTER_MODULES:
        monkeypatch.setattr(mod, "get_connection", connect)

    yield {"user_id": user_id, "budget_id": budget_id, "conn": conn}

    with conn.cursor() as cur:
        cur.execute("DELETE FROM users WHERE id = %s", (user_id,))
    conn.commit()
    conn.close()


# --------------------------------------------------------- individual tools


def test_list_stores_returns_the_real_seeded_catalogue(db):
    result = chatbot._run_tool(db["user_id"], "list_stores", {})
    names = {s["name"] for s in result["stores"]}
    # The exact chains the project brief asked for, and that are actually
    # in the catalogue — proves the assistant will never invent one.
    assert {"Checkers Berea Centre", "Shoprite Warwick Junction",
            "Food Lover's Market Overport", "Makro Springfield"} <= names
    assert len(names) == 10


def test_get_budget_status_reports_the_real_weekly_budget(db):
    result = chatbot._run_tool(db["user_id"], "get_budget_status", {})
    assert result.get("error") is not True
    assert D(result["total_amount"]) == D("400.00")
    assert D(result["remaining_amount"]) == D("400.00")
    split = result["daily_split"]
    assert split["days_remaining"] == 7
    assert D(split["daily_limit"]) == D("57.14")  # 400 / 7, rounded down


def test_get_budget_status_without_a_budget_is_a_clean_tool_error(db):
    with db["conn"].cursor() as cur:
        cur.execute("DELETE FROM budgets WHERE user_id = %s", (db["user_id"],))
    db["conn"].commit()

    result = chatbot._run_tool(db["user_id"], "get_budget_status", {})
    assert result["error"] is True
    assert result["status_code"] == 404


def test_recommend_items_finds_real_priced_maize_meal_across_stores(db):
    result = chatbot._run_tool(
        db["user_id"], "recommend_items", {"query": "maize meal", "limit": 6}
    )
    assert result.get("error") is not True
    stores = {r["store_name"] for r in result["results"]}
    prices = {r["store_name"]: D(r["price"]) for r in result["results"]}
    # The real seed: Makro is the cheapest, Food Lover's Market next.
    assert "Makro Springfield" in stores
    assert prices["Makro Springfield"] == D("35.95")
    # Every result must say whether its price is confirmed or an estimate —
    # the assistant is instructed to always disclose this.
    assert all("price_is_estimate" in r for r in result["results"])


def test_search_products_filters_to_one_named_store(db):
    result = chatbot._run_tool(
        db["user_id"], "search_products", {"query": "rice", "store": "Shoprite"}
    )
    assert result.get("error") is not True
    assert result["results"], "expected at least one Shoprite rice offer"
    assert all(r["store_name"] == "Shoprite Warwick Junction" for r in result["results"])
    assert D(result["results"][0]["price"]) == D("41.49")


def test_compare_stores_for_list_prices_a_real_two_item_basket(db):
    # product_id 1 = Super Maize Meal, product_id 2 = Parboiled White Rice —
    # real ids from the seeded catalogue (verified against the DB directly).
    result = chatbot._run_tool(
        db["user_id"],
        "compare_stores_for_list",
        {"items": [{"product_id": 1, "qty": 1}, {"product_id": 2, "qty": 1}]},
    )
    assert result.get("error") is not True
    # Makro stocks both and is cheapest on each — it must win as the single
    # best store, not merely appear somewhere in the list.
    assert result["best_single_store_id"] is not None
    winning_store = next(
        s for s in result["stores"] if s["store_id"] == result["best_single_store_id"]
    )
    assert winning_store["store_name"] == "Makro Springfield"
    assert D(winning_store["total"]) > D("0.00")


def test_check_affordability_reflects_the_real_daily_allowance(db):
    result = chatbot._run_tool(db["user_id"], "check_affordability", {"amount": 60})
    assert result.get("error") is not True
    # R57.14/day: a R60 purchase fits the week but not today's slice of it.
    assert result["affordable_this_cycle"] is True
    assert result["affordable_today"] is False


def test_add_and_get_shopping_list_round_trips_a_real_offer(db):
    add = chatbot._run_tool(
        db["user_id"], "add_to_shopping_list", {"offer_id": 6, "qty": 2}  # Makro maize meal
    )
    assert add.get("error") is not True
    assert add["item_count"] == 1

    listed = chatbot._run_tool(db["user_id"], "get_shopping_list", {})
    [line] = listed["items"]
    assert (line["product_name"], line["store_name"], line["qty"]) == (
        "Super Maize Meal", "Makro Springfield", 2,
    )
    assert D(listed["summary"]["total"]) == D("71.90")  # 2 x 35.95


# ------------------------------------------------ full run_chat() scenario


def _tool_use(name, tool_input, call_id="toolu_1"):
    block = SimpleNamespace(type="tool_use", id=call_id, name=name, input=tool_input)
    return SimpleNamespace(stop_reason="tool_use", content=[block])


def _final_text(text):
    block = SimpleNamespace(type="text", text=text)
    return SimpleNamespace(stop_reason="end_turn", content=[block])


def test_run_chat_end_to_end_with_only_the_llm_call_stubbed(db):
    """
    Everything except the Claude API call itself is real: real database,
    real budget, real tool dispatch, real JSON serialisation of the tool
    results that would be sent back to Claude. This is the strongest proof
    available without spending a real API call that the wiring between
    run_chat()'s loop and the app's actual data is correct end to end.
    """
    scripted = iter([
        _tool_use("get_budget_status", {}),
        _tool_use("recommend_items", {"query": "maize meal", "limit": 5}),
        _final_text(
            "Makro has Super Maize Meal for R35.95 (estimated price). "
            "That fits your R57.14 daily allowance."
        ),
    ])
    seen_requests = []

    class StubMessages:
        def create(self, **kwargs):
            seen_requests.append(kwargs)
            return next(scripted)

    with patch.object(
        chatbot, "_get_client", return_value=SimpleNamespace(messages=StubMessages())
    ):
        result = chatbot.run_chat(db["user_id"], "I have R400 for the week, help me budget")

    assert result["tools_used"] == ["get_budget_status", "recommend_items"]
    assert "Makro" in result["reply"] and "35.95" in result["reply"]

    # The tool_result content actually sent back to Claude must be real,
    # correctly-priced JSON, not a placeholder — this is what "grounding"
    # means in practice.
    second_request = seen_requests[1]
    tool_result_msg = second_request["messages"][-1]
    assert tool_result_msg["role"] == "user"
    budget_result_json = tool_result_msg["content"][0]["content"]
    assert "400.00" in budget_result_json
    assert tool_result_msg["content"][0]["is_error"] is False

    third_request = seen_requests[2]
    recommend_result_json = third_request["messages"][-1]["content"][0]["content"]
    assert "Makro Springfield" in recommend_result_json
    assert "35.95" in recommend_result_json

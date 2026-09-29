"""
UniWallet's budgeting chatbot — an assistant that turns "I have R500 for the
week" into a real, priced shopping list.

Every price or store name the assistant states has to come from a tool call
made THIS turn (search_products / recommend_items / list_stores /
compare_stores_for_list) — see SYSTEM_PROMPT below, which forbids the model
from inventing one. The tools are thin wrappers around the exact same
route handlers /search, /recommendations, /compare/basket, /budget-split,
/shopping-list and /budgets/current already expose — called directly as
plain Python functions (FastAPI's `@router.post(...)` etc. decorators
return the handler unmodified, so this is an ordinary function call, not an
HTTP round trip) rather than duplicating their SQL.

app/routers/chat.py's POST /chat is stateless per call: the client resends
the prior turns as plain text, and run_chat() below drives one full
tool-use loop for the new turn and returns only the final assistant text.
Tool calls are never persisted or replayed across turns — prices and the
student's budget can change between messages, so every turn re-grounds
itself rather than trusting what an earlier turn found.

Runs on Google's Gemini API (the free-tier Flash models — see
https://aistudio.google.com/apikey for a free GEMINI_API_KEY). Everything
above the "provider loop" section (the system prompt, the eight tool
functions, TOOL_DISPATCH, _run_tool) is otherwise ordinary Python calling
into this app's own routers — only run_chat() itself talks to Gemini.
"""

from __future__ import annotations

import json
import os
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Dict, List, Optional

from fastapi import HTTPException

from app.clock import local_today
from app.database import get_connection
from app.routers import budget_split as budget_split_router
from app.routers import budgets as budgets_router
from app.routers import compare as compare_router
from app.routers import recommendations as recommendations_router
from app.routers import search as search_router
from app.routers import shopping_list as shopping_list_router
from app.schemas import (
    AffordabilityRequest,
    BasketItemIn,
    CompareBasketRequest,
    RecommendationRequest,
    ShoppingListItemIn,
)

# gemini-flash-latest always points at Google's current free-tier Flash
# model, so this never needs updating by hand as Gemini versions move on.
GEMINI_MODEL = os.getenv("GEMINI_CHAT_MODEL", "gemini-flash-latest")
# A full itemised weekly plan (several categories, running total, a store
# comparison) can genuinely run long — 4096 truncated real plans mid-list.
MAX_TOKENS = 8192
# A model that keeps calling tools forever must not turn into an unbounded
# loop. Parallel tool use means several tool calls in one turn only cost one
# iteration here, so this is generous for a real multi-item shopping plan
# (budget check, a few category searches, a store comparison, an
# affordability check).
MAX_TOOL_ITERATIONS = 8
# Flash models "think" before answering, which adds seconds to every model
# call (and a plan makes several). 0 turns thinking off; a small number such
# as 512 keeps a little reasoning; blank leaves the model's own default.
# Set GEMINI_THINKING_BUDGET in .env to tune it without touching code.
def _thinking_budget() -> Optional[int]:
    raw = os.getenv("GEMINI_THINKING_BUDGET", "0").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None

_gemini_client = None


def _get_gemini_client():
    global _gemini_client
    if _gemini_client is None:
        from google import genai
        from google.genai import types

        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GEMINI_API_KEY is not set — the chatbot needs it to reach Gemini. "
                "Get a free key at https://aistudio.google.com/apikey."
            )
        # The SDK does ZERO automatic retries unless retry_options is set —
        # an empty HttpRetryOptions() opts into its own sensible defaults
        # (5 attempts, exponential backoff with jitter, retrying exactly the
        # transient codes free-tier traffic actually hits: 429 rate-limited
        # and 500/502/503/504 — 503 being Google's own "model is
        # experiencing high demand, temporary" response). Without this, a
        # single busy moment on the free tier surfaces as a hard error
        # instead of the SDK quietly waiting it out.
        _gemini_client = genai.Client(
            api_key=api_key,
            http_options=types.HttpOptions(retry_options=types.HttpRetryOptions()),
        )
    return _gemini_client


_SPREADSHEET_MENU = """Template menu - pick the best fit:
1. Payday-to-Payday Planner - for running out before the next payout.
   Columns: Date | Item | Category | Amount | Running balance | Days left | Daily allowance
   Key formulas: Running balance = starting amount minus the sum of amounts so far; \
Days left = payout date minus TODAY() plus 1; Daily allowance = Running balance divided \
by Days left, rounded down.
2. Weekly Essentials Tracker - for very tight budgets and survival mode.
   Columns: Day | Food | Transport | Data/Airtime | Toiletries | Other | Day total | Left \
for the week
   Key formulas: Day total = sum of the row; Left for the week = weekly budget minus the \
sum of Day total so far.
3. Grocery and Meal Planner - for planning food.
   Columns: Item | Store | Qty | Unit price | Line total | Essential? (Y/N) | Bought? \
(Y/N)
   Key formulas: Line total = Qty times Unit price; Total = sum of Line total; Remaining = \
budget minus Total; add a check that flags the sheet if Total is over budget.
4. Savings Goal Tracker - for saving toward a laptop, textbooks, registration or a \
buffer.
   Columns: Goal | Target amount | Saved so far | Cycles left | Needed per cycle | % done
   Key formulas: Needed per cycle = (Target minus Saved) divided by Cycles left; % done = \
Saved divided by Target.
5. Semester Big-Costs Planner - for registration, textbooks, res or transport deposits, \
and other lumpy costs.
   Columns: Cost | Due date | Amount | Paid? | Months until due | Set aside per month
   Key formulas: Set aside per month = Amount divided by Months until due (only while \
Paid? is No).
6. Shared Costs Splitter - for housemates or group purchases.
   Columns: Expense | Who paid | Amount | Number of people | Each person's share | \
Balance per person
   Key formulas: Share = Amount divided by number of people; Balance = amount paid minus \
share, summed per person.
7. Income and Side-Hustle Log - for irregular income on top of an allowance.
   Columns: Date | Source | Amount in | Set aside for savings (%) | Spendable
   Key formulas: Spendable = Amount in minus (Amount in times savings %).
"""

_SPREADSHEET_WORDS = (
    "spreadsheet", "sheet", "excel", "template", "tracker", "planner", "splitter",
    "help me budget", "track my", "log my",
)


def _wants_spreadsheet(message: str, history: List[dict]) -> bool:
    """
    The template menu is ~40 lines the model resends on every call. Only
    include it when the conversation is actually about a spreadsheet, so
    ordinary shopping turns carry a shorter, faster prompt.
    """
    text = " ".join([message] + [h.get("content", "") for h in history]).lower()
    return any(w in text for w in _SPREADSHEET_WORDS)


def _system_prompt(include_spreadsheets: bool = True) -> str:
    spreadsheet_menu = (
        _SPREADSHEET_MENU + "\n"
        if include_spreadsheets
        else "(The template menu is left out this turn. If the student turns out to want a \
spreadsheet, ask them to say so and offer to describe one.)\n\n"
    )
    return f"""You are UniWallet's budgeting assistant, built into an app that helps \
NSFAS and other students in South Africa stretch a fixed allowance across a budget cycle. \
You do two things: (1) turn "I have R500 for this week" into a real, priced shopping list \
from the stores this app tracks, and (2) coach students on managing their money, \
including recommending a simple spreadsheet that fits what they care about most.

Today's date is {local_today().isoformat()} (Africa/Johannesburg). Currency is always \
South African Rand (R).

## Grounding rules - never break these
1. Never state a price, store name or product you have not just retrieved with a tool \
this turn. Prices drift; call recommend_items / search_products again even if you \
answered a similar question earlier in this conversation.
2. Every price you show must say whether it is confirmed or an estimate \
(price_source "verified_manual" or "live_api" = confirmed; "seed_estimate" = estimate, \
i.e. price_is_estimate=true). Say so plainly, e.g. "R54.99 at Checkers (estimated, not \
yet confirmed)".
3. If a tool returns an error (no active budget, nothing found, out of stock), say so in \
plain language and suggest the next step. Never paper over it or guess a number.
4. Only the stores list_stores / recommend_items / search_products return exist in this \
app's catalogue. If the student names another store, say UniWallet doesn't have prices \
for it yet. Call list_stores if you're not sure.
5. Never invent facts about NSFAS rules, allowance amounts, payout dates, bank fees, \
interest rates or laws. Use only what the student tells you or what get_budget_status \
returns. For anything else, say you're not sure and point them to NSFAS, their \
university's financial aid office, or their bank. Figures you use in examples must be \
labelled as examples, not facts about their situation.

## Step 1 - work out what the student needs
Decide which of these the message is, and ask at most ONE short question if it is unclear:
- A shopping plan ("R400 for the week", "cheapest maize meal") -> follow "How to plan a \
budget" below.
- A money-management question or a request for help budgeting ("how do I make my \
allowance last", "I always run out before payday") -> follow "Money coaching" below.
- A spreadsheet request or a general "help me budget" -> follow "Recommending a \
spreadsheet" below.
If they haven't stated an amount or period, call get_budget_status first and use their \
saved budget, daily allowance and days left. Only ask if that comes back empty.

## How to plan a budget (shopping)
1. Build a staples-first list: (a) a starch (maize meal, rice, bread), (b) a protein \
(eggs, canned fish, chicken, beans), (c) vegetables or fruit if the budget allows, (d) \
anything else they asked for. Add non-essentials only after the essentials are covered \
and money is left over. In survival mode pass essential_only=true.
2. Size quantities with ordinary household knowledge and say so out loud, e.g. "a 10 kg \
bag of maize meal feeds one person for roughly two weeks, so for a one-week budget I've \
costed the 5 kg bag." Adjust for stated household size and say when you're estimating.
3. Find candidates with recommend_items (it ranks by true cost and fit against the daily \
allowance). Use search_products only when the student named a specific store. Then call \
compare_stores_for_list to see whether one store covers the list cheaper than splitting \
it, including delivery or collection cost.
4. Keep a running total against the budget. If you go over, drop or downsize the least \
essential item first and say what you changed and why.
5. Before presenting a plan as final, call check_affordability with its total.
6. Offer to add items with add_to_shopping_list, but only after the student confirms the \
plan.

## Money coaching
Help with the whole picture, not only groceries. Keep advice practical and specific to a \
student on a tight allowance.
- Start from their real numbers (get_budget_status) or ask for the few they haven't \
given: money in per cycle, fixed costs (rent, transport, data), and days until the next \
payout.
- Use a simple priority order: (1) safe housing and food, (2) transport to campus, (3) \
data, airtime and study needs, (4) a small buffer or savings, (5) wants. If the money \
doesn't cover 1-3, say so plainly and suggest they speak to the university's financial \
aid or student support office rather than pretending the maths works.
- Explain the app's tools when they help: the daily allowance on the Dashboard, the \
Compare screen for store totals, the shopping list, and the low-balance notification.
- Give tips that suit the situation (planning meals around staples, buying non-perishables \
in bulk when there is spare cash, checking delivery and travel costs before assuming an \
item is cheaper, tracking small daily spends like airtime and taxi fares).
- If the student mentions borrowing, warn gently about high-cost short-term lenders \
(including informal loan sharks / mashonisas) and suggest campus support first. Do not \
recommend a specific bank, loan or investment product.
- You are a budgeting assistant, not a licensed financial adviser. Give general \
information, help them decide for themselves, and say so briefly if they ask for advice \
on investments, debt or legal matters.
- If a student sounds like they can't afford food or are in distress, respond with care \
first, help them find the cheapest essentials, and point them to campus food-aid and \
student counselling services if they mention them or ask for help. Do not lecture.

## Recommending a spreadsheet
Recommend a spreadsheet only when it would genuinely help: the student asks for one, says \
they want to track or plan something, or keeps losing track of spending. Match it to \
their top priority. If their priority is unclear, ask ONE question: "What's the biggest \
money problem right now: running out before payday, planning food, saving for something, \
or splitting costs?" Suggest one template (two at most), not the whole menu.

{spreadsheet_menu}How to present a template:
- Say in one line why it fits their stated priority.
- Show the columns and key formulas in plain text, then two or three sample rows using \
either their real numbers or clearly labelled example numbers.
- Say how to use it: type the columns into Google Sheets or Excel, and copy the \
formulas. You are describing the layout; you have not created a file and cannot email or \
attach one. Never claim otherwise.
- Suggest a simple rhythm (e.g. update it once a day, review at the end of the week).
- Remind them UniWallet already tracks their daily allowance and spending on the \
Dashboard, so a sheet is for extra detail or for goals the app doesn't cover.
- Offer to tailor it (add categories, change the cycle length) if they tell you what \
they need.

## Tone and format
- Direct, practical, warm and respectful of how tight the budget really is. No lecturing, \
no filler, no judgement about past spending.
- Plain text only. The chat window does not render markdown, so do not use asterisks, \
pound-sign headings, backticks or markdown tables. Use short lines, simple dashes for \
lists, and " | " to separate spreadsheet columns.
- Show numbers itemised (item, quantity, store, price, running total, amount left) rather \
than describing them in prose.
- Keep replies as short as the question allows. Lead with the answer or the plan, then \
the detail.
- When the budget is very tight, say so plainly and help the student get the essentials \
rather than pretending the maths works when it doesn't."""


TOOLS: List[Dict[str, Any]] = [
    {
        "name": "get_budget_status",
        "description": (
            "Get the student's current active budget: remaining balance, today's "
            "daily allowance, days left in the cycle, and whether they are in "
            "survival mode. Call this first whenever the student doesn't state an "
            "amount and a period themselves (e.g. \"budget me for this week\") so "
            "you plan against their real numbers instead of asking them to repeat "
            "what the app already knows. Returns an error if they have no active "
            "budget — tell them to set one up on the Budget screen."
        ),
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "recommend_items",
        "description": (
            "Find real, currently-listed products for something the student wants to "
            "buy (e.g. \"maize meal\", \"cheap protein\"), ranked by true cost and fit "
            "against their daily allowance. This is the main way to find priced items "
            "across every store in the catalogue — prefer it over search_products "
            "unless the student named a specific store. Every result includes the "
            "store, the price, whether the price is confirmed or an estimate, and a "
            "plain-English reason it was picked."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What to search for, e.g. 'maize meal' or '10kg rice'.",
                },
                "category": {
                    "type": "string",
                    "description": "Optional exact category filter, e.g. 'Groceries'.",
                },
                "max_price": {
                    "type": "number",
                    "description": "Optional ceiling on the item's true cost, in Rand.",
                },
                "essential_only": {
                    "type": "boolean",
                    "description": "Only essentials (staples, toiletries) — true in survival mode.",
                },
                "fulfilment": {
                    "type": "string",
                    "enum": ["collection", "delivery"],
                    "description": (
                        "'collection' (default) prices what the student pays walking into "
                        "the store — use this unless they've asked for delivery, since "
                        "defaulting to delivery quietly adds a delivery fee to every price "
                        "and can hide the actual cheapest store."
                    ),
                },
                "limit": {"type": "integer", "description": "How many results, 1-15 (default 8)."},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "search_products",
        "description": (
            "Look products up directly by keyword, optionally narrowed to one store "
            "(e.g. \"what does Checkers have for rice\"). Simpler than "
            "recommend_items — it does not rank by true cost or budget fit — so use "
            "it only when the student names a specific store or wants a plain "
            "catalogue lookup rather than a recommendation."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Free-text search, e.g. 'brown bread'."},
                "category": {"type": "string"},
                "store": {
                    "type": "string",
                    "description": "A store name or part of one, e.g. 'Checkers' or 'Shoprite'.",
                },
                "max_price": {"type": "number"},
                "essential_only": {"type": "boolean"},
                "limit": {"type": "integer", "description": "1-25 (default 10)."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "list_stores",
        "description": (
            "List every store this app actually has prices for, and whether each is "
            "physical, online or both. Call this before telling a student a store "
            "isn't available, or when they ask what stores UniWallet covers — never "
            "assume which real-world chains are or aren't in the catalogue."
        ),
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "compare_stores_for_list",
        "description": (
            "Given a set of product_ids (from recommend_items or search_products "
            "results) and quantities, work out where to buy the whole list: one "
            "store that stocks everything, or the cheapest split across up to three "
            "stores — with delivery/collection and travel cost included, not just "
            "the item prices. Use this once you have a candidate list to decide "
            "where the student should actually shop."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "description": "Products and quantities to price as one shop.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "product_id": {"type": "integer"},
                            "qty": {"type": "integer", "description": "Default 1."},
                        },
                        "required": ["product_id"],
                        "additionalProperties": False,
                    },
                },
                "fulfilment": {
                    "type": "string",
                    "enum": ["collection", "delivery"],
                    "description": "How the student will get it home. Default 'collection'.",
                },
            },
            "required": ["items"],
            "additionalProperties": False,
        },
    },
    {
        "name": "check_affordability",
        "description": (
            "Check a total amount against the student's actual remaining daily "
            "allowance and cycle balance, not just whatever number they stated. Call "
            "this with the final total of a plan before presenting it as affordable."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"amount": {"type": "number", "description": "The total in Rand."}},
            "required": ["amount"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_shopping_list",
        "description": (
            "See what is already on the student's saved shopping list, so you don't "
            "duplicate it or lose track of a running total across turns."
        ),
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "add_to_shopping_list",
        "description": (
            "Add one priced offer to the student's shopping list. Only call this "
            "after the student has confirmed they want that specific item added — "
            "never add items on your own initiative while just planning out loud."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "offer_id": {
                    "type": "integer",
                    "description": "The offer_id from a recommend_items or search_products result.",
                },
                "qty": {"type": "integer", "description": "How many, 1-20. Default 1."},
            },
            "required": ["offer_id"],
            "additionalProperties": False,
        },
    },
]


def _dump(value: Any) -> Any:
    """JSON-safe for a tool result: Decimal/date/datetime -> str, pydantic models too."""
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    return json.loads(json.dumps(value, default=str))


def _tool_error(exc: HTTPException) -> dict:
    return {"error": True, "status_code": exc.status_code, "message": exc.detail}


def _decimal(value: Any, field: str) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError):
        raise HTTPException(status_code=400, detail=f"'{field}' must be a number")


# ---------------------------------------------------------------------------
# Tool implementations — one per TOOLS entry above, each a thin call into the
# same router functions /search, /recommendations, /compare, /budget-split,
# /shopping-list and /budgets already use.
# ---------------------------------------------------------------------------


def _get_budget_status(user_id: int, **_: Any) -> dict:
    out = budgets_router.get_current_budget(user_id=user_id)
    return _dump(out)


def _recommend_items(
    user_id: int,
    query: str,
    category: Optional[str] = None,
    max_price: Optional[float] = None,
    essential_only: bool = False,
    fulfilment: str = "collection",
    limit: int = 8,
    **_: Any,
) -> dict:
    # RecommendationRequest's OWN default is "delivery" — left unset, every
    # price the student sees would silently include a delivery fee they may
    # never have asked for, which can hide the store that's actually
    # cheapest to walk into (a real seed-data case: Makro is the cheapest
    # shelf price for maize meal but has the highest delivery fee of any
    # store carrying it, so a "delivery" search drops it off a short list
    # entirely). Defaulting to "collection" here matches
    # compare_stores_for_list's own default and what a budget-tight student
    # physically visiting a named store actually pays.
    payload = RecommendationRequest(
        query=query,
        category=category,
        max_price=_decimal(max_price, "max_price") if max_price is not None else None,
        essential_only=bool(essential_only),
        fulfilment=fulfilment if fulfilment in ("collection", "delivery") else "collection",
        limit=max(1, min(int(limit), 15)),
    )
    out = recommendations_router.get_recommendations(payload=payload, user_id=user_id)
    data = _dump(out)
    # Trimmed to what grounds a chat answer — component_scores and the full
    # cost_breakdown are for the UI, not for the model, and just burn tokens.
    return {
        "query": data.get("query"),
        "budget": data.get("budget"),
        "message": data.get("message"),
        "results": [
            {
                "offer_id": r["offer_id"],
                "product_id": r["product_id"],
                "product_name": r["product_name"],
                "store_name": r["store_name"],
                "price": r["price"],
                "true_cost": r["true_cost"],
                "is_essential": r["is_essential"],
                "matched_query": r["matched_query"],
                "meets_budget": r["meets_budget"],
                "price_source": r["price_source"],
                "price_is_estimate": r["price_is_estimate"],
                "explanation": r["explanation"],
            }
            for r in data.get("results", [])
        ],
    }


def _search_products(
    user_id: int,
    query: Optional[str] = None,
    category: Optional[str] = None,
    store: Optional[str] = None,
    max_price: Optional[float] = None,
    essential_only: bool = False,
    limit: int = 10,
    **_: Any,
) -> dict:
    # search_offers is a FastAPI route handler: several of its parameters
    # default to a `fastapi.Query(...)` sentinel object, not a plain `None`,
    # because FastAPI itself resolves those at request time. Calling it
    # directly (as every tool here does, to reuse the route's own logic
    # without a network hop) means every one of those parameters MUST be
    # passed explicitly — an omitted one leaves the raw Query object in
    # place, which crashes the first time the route's code does arithmetic
    # on it (e.g. `page - 1`). min_price / max_shipping_cost /
    # max_distance_km / offset / page all need it; limit is fine here since
    # it's always supplied below.
    out = search_router.search_offers(
        q=query,
        category=category,
        store=store,
        min_price=None,
        max_price=_decimal(max_price, "max_price") if max_price is not None else None,
        max_shipping_cost=None,
        essential_only=bool(essential_only),
        max_distance_km=None,
        limit=max(1, min(int(limit), 25)),
        offset=0,
        page=None,
        user_id=user_id,
    )
    data = _dump(out)
    return {
        "count": data["count"],
        "message": data.get("message"),
        "results": [
            {
                "offer_id": r["offer_id"],
                "product_id": r["product_id"],
                "product_name": r["product_name"],
                "store_name": r["store_name"],
                "price": r["price"],
                "total_cost": r["total_cost"],
                "availability_status": r["availability_status"],
                "price_source": r["price_source"],
                "is_essential": r["is_essential"],
            }
            for r in data.get("results", [])
        ],
    }


def _list_stores(user_id: int, **_: Any) -> dict:
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name, store_type, delivery_available, collection_available "
                "FROM stores ORDER BY name"
            )
            rows = cur.fetchall()
    finally:
        conn.close()
    return {"stores": _dump(rows)}


def _compare_stores_for_list(
    user_id: int,
    items: List[dict],
    fulfilment: str = "collection",
    **_: Any,
) -> dict:
    basket_items = [
        BasketItemIn(product_id=int(i["product_id"]), qty=int(i.get("qty", 1))) for i in items
    ]
    payload = CompareBasketRequest(items=basket_items, fulfilment=fulfilment, use_my_location=True)
    out = compare_router.compare_basket_endpoint(payload=payload, user_id=user_id)
    data = _dump(out)
    return {
        "fulfilment": data["fulfilment"],
        "location_known": data["location_known"],
        "best_single_store_id": data.get("best_single_store_id"),
        "stores": [
            {
                "store_id": s["store_id"],
                "store_name": s["store_name"],
                "full": s["full"],
                "total": s["total"],
                "missing_count": s["missing_count"],
                "notes": s["notes"],
            }
            for s in data.get("stores", [])
        ],
        "best_plan": data.get("best_plan"),
        "unavailable": data.get("unavailable", []),
        "prices": data.get("prices"),
    }


def _check_affordability(user_id: int, amount: float, **_: Any) -> dict:
    payload = AffordabilityRequest(amount=_decimal(amount, "amount"))
    out = budget_split_router.check_purchase(payload=payload, user_id=user_id)
    return _dump(out)


def _get_shopping_list(user_id: int, **_: Any) -> dict:
    out = shopping_list_router.get_list(user_id=user_id)
    data = _dump(out)
    return {
        "items": [
            {
                "offer_id": i["offer_id"],
                "product_name": i["product_name"],
                "store_name": i["store_name"],
                "qty": i["qty"],
                "price": i["price"],
                "current_price": i["current_price"],
                "availability_status": i["availability_status"],
            }
            for i in data.get("items", [])
        ],
        "summary": data.get("summary"),
    }


def _add_to_shopping_list(user_id: int, offer_id: int, qty: int = 1, **_: Any) -> dict:
    payload = ShoppingListItemIn(offer_id=int(offer_id), qty=max(1, min(int(qty), 20)))
    out = shopping_list_router.add_item(payload=payload, user_id=user_id)
    data = _dump(out)
    return {
        "summary": data.get("summary"),
        "item_count": len(data.get("items", [])) + len(data.get("live_items", [])),
    }


TOOL_DISPATCH: Dict[str, Callable[..., dict]] = {
    "get_budget_status": _get_budget_status,
    "recommend_items": _recommend_items,
    "search_products": _search_products,
    "list_stores": _list_stores,
    "compare_stores_for_list": _compare_stores_for_list,
    "check_affordability": _check_affordability,
    "get_shopping_list": _get_shopping_list,
    "add_to_shopping_list": _add_to_shopping_list,
}


def _run_tool(user_id: int, name: str, tool_input: dict) -> dict:
    fn = TOOL_DISPATCH.get(name)
    if fn is None:
        return {"error": True, "message": f"Unknown tool '{name}'."}
    # tool_input is JSON the model produced — never let it smuggle a
    # `user_id` that would collide with (or, absent this guard, on some
    # future tool, override) the authenticated caller. Every tool always
    # runs as the real signed-in student, never as whoever the input claims.
    safe_input = {k: v for k, v in tool_input.items() if k != "user_id"}
    try:
        return fn(user_id=user_id, **safe_input)
    except HTTPException as exc:
        return _tool_error(exc)
    except Exception as exc:  # a bad tool call must end the turn, not crash it
        return {"error": True, "message": f"{name} failed: {exc}"}


_TOO_MANY_STEPS = (
    "That took more steps than I could finish in one go — could you narrow the "
    "request (e.g. one store or one category at a time)?"
)


def _gemini_tools():
    """TOOLS translated once into Gemini's function-declaration shape.

    Gemini's FunctionDeclaration accepts a plain JSON Schema dict via
    parameters_json_schema — the exact shape TOOLS already uses as
    input_schema — so this is a rename, not a rewrite of each schema.
    """
    from google.genai import types

    return [
        types.Tool(
            function_declarations=[
                types.FunctionDeclaration(
                    name=tool["name"],
                    description=tool["description"],
                    parameters_json_schema=tool["input_schema"],
                )
                for tool in TOOLS
            ]
        )
    ]


def _generate_config(types, message: str, history: List[dict]):
    """Per-turn Gemini config: system prompt, tools, output cap, thinking budget."""
    kwargs: Dict[str, Any] = {}
    budget = _thinking_budget()
    if budget is not None:
        kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=budget)
    return types.GenerateContentConfig(
        system_instruction=_system_prompt(_wants_spreadsheet(message, history)),
        tools=_gemini_tools(),
        max_output_tokens=MAX_TOKENS,
        **kwargs,
    )


def _finalise_reply(text: Optional[str], finish_reason: Any) -> str:
    reply = (text or "").strip()
    if not reply:
        return "I couldn't put together an answer that time — could you rephrase?"
    if finish_reason == "MAX_TOKENS" or str(finish_reason).endswith("MAX_TOKENS"):
        reply += "\n\n(That answer got cut off — ask me to continue for the rest.)"
    return reply


def _history_contents(types, message: str, history: List[dict]) -> List[Any]:
    contents: List[Any] = [
        types.Content(
            role="model" if h["role"] == "assistant" else "user",
            parts=[types.Part.from_text(text=h["content"])],
        )
        for h in history
    ]
    contents.append(types.Content(role="user", parts=[types.Part.from_text(text=message)]))
    return contents


def run_chat_stream(user_id: int, message: str, history: Optional[List[dict]] = None):
    """
    Same tool-use loop as run_chat(), but a generator of events so the UI can
    show the reply as it is written instead of after the whole turn:

      {"type": "tool",  "name": str}                  a tool is being run
      {"type": "delta", "text": str}                  more reply text
      {"type": "reset"}                               discard streamed text (it was
                                                      a preamble to a tool call)
      {"type": "done",  "reply": str, "tools_used": [str]}
    """
    from google.genai import types

    history = history or []
    client = _get_gemini_client()
    contents = _history_contents(types, message, history)
    config = _generate_config(types, message, history)

    tools_used: List[str] = []
    for _ in range(MAX_TOOL_ITERATIONS):
        text_parts: List[str] = []
        model_parts: List[Any] = []
        calls: List[Any] = []
        finish_reason = None
        for chunk in client.models.generate_content_stream(
            model=GEMINI_MODEL, contents=contents, config=config
        ):
            if not chunk.candidates:
                continue
            candidate = chunk.candidates[0]
            finish_reason = getattr(candidate, "finish_reason", None) or finish_reason
            # Keep the raw parts: the model's own function-call parts (with any
            # signatures) have to go back in before the tool results do.
            for part in (candidate.content.parts if candidate.content else None) or []:
                model_parts.append(part)
                if getattr(part, "function_call", None):
                    calls.append(part.function_call)
                elif getattr(part, "text", None) and not getattr(part, "thought", False):
                    text_parts.append(part.text)
                    yield {"type": "delta", "text": part.text}

        if not calls:
            yield {
                "type": "done",
                "reply": _finalise_reply("".join(text_parts), finish_reason),
                "tools_used": tools_used,
            }
            return

        if text_parts:
            yield {"type": "reset"}
        contents.append(types.Content(role="model", parts=model_parts))
        result_parts = []
        for call in calls:
            tools_used.append(call.name)
            yield {"type": "tool", "name": call.name}
            result = _run_tool(user_id, call.name, dict(call.args or {}))
            result_parts.append(
                types.Part.from_function_response(name=call.name, response=_dump(result))
            )
        contents.append(types.Content(role="user", parts=result_parts))

    yield {"type": "done", "reply": _TOO_MANY_STEPS, "tools_used": tools_used}


def run_chat(user_id: int, message: str, history: Optional[List[dict]] = None) -> dict:
    """
    Run one chat turn to completion: send `message` (plus the prior plain-text
    `history`) to Gemini, execute every tool call it makes against this
    student's real data, and return the final reply.

    `history` is a list of {"role": "user"|"assistant", "content": str} —
    exactly what the client sent back last time. Gemini's own tool-call
    content is never returned to the client or stored, so it is never part
    of `history` either — each turn re-sends only plain text.
    """
    from google.genai import types

    history = history or []

    client = _get_gemini_client()
    # Gemini's roles are "user"/"model", not "user"/"assistant" — translated
    # in _history_contents only; the wire contract with the frontend stays "assistant".
    contents = _history_contents(types, message, history)

    config = _generate_config(types, message, history)

    tools_used: List[str] = []
    for _ in range(MAX_TOOL_ITERATIONS):
        response = client.models.generate_content(
            model=GEMINI_MODEL, contents=contents, config=config
        )

        calls = response.function_calls or []
        if not calls:
            finish_reason = getattr(response.candidates[0], "finish_reason", None) if response.candidates else None
            return {
                "reply": _finalise_reply(response.text, finish_reason),
                "tools_used": tools_used,
            }

        # The turn that made the calls has to go back in before the results do.
        contents.append(response.candidates[0].content)
        result_parts = []
        for call in calls:
            tools_used.append(call.name)
            result = _run_tool(user_id, call.name, dict(call.args or {}))
            result_parts.append(
                types.Part.from_function_response(name=call.name, response=_dump(result))
            )
        # "tool" is accepted by the SDK's own type constructor (some official
        # examples use it) but the live API rejects it — confirmed against a
        # real 400 whose own error names the accepted set, "user" included.
        contents.append(types.Content(role="user", parts=result_parts))

    return {"reply": _TOO_MANY_STEPS, "tools_used": tools_used}

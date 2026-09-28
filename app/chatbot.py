"""
UniWallet's budgeting chatbot — a Claude-powered assistant that turns
"I have R500 for the week" into a real, priced shopping list.

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
"""

from __future__ import annotations

import json
import os
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Dict, List, Optional

import anthropic
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

# Cheaper models (e.g. "claude-sonnet-5-5" or "claude-haiku-4-5") work fine
# here — the tool set is small and the task isn't deep reasoning — set
# ANTHROPIC_CHAT_MODEL to trade quality for cost.
MODEL = os.getenv("ANTHROPIC_CHAT_MODEL", "claude-opus-5-5")
# A full itemised weekly plan (several categories, running total, a store
# comparison) can genuinely run long — 4096 truncated real plans mid-list.
MAX_TOKENS = 8192
# A model that keeps calling tools forever must not turn into an unbounded —
# and unboundedly billed — loop. Parallel tool use means several tool calls
# in one assistant turn only cost one iteration here, so this is generous
# for a real multi-item shopping plan (budget check, a few category
# searches, a store comparison, an affordability check).
MAX_TOOL_ITERATIONS = 8

_client: Optional[anthropic.Anthropic] = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not set — the chatbot needs it to reach Claude."
            )
        _client = anthropic.Anthropic(api_key=api_key)
    return _client


def _system_prompt() -> str:
    return f"""You are UniWallet's budgeting assistant, built into an app that helps \
NSFAS students in South Africa stretch a fixed allowance across a budget cycle. Your \
job is to turn "I have R500 for this week" into an actual, buyable shopping list, \
priced from the real stores this app tracks — never invented prices.

Today's date is {local_today().isoformat()} (Africa/Johannesburg). Currency is always \
South African Rand (R).

## Grounding rules — never break these
1. Never state a price, store name or product you have not just retrieved with a tool \
this turn. Prices drift; call recommend_items / search_products again even if you \
answered a similar question earlier in this conversation.
2. Every price you show must say whether it is confirmed or an estimate \
(price_source "verified_manual" or "live_api" = confirmed; "seed_estimate" = \
estimate, i.e. price_is_estimate=true). Say so plainly, e.g. "R54.99 at Checkers \
(estimated, not yet confirmed)".
3. If a tool returns an error (no active budget, nothing found, out of stock), say so \
in plain language and suggest the next step — never paper over it or guess a \
substitute number.
4. Only the stores list_stores / recommend_items / search_products actually return \
exist in this app's catalogue. If the student names a store that isn't there, say \
plainly that UniWallet doesn't have prices for it yet rather than inventing one — \
call list_stores if you're not sure.

## How to plan a budget
1. Work out the amount and the period. If the student didn't state both (e.g. \
"budget me for groceries this week"), call get_budget_status and use their saved \
active budget and daily allowance instead of making them repeat what the app already \
knows; ask only if that also comes back empty.
2. Build a staples-first list. Prioritise, in order: (a) a starch (maize meal, rice, \
bread), (b) a protein (eggs, canned fish, chicken, beans), (c) vegetables or fruit if \
the budget allows, (d) anything else the student asked for. Only add non-essentials \
once the essentials are covered and money is left over — check is_essential on \
results, and in survival mode pass essential_only=true.
3. Size quantities using ordinary household knowledge, and say so out loud, e.g. "a \
10 kg bag of maize meal feeds one person for roughly two weeks, so for a one-week \
budget I've costed the 5 kg bag instead." Adjust for a stated household size. These \
are reasonable planning assumptions, not guarantees — say when you're estimating.
4. Find real candidates with recommend_items (it already ranks by true cost and fit \
against the daily allowance) — use search_products instead only when the student \
named a specific store. Once you have a candidate set of product_ids, call \
compare_stores_for_list to see whether one store covers the whole list cheaper than \
splitting it, including delivery or collection cost.
5. Keep a running total against the stated budget as you build the list. If you go \
over, drop or downsize the least essential item first and say what you changed and \
why.
6. Before presenting the plan as final, call check_affordability with its total so \
the student sees it against their actual daily allowance, not just the number they \
first named.
7. Offer to add the chosen items with add_to_shopping_list — but only after the \
student has confirmed the plan, never on your own initiative while still thinking out \
loud.

## Tone
Direct, practical and respectful of how tight the budget really is — no lecturing, no \
filler. Show the numbers (itemised: item, quantity, store, price, running total, \
amount left) rather than only describing them in prose. When the budget is very \
tight, say so plainly and help the student get the essentials rather than pretending \
the maths works when it doesn't."""


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


def run_chat(user_id: int, message: str, history: Optional[List[dict]] = None) -> dict:
    """
    Run one chat turn to completion: send `message` (plus the prior plain-text
    `history`) to Claude, execute every tool call it makes against this
    student's real data, and return the final reply.

    `history` is a list of {"role": "user"|"assistant", "content": str} —
    exactly what the client sent back last time. Claude's tool_use/tool_result
    content blocks are never returned to the client or stored, so they are
    never part of `history` either.
    """
    client = _get_client()
    messages: List[dict] = [{"role": h["role"], "content": h["content"]} for h in (history or [])]
    messages.append({"role": "user", "content": message})

    # Rendered once per turn, not once per loop iteration: the date inside it
    # must not drift mid-turn, and rendering it once lets the ephemeral cache
    # breakpoint below actually hit on iteration 2+ of a multi-tool-call turn
    # (render order is tools -> system -> messages, so caching the system
    # block's tail caches the static tool schemas ahead of it too).
    system = [
        {
            "type": "text",
            "text": _system_prompt(),
            "cache_control": {"type": "ephemeral"},
        }
    ]

    tools_used: List[str] = []
    for _ in range(MAX_TOOL_ITERATIONS):
        response = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=system,
            tools=TOOLS,
            messages=messages,
        )

        if response.stop_reason != "tool_use":
            reply = "".join(b.text for b in response.content if b.type == "text").strip()
            if response.stop_reason == "refusal":
                reply = reply or "I can't help with that request."
            elif not reply:
                reply = "I couldn't put together an answer that time — could you rephrase?"
            elif response.stop_reason == "max_tokens":
                reply += "\n\n(That answer got cut off — ask me to continue for the rest.)"
            return {"reply": reply, "tools_used": tools_used}

        messages.append({"role": "assistant", "content": response.content})
        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            tools_used.append(block.name)
            result = _run_tool(user_id, block.name, block.input)
            tool_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(result, default=str),
                    "is_error": bool(result.get("error")),
                }
            )
        messages.append({"role": "user", "content": tool_results})

    return {
        "reply": (
            "That took more steps than I could finish in one go — could you narrow the "
            "request (e.g. one store or one category at a time)?"
        ),
        "tools_used": tools_used,
    }

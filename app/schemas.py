from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator
from typing import Optional, List
from datetime import datetime, date
from decimal import Decimal

from app.budget_categories import (
    MAX_CATEGORIES,
    MAX_NAME_LENGTH,
    clean_category_name,
)

# DUT student numbers are 8-9 digits, no letters/spaces — matches
# mintly-react/src/lib/validation.js's studentNumber() check, and the
# users.student_number CHECK constraint in schema.sql.
STUDENT_NUMBER_PATTERN = r"^[0-9]{8,9}$"


class RegisterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: EmailStr
    password: str
    # Both optional: the frontend's residence dropdown and student-number
    # field can be left blank, and older/other clients that don't send
    # them at all should still work.
    residence: Optional[str] = Field(default=None, max_length=100)
    student_number: Optional[str] = Field(default=None, max_length=9)

    @field_validator("student_number")
    @classmethod
    def validate_student_number(cls, value: Optional[str]) -> Optional[str]:
        if value is None or value == "":
            return None
        import re

        if not re.match(STUDENT_NUMBER_PATTERN, value):
            raise ValueError("Student number must be 8 or 9 digits, with no letters or spaces")
        return value


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: int
    name: str
    email: EmailStr
    residence: Optional[str] = None
    student_number: Optional[str] = None
    phone_number: Optional[str] = None
    created_at: Optional[datetime] = None


class AuthResponse(BaseModel):
    user: UserOut
    token: str


class UpdateProfileRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    # Optional, like at sign-up. Omitted = unchanged; "" = clear it.
    residence: Optional[str] = Field(default=None, max_length=100)
    student_number: Optional[str] = Field(default=None, max_length=9)
    # Phase 6: legacy phone number field. Omitted = unchanged; "" = clear it.
    phone_number: Optional[str] = Field(default=None, max_length=30)

    @field_validator("student_number")
    @classmethod
    def validate_student_number(cls, value: Optional[str]) -> Optional[str]:
        if value is None or value == "":
            return value
        import re

        if not re.match(STUDENT_NUMBER_PATTERN, value):
            raise ValueError("Student number must be 8 or 9 digits, with no letters or spaces")
        return value


class LocationIn(BaseModel):
    """The student's default location — a campus they picked, or their device's."""
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    label: str = Field(default="My location", min_length=1, max_length=100)


class LocationOut(BaseModel):
    latitude: float
    longitude: float
    label: str
    updated_at: Optional[datetime] = None


class PreferencesOut(BaseModel):
    preferred_categories: List[str] = []
    preferred_stores: List[str] = []
    max_distance_km: Optional[float] = None


class UpdatePreferencesRequest(BaseModel):
    preferred_categories: Optional[List[str]] = None
    preferred_stores: Optional[List[str]] = None
    max_distance_km: Optional[float] = Field(default=None, ge=0, le=9999)


# -------------------------
# Budgets & transactions (Member 3)
# -------------------------

class BudgetCreateRequest(BaseModel):
    total_amount: Decimal = Field(gt=0)
    cycle_start_date: date
    cycle_end_date: date
    budget_kind: str = Field(default="monthly", pattern="^(monthly|available)$")
    savings_percentage: Decimal = Field(default=Decimal("0"), ge=0, le=100)
    # Remaining balance at or below this flips the Daily Budget Split into
    # survival mode (essentials only). Optional — no threshold, no survival mode.
    survival_threshold: Optional[Decimal] = Field(default=None, ge=0)


class BudgetUpdateRequest(BaseModel):
    """
    PUT /budgets/{id}. Every field is optional; only the ones sent change.

    survival_threshold is the one field where "not sent" and "sent as null" mean
    different things: leaving it out keeps the current threshold, sending null
    (or 0) clears it. The handler tells them apart with `model_fields_set`.
    """
    total_amount: Optional[Decimal] = Field(default=None, gt=0)
    cycle_end_date: Optional[date] = None
    survival_threshold: Optional[Decimal] = Field(default=None, ge=0)
    # Savings are recomputed from this whenever it or the total changes.
    savings_percentage: Optional[Decimal] = Field(default=None, ge=0, le=100)


class BudgetRenewRequest(BaseModel):
    """
    POST /budgets/{id}/renew — close this cycle and start the next one.

    The dates default to "starts today, lasts as long as the last one" so the
    common case is just an amount. `carry_over_leftover` rolls what was not
    spent into the new total; `carry_over_savings` makes last cycle's savings
    spendable again (otherwise they stay banked in the savings ledger).

    total_amount is the FRESH allowance. It may be 0 when the whole new budget is
    carried over; the total after carry-over must still be above zero.
    """
    total_amount: Decimal = Field(ge=0)
    cycle_start_date: Optional[date] = None
    cycle_end_date: Optional[date] = None
    savings_percentage: Optional[Decimal] = Field(default=None, ge=0, le=100)
    survival_threshold: Optional[Decimal] = Field(default=None, ge=0)
    carry_over_leftover: bool = True
    carry_over_savings: bool = False
    # Copy the priority categories (with their planned amounts) to the new cycle.
    keep_categories: bool = True


class BudgetOut(BaseModel):
    id: int
    user_id: int
    budget_kind: str
    status: str
    currency: str
    total_amount: Decimal
    remaining_amount: Decimal
    savings_percentage: Decimal
    savings_amount: Decimal
    cycle_start_date: date
    cycle_end_date: date
    daily_limit: Optional[Decimal] = None
    survival_threshold: Optional[Decimal] = None
    budget_mode: str = "normal"
    # Cycle history: what was rolled in, when this cycle was closed, and which
    # cycle it replaced.
    carried_over_amount: Decimal = Decimal("0")
    completed_at: Optional[datetime] = None
    renewed_from_budget_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime


class TransactionCreateRequest(BaseModel):
    item_name: str = Field(min_length=1, max_length=150)
    amount: Decimal = Field(gt=0)
    category: Optional[str] = Field(default=None, max_length=100)
    is_essential: bool = False
    # When it was bought. Omit for "now". A past date (never before the budget
    # started, never in the future) lets a student log yesterday's groceries
    # without it eating into today's allowance.
    transaction_date: Optional[date] = None


class TransactionUpdateRequest(BaseModel):
    """PUT /budgets/{id}/transactions/{tid} — only the fields sent change."""
    item_name: Optional[str] = Field(default=None, min_length=1, max_length=150)
    amount: Optional[Decimal] = Field(default=None, gt=0)
    category: Optional[str] = Field(default=None, max_length=100)
    is_essential: Optional[bool] = None
    transaction_date: Optional[date] = None


class TransactionOut(BaseModel):
    id: int
    user_id: int
    budget_id: int
    item_name: str
    amount: Decimal
    category: Optional[str] = None
    is_essential: bool
    transaction_date: datetime
    created_at: datetime


class TransactionResult(BaseModel):
    transaction: TransactionOut
    budget: BudgetOut
    overspend_warning: bool
    warning_message: Optional[str] = None
    # Phase 3: the purchase fit the cycle but not today's Daily Budget Split
    daily_limit_warning: bool = False
    daily_limit_message: Optional[str] = None
    # The split recalculated after this transaction (None if it could not be built)
    daily_split: Optional["BudgetSplitOut"] = None


class TransactionUpdateResult(BaseModel):
    """PUT /budgets/{id}/transactions/{tid} — the edited spend and the budget after it."""
    transaction: TransactionOut
    budget: "BudgetOut"
    daily_split: Optional["BudgetSplitOut"] = None


class TransactionDeleteResult(BaseModel):
    """DELETE /budgets/{id}/transactions/{tid} — the budget after the refund."""
    budget: "BudgetOut"
    daily_split: Optional["BudgetSplitOut"] = None


# -------------------------
# Search (Member 4)
# -------------------------

class SearchResultItem(BaseModel):
    offer_id: int
    product_id: int
    product_name: str
    brand: Optional[str] = None
    category: Optional[str] = None
    subcategory: Optional[str] = None
    colour: Optional[str] = None
    size: Optional[str] = None
    is_essential: bool
    store_id: int
    store_name: str
    store_type: str
    store_latitude: Optional[Decimal] = None
    store_longitude: Optional[Decimal] = None
    price: Decimal
    shipping_cost: Decimal
    total_cost: Decimal
    currency: str
    availability_status: str
    rating: Optional[Decimal] = None
    rating_count: int = 0
    last_updated: Optional[datetime] = None
    product_url: Optional[str] = None
    product_url: Optional[str] = None
    # Phase 4 (all additive, so older callers keep working)
    effective_cost: Optional[Decimal] = None     # what ?fulfilment= makes it cost
    price_source: str = "seed_estimate"          # seed_estimate | live_api | verified_manual
    price_verified_at: Optional[datetime] = None
    delivery_available: Optional[bool] = None
    collection_available: Optional[bool] = None
    distance_km: Optional[float] = None           # from the student's saved location


class SearchResponse(BaseModel):
    results: List[SearchResultItem]
    count: int
    limit: int
    offset: int
    # Phase 3 pagination helpers (additive — older callers can ignore them)
    page: int = 1
    total_pages: int = 0
    has_more: bool = False
    next_offset: Optional[int] = None
    message: Optional[str] = None
    # How a natural-language `q` was read (None when q was not sent)
    parsed: Optional["ParsedQueryOut"] = None


class StoreNearbyOut(BaseModel):
    """One physical/mixed store, with its distance from the student's saved location."""
    store_id: int
    store_name: str
    store_type: str
    address: Optional[str] = None
    latitude: Decimal
    longitude: Decimal
    distance_km: float
    delivery_available: Optional[bool] = None
    collection_available: Optional[bool] = None


class NearbyStoresResponse(BaseModel):
    results: List[StoreNearbyOut]
    count: int
    max_distance_km: float
    origin: LocationOut


# -------------------------
# True cost (Member 6)
# -------------------------

class ChargeLineOut(BaseModel):
    label: str
    charge_type: str
    amount: Decimal
    waived: bool = False
    note: Optional[str] = None


class TrueCostOut(BaseModel):
    offer_id: int
    currency: str
    quantity: int
    fulfilment: str
    # Phase 4: what was asked for, and whether the store can do it. When it
    # can't, `fulfilment` is the way it was priced instead.
    requested_fulfilment: Optional[str] = None
    fulfilment_available: bool = True
    subtotal: Decimal
    shipping: Decimal
    charges: List[ChargeLineOut] = []
    charges_total: Decimal
    travel_cost: Decimal
    true_cost: Decimal
    hidden_cost: Decimal
    distance_km: Optional[float] = None
    notes: List[str] = []
    # Context the frontend shows next to the number
    product_name: Optional[str] = None
    store_name: Optional[str] = None


class TrueCostRequest(BaseModel):
    offer_ids: List[int] = Field(min_length=1, max_length=50)
    quantity: int = Field(default=1, ge=1, le=99)
    fulfilment: str = Field(default="delivery", pattern="^(delivery|collection)$")
    use_my_location: bool = True


class TrueCostResponse(BaseModel):
    results: List[TrueCostOut]
    cheapest_offer_id: Optional[int] = None
    saving_vs_dearest: Decimal = Decimal("0.00")


# -------------------------
# Daily Budget Split (Member 6)
# -------------------------

class DaySplitOut(BaseModel):
    limit_date: date
    planned_limit: Decimal
    spent_amount: Decimal
    remaining_limit: Decimal
    is_today: bool


class BudgetSplitOut(BaseModel):
    budget_id: int
    currency: str
    as_of: date
    next_payout_date: date
    days_remaining: int
    remaining_amount: Decimal
    daily_limit: Decimal
    spent_today: Decimal
    remaining_today: Decimal
    tomorrow_limit: Optional[Decimal] = None
    mode: str
    survival_threshold: Optional[Decimal] = None
    message: str
    days: List[DaySplitOut] = []
    # True once the payout date has passed — the budget needs renewing.
    cycle_ended: bool = False
    days_overdue: int = 0


class BudgetHealthOut(BaseModel):
    warning_level: str
    spendable_amount: Decimal
    spent_amount: Decimal
    spent_percentage: Decimal
    over_daily_limit_by: Decimal
    warnings: List[str] = []


class BudgetWithSplitOut(BudgetOut):
    """BudgetOut plus the Daily Budget Split — GET /budgets/current."""
    daily_split: BudgetSplitOut


class BudgetCategoryIn(BaseModel):
    """One priority category the student wants to budget for."""
    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)
    planned_amount: Optional[Decimal] = Field(default=None, ge=0, le=Decimal("1000000"))

    @field_validator("name")
    @classmethod
    def _clean_name(cls, value: str) -> str:
        return clean_category_name(value)


class BudgetCategoriesRequest(BaseModel):
    """PUT /budgets/{id}/categories — replaces the whole list."""
    categories: List[BudgetCategoryIn] = Field(default_factory=list, max_length=MAX_CATEGORIES)


class BudgetCategoryOut(BaseModel):
    id: int
    name: str
    planned_amount: Optional[Decimal] = None
    position: int = 0
    # Recorded spending under this name (case-insensitive), so the dashboard
    # can show planned vs spent without a second request.
    spent_amount: Decimal = Decimal("0")


class BudgetTemplateRequest(BaseModel):
    """
    POST /budgets/template — build the downloadable budget spreadsheet.

    The money and period default to the student's active budget, so the form
    only has to send them when there is no budget yet (or to try "what if").
    """
    categories: List[BudgetCategoryIn] = Field(min_length=1, max_length=MAX_CATEGORIES)
    total_amount: Optional[Decimal] = Field(default=None, gt=0)
    savings_percentage: Optional[Decimal] = Field(default=None, ge=0, le=100)
    period_days: Optional[int] = Field(default=None, ge=1, le=92)
    start_date: Optional[date] = None


class BudgetDashboardOut(BaseModel):
    """GET /budgets/dashboard — everything the dashboard screen renders."""
    budget: BudgetOut
    daily_split: BudgetSplitOut
    health: BudgetHealthOut
    recent_transactions: List[TransactionOut] = []
    categories: List[BudgetCategoryOut] = []


class AffordabilityRequest(BaseModel):
    amount: Decimal = Field(gt=0)


class AffordabilityOut(BaseModel):
    amount: Decimal
    affordable_today: bool
    affordable_this_cycle: bool
    remaining_today: Decimal
    remaining_amount: Decimal
    days_of_budget: Optional[Decimal] = None
    message: str


# -------------------------
# Recommendations (Member 5)
# -------------------------

class RecommendationRequest(BaseModel):
    query: Optional[str] = None
    category: Optional[str] = None
    max_price: Optional[Decimal] = Field(default=None, ge=0)
    fulfilment: str = Field(default="delivery", pattern="^(delivery|collection)$")
    limit: int = Field(default=10, ge=1, le=50)
    include_unaffordable: bool = True
    candidate_pool: int = Field(default=60, ge=10, le=200)
    # Phase 4: applied on the server BEFORE the limit. The For you screen used
    # to filter the 12 results it got back, so "essentials only" could show
    # an empty page while essentials existed.
    essential_only: bool = False


class ParsedQueryOut(BaseModel):
    keywords: List[str] = []
    category: Optional[str] = None
    subcategory: Optional[str] = None
    colour: Optional[str] = None
    size: Optional[str] = None
    min_price: Optional[Decimal] = None
    max_price: Optional[Decimal] = None
    essential_only: bool = False
    nearby_only: bool = False
    free_delivery_only: bool = False
    prefer_collection: bool = False
    sort_hint: Optional[str] = None
    category_is_explicit: bool = False


class RecommendedOffer(BaseModel):
    rank: int
    offer_id: int
    product_id: Optional[int] = None
    product_name: str
    brand: Optional[str] = None
    category: Optional[str] = None
    subcategory: Optional[str] = None
    colour: Optional[str] = None
    size: Optional[str] = None
    is_essential: bool = False
    store_id: Optional[int] = None
    store_name: Optional[str] = None
    store_type: str
    product_url: Optional[str] = None
    rating: Optional[Decimal] = None
    rating_count: int = 0
    price: Decimal
    true_cost: Decimal
    currency: str
    distance_km: Optional[float] = None
    score: float
    component_scores: dict = {}
    meets_budget: bool
    meets_preferences: bool
    # False when none of the student's words matched and this is a closest
    # match from the inferred category — the UI should say so.
    matched_query: bool = True
    explanation: str
    cost_breakdown: TrueCostOut
    # Phase 4
    price_source: str = "seed_estimate"
    price_verified_at: Optional[datetime] = None
    price_is_estimate: bool = True


class BudgetContextOut(BaseModel):
    budget_id: Optional[int] = None
    remaining_amount: Optional[Decimal] = None
    daily_limit: Optional[Decimal] = None
    days_remaining: Optional[int] = None
    mode: str = "normal"
    message: Optional[str] = None


class RecommendationResponse(BaseModel):
    run_id: Optional[int] = None
    search_id: Optional[int] = None
    query: Optional[str] = None
    parsed: ParsedQueryOut
    budget: BudgetContextOut
    results: List[RecommendedOffer]
    count: int
    candidates_considered: int
    response_time_ms: int
    message: Optional[str] = None


# These refer to models declared further down the file.
TransactionResult.model_rebuild()
TransactionDeleteResult.model_rebuild()
TransactionUpdateResult.model_rebuild()
SearchResponse.model_rebuild()


# -------------------------
# Basket comparison (Phase 4) — POST /compare/basket
# -------------------------

class BasketItemIn(BaseModel):
    product_id: int
    qty: int = Field(default=1, ge=1, le=99)


class CompareBasketRequest(BaseModel):
    items: List[BasketItemIn] = Field(min_length=1, max_length=50)
    fulfilment: str = Field(default="collection", pattern="^(delivery|collection)$")
    use_my_location: bool = True


class BasketLineOut(BaseModel):
    product_id: int
    product_name: str
    qty: int
    offer_id: int
    price: Decimal
    line_total: Decimal
    is_estimate: bool
    price_source: str
    price_verified_at: Optional[datetime] = None


class MissingLineOut(BaseModel):
    product_id: int
    product_name: str
    reason: Optional[str] = None


class StoreQuoteOut(BaseModel):
    store_id: int
    store_name: str
    store_type: str
    distance_km: Optional[float] = None
    fulfilment: str
    fulfilment_available: bool
    full: bool
    stocked: int
    missing_count: int
    lines: List[BasketLineOut]
    missing: List[MissingLineOut]
    subtotal: Decimal
    delivery: Decimal
    fees: Decimal
    travel: Decimal
    total: Decimal
    estimate_count: int
    notes: List[str] = []


class BasketPlanOut(BaseModel):
    total: Decimal
    store_count: int
    stores: List[StoreQuoteOut]
    saving_vs_best_single: Optional[Decimal] = None


class ItemOfferOut(BaseModel):
    offer_id: int
    store_id: int
    store_name: str
    price: Decimal
    line_total: Decimal
    in_stock: bool
    is_estimate: bool
    price_source: str
    price_verified_at: Optional[datetime] = None
    product_url: Optional[str] = None


class ItemComparisonOut(BaseModel):
    product_id: int
    product_name: str
    qty: int
    offers: List[ItemOfferOut]


class PriceProvenanceOut(BaseModel):
    listings: int
    estimates: int
    confirmed: int
    all_confirmed: bool


class CompareBasketResponse(BaseModel):
    fulfilment: str
    location_known: bool
    stores: List[StoreQuoteOut]
    best_single_store_id: Optional[int] = None
    best_plan: Optional[BasketPlanOut] = None
    unavailable: List[MissingLineOut] = []
    items: List[ItemComparisonOut]
    prices: PriceProvenanceOut


class PriceStatusOut(BaseModel):
    by_source: dict
    newest_verification: Optional[datetime] = None
    live_provider_configured: bool
    message: str


# -------------------------
# Shopping list (Phase 5) — /shopping-list
# -------------------------

class ShoppingListItemIn(BaseModel):
    """Exactly one of: offer_id (a catalogue offer) or item_id (a live store item)."""
    offer_id: Optional[int] = None
    item_id: Optional[int] = None
    qty: int = Field(default=1, ge=1, le=99)

    @model_validator(mode="after")
    def one_product(self):
        if (self.offer_id is None) == (self.item_id is None):
            raise ValueError("Send exactly one of offer_id or item_id.")
        return self


class ShoppingListQtyIn(BaseModel):
    qty: int = Field(ge=0, le=99)     # 0 removes the line


class ShoppingListLineOut(BaseModel):
    offer_id: int
    product_id: int
    product_name: str
    brand: Optional[str] = None
    size: Optional[str] = None
    category: Optional[str] = None
    is_essential: bool = False
    store_id: int
    store_name: str
    store_type: str
    price: Decimal                    # when it was added
    current_price: Decimal            # today
    shipping_cost: Decimal
    total_cost: Decimal
    availability_status: str
    qty: int
    added_at: datetime


class LiveListLineOut(BaseModel):
    """A live store item (GET /api/search) on the list."""
    item_id: int
    name: str
    store: str
    brand: Optional[str] = None
    image_url: Optional[str] = None
    product_url: Optional[str] = None
    price: Decimal                         # unit price saved when it was added
    current_price: Optional[Decimal] = None  # the store's price today; None = no price now
    in_stock: bool
    buyable: bool                          # in stock with a real price today
    price_changed: bool                    # today's price differs from the saved one
    qty: int
    line_total: Decimal                    # saved price x qty
    added_at: datetime


class ShoppingListSummary(BaseModel):
    """
    total: saved prices x qty for every line that can still be bought — an
    out-of-stock or unpriced line is never counted. Today's prices never
    change it; they are only shown next to the saved one.
    """
    total: Decimal
    count: int                             # all quantities, every line
    unavailable_count: int                 # lines left out of the total
    changed_count: int                     # lines whose price moved since added


class ShoppingListOut(BaseModel):
    items: List[ShoppingListLineOut]       # catalogue offers
    live_items: List[LiveListLineOut] = []  # live store items
    summary: ShoppingListSummary


# -------------------------
# Live store search — GET /api/search (app/routers/live_search.py)
# -------------------------

class LiveSearchItem(BaseModel):
    id: int
    name: str
    # The store's current price. None — never 0 — when it has none right now
    # (out of stock). last_known_price is the last real price seen, if any.
    price: Optional[Decimal] = None
    last_known_price: Optional[Decimal] = None
    last_priced_at: Optional[datetime] = None
    image_url: Optional[str] = None
    product_url: Optional[str] = None
    store: str
    brand: Optional[str] = None
    category: Optional[str] = None
    on_promotion: bool = False
    in_stock: bool = True
    last_updated: datetime


class LiveSearchStoreStatus(BaseModel):
    store: str                      # key from app/scrapers, e.g. "checkers"
    name: str                       # the items.store value its results carry, e.g. "Checkers"
    source: str                     # cache | live | stale | unavailable
    fetched_at: Optional[datetime] = None
    count: int


class LiveSearchResponse(BaseModel):
    query: str
    results: List[LiveSearchItem]
    count: int
    stores: List[LiveSearchStoreStatus]
    message: Optional[str] = None


# -------------------------
# Notifications (Phase 6) — /notifications
# -------------------------

class NotificationOut(BaseModel):
    id: int
    category: str            # success | info | warning | alert | survival | balance | system
    module: str = "system"   # where it happened: budget | transactions | shopping_list | ...
    title: str
    body: str
    is_read: bool
    created_at: datetime


class NotificationListOut(BaseModel):
    items: List[NotificationOut]
    unread_count: int


class NotificationPreferencesOut(BaseModel):
    low_balance_threshold: Optional[Decimal] = None


class NotificationPreferencesUpdate(BaseModel):
    low_balance_threshold: Optional[Decimal] = Field(default=None, ge=0)


# -------------------------
# Budgeting chatbot — POST /chat  (app/chatbot.py)
# -------------------------

class ChatMessage(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1, max_length=4000)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    # Prior plain-text turns from this conversation, oldest first. The
    # backend never stores or replays Gemini's tool calls — each turn
    # re-grounds itself against live prices and the student's current budget.
    history: List[ChatMessage] = Field(default_factory=list, max_length=40)


class ChatResponse(BaseModel):
    reply: str
    # Which tools were used this turn, e.g. ["get_budget_status",
    # "recommend_items"] — the frontend can show "checked your budget and
    # live prices" instead of a bare reply.
    tools_used: List[str] = Field(default_factory=list)

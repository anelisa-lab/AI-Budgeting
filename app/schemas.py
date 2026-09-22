from pydantic import BaseModel, EmailStr, Field
from typing import Optional, List
from datetime import datetime, date
from decimal import Decimal


class RegisterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: EmailStr
    password: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: int
    name: str
    email: EmailStr
    created_at: Optional[datetime] = None


class AuthResponse(BaseModel):
    user: UserOut
    token: str


class UpdateProfileRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)


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
    total_amount: Optional[Decimal] = Field(default=None, gt=0)
    cycle_end_date: Optional[date] = None
    survival_threshold: Optional[Decimal] = Field(default=None, ge=0)


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
    created_at: datetime
    updated_at: datetime


class TransactionCreateRequest(BaseModel):
    item_name: str = Field(min_length=1, max_length=150)
    amount: Decimal = Field(gt=0)
    category: Optional[str] = Field(default=None, max_length=100)
    is_essential: bool = False


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


class BudgetDashboardOut(BaseModel):
    """GET /budgets/dashboard — everything the dashboard screen renders."""
    budget: BudgetOut
    daily_split: BudgetSplitOut
    health: BudgetHealthOut
    recent_transactions: List[TransactionOut] = []


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
    explanation: str
    cost_breakdown: TrueCostOut


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
SearchResponse.model_rebuild()

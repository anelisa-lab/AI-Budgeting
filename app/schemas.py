from pydantic import BaseModel, EmailStr, Field
from typing import Optional, List
from datetime import datetime, date
from decimal import Decimal


class RegisterRequest(BaseModel):
    name: str
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
    name: str


class PreferencesOut(BaseModel):
    preferred_categories: List[str] = []
    preferred_stores: List[str] = []
    max_distance_km: Optional[float] = None


class UpdatePreferencesRequest(BaseModel):
    preferred_categories: Optional[List[str]] = None
    preferred_stores: Optional[List[str]] = None
    max_distance_km: Optional[float] = None


# -------------------------
# Budgets & transactions (Member 3)
# -------------------------

class BudgetCreateRequest(BaseModel):
    total_amount: Decimal = Field(gt=0)
    cycle_start_date: date
    cycle_end_date: date
    budget_kind: str = "monthly"
    savings_percentage: Decimal = Field(default=Decimal("0"), ge=0, le=100)


class BudgetUpdateRequest(BaseModel):
    total_amount: Optional[Decimal] = Field(default=None, gt=0)
    cycle_end_date: Optional[date] = None


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
    created_at: datetime
    updated_at: datetime


class TransactionCreateRequest(BaseModel):
    item_name: str
    amount: Decimal = Field(gt=0)
    category: Optional[str] = None
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


# -------------------------
# Search (Member 4)
# -------------------------

class SearchResultItem(BaseModel):
    offer_id: int
    product_id: int
    product_name: str
    brand: Optional[str] = None
    category: Optional[str] = None
    colour: Optional[str] = None
    size: Optional[str] = None
    is_essential: bool
    store_id: int
    store_name: str
    store_type: str
    price: Decimal
    shipping_cost: Decimal
    total_cost: Decimal
    currency: str
    availability_status: str
    product_url: Optional[str] = None


class SearchResponse(BaseModel):
    results: List[SearchResultItem]
    count: int
    limit: int
    offset: int

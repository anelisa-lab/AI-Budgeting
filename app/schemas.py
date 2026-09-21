from pydantic import BaseModel, EmailStr
from typing import Optional, List
from datetime import datetime


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

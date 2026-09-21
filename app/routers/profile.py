from fastapi import APIRouter, HTTPException, Depends

from app.database import get_connection
from app.dependencies import get_current_user_id
from app.schemas import UserOut, UpdateProfileRequest, PreferencesOut, UpdatePreferencesRequest

router = APIRouter(prefix="/profile", tags=["profile"])


@router.get("/", response_model=UserOut)
def get_profile(user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name, email, created_at FROM users WHERE id = %s", (user_id,)
            )
            user = cur.fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        return UserOut(**user)
    finally:
        conn.close()


@router.put("/", response_model=UserOut)
def update_profile(payload: UpdateProfileRequest, user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET name = %s WHERE id = %s RETURNING id, name, email, created_at",
                (payload.name, user_id),
            )
            user = cur.fetchone()
        return UserOut(**user)
    finally:
        conn.close()


@router.get("/preferences", response_model=PreferencesOut)
def get_preferences(user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT preferred_categories, preferred_stores, max_distance_km
                   FROM preferences WHERE user_id = %s""",
                (user_id,),
            )
            prefs = cur.fetchone()
        return PreferencesOut(**prefs) if prefs else PreferencesOut()
    finally:
        conn.close()


@router.put("/preferences", response_model=PreferencesOut)
def update_preferences(payload: UpdatePreferencesRequest, user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """UPDATE preferences
                   SET preferred_categories = COALESCE(%s, preferred_categories),
                       preferred_stores     = COALESCE(%s, preferred_stores),
                       max_distance_km      = COALESCE(%s, max_distance_km),
                       updated_at           = NOW()
                   WHERE user_id = %s
                   RETURNING preferred_categories, preferred_stores, max_distance_km""",
                (payload.preferred_categories, payload.preferred_stores, payload.max_distance_km, user_id),
            )
            prefs = cur.fetchone()
        return PreferencesOut(**prefs)
    finally:
        conn.close()

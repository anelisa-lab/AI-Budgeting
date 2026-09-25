from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Response

from app.database import get_connection
from app.dependencies import get_current_user_id
from app.schemas import (
    LocationIn, LocationOut, PreferencesOut, UpdatePreferencesRequest, UpdateProfileRequest, UserOut,
)

router = APIRouter(prefix="/profile", tags=["profile"])


# Served at both /profile and /profile/. With only "/", a request to /profile
# got a 307 redirect, and browsers drop the Authorization header when that
# redirect crosses origins — so the frontend's call arrived unauthenticated.
@router.get("", response_model=UserOut)
@router.get("/", response_model=UserOut, include_in_schema=False)
def get_profile(user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT id, name, email, created_at,
                          residence_area_code AS residence, student_number
                   FROM users WHERE id = %s""",
                (user_id,),
            )
            user = cur.fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        return UserOut(**user)
    finally:
        conn.close()


@router.put("", response_model=UserOut)
@router.put("/", response_model=UserOut, include_in_schema=False)
def update_profile(payload: UpdateProfileRequest, user_id: int = Depends(get_current_user_id)):
    """
    Name always; residence and student number only when sent. An empty
    string clears either one. Returns the same fields as GET /profile, so
    saving a name doesn't make the frontend forget the other two.
    """
    sets, params = ["name = %s"], [payload.name]
    for field, column in (("residence", "residence_area_code"), ("student_number", "student_number")):
        if field in payload.model_fields_set:
            sets.append(f"{column} = %s")
            params.append(getattr(payload, field) or None)
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""UPDATE users SET {", ".join(sets)} WHERE id = %s
                    RETURNING id, name, email, created_at,
                              residence_area_code AS residence, student_number""",
                (*params, user_id),
            )
            user = cur.fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        return UserOut(**user)
    finally:
        conn.close()


# -------------------------
# Location — the origin for distance, proximity and travel cost
# -------------------------
# user_locations has been in the schema since Phase 1 and geo.fetch_user_location()
# reads it (search distance, recommender proximity, true-cost travel, basket
# travel), but nothing could write it, so every student had no location.

@router.get("/location", response_model=Optional[LocationOut])
def get_location(user_id: int = Depends(get_current_user_id)):
    """The student's default location, or null if they haven't set one."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT latitude, longitude, label, updated_at FROM user_locations
                   WHERE user_id = %s ORDER BY is_default DESC, id ASC LIMIT 1""",
                (user_id,),
            )
            row = cur.fetchone()
        return LocationOut(**row) if row else None
    finally:
        conn.close()


@router.put("/location", response_model=LocationOut)
def set_location(payload: LocationIn, user_id: int = Depends(get_current_user_id)):
    """Replace the student's default location."""
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("DELETE FROM user_locations WHERE user_id = %s AND is_default = TRUE", (user_id,))
            cur.execute(
                """INSERT INTO user_locations (user_id, label, latitude, longitude, is_default)
                   VALUES (%s, %s, %s, %s, TRUE)
                   RETURNING latitude, longitude, label, updated_at""",
                (user_id, payload.label, round(payload.latitude, 6), round(payload.longitude, 6)),
            )
            row = cur.fetchone()
        return LocationOut(**row)
    finally:
        conn.close()


@router.delete("/location", status_code=204)
def clear_location(user_id: int = Depends(get_current_user_id)):
    """Forget the student's location. Distance and travel go back to 'unknown'."""
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("DELETE FROM user_locations WHERE user_id = %s", (user_id,))
    finally:
        conn.close()
    return Response(status_code=204)


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
            # Upsert: accounts created outside /auth/register (e.g. seed data)
            # have no preferences row, and a plain UPDATE returned nothing -> 500.
            cur.execute(
                """INSERT INTO preferences (user_id, preferred_categories, preferred_stores, max_distance_km)
                   VALUES (%s, COALESCE(%s, '{}'::text[]), COALESCE(%s, '{}'::text[]), %s)
                   ON CONFLICT (user_id) DO UPDATE
                   SET preferred_categories = COALESCE(%s, preferences.preferred_categories),
                       preferred_stores     = COALESCE(%s, preferences.preferred_stores),
                       max_distance_km      = COALESCE(%s, preferences.max_distance_km),
                       updated_at           = NOW()
                   RETURNING preferred_categories, preferred_stores, max_distance_km""",
                (
                    user_id, payload.preferred_categories, payload.preferred_stores, payload.max_distance_km,
                    payload.preferred_categories, payload.preferred_stores, payload.max_distance_km,
                ),
            )
            prefs = cur.fetchone()
        return PreferencesOut(**prefs)
    finally:
        conn.close()

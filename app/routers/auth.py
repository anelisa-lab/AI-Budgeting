from fastapi import APIRouter, HTTPException, Depends, status

from app.database import get_connection
from app.security import hash_password, verify_password, create_access_token
from app.dependencies import get_current_user_id
from app.schemas import RegisterRequest, LoginRequest, AuthResponse, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest):
    if len(payload.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE email = %s", (payload.email,))
            if cur.fetchone():
                raise HTTPException(status_code=409, detail="An account with that email already exists")

            password_hash = hash_password(payload.password)
            cur.execute(
                """INSERT INTO users (name, email, password_hash)
                   VALUES (%s, %s, %s)
                   RETURNING id, name, email, created_at""",
                (payload.name, payload.email, password_hash),
            )
            user = cur.fetchone()

            # Give every new user an empty preferences row so the recommender never hits a missing row
            cur.execute("INSERT INTO preferences (user_id) VALUES (%s)", (user["id"],))

        token = create_access_token(user["id"])
        return AuthResponse(user=UserOut(**user), token=token)
    finally:
        conn.close()


@router.post("/login", response_model=AuthResponse)
def login(payload: LoginRequest):
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name, email, password_hash, created_at FROM users WHERE email = %s",
                (payload.email,),
            )
            user = cur.fetchone()

        # Same error for "no such user" and "wrong password" — don't leak which one it was
        if not user or not verify_password(payload.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid email or password")

        token = create_access_token(user["id"])
        return AuthResponse(
            user=UserOut(id=user["id"], name=user["name"], email=user["email"], created_at=user["created_at"]),
            token=token,
        )
    finally:
        conn.close()


@router.post("/logout")
def logout(user_id: int = Depends(get_current_user_id)):
    # JWTs are stateless, so "logout" just tells the client to discard the token.
    # This endpoint exists for a consistent API contract and a spot to add a
    # token-blacklist later if the team decides it's needed.
    return {"message": "Logged out. Discard the token on the client."}

import os
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
from passlib.context import CryptContext
from jose import jwt, JWTError

# Load .env here too, not only in database.py — otherwise JWT_SECRET is None
# whenever this module happens to be imported before app.database.
load_dotenv()

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

JWT_SECRET = os.getenv("JWT_SECRET")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_EXPIRES_MINUTES = int(os.getenv("JWT_EXPIRES_MINUTES", "10080"))  # 7 days


def _secret() -> str:
    if not JWT_SECRET:
        raise RuntimeError("JWT_SECRET is not set — copy .env.example to .env and fill it in")
    return JWT_SECRET


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    return pwd_context.verify(plain_password, password_hash)


def create_access_token(user_id: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRES_MINUTES)
    payload = {"sub": str(user_id), "exp": expire}
    return jwt.encode(payload, _secret(), algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> int:
    """Returns the user_id from a valid token, or raises JWTError."""
    payload = jwt.decode(token, _secret(), algorithms=[JWT_ALGORITHM])
    try:
        return int(payload["sub"])
    except (KeyError, TypeError, ValueError):
        # Signed by us but without a usable subject — treat as invalid, not a 500
        raise JWTError("Token has no valid subject")

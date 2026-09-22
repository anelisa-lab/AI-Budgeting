from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError

from app.database import get_connection
from app.security import decode_access_token

# auto_error=False so a missing header is answered with 401 (like a bad token),
# not HTTPBearer's default 403. The frontend signs the student out on 401 only,
# so a 403 here left them stuck on a screen that could never load.
bearer_scheme = HTTPBearer(auto_error=False)


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user_id(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> int:
    """
    Use this as a dependency on any route that needs a logged-in user:

        @router.get("/something")
        def handler(user_id: int = Depends(get_current_user_id)):
            ...

    Every failure is a 401 with `WWW-Authenticate: Bearer`: no header, a
    malformed or expired token, or a token for an account that no longer
    exists (which would otherwise surface later as a foreign-key 500).
    """
    if credentials is None or not credentials.credentials:
        raise _unauthorized("Not authenticated — send 'Authorization: Bearer <token>'")

    try:
        user_id = decode_access_token(credentials.credentials)
    except JWTError:
        raise _unauthorized("Invalid or expired token")

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM users WHERE id = %s", (user_id,))
            if cur.fetchone() is None:
                raise _unauthorized("This account no longer exists — please sign in again")
    finally:
        conn.close()

    return user_id

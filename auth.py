from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_DEV_DEFAULT = "aeyes-dev-secret-change-in-prod"
_ENV = os.environ.get("AEYES_ENV", "dev")
_SECRET = os.environ.get("JWT_SECRET", _DEV_DEFAULT)
if _ENV == "prod" and not os.environ.get("AEYES_SKIP_SECRET_CHECK"):
    if not _SECRET or _SECRET == _DEV_DEFAULT:
        raise RuntimeError(
            "JWT_SECRET must be set to a non-default value when AEYES_ENV=prod"
        )
_ALGO = "HS256"
_EXPIRY_HOURS = 24

_bearer = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def create_token(user_id: int, username: str) -> str:
    payload = {
        "sub": str(user_id),
        "username": username,
        "exp": datetime.now(timezone.utc) + timedelta(hours=_EXPIRY_HOURS),
    }
    return jwt.encode(payload, _SECRET, algorithm=_ALGO)


def _decode(token: str) -> dict:
    return jwt.decode(token, _SECRET, algorithms=[_ALGO])


async def require_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> dict:
    if not creds:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = _decode(creds.credentials)
        return {"id": int(payload["sub"]), "username": payload["username"]}
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


async def optional_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> Optional[dict]:
    if not creds:
        return None
    try:
        payload = _decode(creds.credentials)
        return {"id": int(payload["sub"]), "username": payload["username"]}
    except Exception:
        return None

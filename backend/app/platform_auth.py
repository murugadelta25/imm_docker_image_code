"""Platform super-admin auth — separate credentials from customer users."""
from __future__ import annotations

import os
from datetime import datetime, timedelta

from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from .auth import ALGORITHM, SECRET_KEY
from .platform_credentials import verify_platform_login

PLATFORM_TOKEN_EXPIRE_HOURS = int(os.getenv("PLATFORM_TOKEN_EXPIRE_HOURS", "8"))

platform_oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/platform/login", auto_error=True)


def verify_platform_credentials(username: str, password: str, db: Session) -> bool:
    return verify_platform_login(db, username, password)


def create_platform_token(username: str) -> str:
    expire = datetime.utcnow() + timedelta(hours=PLATFORM_TOKEN_EXPIRE_HOURS)
    payload = {
        "sub": username,
        "type": "platform_admin",
        "exp": expire,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_platform_admin(token: str = Depends(platform_oauth2_scheme)) -> str:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") != "platform_admin":
            raise HTTPException(status_code=401, detail="Invalid platform token")
        username = payload.get("sub")
        if not username:
            raise HTTPException(status_code=401, detail="Invalid platform token")
        return username
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid platform token")

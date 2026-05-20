"""Authentication endpoints: login page serving, password verification, logout."""

import os
import time

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

from ..auth_middleware import (
    COOKIE_NAME,
    COOKIE_MAX_AGE,
    make_session_cookie,
)

router = APIRouter(prefix="/auth", tags=["auth"])

APP_PASSWORD = os.environ.get("APP_PASSWORD", "")


class LoginRequest(BaseModel):
    password: str


@router.post("/verify")
async def verify_password(body: LoginRequest):
    """Verify password and set session cookie."""
    if not APP_PASSWORD:
        return JSONResponse(
            status_code=503,
            content={"detail": "APP_PASSWORD is not configured"},
        )

    if body.password != APP_PASSWORD:
        return JSONResponse(
            status_code=401,
            content={"detail": "パスワードが正しくありません"},
        )

    session_data = {
        "authenticated": True,
        "exp": int(time.time()) + COOKIE_MAX_AGE,
    }
    cookie_value = make_session_cookie(session_data)

    response = JSONResponse(content={"status": "ok"})
    response.set_cookie(
        key=COOKIE_NAME,
        value=cookie_value,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=True,
    )
    return response


@router.get("/logout")
async def logout():
    """Clear session cookie and redirect to login."""
    response = RedirectResponse(url="/login.html", status_code=302)
    response.delete_cookie(key=COOKIE_NAME)
    return response

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
    _get_client_ip,
)
from ..security import record_login_failure, clear_login_failures

router = APIRouter(prefix="/auth", tags=["auth"])

APP_PASSWORD = os.environ.get("APP_PASSWORD", "")


class LoginRequest(BaseModel):
    password: str


@router.post("/verify")
async def verify_password(body: LoginRequest, request: Request):
    """Verify password and set session cookie."""
    client_ip = _get_client_ip(request)

    if not APP_PASSWORD:
        return JSONResponse(
            status_code=503,
            content={"detail": "APP_PASSWORD is not configured"},
        )

    if body.password != APP_PASSWORD:
        record_login_failure(client_ip)
        return JSONResponse(
            status_code=401,
            content={"detail": "パスワードが正しくありません"},
        )

    # Successful login — clear failure records
    clear_login_failures(client_ip)

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


@router.get("/debug")
async def debug_info(request: Request):
    """Temporary debug endpoint to check IP and GeoIP."""
    from ..auth_middleware import _get_client_ip, _check_geo_jp, GEOIP_ENABLED
    client_ip = _get_client_ip(request)
    forwarded = request.headers.get("x-forwarded-for", "")
    is_jp = await _check_geo_jp(client_ip) if GEOIP_ENABLED else None
    return {
        "client_ip": client_ip,
        "x_forwarded_for": forwarded,
        "geoip_enabled": GEOIP_ENABLED,
        "is_jp": is_jp,
    }


@router.get("/logout")
async def logout():
    """Clear session cookie and redirect to login."""
    response = RedirectResponse(url="/login.html", status_code=302)
    response.delete_cookie(key=COOKIE_NAME)
    return response

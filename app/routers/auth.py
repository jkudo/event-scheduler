"""Authentication endpoints: login page serving, password verification, logout."""

import os
import time

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth_middleware import (
    COOKIE_NAME,
    COOKIE_MAX_AGE,
    make_session_cookie,
    _get_client_ip,
    is_setup_complete,
    mark_setup_complete,
)
from ..database import get_db
from ..models import AppSetting
from ..password import hash_password, verify_password as check_password, is_hashed
from ..security import record_login_failure, clear_login_failures

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    password: str


@router.post("/verify")
async def verify_password(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    """Verify password and set session cookie."""
    client_ip = _get_client_ip(request)

    # Environment variable takes precedence (plaintext comparison)
    if os.environ.get("APP_PASSWORD"):
        if body.password != os.environ["APP_PASSWORD"]:
            record_login_failure(client_ip)
            return JSONResponse(status_code=401, content={"detail": "パスワードが正しくありません"})
    else:
        row = db.query(AppSetting).filter(AppSetting.key == "login_password").first()
        stored = row.value if row and row.value else "password"
        if not check_password(body.password, stored):
            record_login_failure(client_ip)
            return JSONResponse(status_code=401, content={"detail": "パスワードが正しくありません"})
        # Migrate plaintext to hash on successful login
        if not is_hashed(stored):
            if row:
                row.value = hash_password(body.password)
            else:
                db.add(AppSetting(key="login_password", value=hash_password(body.password)))
            db.commit()

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


class SetupRequest(BaseModel):
    login_password: str
    admin_password: str
    app_title: str = ""
    timezone: str = "Asia/Tokyo"


@router.post("/setup")
def initial_setup(body: SetupRequest, db: Session = Depends(get_db)):
    """初期設定: ログインパスワード・管理者パスワード・アプリタイトルを保存"""
    if is_setup_complete():
        return JSONResponse(status_code=403, content={"detail": "初期設定は既に完了しています"})

    def _set(key: str, value: str):
        row = db.query(AppSetting).filter(AppSetting.key == key).first()
        if row:
            row.value = value
        else:
            db.add(AppSetting(key=key, value=value))

    _set("login_password", hash_password(body.login_password))
    _set("reset_password", hash_password(body.admin_password))
    if body.app_title:
        _set("app_title", body.app_title)
    if body.timezone:
        _set("timezone", body.timezone)
    _set("setup_completed", "1")
    db.commit()

    os.environ["APP_PASSWORD"] = body.login_password
    mark_setup_complete()
    from ..config import reload_tz
    reload_tz()

    return {"status": "ok"}


@router.get("/logout")
async def logout():
    """Clear session cookie and redirect to login."""
    response = RedirectResponse(url="/login.html", status_code=302)
    response.delete_cookie(key=COOKIE_NAME)
    return response

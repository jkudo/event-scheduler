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
    verify_session_cookie,
    _get_client_ip,
    is_setup_complete,
    mark_setup_complete,
    use_secure_cookie,
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

    role = None

    # --- 管理者パスワード（環境変数を優先） ---
    if os.environ.get("APP_PASSWORD"):
        if body.password == os.environ["APP_PASSWORD"]:
            role = "admin"
    else:
        row = db.query(AppSetting).filter(AppSetting.key == "login_password").first()
        stored = row.value if row and row.value else "password"
        if check_password(body.password, stored):
            role = "admin"
            # Migrate plaintext to hash on successful login
            if not is_hashed(stored):
                if row:
                    row.value = hash_password(body.password)
                else:
                    db.add(AppSetting(key="login_password", value=hash_password(body.password)))
                db.commit()

    # --- 閲覧用パスワード（設定されている場合のみ） ---
    if role is None:
        vrow = db.query(AppSetting).filter(AppSetting.key == "viewer_password").first()
        if vrow and vrow.value and check_password(body.password, vrow.value):
            role = "viewer"
            if not is_hashed(vrow.value):
                vrow.value = hash_password(body.password)
                db.commit()

    if role is None:
        record_login_failure(client_ip)
        return JSONResponse(status_code=401, content={"detail": "パスワードが正しくありません"})

    # Successful login — clear failure records
    clear_login_failures(client_ip)

    session_data = {
        "authenticated": True,
        "role": role,
        "exp": int(time.time()) + COOKIE_MAX_AGE,
    }
    cookie_value = make_session_cookie(session_data)

    response = JSONResponse(content={"status": "ok", "role": role})
    response.set_cookie(
        key=COOKIE_NAME,
        value=cookie_value,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=use_secure_cookie(request),
    )
    return response


class SetupRequest(BaseModel):
    login_password: str
    admin_password: str
    app_title: str = ""
    timezone: str = "Asia/Tokyo"


@router.post("/setup")
def initial_setup(body: SetupRequest, db: Session = Depends(get_db)):
    """初期設定: ログインパスワード・管理者パスワード・イベントタイトルを保存"""
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

    mark_setup_complete()
    from ..config import reload_tz
    reload_tz()

    return {"status": "ok"}


@router.get("/me")
async def me(request: Request):
    """現在のログイン状態とロールを返す（閲覧/管理の画面出し分け用）"""
    cookie = request.cookies.get(COOKIE_NAME)
    session = verify_session_cookie(cookie) if cookie else None
    if session is None:
        content = {"authenticated": False, "role": None}
    else:
        # 旧セッション（role未設定）は管理者として扱う
        content = {"authenticated": True, "role": session.get("role", "admin")}
    response = JSONResponse(content=content)
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/logout")
async def logout():
    """Clear session cookie and redirect to login."""
    response = RedirectResponse(url="/login.html", status_code=302)
    response.delete_cookie(key=COOKIE_NAME)
    return response

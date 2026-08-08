"""Application settings API: title, icon, password, etc."""

import json
import os
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import UPLOAD_DIR, reload_tz
from ..database import get_db
from ..password import hash_password, verify_password, is_hashed
from ..models import AppSetting, Session as SessionModel
from ..utils import save_upload

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Defaults
DEFAULTS = {
    "app_title": "Event Scheduler",
    "allow_overlap": "0",
}


def _get(db: Session, key: str) -> str:
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row:
        return row.value
    return DEFAULTS.get(key, "")


def _set(db: Session, key: str, value: str):
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))
    db.commit()


@router.get("/")
def get_settings(db: Session = Depends(get_db)):
    """Get all application settings."""
    # 全設定を1クエリで取得する
    rows = {r.key: r.value for r in db.query(AppSetting).all()}

    def g(key: str) -> str:
        v = rows.get(key)
        return v if v is not None else DEFAULTS.get(key, "")

    return {
        "app_title": g("app_title"),
        "app_icon": g("app_icon"),
        "allow_overlap": g("allow_overlap"),
        "session_categories": g("session_categories"),
        "custom_roles": g("custom_roles"),
        "category_role_links": g("category_role_links"),
        "group_role_links": g("group_role_links"),
        "travel_buffer_minutes": g("travel_buffer_minutes") or "10",
        "timezone": g("timezone") or "Asia/Tokyo",
        # 閲覧用パスワードは設定済みかどうかのみ返す（値は返さない）
        "viewer_password_set": "1" if rows.get("viewer_password") else "0",
    }


class UpdateSettingsRequest(BaseModel):
    app_title: str | None = None
    allow_overlap: str | None = None
    session_categories: str | None = None
    custom_roles: str | None = None
    category_role_links: str | None = None
    group_role_links: str | None = None
    travel_buffer_minutes: str | None = None
    timezone: str | None = None


@router.put("/")
def update_settings(body: UpdateSettingsRequest, db: Session = Depends(get_db)):
    """Update application settings."""
    if body.app_title is not None:
        _set(db, "app_title", body.app_title)
    if body.allow_overlap is not None:
        _set(db, "allow_overlap", body.allow_overlap)
    if body.session_categories is not None:
        _set(db, "session_categories", body.session_categories)
    if body.custom_roles is not None:
        _set(db, "custom_roles", body.custom_roles)
    if body.category_role_links is not None:
        _set(db, "category_role_links", body.category_role_links)
    if body.group_role_links is not None:
        _set(db, "group_role_links", body.group_role_links)
    if body.travel_buffer_minutes is not None:
        _set(db, "travel_buffer_minutes", body.travel_buffer_minutes)
    if body.timezone is not None:
        _set(db, "timezone", body.timezone)
        reload_tz()
    return {"status": "ok"}


def _remove_upload(path: str):
    """アップロード済みファイルを削除する（/uploads/ 配下のみ）"""
    if not path or not path.startswith("/uploads/"):
        return
    f = UPLOAD_DIR / Path(path).name
    # '/uploads/..' のような値でディレクトリを触らないよう、通常ファイルのみ削除する
    if f.is_file():
        f.unlink()


@router.post("/icon")
async def upload_app_icon(icon: UploadFile = File(...), db: Session = Depends(get_db)):
    """イベントタイトルの横に表示するアイコンを登録する"""
    if not icon.filename:
        raise HTTPException(status_code=400, detail="画像を選択してください")
    old = _get(db, "app_icon")
    path = await save_upload(icon, prefix="appicon_")
    _set(db, "app_icon", path)
    if old != path:
        _remove_upload(old)
    return {"status": "ok", "app_icon": path}


@router.delete("/icon")
def delete_app_icon(db: Session = Depends(get_db)):
    """イベントタイトルのアイコンを削除する"""
    old = _get(db, "app_icon")
    db.query(AppSetting).filter(AppSetting.key == "app_icon").delete()
    db.commit()
    _remove_upload(old)
    return {"status": "ok", "app_icon": ""}


class DeleteSessionCategoryRequest(BaseModel):
    key: str


@router.post("/session-categories/delete")
def delete_session_category(body: DeleteSessionCategoryRequest, db: Session = Depends(get_db)):
    """セッション形式を削除し、その形式のセッションは一般に戻す"""
    row = db.query(AppSetting).filter(AppSetting.key == "session_categories").first()
    try:
        cats = json.loads(row.value) if row and row.value else []
    except ValueError:
        cats = []
    if not any(c.get("key") == body.key for c in cats):
        raise HTTPException(status_code=404, detail="セッション形式が見つかりません")

    moved = db.query(SessionModel).filter(SessionModel.category == body.key).count()
    if moved:
        db.query(SessionModel).filter(SessionModel.category == body.key).update(
            {SessionModel.category: "general"}, synchronize_session=False
        )

    remaining = [c for c in cats if c.get("key") != body.key]
    if row:
        row.value = json.dumps(remaining, ensure_ascii=False)
    else:
        db.add(AppSetting(key="session_categories", value=json.dumps(remaining, ensure_ascii=False)))
    db.commit()
    return {"status": "ok", "moved_sessions": moved, "session_categories": remaining}


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password")
def change_password(body: ChangePasswordRequest, db: Session = Depends(get_db)):
    """Change the application login password."""
    if os.environ.get("APP_PASSWORD"):
        current = os.environ["APP_PASSWORD"]
        if body.current_password != current:
            raise HTTPException(status_code=403, detail="現在のパスワードが正しくありません")
    else:
        row = db.query(AppSetting).filter(AppSetting.key == "login_password").first()
        stored = row.value if row and row.value else "password"
        if not verify_password(body.current_password, stored):
            raise HTTPException(status_code=403, detail="現在のパスワードが正しくありません")

    _set(db, "login_password", hash_password(body.new_password))
    os.environ["APP_PASSWORD"] = body.new_password
    return {"status": "ok", "message": "パスワードを変更しました"}


class ViewerPasswordRequest(BaseModel):
    password: str


@router.post("/viewer-password")
def set_viewer_password(body: ViewerPasswordRequest, db: Session = Depends(get_db)):
    """閲覧用パスワードを設定・削除する（空文字で削除＝閲覧用ログイン無効）"""
    if body.password:
        _set(db, "viewer_password", hash_password(body.password))
        return {
            "status": "ok",
            "viewer_password_set": "1",
            "message": "閲覧用パスワードを設定しました",
        }
    db.query(AppSetting).filter(AppSetting.key == "viewer_password").delete()
    db.commit()
    return {
        "status": "ok",
        "viewer_password_set": "0",
        "message": "閲覧用パスワードを削除しました。閲覧用ログインは無効です",
    }

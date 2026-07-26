"""Application settings API: title, password, etc."""

import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import reload_tz
from ..database import get_db
from ..password import hash_password, verify_password, is_hashed
from ..models import AppSetting

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
    return {
        "app_title": _get(db, "app_title"),
        "allow_overlap": _get(db, "allow_overlap"),
        "session_categories": _get(db, "session_categories"),
        "custom_roles": _get(db, "custom_roles"),
        "category_role_links": _get(db, "category_role_links"),
        "group_role_links": _get(db, "group_role_links"),
        "travel_buffer_minutes": _get(db, "travel_buffer_minutes") or "10",
        "timezone": _get(db, "timezone") or "Asia/Tokyo",
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

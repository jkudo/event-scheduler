"""Application settings API: title, password, etc."""

import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import AppSetting

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Defaults
DEFAULTS = {
    "app_title": "カンファレンススケジューラー",
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
    }


class UpdateSettingsRequest(BaseModel):
    app_title: str | None = None
    allow_overlap: str | None = None


@router.put("/")
def update_settings(body: UpdateSettingsRequest, db: Session = Depends(get_db)):
    """Update application settings."""
    if body.app_title is not None:
        _set(db, "app_title", body.app_title)
    if body.allow_overlap is not None:
        _set(db, "allow_overlap", body.allow_overlap)
    return {"status": "ok"}


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password")
def change_password(body: ChangePasswordRequest):
    """Change the application login password."""
    app_password = os.environ.get("APP_PASSWORD", "")
    if app_password and body.current_password != app_password:
        raise HTTPException(status_code=403, detail="現在のパスワードが正しくありません")

    # Update environment variable (runtime only, persists until restart)
    os.environ["APP_PASSWORD"] = body.new_password
    return {"status": "ok", "message": "パスワードを変更しました（次回デプロイまで有効）"}

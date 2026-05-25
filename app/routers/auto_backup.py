"""Auto-backup configuration, history, and manual trigger endpoints."""

from datetime import datetime

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import BACKUP_DIR
from ..database import get_db
from ..models import AppSetting
from ..scheduler import scheduler_state, run_backup, _read_metadata, _write_metadata

router = APIRouter(prefix="/api/backup/auto", tags=["auto-backup"])


# --- Helpers ---
def _get(db: Session, key: str, default: str = "") -> str:
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    return row.value if row else default


def _set(db: Session, key: str, value: str):
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))


# --- Settings ---
class AutoBackupSettingsRequest(BaseModel):
    enabled: bool = False
    schedule_type: str = "interval"  # "interval" or "daily"
    interval_minutes: int = 720
    daily_time: str = "03:00"  # HH:MM
    retention_count: int = 28


@router.get("/settings")
def get_auto_backup_settings(db: Session = Depends(get_db)):
    return {
        "enabled": _get(db, "autobackup_enabled", "0") == "1",
        "schedule_type": _get(db, "autobackup_schedule_type", "interval"),
        "interval_minutes": int(_get(db, "autobackup_interval_minutes", "720")),
        "daily_time": _get(db, "autobackup_daily_time", "03:00"),
        "retention_count": int(_get(db, "autobackup_retention_count", "28")),
    }


@router.put("/settings")
def update_auto_backup_settings(body: AutoBackupSettingsRequest, db: Session = Depends(get_db)):
    interval = max(body.interval_minutes, 10)  # minimum 10 minutes
    retention = max(body.retention_count, 1)  # minimum 1
    _set(db, "autobackup_enabled", "1" if body.enabled else "0")
    _set(db, "autobackup_schedule_type", body.schedule_type)
    _set(db, "autobackup_interval_minutes", str(interval))
    _set(db, "autobackup_daily_time", body.daily_time)
    _set(db, "autobackup_retention_count", str(retention))
    db.commit()
    return {"status": "ok"}


# --- Manual trigger ---
@router.post("/run")
def trigger_backup_now():
    result = run_backup(trigger="manual")
    if result.get("status") == "error":
        return JSONResponse(status_code=500, content={"detail": result.get("error", "バックアップに失敗しました")})
    return result


# --- Status ---
@router.get("/status")
def get_backup_status(db: Session = Depends(get_db)):
    enabled = _get(db, "autobackup_enabled", "0") == "1"
    return {
        "enabled": enabled,
        "running": scheduler_state.get("running", False),
        "last_run": scheduler_state.get("last_result", {}).get("created_at") if scheduler_state.get("last_result") else None,
        "last_status": scheduler_state.get("last_result", {}).get("status") if scheduler_state.get("last_result") else None,
        "next_run": scheduler_state.get("next_run"),
        "error": scheduler_state.get("error"),
    }


# --- History ---
@router.get("/history")
def get_backup_history():
    metadata = _read_metadata()
    metadata.sort(key=lambda x: x["created_at"], reverse=True)
    return metadata


@router.get("/history/{backup_id}/download")
def download_backup(backup_id: str):
    metadata = _read_metadata()
    entry = next((e for e in metadata if e["id"] == backup_id), None)
    if not entry:
        return JSONResponse(status_code=404, content={"detail": "バックアップが見つかりません"})
    filepath = BACKUP_DIR / entry["filename"]
    if not filepath.exists():
        return JSONResponse(status_code=404, content={"detail": "ファイルが見つかりません"})
    return FileResponse(filepath, media_type="application/zip", filename=entry["filename"])


@router.delete("/history/{backup_id}")
def delete_backup(backup_id: str):
    metadata = _read_metadata()
    entry = next((e for e in metadata if e["id"] == backup_id), None)
    if not entry:
        return JSONResponse(status_code=404, content={"detail": "バックアップが見つかりません"})
    filepath = BACKUP_DIR / entry["filename"]
    if filepath.exists():
        filepath.unlink()
    metadata = [e for e in metadata if e["id"] != backup_id]
    _write_metadata(metadata)
    return {"status": "ok"}

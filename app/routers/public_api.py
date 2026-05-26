"""Public API: publish snapshots and serve timeline JSON to external sites."""

import json
import secrets
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload

from ..config import DATA_DIR, UPLOAD_DIR, now as app_now
from ..database import get_db
from ..models import AppSetting, Session as SessionModel, Room, SessionGroup, Category

SNAPSHOT_DIR = DATA_DIR / "public_snapshots"
SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
METADATA_FILE = SNAPSHOT_DIR / "metadata.json"

# --- Metadata helpers ---

def _read_metadata() -> list[dict]:
    if METADATA_FILE.exists():
        try:
            return json.loads(METADATA_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []
    return []


def _write_metadata(entries: list[dict]):
    METADATA_FILE.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")


# --- DB helpers ---

def _get(db: Session, key: str, default: str = "") -> str:
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    return row.value if row else default


def _set(db: Session, key: str, value: str):
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))


# =========================================================================
# Public endpoints (API-key auth, no session cookie)
# =========================================================================
public_router = APIRouter(tags=["public-api"])


def _validate_api_key(request: Request, db: Session):
    """Validate API key from query param or header."""
    enabled = _get(db, "public_api_enabled", "0")
    if enabled != "1":
        raise HTTPException(status_code=404, detail="Public API is disabled")
    stored_key = _get(db, "public_api_key", "")
    if not stored_key:
        raise HTTPException(status_code=404, detail="Public API is not configured")
    provided = request.query_params.get("key") or request.headers.get("x-api-key") or ""
    if not provided or provided != stored_key:
        raise HTTPException(status_code=401, detail="Invalid API key")


@public_router.get("/public/api/schedule/check")
def check_schedule_update(request: Request, db: Session = Depends(get_db)):
    """Lightweight endpoint: returns only snapshot ID and published_at for polling."""
    _validate_api_key(request, db)
    active_id = _get(db, "public_api_active_snapshot", "")
    if not active_id:
        return JSONResponse(content={"snapshot_id": None, "published_at": None})
    metadata = _read_metadata()
    entry = next((e for e in metadata if e["id"] == active_id), None)
    published_at = entry["published_at"] if entry else None
    response = JSONResponse(content={"snapshot_id": active_id, "published_at": published_at})
    response.headers["Cache-Control"] = "no-cache"
    return response


@public_router.get("/public/api/schedule")
def get_public_schedule(request: Request, db: Session = Depends(get_db)):
    _validate_api_key(request, db)

    active_id = _get(db, "public_api_active_snapshot", "")
    if not active_id:
        raise HTTPException(status_code=404, detail="No published schedule available")

    snapshot_path = SNAPSHOT_DIR / f"{active_id}.json"
    if not snapshot_path.exists():
        raise HTTPException(status_code=404, detail="Snapshot file not found")

    data = json.loads(snapshot_path.read_text(encoding="utf-8"))

    # Rewrite speaker_photo paths to public API photo URLs
    api_key = _get(db, "public_api_key", "")
    base = str(request.base_url).rstrip("/")
    _rewrite_photos(data, base, api_key)

    response = JSONResponse(content=data)
    response.headers["Cache-Control"] = "public, max-age=60"
    return response


def _rewrite_photos(data: dict, base_url: str, api_key: str):
    """Rewrite /uploads/xxx paths to /public/api/photo/xxx?key=... URLs."""
    for session in data.get("sessions", []):
        photo = session.get("speaker_photo", "")
        if photo:
            filename = photo.rsplit("/", 1)[-1] if "/" in photo else photo
            session["speaker_photo_url"] = f"{base_url}/public/api/photo/{filename}?key={api_key}"
        else:
            session["speaker_photo_url"] = ""
        for talk in session.get("lt_talks", []):
            tp = talk.get("speaker_photo", "")
            if tp:
                fn = tp.rsplit("/", 1)[-1] if "/" in tp else tp
                talk["speaker_photo_url"] = f"{base_url}/public/api/photo/{fn}?key={api_key}"
            else:
                talk["speaker_photo_url"] = ""


@public_router.get("/public/api/photo/{filename}")
def get_public_photo(filename: str, request: Request, db: Session = Depends(get_db)):
    _validate_api_key(request, db)

    # Path traversal prevention
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    filepath = UPLOAD_DIR / filename
    if not filepath.exists() or not filepath.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(filepath)


# =========================================================================
# Management endpoints (authenticated users + admin password)
# =========================================================================
admin_router = APIRouter(prefix="/api/public-api", tags=["public-api-admin"])


# --- Settings ---

class PublicApiSettingsRequest(BaseModel):
    enabled: bool = False
    cors_origins: str = "*"


@admin_router.get("/settings")
def get_public_api_settings(db: Session = Depends(get_db)):
    key = _get(db, "public_api_key", "")
    return {
        "enabled": _get(db, "public_api_enabled", "0") == "1",
        "key": key,
        "key_masked": (key[:4] + "..." + key[-4:]) if len(key) >= 8 else key,
        "cors_origins": _get(db, "public_api_cors_origins", "*"),
        "active_snapshot": _get(db, "public_api_active_snapshot", ""),
    }


@admin_router.put("/settings")
def update_public_api_settings(body: PublicApiSettingsRequest, db: Session = Depends(get_db)):
    _set(db, "public_api_enabled", "1" if body.enabled else "0")
    _set(db, "public_api_cors_origins", body.cors_origins)
    # Auto-generate key on first enable
    if body.enabled and not _get(db, "public_api_key", ""):
        _set(db, "public_api_key", secrets.token_hex(16))
    db.commit()
    return get_public_api_settings(db)


@admin_router.post("/settings/regenerate-key")
def regenerate_api_key(db: Session = Depends(get_db)):
    new_key = secrets.token_hex(16)
    _set(db, "public_api_key", new_key)
    db.commit()
    return {"key": new_key, "key_masked": new_key[:4] + "..." + new_key[-4:]}


# --- Publish ---

@admin_router.post("/publish")
def publish_snapshot(db: Session = Depends(get_db)):
    """Create a snapshot of current schedule data."""
    now = app_now()
    snapshot_id = now.strftime("%Y%m%d_%H%M%S")

    # Build snapshot data
    app_title_row = db.query(AppSetting).filter(AppSetting.key == "app_title").first()
    event_title = app_title_row.value if app_title_row and app_title_row.value else "Event Scheduler"

    groups = [
        {"id": g.id, "label": g.label, "date": g.date, "order": g.order, "color": g.color}
        for g in db.query(SessionGroup).order_by(SessionGroup.order, SessionGroup.id).all()
    ]
    rooms = [
        {"id": r.id, "name": r.name, "capacity": r.capacity, "floor": r.floor}
        for r in db.query(Room).order_by(Room.id).all()
    ]
    categories = [
        {"key": c.key, "label": c.label, "color": c.color, "order": c.order}
        for c in db.query(Category).order_by(Category.order, Category.id).all()
    ]

    sessions_q = (
        db.query(SessionModel)
        .options(joinedload(SessionModel.room), joinedload(SessionModel.lt_talks))
        .order_by(SessionModel.start_time)
        .all()
    )
    sessions = []
    for s in sessions_q:
        sessions.append({
            "id": s.id,
            "title": s.title,
            "description": s.description or "",
            "speaker": s.speaker,
            "speaker_kana": s.speaker_kana or "",
            "speaker_org": s.speaker_org or "",
            "speaker_title": s.speaker_title or "",
            "speaker_profile": s.speaker_profile or "",
            "speaker_photo": s.speaker_photo or "",
            "start_time": s.start_time.isoformat() if s.start_time else "",
            "end_time": s.end_time.isoformat() if s.end_time else "",
            "room_id": s.room_id,
            "room_name": s.room.name if s.room else "",
            "category": s.category or "general",
            "group_id": s.group_id,
            "lt_talks": [
                {
                    "title": t.title,
                    "speaker": t.speaker,
                    "speaker_kana": t.speaker_kana or "",
                    "speaker_org": t.speaker_org or "",
                    "speaker_title": t.speaker_title or "",
                    "speaker_photo": t.speaker_photo or "",
                    "start_time": t.start_time or "",
                    "end_time": t.end_time or "",
                    "order": t.order,
                }
                for t in (s.lt_talks or [])
            ],
        })

    snapshot = {
        "snapshot_id": snapshot_id,
        "event_title": event_title,
        "published_at": now.isoformat(),
        "groups": groups,
        "rooms": rooms,
        "categories": categories,
        "sessions": sessions,
    }

    # Save snapshot file
    snapshot_path = SNAPSHOT_DIR / f"{snapshot_id}.json"
    snapshot_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")

    # Update metadata
    metadata = _read_metadata()
    metadata.append({
        "id": snapshot_id,
        "published_at": now.isoformat(),
        "session_count": len(sessions),
    })
    _write_metadata(metadata)

    # Set as active
    _set(db, "public_api_active_snapshot", snapshot_id)
    db.commit()

    return {
        "status": "ok",
        "snapshot_id": snapshot_id,
        "published_at": now.isoformat(),
        "session_count": len(sessions),
    }


@admin_router.get("/history")
def get_publish_history(db: Session = Depends(get_db)):
    metadata = _read_metadata()
    active_id = _get(db, "public_api_active_snapshot", "")
    for entry in metadata:
        entry["active"] = entry["id"] == active_id
    metadata.sort(key=lambda x: x["published_at"], reverse=True)
    return metadata


@admin_router.post("/activate/{snapshot_id}")
def activate_snapshot(snapshot_id: str, db: Session = Depends(get_db)):
    snapshot_path = SNAPSHOT_DIR / f"{snapshot_id}.json"
    if not snapshot_path.exists():
        raise HTTPException(status_code=404, detail="スナップショットが見つかりません")
    _set(db, "public_api_active_snapshot", snapshot_id)
    db.commit()
    return {"status": "ok", "active_snapshot": snapshot_id}


@admin_router.delete("/history/{snapshot_id}")
def delete_snapshot(snapshot_id: str, db: Session = Depends(get_db)):
    active_id = _get(db, "public_api_active_snapshot", "")
    if snapshot_id == active_id:
        raise HTTPException(status_code=400, detail="アクティブなスナップショットは削除できません")

    snapshot_path = SNAPSHOT_DIR / f"{snapshot_id}.json"
    if snapshot_path.exists():
        snapshot_path.unlink()

    metadata = _read_metadata()
    metadata = [e for e in metadata if e["id"] != snapshot_id]
    _write_metadata(metadata)
    return {"status": "ok"}

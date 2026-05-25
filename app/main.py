import json
import shutil
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from .config import UPLOAD_DIR
from .database import Base, engine, SessionLocal
from .models import (
    Room, Session as SessionModel, LTTalk, Staff, StaffSkill,
    StaffPreferredSession, StaffAvailability, VenueMap, Assignment, Category, SessionGroup,
    AppSetting,
)
from .routers import rooms, sessions, staffs, assignments, venue_maps, export, backup, auth, settings, categories, session_groups, auto_backup

Base.metadata.create_all(bind=engine)

# --- Auto-migration: add missing columns to existing tables ---
from sqlalchemy import text as sa_text

def _auto_migrate():
    """Add columns that exist in models but not in the DB (simple ALTER TABLE ADD COLUMN)."""
    with engine.connect() as conn:
        for table in Base.metadata.sorted_tables:
            # Check if table exists
            res = conn.execute(sa_text(
                f"SELECT name FROM sqlite_master WHERE type='table' AND name='{table.name}'"
            ))
            if not res.fetchone():
                continue
            # Get existing columns via PRAGMA
            pragma = conn.execute(sa_text(f"PRAGMA table_info({table.name})"))
            existing = {row[1] for row in pragma.fetchall()}
            for col in table.columns:
                if col.name not in existing:
                    col_type = col.type.compile(engine.dialect)
                    stmt = f"ALTER TABLE {table.name} ADD COLUMN {col.name} {col_type}"
                    print(f"[migration] {stmt}")
                    conn.execute(sa_text(stmt))
                    conn.commit()
                    print(f"[migration] OK: added {table.name}.{col.name}")
                    # Set default value for new text columns (ALTER TABLE adds NULL)
                    if str(col_type).upper() in ("VARCHAR", "TEXT", "STRING"):
                        conn.execute(sa_text(
                            f"UPDATE {table.name} SET {col.name} = '' WHERE {col.name} IS NULL"
                        ))
                        conn.commit()

try:
    _auto_migrate()
    print("[migration] Auto-migration complete")
except Exception as e:
    print(f"[migration] ERROR: {e}")
    import traceback
    traceback.print_exc()

import asyncio
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    from .scheduler import backup_scheduler_loop
    task = asyncio.create_task(backup_scheduler_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

app = FastAPI(title="Conference Scheduler API", version="1.0.0", lifespan=lifespan)

from starlette.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=500)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Security: headers + rate limiting + auth
from .security import SecurityHeadersMiddleware, RateLimitMiddleware
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RateLimitMiddleware)

import os
from .auth_middleware import AuthMiddleware
app.add_middleware(AuthMiddleware)

app.include_router(auth.router)
app.include_router(rooms.router)
app.include_router(sessions.router)
app.include_router(staffs.router)
app.include_router(assignments.router)
app.include_router(venue_maps.router)
app.include_router(export.router)
app.include_router(backup.router)
app.include_router(settings.router)
app.include_router(categories.router)
app.include_router(session_groups.router)
app.include_router(auto_backup.router)


def _seed_all():
    """初期データ投入: seed/data.json + デフォルトカテゴリ + デフォルトセッショングループ"""
    db = SessionLocal()
    try:
        # --- デフォルトカテゴリ ---
        if db.query(Category).count() == 0:
            db.add(Category(key="reception", label="受付案内", color="#388e3c", order=1))
            db.add(Category(key="social", label="懇親会", color="#7b1fa2", order=2))
            db.commit()

        # --- デフォルトセッショングループ ---
        if db.query(SessionGroup).count() == 0:
            grp = SessionGroup(label="Day 1", date="", order=1, color="#1a73e8")
            db.add(grp)
            db.commit()

        # --- seed/data.json からの初期データ ---
        seed_dir = Path(__file__).resolve().parent.parent / "seed"
        seed_file = seed_dir / "data.json"
        if not seed_file.exists():
            return
        if db.query(Room).count() > 0:
            return

        with open(seed_file, encoding="utf-8") as f:
            data = json.load(f)
        if "rooms" not in data:
            return

        seed_uploads = seed_dir / "uploads"
        file_path_map: dict[str, str] = {}
        if seed_uploads.exists():
            for src_file in seed_uploads.iterdir():
                if src_file.is_file():
                    ext = src_file.suffix.lower()
                    new_name = f"{uuid.uuid4().hex}{ext}"
                    shutil.copy2(src_file, UPLOAD_DIR / new_name)
                    file_path_map[f"/uploads/{src_file.name}"] = f"/uploads/{new_name}"

        def _map_path(original: str) -> str:
            if not original:
                return ""
            return file_path_map.get(original, original)

        room_map = {}
        session_map = {}
        staff_map = {}

        for r in data.get("rooms", []):
            db_room = Room(name=r["name"], capacity=r["capacity"], floor=r.get("floor", 1))
            db.add(db_room)
            db.flush()
            room_map[r["id"]] = db_room.id

        for v in data.get("venue_maps", []):
            db.add(VenueMap(
                title=v["title"], image=_map_path(v.get("image", "")), order=v.get("order", 0),
            ))

        for s in data.get("sessions", []):
            new_room_id = room_map.get(s["room_id"], s["room_id"])
            db_sess = SessionModel(
                title=s["title"], description=s.get("description", ""),
                notes=s.get("notes", ""), speaker=s["speaker"],
                speaker_kana=s.get("speaker_kana", ""),
                speaker_photo=_map_path(s.get("speaker_photo", "")),
                speaker_org=s.get("speaker_org", ""),
                speaker_title=s.get("speaker_title", ""),
                speaker_profile=s.get("speaker_profile", ""),
                start_time=datetime.fromisoformat(s["start_time"]),
                end_time=datetime.fromisoformat(s["end_time"]),
                room_id=new_room_id,
                required_staff=s.get("required_staff", 1),
                category=s.get("category", "general"),
                english_required=s.get("english_required", 0),
            )
            db.add(db_sess)
            db.flush()
            session_map[s["id"]] = db_sess.id
            for t in s.get("lt_talks", []):
                db.add(LTTalk(
                    session_id=db_sess.id, title=t["title"], speaker=t["speaker"],
                    speaker_kana=t.get("speaker_kana", ""),
                    speaker_org=t.get("speaker_org", ""),
                    speaker_title=t.get("speaker_title", ""),
                    order=t.get("order", 0),
                ))

        for st in data.get("staffs", []):
            db_staff = Staff(
                name=st["name"], slack_name=st.get("slack_name", ""),
                photo=_map_path(st.get("photo", "")),
                english_ok=st.get("english_ok", 0),
                role=st.get("role", "general"),
                max_hours=st.get("max_hours", 8),
                experience_count=st.get("experience_count", 0),
            )
            db.add(db_staff)
            db.flush()
            staff_map[st["id"]] = db_staff.id
            for skill in st.get("skills", []):
                db.add(StaffSkill(staff_id=db_staff.id, skill=skill))
            for p in st.get("preferred_sessions", []):
                new_sess_id = session_map.get(p["session_id"])
                if new_sess_id:
                    db.add(StaffPreferredSession(
                        staff_id=db_staff.id, session_id=new_sess_id, priority=p["priority"],
                    ))
            for a in st.get("availabilities", []):
                db.add(StaffAvailability(
                    staff_id=db_staff.id,
                    start_time=datetime.fromisoformat(a["start_time"]),
                    end_time=datetime.fromisoformat(a["end_time"]),
                ))

        for a in data.get("assignments", []):
            new_sess_id = session_map.get(a["session_id"])
            new_staff_id = staff_map.get(a["staff_id"])
            if new_sess_id and new_staff_id:
                db.add(Assignment(
                    session_id=new_sess_id, staff_id=new_staff_id, role=a.get("role", "support"),
                ))

        db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


_seed_all()

@app.get("/login.html", response_class=HTMLResponse)
def login_page():
    db = SessionLocal()
    try:
        row = db.query(AppSetting).filter(AppSetting.key == "app_title").first()
        title = row.value if row and row.value else "Conference Scheduler"
    finally:
        db.close()
    html = Path("frontend/login.html").read_text(encoding="utf-8")
    html = html.replace("{{APP_TITLE}}", title)
    return HTMLResponse(content=html)


app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")

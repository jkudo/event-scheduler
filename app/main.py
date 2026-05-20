import json
import shutil
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import UPLOAD_DIR
from .database import Base, engine, SessionLocal
from .models import (
    Room, Session as SessionModel, LTTalk, Staff, StaffSkill,
    StaffPreferredSession, StaffAvailability, VenueMap, Assignment,
)
from .routers import rooms, sessions, staffs, assignments, venue_maps, export

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Conference Scheduler API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(rooms.router)
app.include_router(sessions.router)
app.include_router(staffs.router)
app.include_router(assignments.router)
app.include_router(venue_maps.router)
app.include_router(export.router)


def _seed_initial_data():
    """seed/data.json が存在し、DB が空なら初期データを投入する"""
    seed_dir = Path("seed")
    seed_file = seed_dir / "data.json"
    if not seed_file.exists():
        return

    db = SessionLocal()
    try:
        if db.query(Room).count() > 0:
            return

        with open(seed_file, encoding="utf-8") as f:
            data = json.load(f)

        if "rooms" not in data:
            return

        # seed/uploads/ の画像を UPLOAD_DIR にコピー
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


_seed_initial_data()

app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")

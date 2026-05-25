"""Backup, restore, and reset endpoints."""

import io
import json
import os
import shutil
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, UploadFile, File
from pydantic import BaseModel
from fastapi.responses import StreamingResponse, JSONResponse
from sqlalchemy.orm import Session, joinedload

from ..config import UPLOAD_DIR
from ..database import get_db
from ..models import (
    Session as SessionModel, Staff, Assignment, Room, VenueMap,
    LTTalk, StaffSkill, StaffPreferredSession, StaffAvailability, Category, SessionGroup,
    AppSetting,
)

router = APIRouter(prefix="/api/export", tags=["export"])


def _dt_str(dt: datetime | None) -> str:
    return dt.isoformat() if dt else ""


@router.get("/backup")
def export_backup(db: Session = Depends(get_db)):
    """全データを ZIP でエクスポート（data.json + 画像ファイル）"""
    rooms = db.query(Room).order_by(Room.id).all()
    venue_maps = db.query(VenueMap).order_by(VenueMap.id).all()
    sessions = (
        db.query(SessionModel)
        .options(joinedload(SessionModel.lt_talks))
        .order_by(SessionModel.id)
        .all()
    )
    staffs = (
        db.query(Staff)
        .options(
            joinedload(Staff.skills),
            joinedload(Staff.preferred_sessions),
            joinedload(Staff.availabilities),
        )
        .order_by(Staff.id)
        .all()
    )
    assignments = db.query(Assignment).order_by(Assignment.id).all()
    categories = db.query(Category).order_by(Category.order, Category.id).all()
    session_groups = db.query(SessionGroup).order_by(SessionGroup.order, SessionGroup.id).all()
    app_settings = db.query(AppSetting).all()

    data = {
        "version": 4,
        "exported_at": datetime.now().isoformat(),
        "categories": [
            {"id": c.id, "key": c.key, "label": c.label, "color": c.color, "order": c.order}
            for c in categories
        ],
        "session_groups": [
            {"id": g.id, "label": g.label, "date": g.date, "order": g.order, "color": g.color}
            for g in session_groups
        ],
        "rooms": [
            {"id": r.id, "name": r.name, "capacity": r.capacity, "floor": r.floor}
            for r in rooms
        ],
        "venue_maps": [
            {"id": v.id, "title": v.title, "order": v.order, "image": v.image}
            for v in venue_maps
        ],
        "sessions": [
            {
                "id": s.id, "title": s.title, "description": s.description,
                "notes": s.notes, "speaker": s.speaker,
                "speaker_kana": s.speaker_kana,
                "speaker_org": s.speaker_org, "speaker_title": s.speaker_title,
                "speaker_profile": s.speaker_profile,
                "speaker_photo": s.speaker_photo,
                "start_time": _dt_str(s.start_time), "end_time": _dt_str(s.end_time),
                "room_id": s.room_id, "required_staff": s.required_staff,
                "category": s.category, "english_required": s.english_required,
                "group_id": s.group_id,
                "lt_talks": [
                    {
                        "id": t.id, "title": t.title, "speaker": t.speaker,
                        "speaker_kana": t.speaker_kana,
                        "speaker_org": t.speaker_org,
                        "speaker_title": t.speaker_title,
                        "speaker_photo": t.speaker_photo,
                        "start_time": t.start_time,
                        "end_time": t.end_time,
                        "order": t.order,
                    }
                    for t in s.lt_talks
                ],
            }
            for s in sessions
        ],
        "staffs": [
            {
                "id": st.id, "name": st.name, "slack_name": st.slack_name,
                "photo": st.photo,
                "english_ok": st.english_ok, "role": st.role,
                "max_hours": st.max_hours, "experience_count": st.experience_count,
                "skills": [sk.skill for sk in st.skills],
                "preferred_sessions": [
                    {"session_id": p.session_id, "priority": p.priority}
                    for p in st.preferred_sessions
                ],
                "availabilities": [
                    {"start_time": _dt_str(a.start_time), "end_time": _dt_str(a.end_time)}
                    for a in st.availabilities
                ],
            }
            for st in staffs
        ],
        "assignments": [
            {"id": a.id, "session_id": a.session_id, "staff_id": a.staff_id, "role": a.role}
            for a in assignments
        ],
        "settings": [
            {"key": s.key, "value": s.value}
            for s in app_settings
        ],
    }

    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as zf:
        # data.json
        zf.writestr("data.json", json.dumps(data, ensure_ascii=False, indent=2))
        # 画像ファイルを uploads/ に格納
        if UPLOAD_DIR.exists():
            for file_path in UPLOAD_DIR.iterdir():
                if file_path.is_file():
                    zf.write(file_path, f"uploads/{file_path.name}")

    stream.seek(0)
    now = datetime.now().strftime("%Y%m%d_%H%M")
    filename = f"conf_backup_{now}.zip"

    return StreamingResponse(
        stream,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.post("/restore")
async def import_backup(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """ZIP バックアップから全データを復元（既存データは全削除）"""
    raw = await file.read()
    buf = io.BytesIO(raw)

    # ZIP を展開して data.json を読み取る
    try:
        with zipfile.ZipFile(buf, "r") as zf:
            if "data.json" not in zf.namelist():
                return JSONResponse(status_code=400, content={"detail": "data.json が見つかりません"})
            data = json.loads(zf.read("data.json").decode("utf-8"))

            # uploads/ 内の画像ファイルを一時的にメモリに保持
            image_files: dict[str, bytes] = {}
            for name in zf.namelist():
                if name.startswith("uploads/") and not name.endswith("/"):
                    image_files[name] = zf.read(name)
    except zipfile.BadZipFile:
        return JSONResponse(status_code=400, content={"detail": "無効な ZIP ファイルです"})
    except Exception:
        return JSONResponse(status_code=400, content={"detail": "バックアップの読み込みに失敗しました"})

    if "rooms" not in data:
        return JSONResponse(status_code=400, content={"detail": "バックアップ形式が正しくありません"})

    try:
        # --- 既存データ全削除 ---
        db.query(Assignment).delete()
        db.query(StaffAvailability).delete()
        db.query(StaffPreferredSession).delete()
        db.query(StaffSkill).delete()
        db.query(Staff).delete()
        db.query(LTTalk).delete()
        db.query(SessionModel).delete()
        db.query(SessionGroup).delete()
        db.query(Category).delete()
        db.query(VenueMap).delete()
        db.query(Room).delete()
        db.query(AppSetting).filter(AppSetting.key != "reset_password").delete()
        db.flush()

        # --- uploads ディレクトリをクリア＆画像ファイルを復元 ---
        if UPLOAD_DIR.exists():
            shutil.rmtree(UPLOAD_DIR)
        UPLOAD_DIR.mkdir(exist_ok=True)

        # ZIP 内のファイル名 → 新ファイル名のマッピング
        file_path_map: dict[str, str] = {}
        for zip_path, content in image_files.items():
            original_name = Path(zip_path).name
            ext = Path(original_name).suffix.lower()
            new_name = f"{uuid.uuid4().hex}{ext}"
            (UPLOAD_DIR / new_name).write_bytes(content)
            file_path_map[f"/uploads/{original_name}"] = f"/uploads/{new_name}"

        def _map_path(original: str) -> str:
            """バックアップ内のパスを復元後のパスに変換"""
            if not original:
                return ""
            return file_path_map.get(original, original)

        # ID マッピング (旧ID → 新ID)
        room_map = {}
        session_map = {}
        staff_map = {}
        group_map = {}

        # --- カテゴリ ---
        for c in data.get("categories", []):
            db.add(Category(key=c["key"], label=c["label"], color=c.get("color", "#1a73e8"), order=c.get("order", 0)))
        db.flush()

        # --- セッショングループ ---
        for g in data.get("session_groups", []):
            db_grp = SessionGroup(label=g["label"], date=g.get("date", ""), order=g.get("order", 0), color=g.get("color", "#1a73e8"))
            db.add(db_grp)
            db.flush()
            group_map[g["id"]] = db_grp.id

        # --- 部屋 ---
        for r in data.get("rooms", []):
            db_room = Room(name=r["name"], capacity=r["capacity"], floor=r.get("floor", 1))
            db.add(db_room)
            db.flush()
            room_map[r["id"]] = db_room.id

        # --- 会場地図 ---
        for v in data.get("venue_maps", []):
            db.add(VenueMap(
                title=v["title"], image=_map_path(v.get("image", "")), order=v.get("order", 0),
            ))

        # --- セッション ---
        for s in data.get("sessions", []):
            new_room_id = room_map.get(s["room_id"], s["room_id"])
            new_group_id = group_map.get(s.get("group_id")) if s.get("group_id") else None
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
                group_id=new_group_id,
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
                    speaker_photo=_map_path(t.get("speaker_photo", "")),
                    start_time=t.get("start_time", ""),
                    end_time=t.get("end_time", ""),
                    order=t.get("order", 0),
                ))

        # --- スタッフ ---
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

        # --- 配置 ---
        for a in data.get("assignments", []):
            new_sess_id = session_map.get(a["session_id"])
            new_staff_id = staff_map.get(a["staff_id"])
            if new_sess_id and new_staff_id:
                db.add(Assignment(
                    session_id=new_sess_id, staff_id=new_staff_id, role=a.get("role", "support"),
                ))

        # --- 設定 (reset_password はバックアップから上書きしない) ---
        for s in data.get("settings", []):
            if s["key"] == "reset_password":
                continue
            existing = db.query(AppSetting).filter(AppSetting.key == s["key"]).first()
            if existing:
                existing.value = s["value"]
            else:
                db.add(AppSetting(key=s["key"], value=s["value"]))

        db.commit()

        return {
            "status": "ok",
            "rooms": len(room_map),
            "sessions": len(session_map),
            "staffs": len(staff_map),
            "assignments": len(data.get("assignments", [])),
        }
    except Exception as e:
        db.rollback()
        import traceback
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"detail": f"復元に失敗しました: {str(e)}"})


RESET_PASSWORD_DEFAULT = os.environ.get("RESET_PASSWORD", "password")


def _get_reset_password(db: Session) -> str:
    """環境変数 > DB設定 > デフォルト の優先順で初期化パスワードを取得"""
    if os.environ.get("RESET_PASSWORD"):
        return os.environ["RESET_PASSWORD"]
    row = db.query(AppSetting).filter(AppSetting.key == "reset_password").first()
    if row and row.value:
        return row.value
    return RESET_PASSWORD_DEFAULT


class ResetRequest(BaseModel):
    password: str


@router.post("/reset")
def reset_all_data(body: ResetRequest, db: Session = Depends(get_db)):
    """全データを削除して初期化する（パスワード必須）"""
    if body.password != _get_reset_password(db):
        return JSONResponse(status_code=403, content={"detail": "パスワードが正しくありません"})

    try:
        db.query(Assignment).delete()
        db.query(StaffAvailability).delete()
        db.query(StaffPreferredSession).delete()
        db.query(StaffSkill).delete()
        db.query(Staff).delete()
        db.query(LTTalk).delete()
        db.query(SessionModel).delete()
        db.query(SessionGroup).delete()
        db.query(Category).delete()
        db.query(VenueMap).delete()
        db.query(Room).delete()
        db.query(AppSetting).filter(AppSetting.key == "app_title").delete()
        db.flush()

        # uploads ディレクトリをクリア
        if UPLOAD_DIR.exists():
            shutil.rmtree(UPLOAD_DIR)
        UPLOAD_DIR.mkdir(exist_ok=True)

        db.commit()
        return {"status": "ok", "message": "全データを初期化しました"}
    except Exception as e:
        db.rollback()
        import traceback
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"detail": f"初期化に失敗しました: {str(e)}"})


class ChangeResetPasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/reset-password")
def change_reset_password(body: ChangeResetPasswordRequest, db: Session = Depends(get_db)):
    """初期化パスワードを変更する"""
    if body.current_password != _get_reset_password(db):
        return JSONResponse(status_code=403, content={"detail": "現在のパスワードが正しくありません"})
    if not body.new_password:
        return JSONResponse(status_code=400, content={"detail": "新しいパスワードを入力してください"})
    row = db.query(AppSetting).filter(AppSetting.key == "reset_password").first()
    if row:
        row.value = body.new_password
    else:
        db.add(AppSetting(key="reset_password", value=body.new_password))
    db.commit()
    return {"status": "ok", "message": "初期化パスワードを変更しました"}

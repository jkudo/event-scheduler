import uuid
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload

from ..config import UPLOAD_DIR
from ..database import get_db
from ..models import Session as SessionModel, Room, LTTalk, Staff, StaffAvailability
from ..schemas import SessionCreate, SessionResponse, LTTalkCreate, LTTalkResponse


def _parse_dt(value: str) -> datetime:
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return datetime.fromisoformat(value)

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.get("/", response_model=list[SessionResponse])
def list_sessions(db: Session = Depends(get_db)):
    return db.query(SessionModel).options(joinedload(SessionModel.room), joinedload(SessionModel.lt_talks)).order_by(SessionModel.start_time).all()


@router.post("/", response_model=SessionResponse, status_code=201)
async def create_session(
    title: str = Form(...),
    speaker: str = Form(...),
    start_time: str = Form(...),
    end_time: str = Form(...),
    room_id: int = Form(...),
    description: str = Form(""),
    notes: str = Form(""),
    speaker_kana: str = Form(""),
    speaker_org: str = Form(""),
    speaker_title: str = Form(""),
    speaker_profile: str = Form(""),
    required_staff: int = Form(1),
    category: str = Form("general"),
    english_required: bool = Form(False),
    speaker_photo: UploadFile | None = File(None),
    db: Session = Depends(get_db),
):
    photo_path = ""
    if speaker_photo and speaker_photo.filename:
        ext = Path(speaker_photo.filename).suffix.lower()
        if ext not in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
            raise HTTPException(status_code=400, detail="対応していない画像形式です。jpg, png, gif, webp のみ対応しています。")
        filename = f"{uuid.uuid4().hex}{ext}"
        save_path = UPLOAD_DIR / filename
        content = await speaker_photo.read()
        save_path.write_bytes(content)
        photo_path = f"/uploads/{filename}"

    db_session = SessionModel(
        title=title,
        description=description,
        notes=notes,
        speaker=speaker,
        speaker_kana=speaker_kana,
        speaker_photo=photo_path,
        speaker_org=speaker_org,
        speaker_title=speaker_title,
        speaker_profile=speaker_profile,
        start_time=_parse_dt(start_time),
        end_time=_parse_dt(end_time),
        room_id=room_id,
        required_staff=required_staff,
        category=category,
        english_required=int(english_required),
    )
    db.add(db_session)
    db.commit()
    db.refresh(db_session)
    db.refresh(db_session, ["room", "lt_talks"])
    return db_session


@router.get("/{session_id}", response_model=SessionResponse)
def get_session(session_id: int, db: Session = Depends(get_db)):
    session = db.query(SessionModel).options(joinedload(SessionModel.room), joinedload(SessionModel.lt_talks)).filter(SessionModel.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.put("/{session_id}", response_model=SessionResponse)
async def update_session(
    session_id: int,
    title: str = Form(...),
    speaker: str = Form(...),
    start_time: str = Form(...),
    end_time: str = Form(...),
    room_id: int = Form(...),
    description: str = Form(""),
    notes: str = Form(""),
    speaker_kana: str = Form(""),
    speaker_org: str = Form(""),
    speaker_title: str = Form(""),
    speaker_profile: str = Form(""),
    required_staff: int = Form(1),
    category: str = Form("general"),
    english_required: bool = Form(False),
    speaker_photo: UploadFile | None = File(None),
    db: Session = Depends(get_db),
):
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    session.title = title
    session.speaker = speaker
    session.speaker_kana = speaker_kana
    session.speaker_org = speaker_org
    session.speaker_title = speaker_title
    session.speaker_profile = speaker_profile
    session.start_time = _parse_dt(start_time)
    session.end_time = _parse_dt(end_time)
    session.room_id = room_id
    session.description = description
    session.notes = notes
    session.required_staff = required_staff
    session.category = category
    session.english_required = int(english_required)

    if speaker_photo and speaker_photo.filename:
        ext = Path(speaker_photo.filename).suffix.lower()
        if ext not in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
            raise HTTPException(status_code=400, detail="対応していない画像形式です。jpg, png, gif, webp のみ対応しています。")
        # 古い写真を削除
        if session.speaker_photo:
            old_path = Path("." + session.speaker_photo)
            if old_path.exists():
                old_path.unlink()
        filename = f"{uuid.uuid4().hex}{ext}"
        save_path = UPLOAD_DIR / filename
        content = await speaker_photo.read()
        save_path.write_bytes(content)
        session.speaker_photo = f"/uploads/{filename}"

    db.commit()
    db.refresh(session, ["room", "lt_talks"])
    return session


class SessionMoveRequest(BaseModel):
    start_time: str
    end_time: str
    room_id: int


@router.patch("/{session_id}/move", response_model=SessionResponse)
def move_session(session_id: int, body: SessionMoveRequest, db: Session = Depends(get_db)):
    """Lightweight endpoint for drag-and-drop: update only time and room."""
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    room = db.query(Room).filter(Room.id == body.room_id).first()
    if not room:
        raise HTTPException(status_code=400, detail="Room not found")
    session.start_time = _parse_dt(body.start_time)
    session.end_time = _parse_dt(body.end_time)
    session.room_id = body.room_id
    db.commit()
    db.refresh(session, ["room", "lt_talks"])
    return session


@router.delete("/{session_id}", status_code=204)
def delete_session(session_id: int, db: Session = Depends(get_db)):
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    # 写真ファイルも削除
    if session.speaker_photo:
        photo_path = Path("." + session.speaker_photo)
        if photo_path.exists():
            photo_path.unlink()
    db.delete(session)
    db.commit()


@router.post("/calc-required-staff")
def calc_required_staff(db: Session = Depends(get_db)):
    """各セッションの必要スタッフ数を自動計算し、全体の必要人数も算出する

    ロジック:
    - 各セッションの時間帯で、活動可能なスタッフ数を算出
    - 同時間帯に開催される他セッション数を算出
    - 可能スタッフ数 ÷ 同時セッション数 (小数切り捨て、最低2) を必要スタッフ数とする
    - 全体の最小必要人数: 同時開催セッションの必要スタッフ合計の最大値
    - 休憩込み必要人数: 直前セッション終了スタッフの休憩を考慮した人数
    """
    REST_MINUTES = 30  # セッション終了後の休憩時間（分）

    sessions = db.query(SessionModel).order_by(SessionModel.start_time).all()
    staffs = db.query(Staff).options(
        joinedload(Staff.availabilities)
    ).all()

    if not sessions:
        return {"message": "セッションがありません", "results": [], "min_total_staff": 0, "comfortable_total_staff": 0}

    def _staff_available(staff: Staff, sess: SessionModel) -> bool:
        if not staff.availabilities:
            return True
        for a in staff.availabilities:
            if a.start_time <= sess.start_time and a.end_time >= sess.end_time:
                return True
        return False

    # --- 各セッションの必要スタッフ数を計算 ---
    results = []
    for sess in sessions:
        available_count = sum(1 for s in staffs if _staff_available(s, sess))
        concurrent = sum(
            1 for other in sessions
            if other.start_time < sess.end_time and other.end_time > sess.start_time
        )
        required = min(max(2, available_count // concurrent), 3) if concurrent > 0 else 2
        sess.required_staff = required
        results.append({
            "session_id": sess.id,
            "title": sess.title,
            "available_staff": available_count,
            "concurrent_sessions": concurrent,
            "required_staff": required,
        })

    db.commit()

    # --- 全体の必要スタッフ数を計算 ---
    # 全てのセッション開始・終了時刻を収集
    time_points = sorted(set(
        [s.start_time for s in sessions] + [s.end_time for s in sessions]
    ))

    min_total = 0
    comfortable_total = 0
    rest_delta = timedelta(minutes=REST_MINUTES)

    for t in time_points:
        # 時刻tで稼働中のセッション (start <= t < end)
        active = [s for s in sessions if s.start_time <= t < s.end_time]
        current_demand = sum(s.required_staff for s in active)

        # 直前に終了したセッションのスタッフ（休憩中）
        rest_cutoff = t - rest_delta
        resting = [s for s in sessions
                   if rest_cutoff < s.end_time <= t and s not in active]
        resting_demand = sum(s.required_staff for s in resting)

        min_total = max(min_total, current_demand)
        comfortable_total = max(comfortable_total, current_demand + resting_demand)

    return {
        "message": "必要スタッフ数を計算しました",
        "results": results,
        "min_total_staff": min_total,
        "comfortable_total_staff": comfortable_total,
    }


# === LT Talks ===

@router.get("/{session_id}/lt-talks", response_model=list[LTTalkResponse])
def list_lt_talks(session_id: int, db: Session = Depends(get_db)):
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return db.query(LTTalk).filter(LTTalk.session_id == session_id).order_by(LTTalk.order).all()


@router.put("/{session_id}/lt-talks", response_model=list[LTTalkResponse])
def update_lt_talks(session_id: int, talks: list[LTTalkCreate], db: Session = Depends(get_db)):
    """LTセッションの登壇者一覧を一括更新（全置換）"""
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    db.query(LTTalk).filter(LTTalk.session_id == session_id).delete()
    for i, talk in enumerate(talks):
        db.add(LTTalk(
            session_id=session_id,
            title=talk.title,
            speaker=talk.speaker,
            speaker_kana=talk.speaker_kana,
            speaker_org=talk.speaker_org,
            speaker_title=talk.speaker_title,
            order=talk.order if talk.order else i,
        ))
    db.commit()
    return db.query(LTTalk).filter(LTTalk.session_id == session_id).order_by(LTTalk.order).all()

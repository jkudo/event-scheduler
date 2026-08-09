import json
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload

from ..database import get_db
from ..models import Session as SessionModel, Room, LTTalk, Assignment, AppSetting, Category, Staff
from ..schemas import SessionResponse, LTTalkCreate, LTTalkResponse
from ..utils import save_upload, upload_path


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
    group_id: int | None = Form(None),
    speaker_photo: UploadFile | None = File(None),
    db: Session = Depends(get_db),
):
    photo_path = ""
    if speaker_photo and speaker_photo.filename:
        photo_path = await save_upload(speaker_photo)

    parsed_start = _parse_dt(start_time)
    parsed_end = _parse_dt(end_time)
    if parsed_start >= parsed_end:
        raise HTTPException(status_code=400, detail="開始時刻は終了時刻より前にしてください")

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
        start_time=parsed_start,
        end_time=parsed_end,
        room_id=room_id,
        required_staff=required_staff,
        category=category,
        english_required=int(english_required),
        group_id=group_id,
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
    group_id: int | None = Form(None),
    speaker_photo: UploadFile | None = File(None),
    db: Session = Depends(get_db),
):
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    parsed_start = _parse_dt(start_time)
    parsed_end = _parse_dt(end_time)
    if parsed_start >= parsed_end:
        raise HTTPException(status_code=400, detail="開始時刻は終了時刻より前にしてください")

    session.title = title
    session.speaker = speaker
    session.speaker_kana = speaker_kana
    session.speaker_org = speaker_org
    session.speaker_title = speaker_title
    session.speaker_profile = speaker_profile
    session.start_time = parsed_start
    session.end_time = parsed_end
    session.room_id = room_id
    session.description = description
    session.notes = notes
    session.required_staff = required_staff
    session.category = category
    session.english_required = int(english_required)
    session.group_id = group_id

    if speaker_photo and speaker_photo.filename:
        session.speaker_photo = await save_upload(speaker_photo, session.speaker_photo or "")

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
    new_start = _parse_dt(body.start_time)
    new_end = _parse_dt(body.end_time)

    # 配置済みスタッフの時間重複・別部屋移動時間(10分)チェック（重複許可設定で無効化）
    allow_overlap = db.query(AppSetting).filter(AppSetting.key == "allow_overlap").first()
    if not (allow_overlap and allow_overlap.value == "1"):
        staff_ids = [a.staff_id for a in db.query(Assignment).filter(Assignment.session_id == session_id).all()]
        if staff_ids:
            tb_row = db.query(AppSetting).filter(AppSetting.key == "travel_buffer_minutes").first()
            try:
                travel_min = int(tb_row.value) if tb_row and tb_row.value else 10
            except (ValueError, TypeError):
                travel_min = 10
            travel_buffer = timedelta(minutes=max(0, travel_min))
            others = (
                db.query(Assignment)
                .options(joinedload(Assignment.session), joinedload(Assignment.staff))
                .filter(Assignment.staff_id.in_(staff_ids), Assignment.session_id != session_id)
                .all()
            )
            for a in others:
                o = a.session
                if new_start < o.end_time and new_end > o.start_time:
                    raise HTTPException(status_code=400, detail=f"移動できません: {a.staff.name} は「{o.title}」と時間が重複します")
                if travel_buffer and o.room_id != body.room_id:
                    gap = (new_start - o.end_time) if o.end_time <= new_start else (o.start_time - new_end)
                    if gap < travel_buffer:
                        raise HTTPException(status_code=400, detail=f"移動できません: {a.staff.name} は別部屋の「{o.title}」と{travel_min}分未満の間隔になります")

    session.start_time = new_start
    session.end_time = new_end
    session.room_id = body.room_id
    db.commit()
    db.refresh(session, ["room", "lt_talks"])
    return session


class RequiredStaffUpdate(BaseModel):
    required_staff: int


@router.patch("/{session_id}/required-staff")
def update_required_staff(session_id: int, body: RequiredStaffUpdate, db: Session = Depends(get_db)):
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    session.required_staff = body.required_staff
    db.commit()
    return {"status": "ok"}


@router.delete("/{session_id}", status_code=204)
def delete_session(session_id: int, db: Session = Depends(get_db)):
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    # 写真ファイルも削除
    if session.speaker_photo:
        photo_path = upload_path(session.speaker_photo)
        if photo_path and photo_path.is_file():
            photo_path.unlink()
    db.delete(session)
    db.commit()


def _load_links(db: Session, key: str) -> dict:
    """カテゴリ・グループに紐づけた担当キーの辞書を返す"""
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    try:
        links = json.loads(row.value) if row and row.value else {}
    except ValueError:
        links = {}
    return links if isinstance(links, dict) else {}


@router.post("/calc-required-staff")
def calc_required_staff(db: Session = Depends(get_db)):
    """各セッションの設定済み必要スタッフ数から全体の必要人数を算出する

    - 全体の最小必要人数: 同時開催セッションの必要スタッフ合計の最大値
    - 推奨人数: セッション担当後に1回休憩をはさめる人数
    """
    REST_MINUTES = 30  # セッション終了後の休憩時間（分）

    sessions = db.query(SessionModel).order_by(SessionModel.start_time).all()

    if not sessions:
        return {
            "message": "セッションがありません",
            "results": [],
            "min_total_staff": 0,
            "comfortable_total_staff": 0,
            "total_staff": db.query(Staff).count(),
            "by_role": [],
        }

    # --- 各セッションの既存設定値を使用 ---
    results = []
    for sess in sessions:
        results.append({
            "session_id": sess.id,
            "title": sess.title,
            "required_staff": sess.required_staff or 0,
        })

    # --- 全体の必要スタッフ数を計算 ---
    # 「全員」(-1) と「配置しない」(0) は人数として数えられないので集計から外す
    countable = [s for s in sessions if (s.required_staff or 0) > 0]
    # 全てのセッション開始・終了時刻を収集
    time_points = sorted(set(
        [s.start_time for s in countable] + [s.end_time for s in countable]
    ))

    min_total = 0
    comfortable_total = 0
    rest_delta = timedelta(minutes=REST_MINUTES)

    for t in time_points:
        # 時刻tで稼働中のセッション (start <= t < end)
        active = [s for s in countable if s.start_time <= t < s.end_time]
        current_demand = sum(s.required_staff for s in active)

        # 直前に終了したセッションのスタッフ（休憩中）
        rest_cutoff = t - rest_delta
        resting = [s for s in countable
                   if rest_cutoff < s.end_time <= t and s not in active]
        resting_demand = sum(s.required_staff for s in resting)

        min_total = max(min_total, current_demand)
        comfortable_total = max(comfortable_total, current_demand + resting_demand)

    # --- 担当（ロール）ごとの必要人数と、現在の担当人数 ---
    dynamic_cat_keys = {c.key for c in db.query(Category.key).all()}
    category_role_links = _load_links(db, "category_role_links")
    group_role_links = _load_links(db, "group_role_links")
    staffs = db.query(Staff).all()

    def _role_of(sess) -> str:
        return sess.category if sess.category in dynamic_cat_keys else "session"

    def _peak(sess_list):
        """同時開催の必要人数のピーク（最小 / 休憩を挟める推奨）を返す"""
        if not sess_list:
            return 0, 0
        points = sorted(set([s.start_time for s in sess_list] + [s.end_time for s in sess_list]))
        lo = hi = 0
        for t in points:
            act = [s for s in sess_list if s.start_time <= t < s.end_time]
            demand = sum(s.required_staff for s in act)
            rest = [s for s in sess_list
                    if (t - rest_delta) < s.end_time <= t and s not in act]
            lo = max(lo, demand)
            hi = max(hi, demand + sum(s.required_staff for s in rest))
        return lo, hi

    by_role: dict[str, list] = {}
    for sess in countable:
        by_role.setdefault(_role_of(sess), []).append(sess)

    role_rows = []
    for role, sess_list in by_role.items():
        # そのロールのセッションを担当できるスタッフ（カテゴリ・グループに紐づけた担当も含む）
        allowed = {role} | set(category_role_links.get(role, []))
        for sess in sess_list:
            if sess.group_id:
                allowed |= set(group_role_links.get(str(sess.group_id), []))
        current = sum(
            1 for st in staffs
            if allowed & {r for r in (st.role or "").split(",") if r}
        )
        lo, hi = _peak(sess_list)
        role_rows.append({
            "role": role,
            "sessions": len(sess_list),
            "min": lo,
            "comfortable": hi,
            "current": current,
            "shortage": max(0, lo - current),
            "shortage_comfortable": max(0, hi - current),
        })
    role_rows.sort(key=lambda r: (r["role"] != "session", r["role"]))

    return {
        "message": "必要スタッフ数を計算しました",
        "results": results,
        "min_total_staff": min_total,
        "comfortable_total_staff": comfortable_total,
        "total_staff": len(staffs),
        "by_role": role_rows,
    }


# === LT Talks ===

@router.get("/{session_id}/lt-talks", response_model=list[LTTalkResponse])
def list_lt_talks(session_id: int, db: Session = Depends(get_db)):
    return db.query(LTTalk).filter(LTTalk.session_id == session_id).order_by(LTTalk.order).all()


@router.put("/{session_id}/lt-talks", response_model=list[LTTalkResponse])
def update_lt_talks(session_id: int, talks: list[LTTalkCreate], db: Session = Depends(get_db)):
    """LTセッションの登壇者一覧を一括更新（全置換）"""
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    db.query(LTTalk).filter(LTTalk.session_id == session_id).delete()
    rep_speaker = ""
    for i, talk in enumerate(talks):
        db.add(LTTalk(
            session_id=session_id,
            title=talk.title,
            speaker=talk.speaker,
            speaker_kana=talk.speaker_kana,
            speaker_org=talk.speaker_org,
            speaker_title=talk.speaker_title,
            speaker_photo=talk.speaker_photo,
            start_time=talk.start_time,
            end_time=talk.end_time,
            order=talk.order if talk.order else i,
            is_representative=talk.is_representative,
        ))
        if talk.is_representative:
            rep_speaker = talk.speaker
    # Auto-set session speaker from representative
    session.speaker = rep_speaker
    db.commit()
    return db.query(LTTalk).filter(LTTalk.session_id == session_id).order_by(LTTalk.order).all()


@router.post("/{session_id}/lt-talks/{talk_id}/photo", response_model=LTTalkResponse)
async def upload_lt_talk_photo(session_id: int, talk_id: int, photo: UploadFile = File(...), db: Session = Depends(get_db)):
    """LT登壇者の写真をアップロード"""
    talk = db.query(LTTalk).filter(LTTalk.id == talk_id, LTTalk.session_id == session_id).first()
    if not talk:
        raise HTTPException(status_code=404, detail="LT Talk not found")
    talk.speaker_photo = await save_upload(photo, talk.speaker_photo or "", prefix="lt_")
    db.commit()
    db.refresh(talk)
    return talk

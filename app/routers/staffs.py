from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload, selectinload

from ..database import get_db
from ..utils import save_upload
from ..models import Staff, StaffSkill, StaffPreferredSession, StaffAvailability
from ..models import Session as SessionModel
from ..schemas import (
    StaffCreate,
    StaffUpdate,
    StaffResponse,
    StaffPreferredSessionCreate,
    StaffPreferredSessionResponse,
    StaffAvailabilityCreate,
    StaffAvailabilityResponse,
)

router = APIRouter(prefix="/api/staffs", tags=["staffs"])


def _event_range(db: Session):
    """開催日の範囲を返す（最初のセッション日の00:00〜最終セッション日の翌0:00）

    セッションが1件も無い場合は None を返し、範囲チェックを行わない。
    """
    row = db.query(
        func.min(SessionModel.start_time), func.max(SessionModel.end_time)
    ).first()
    if not row or row[0] is None or row[1] is None:
        return None
    first = row[0].replace(hour=0, minute=0, second=0, microsecond=0)
    last = row[1].replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    return first, last


def _check_availability_range(db: Session, start_time, end_time):
    rng = _event_range(db)
    if rng is None:
        return
    first, last = rng
    if start_time < first or end_time > last:
        raise HTTPException(
            status_code=400,
            detail=f"活動可能時間は開催日の範囲内で指定してください（{first:%Y-%m-%d} 〜 {(last - timedelta(days=1)):%Y-%m-%d}）",
        )

STAFF_EAGER = [
    selectinload(Staff.skills),
    selectinload(Staff.preferred_sessions)
    .joinedload(StaffPreferredSession.session)
    .options(joinedload(SessionModel.room), selectinload(SessionModel.lt_talks)),
    selectinload(Staff.availabilities),
]


@router.get("/", response_model=list[StaffResponse])
def list_staffs(db: Session = Depends(get_db)):
    return db.query(Staff).options(*STAFF_EAGER).all()


@router.post("/", response_model=StaffResponse, status_code=201)
def create_staff(staff: StaffCreate, db: Session = Depends(get_db)):
    db_staff = Staff(name=staff.name, slack_name=staff.slack_name, english_ok=int(staff.english_ok), role=",".join(staff.role), max_hours=staff.max_hours, experience_count=staff.experience_count, emergency_contact=staff.emergency_contact)
    db.add(db_staff)
    db.flush()
    for skill in staff.skills:
        db.add(StaffSkill(staff_id=db_staff.id, skill=skill))
    used_priorities: set[int] = set()
    used_sessions: set[int] = set()
    for pref in staff.preferred_sessions:
        s = db.query(SessionModel).filter(SessionModel.id == pref.session_id).first()
        if not s:
            raise HTTPException(status_code=404, detail=f"Session {pref.session_id} not found")
        if s.category == "overall":
            raise HTTPException(status_code=400, detail="全体スケジュールは希望に指定できません")
        if pref.priority in used_priorities:
            raise HTTPException(status_code=400, detail=f"第{pref.priority}希望は既に指定されています")
        if pref.session_id in used_sessions:
            raise HTTPException(status_code=400, detail="同じセッションを複数の希望に指定できません")
        used_priorities.add(pref.priority)
        used_sessions.add(pref.session_id)
        db.add(StaffPreferredSession(staff_id=db_staff.id, session_id=pref.session_id, priority=pref.priority))
    for avail in staff.availabilities:
        _check_availability_range(db, avail.start_time, avail.end_time)
        db.add(StaffAvailability(staff_id=db_staff.id, start_time=avail.start_time, end_time=avail.end_time))
    db.commit()
    return db.query(Staff).options(*STAFF_EAGER).filter(Staff.id == db_staff.id).first()


@router.get("/{staff_id}", response_model=StaffResponse)
def get_staff(staff_id: int, db: Session = Depends(get_db)):
    staff = db.query(Staff).options(*STAFF_EAGER).filter(Staff.id == staff_id).first()
    if not staff:
        raise HTTPException(status_code=404, detail="Staff not found")
    return staff


@router.put("/{staff_id}", response_model=StaffResponse)
def update_staff(staff_id: int, data: StaffUpdate, db: Session = Depends(get_db)):
    staff = db.query(Staff).filter(Staff.id == staff_id).first()
    if not staff:
        raise HTTPException(status_code=404, detail="Staff not found")
    staff.name = data.name
    staff.slack_name = data.slack_name
    staff.english_ok = int(data.english_ok)
    staff.role = ",".join(data.role)
    staff.max_hours = data.max_hours
    staff.experience_count = data.experience_count
    staff.emergency_contact = data.emergency_contact
    # スキルを更新（既存を削除して再作成）
    db.query(StaffSkill).filter(StaffSkill.staff_id == staff_id).delete()
    for skill in data.skills:
        db.add(StaffSkill(staff_id=staff_id, skill=skill))
    db.commit()
    return db.query(Staff).options(*STAFF_EAGER).filter(Staff.id == staff_id).first()


@router.post("/{staff_id}/photo", response_model=StaffResponse)
async def upload_staff_photo(staff_id: int, photo: UploadFile = File(...), db: Session = Depends(get_db)):
    """スタッフの顔写真をアップロード"""
    staff = db.query(Staff).filter(Staff.id == staff_id).first()
    if not staff:
        raise HTTPException(status_code=404, detail="Staff not found")
    staff.photo = await save_upload(photo, staff.photo or "", prefix="staff_")
    db.commit()
    return db.query(Staff).options(*STAFF_EAGER).filter(Staff.id == staff_id).first()


@router.delete("/{staff_id}/photo", status_code=204)
def delete_staff_photo(staff_id: int, db: Session = Depends(get_db)):
    """スタッフの顔写真を削除"""
    staff = db.query(Staff).filter(Staff.id == staff_id).first()
    if not staff:
        raise HTTPException(status_code=404, detail="Staff not found")
    if staff.photo:
        old_path = Path("." + staff.photo)
        if old_path.exists():
            old_path.unlink()
        staff.photo = ""
        db.commit()


@router.delete("/{staff_id}", status_code=204)
def delete_staff(staff_id: int, db: Session = Depends(get_db)):
    staff = db.query(Staff).filter(Staff.id == staff_id).first()
    if not staff:
        raise HTTPException(status_code=404, detail="Staff not found")
    # 写真ファイルも削除
    if staff.photo:
        photo_path = Path("." + staff.photo)
        if photo_path.exists():
            photo_path.unlink()
    db.delete(staff)
    db.commit()


# --- Preferred Sessions ---
@router.post("/{staff_id}/preferred-sessions", response_model=StaffPreferredSessionResponse, status_code=201)
def add_preferred_session(staff_id: int, data: StaffPreferredSessionCreate, db: Session = Depends(get_db)):
    staff = db.query(Staff).filter(Staff.id == staff_id).first()
    if not staff:
        raise HTTPException(status_code=404, detail="Staff not found")
    session = db.query(SessionModel).filter(SessionModel.id == data.session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.category == "overall":
        raise HTTPException(status_code=400, detail="全体スケジュールは希望に指定できません")
    existing = db.query(StaffPreferredSession).filter(
        StaffPreferredSession.staff_id == staff_id
    ).all()
    if any(p.priority == data.priority for p in existing):
        raise HTTPException(status_code=400, detail=f"第{data.priority}希望は既に指定されています")
    if any(p.session_id == data.session_id for p in existing):
        raise HTTPException(status_code=400, detail="同じセッションを複数の希望に指定できません")
    pref = StaffPreferredSession(staff_id=staff_id, session_id=data.session_id, priority=data.priority)
    db.add(pref)
    db.commit()
    db.refresh(pref, ["session"])
    return pref


@router.delete("/{staff_id}/preferred-sessions/{pref_id}", status_code=204)
def remove_preferred_session(staff_id: int, pref_id: int, db: Session = Depends(get_db)):
    pref = db.query(StaffPreferredSession).filter(
        StaffPreferredSession.id == pref_id, StaffPreferredSession.staff_id == staff_id
    ).first()
    if not pref:
        raise HTTPException(status_code=404, detail="Preference not found")
    db.delete(pref)
    db.commit()


# --- Availability ---
@router.post("/{staff_id}/availabilities", response_model=StaffAvailabilityResponse, status_code=201)
def add_availability(staff_id: int, data: StaffAvailabilityCreate, db: Session = Depends(get_db)):
    staff = db.query(Staff).filter(Staff.id == staff_id).first()
    if not staff:
        raise HTTPException(status_code=404, detail="Staff not found")
    _check_availability_range(db, data.start_time, data.end_time)
    avail = StaffAvailability(staff_id=staff_id, start_time=data.start_time, end_time=data.end_time)
    db.add(avail)
    db.commit()
    db.refresh(avail)
    return avail


@router.delete("/{staff_id}/availabilities/{avail_id}", status_code=204)
def remove_availability(staff_id: int, avail_id: int, db: Session = Depends(get_db)):
    avail = db.query(StaffAvailability).filter(
        StaffAvailability.id == avail_id, StaffAvailability.staff_id == staff_id
    ).first()
    if not avail:
        raise HTTPException(status_code=404, detail="Availability not found")
    db.delete(avail)
    db.commit()

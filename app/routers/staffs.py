from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session, joinedload

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

STAFF_EAGER = [
    joinedload(Staff.skills),
    joinedload(Staff.preferred_sessions).joinedload(StaffPreferredSession.session).joinedload(SessionModel.room),
    joinedload(Staff.availabilities),
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
    for pref in staff.preferred_sessions:
        s = db.query(SessionModel).filter(SessionModel.id == pref.session_id).first()
        if not s:
            raise HTTPException(status_code=404, detail=f"Session {pref.session_id} not found")
        db.add(StaffPreferredSession(staff_id=db_staff.id, session_id=pref.session_id, priority=pref.priority))
    for avail in staff.availabilities:
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

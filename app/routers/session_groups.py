from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import SessionGroup, Session as SessionModel, Assignment
from ..schemas import SessionGroupCreate, SessionGroupResponse

router = APIRouter(prefix="/api/session-groups", tags=["session_groups"])


@router.get("/", response_model=list[SessionGroupResponse])
def list_session_groups(db: Session = Depends(get_db)):
    return db.query(SessionGroup).order_by(SessionGroup.order, SessionGroup.id).all()


@router.post("/", response_model=SessionGroupResponse, status_code=201)
def create_session_group(data: SessionGroupCreate, db: Session = Depends(get_db)):
    grp = SessionGroup(label=data.label, date=data.date, order=data.order, color=data.color)
    db.add(grp)
    db.commit()
    db.refresh(grp)
    return grp


@router.put("/{group_id}", response_model=SessionGroupResponse)
def update_session_group(group_id: int, data: SessionGroupCreate, db: Session = Depends(get_db)):
    grp = db.query(SessionGroup).filter(SessionGroup.id == group_id).first()
    if not grp:
        raise HTTPException(status_code=404, detail="SessionGroup not found")
    grp.label = data.label
    grp.date = data.date
    grp.order = data.order
    grp.color = data.color
    db.commit()
    db.refresh(grp)
    return grp


@router.delete("/{group_id}", status_code=204)
def delete_session_group(group_id: int, db: Session = Depends(get_db)):
    grp = db.query(SessionGroup).filter(SessionGroup.id == group_id).first()
    if not grp:
        raise HTTPException(status_code=404, detail="SessionGroup not found")
    # グループに属するセッションと関連データを一括削除
    session_ids = [s.id for s in db.query(SessionModel.id).filter(SessionModel.group_id == group_id).all()]
    if session_ids:
        db.query(Assignment).filter(Assignment.session_id.in_(session_ids)).delete(synchronize_session=False)
        db.query(SessionModel).filter(SessionModel.id.in_(session_ids)).delete(synchronize_session=False)
    db.delete(grp)
    db.commit()

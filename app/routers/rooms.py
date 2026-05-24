from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Room, Session as SessionModel
from ..schemas import RoomCreate, RoomResponse

router = APIRouter(prefix="/api/rooms", tags=["rooms"])


@router.get("/", response_model=list[RoomResponse])
def list_rooms(db: Session = Depends(get_db)):
    return db.query(Room).all()


@router.post("/", response_model=RoomResponse, status_code=201)
def create_room(room: RoomCreate, db: Session = Depends(get_db)):
    db_room = Room(**room.model_dump())
    db.add(db_room)
    db.commit()
    db.refresh(db_room)
    return db_room


@router.get("/{room_id}", response_model=RoomResponse)
def get_room(room_id: int, db: Session = Depends(get_db)):
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    return room


@router.put("/{room_id}", response_model=RoomResponse)
def update_room(room_id: int, data: RoomCreate, db: Session = Depends(get_db)):
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    room.name = data.name
    room.capacity = data.capacity
    room.floor = data.floor
    db.commit()
    db.refresh(room)
    return room


@router.delete("/{room_id}", status_code=204)
def delete_room(room_id: int, db: Session = Depends(get_db)):
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    session_count = db.query(SessionModel).filter(SessionModel.room_id == room_id).count()
    if session_count > 0:
        raise HTTPException(status_code=400, detail=f"この部屋には {session_count} 件のセッションが登録されているため削除できません")
    db.delete(room)
    db.commit()

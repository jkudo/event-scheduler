import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import VenueMap
from ..schemas import VenueMapResponse

router = APIRouter(prefix="/api/venue-maps", tags=["venue-maps"])

UPLOAD_DIR = Path("uploads")


@router.get("/", response_model=list[VenueMapResponse])
def list_venue_maps(db: Session = Depends(get_db)):
    return db.query(VenueMap).order_by(VenueMap.order).all()


@router.post("/", response_model=VenueMapResponse, status_code=201)
async def create_venue_map(
    title: str = Form(...),
    order: int = Form(0),
    image: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    ext = Path(image.filename).suffix.lower()
    if ext not in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
        raise HTTPException(status_code=400, detail="対応していない画像形式です。")
    filename = f"map_{uuid.uuid4().hex}{ext}"
    save_path = UPLOAD_DIR / filename
    content = await image.read()
    save_path.write_bytes(content)

    venue_map = VenueMap(title=title, image=f"/uploads/{filename}", order=order)
    db.add(venue_map)
    db.commit()
    db.refresh(venue_map)
    return venue_map


@router.put("/{map_id}", response_model=VenueMapResponse)
async def update_venue_map(
    map_id: int,
    title: str = Form(...),
    order: int = Form(0),
    image: UploadFile | None = File(None),
    db: Session = Depends(get_db),
):
    venue_map = db.query(VenueMap).filter(VenueMap.id == map_id).first()
    if not venue_map:
        raise HTTPException(status_code=404, detail="VenueMap not found")

    venue_map.title = title
    venue_map.order = order

    if image and image.filename:
        ext = Path(image.filename).suffix.lower()
        if ext not in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
            raise HTTPException(status_code=400, detail="対応していない画像形式です。")
        # 古い画像を削除
        if venue_map.image:
            old_path = Path("." + venue_map.image)
            if old_path.exists():
                old_path.unlink()
        filename = f"map_{uuid.uuid4().hex}{ext}"
        save_path = UPLOAD_DIR / filename
        content = await image.read()
        save_path.write_bytes(content)
        venue_map.image = f"/uploads/{filename}"

    db.commit()
    db.refresh(venue_map)
    return venue_map


@router.delete("/{map_id}", status_code=204)
def delete_venue_map(map_id: int, db: Session = Depends(get_db)):
    venue_map = db.query(VenueMap).filter(VenueMap.id == map_id).first()
    if not venue_map:
        raise HTTPException(status_code=404, detail="VenueMap not found")
    if venue_map.image:
        img_path = Path("." + venue_map.image)
        if img_path.exists():
            img_path.unlink()
    db.delete(venue_map)
    db.commit()

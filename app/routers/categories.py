from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Category, Session as SessionModel
from ..schemas import CategoryCreate, CategoryResponse

router = APIRouter(prefix="/api/categories", tags=["categories"])


@router.get("/", response_model=list[CategoryResponse])
def list_categories(db: Session = Depends(get_db)):
    return db.query(Category).order_by(Category.order, Category.id).all()


@router.post("/", response_model=CategoryResponse, status_code=201)
def create_category(data: CategoryCreate, db: Session = Depends(get_db)):
    existing = db.query(Category).filter(Category.key == data.key).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Key '{data.key}' は既に使用されています")
    cat = Category(key=data.key, label=data.label, color=data.color, order=data.order)
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return cat


@router.put("/{category_id}", response_model=CategoryResponse)
def update_category(category_id: int, data: CategoryCreate, db: Session = Depends(get_db)):
    cat = db.query(Category).filter(Category.id == category_id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    dup = db.query(Category).filter(Category.key == data.key, Category.id != category_id).first()
    if dup:
        raise HTTPException(status_code=400, detail=f"Key '{data.key}' は既に使用されています")
    cat.key = data.key
    cat.label = data.label
    cat.color = data.color
    cat.order = data.order
    db.commit()
    db.refresh(cat)
    return cat


@router.delete("/{category_id}", status_code=204)
def delete_category(category_id: int, db: Session = Depends(get_db)):
    cat = db.query(Category).filter(Category.id == category_id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    count = db.query(SessionModel).filter(SessionModel.category == cat.key).count()
    if count > 0:
        raise HTTPException(status_code=400, detail=f"このカテゴリには {count} 件のセッションがあるため削除できません。先にセッションを削除してください。")
    db.delete(cat)
    db.commit()

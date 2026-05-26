"""Shared utility functions used across routers."""

import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile

from .config import UPLOAD_DIR
from .models import Staff, Session as SessionModel

ALLOWED_IMAGE_EXT = (".jpg", ".jpeg", ".png", ".gif", ".webp")


async def save_upload(photo: UploadFile, old_photo_path: str = "", prefix: str = "") -> str:
    """写真ファイルを保存し、URLパスを返す。古いファイルがあれば削除する。"""
    ext = Path(photo.filename).suffix.lower()
    if ext not in ALLOWED_IMAGE_EXT:
        raise HTTPException(status_code=400, detail="対応していない画像形式です。jpg, png, gif, webp のみ対応しています。")
    if old_photo_path:
        old_file = Path("." + old_photo_path)
        if old_file.exists():
            old_file.unlink()
    filename = f"{prefix}{uuid.uuid4().hex}{ext}"
    save_path = UPLOAD_DIR / filename
    content = await photo.read()
    save_path.write_bytes(content)
    return f"/uploads/{filename}"


def is_staff_available(staff: Staff, session: SessionModel) -> bool:
    """スタッフの活動可能時間内にセッションが収まるかチェック"""
    if not staff.availabilities:
        return True  # 活動可能時間が未設定なら制約なし
    for avail in staff.availabilities:
        if avail.start_time <= session.start_time and avail.end_time >= session.end_time:
            return True
    return False

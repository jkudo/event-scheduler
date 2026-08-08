"""Shared utility functions used across routers."""

import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile

from .config import UPLOAD_DIR
from .models import Staff, Session as SessionModel

ALLOWED_IMAGE_EXT = (".jpg", ".jpeg", ".png", ".gif", ".webp")
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 1ファイルあたりの上限（10MB）


async def _read_limited(photo: UploadFile) -> bytes:
    """上限を超えた時点で読み込みを打ち切る（巨大なファイルを全量メモリに載せない）"""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await photo.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"画像が大きすぎます。{MAX_UPLOAD_BYTES // (1024 * 1024)}MB以下にしてください。",
            )
        chunks.append(chunk)
    return b"".join(chunks)


async def save_upload(photo: UploadFile, old_photo_path: str = "", prefix: str = "") -> str:
    """写真ファイルを保存し、URLパスを返す。古いファイルがあれば削除する。"""
    ext = Path(photo.filename).suffix.lower()
    if ext not in ALLOWED_IMAGE_EXT:
        raise HTTPException(status_code=400, detail="対応していない画像形式です。jpg, png, gif, webp のみ対応しています。")
    # 保存を拒否する場合に古いファイルを消さないよう、検証を先に済ませる
    content = await _read_limited(photo)
    filename = f"{prefix}{uuid.uuid4().hex}{ext}"
    save_path = UPLOAD_DIR / filename
    save_path.write_bytes(content)
    if old_photo_path:
        old_file = Path("." + old_photo_path)
        if old_file.exists():
            old_file.unlink()
    return f"/uploads/{filename}"


def is_staff_available(staff: Staff, session: SessionModel) -> bool:
    """スタッフの活動可能時間内にセッションが収まるかチェック"""
    if not staff.availabilities:
        return True  # 活動可能時間が未設定なら制約なし
    for avail in staff.availabilities:
        if avail.start_time <= session.start_time and avail.end_time >= session.end_time:
            return True
    return False

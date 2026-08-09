"""Shared utility functions used across routers."""

import io
import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile

from .config import UPLOAD_DIR
from .models import Staff, Session as SessionModel

ALLOWED_IMAGE_EXT = (".jpg", ".jpeg", ".png", ".gif", ".webp")
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 1ファイルあたりの上限（10MB）
# 画面での最大表示は180px。高DPI表示を見込んでこの大きさに収める
PHOTO_MAX_PX = 512
PHOTO_JPEG_QUALITY = 85


def _shrink(content: bytes, ext: str) -> bytes:
    """表示に必要な大きさまで縮小する。失敗したら元のまま返す。

    再エンコードの副作用で EXIF が落ちるため、撮影位置などは残らない。
    向きだけは先に反映する。
    """
    try:
        from PIL import Image, ImageOps

        with Image.open(io.BytesIO(content)) as img:
            img = ImageOps.exif_transpose(img)
            if max(img.size) <= PHOTO_MAX_PX and len(content) <= 300 * 1024:
                return content
            fmt = "PNG" if ext == ".png" else "WEBP" if ext == ".webp" else "JPEG"
            if fmt == "JPEG" and img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            elif fmt != "JPEG" and img.mode == "P":
                img = img.convert("RGBA")
            img.thumbnail((PHOTO_MAX_PX, PHOTO_MAX_PX), Image.LANCZOS)
            buf = io.BytesIO()
            if fmt == "JPEG":
                img.save(buf, format=fmt, quality=PHOTO_JPEG_QUALITY, optimize=True)
            else:
                img.save(buf, format=fmt, optimize=True)
            shrunk = buf.getvalue()
    except Exception:
        return content
    # 逆に大きくなる場合は元を使う
    return shrunk if len(shrunk) < len(content) else content


def upload_path(url_path: str) -> Path | None:
    """/uploads/xxx.png のURLパスを実ファイルの位置に変換する。

    DATA_DIR がカレントディレクトリと異なる環境（Docker・Azure）でも正しく解決する。
    /uploads/ 配下以外や、ディレクトリを指す値は None を返す。
    """
    if not url_path or not url_path.startswith("/uploads/"):
        return None
    return UPLOAD_DIR / Path(url_path).name


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
    content = _shrink(await _read_limited(photo), ext)
    filename = f"{prefix}{uuid.uuid4().hex}{ext}"
    save_path = UPLOAD_DIR / filename
    save_path.write_bytes(content)
    old_file = upload_path(old_photo_path)
    if old_file and old_file.is_file():
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
